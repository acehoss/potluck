import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

/**
 * Meal planner (REWORK H1). A week/meal grid of plannable entries belonging to
 * a household. Three plannable kinds (PTE's closed set, scope-cut to these):
 *   recipe — the household's OWN book (a foreign recipe is forked first, so a
 *            plan entry always points at an owned Recipe)
 *   item   — a bare ingredient/product text line (flows to the shopping list)
 *   note   — planner-only text, ignored by list generation
 * Menus / queue / leftovers / freezer are OUT (J3 scope cut).
 *
 * NO money, NO ledger anywhere here. Capability (A3a): `editRecipes` gates every
 * write; reads (week) are any-member. Error convention: 404 = not this
 * household's entry (existence never leaks), 403 = capability failure.
 *
 * A deleted recipe degrades its plan entries to a tombstone rather than
 * vanishing (PlanEntry.recipeId is onDelete: SetNull): week() renders a
 * null-recipeId kind=recipe entry as "(deleted recipe)" so a planned slot is
 * never silently lost.
 */

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const mealSchema = z.enum(MEALS);
const kindSchema = z.enum(['recipe', 'item', 'note']);
const clientKeySchema = z.string().min(8).max(64).optional();

/** A real "YYYY-MM-DD" calendar day (shape AND validity — no 2026-02-31). */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a real date.');

/** Add `days` to a YYYY-MM-DD in UTC and re-format (no timezone drift). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Next append position within one (household, date, meal) column. */
async function nextPosition(
  tx: Prisma.TransactionClient,
  householdId: string,
  date: string,
  meal: string,
): Promise<number> {
  const agg = await tx.planEntry.aggregate({
    where: { householdId, date, meal },
    _max: { position: true },
  });
  return (agg._max.position ?? -1) + 1;
}

export const planRouter = router({
  /**
   * The week starting at `start` (7 days, start..start+6), grouped by day then
   * meal. Also returns a slim own-book recipe list for the picker. Any-member
   * read — the planner is shared household-wide.
   */
  week: protectedProcedure
    .input(z.object({ start: dateSchema }))
    .query(async ({ ctx, input }) => {
      const H = ctx.user.householdId;
      const dates = Array.from({ length: 7 }, (_, i) => addDays(input.start, i));

      const [entries, recipes] = await Promise.all([
        db.planEntry.findMany({
          where: { householdId: H, date: { in: dates } },
          orderBy: { position: 'asc' },
          include: { recipe: { select: { id: true, title: true, servings: true } } },
        }),
        db.recipe.findMany({
          where: { householdId: H },
          orderBy: { title: 'asc' },
          select: { id: true, title: true, servings: true },
        }),
      ]);

      const days = dates.map((date) => ({
        date,
        meals: Object.fromEntries(MEALS.map((m) => [m, [] as unknown[]])) as Record<
          (typeof MEALS)[number],
          {
            id: string;
            meal: string;
            position: number;
            kind: string;
            recipeId: string | null;
            recipeTitle: string | null;
            servings: number | null;
            servingsOverride: number | null;
            text: string | null;
            addedToShoppingAt: Date | null;
          }[]
        >,
      }));
      const byDate = new Map(days.map((d) => [d.date, d]));

      for (const e of entries) {
        const day = byDate.get(e.date);
        if (!day) continue;
        const bucket = day.meals[e.meal as (typeof MEALS)[number]];
        if (!bucket) continue; // an unknown meal string never renders
        // Tombstone: kind=recipe whose recipe was deleted (recipeId nulled).
        const recipeTitle =
          e.kind === 'recipe' ? (e.recipe?.title ?? '(deleted recipe)') : null;
        const baseServings = e.recipe?.servings ?? null;
        bucket.push({
          id: e.id,
          meal: e.meal,
          position: e.position,
          kind: e.kind,
          recipeId: e.recipeId,
          recipeTitle,
          servings: e.servingsOverride ?? baseServings,
          servingsOverride: e.servingsOverride,
          text: e.text,
          // Round S: the plan UI's "on the shopping list" marker (null = never
          // sent). Set by shopping.generate (range) / shopping.addFromEntry.
          addedToShoppingAt: e.addedToShoppingAt,
        });
      }

      return { start: input.start, days, recipes };
    }),

  /**
   * Add a plannable to a (date, meal). kind=recipe requires a recipeId owned by
   * the acting household (404 else — a foreign recipe must be forked first);
   * kind=item|note requires text. Appends at the end of the column.
   */
  addEntry: protectedProcedure
    .input(
      z.object({
        date: dateSchema,
        meal: mealSchema,
        kind: kindSchema,
        recipeId: z.string().min(1).optional(),
        text: z.string().trim().min(1).max(300).optional(),
        servingsOverride: z.number().int().min(1).max(999).optional(),
        clientKey: clientKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      const isRecipe = input.kind === 'recipe';
      if (isRecipe && !input.recipeId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick a recipe to plan.' });
      }
      if (!isRecipe && !input.text) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter some text.' });
      }
      return dbTransaction(async (tx) => {
        if (input.clientKey) {
          const prior = await tx.planEntry.findUnique({ where: { clientKey: input.clientKey } });
          if (prior) {
            if (prior.householdId !== H) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
            }
            return { id: prior.id };
          }
        }
        if (isRecipe) {
          const recipe = await tx.recipe.findUnique({ where: { id: input.recipeId! } });
          if (!recipe || recipe.householdId !== H) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
          }
        }
        const position = await nextPosition(tx, H, input.date, input.meal);
        const entry = await tx.planEntry.create({
          data: {
            clientKey: input.clientKey ?? null,
            householdId: H,
            createdById: ctx.user.id,
            date: input.date,
            meal: input.meal,
            position,
            kind: input.kind,
            recipeId: isRecipe ? input.recipeId! : null,
            // servingsOverride and text are per-kind: only recipes scale, only
            // item/note carry text.
            servingsOverride: isRecipe ? input.servingsOverride ?? null : null,
            text: isRecipe ? null : input.text!,
          },
        });
        return { id: entry.id };
      });
    }),

  /**
   * Edit an own-household entry: move it (date/meal — re-appends position in the
   * target column), rescale it (servingsOverride; null clears the override), or
   * retitle an item/note (text). Only fields present change.
   */
  updateEntry: protectedProcedure
    .input(
      z.object({
        entryId: z.string().min(1),
        date: dateSchema.optional(),
        meal: mealSchema.optional(),
        servingsOverride: z.number().int().min(1).max(999).nullish(),
        text: z.string().trim().min(1).max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const entry = await tx.planEntry.findUnique({ where: { id: input.entryId } });
        if (!entry || entry.householdId !== H) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Plan entry not found.' });
        }
        const newDate = input.date ?? entry.date;
        const newMeal = input.meal ?? entry.meal;
        const moved = newDate !== entry.date || newMeal !== entry.meal;
        const data: Prisma.PlanEntryUpdateInput = {};
        if (moved) {
          data.date = newDate;
          data.meal = newMeal;
          data.position = await nextPosition(tx, H, newDate, newMeal);
        }
        // undefined = leave the override; null = clear it; a number = set it.
        if (input.servingsOverride !== undefined) data.servingsOverride = input.servingsOverride;
        // Text only applies to item/note entries — a recipe entry stays text-null.
        if (input.text !== undefined && entry.kind !== 'recipe') data.text = input.text;
        await tx.planEntry.update({ where: { id: entry.id }, data });
        return { ok: true };
      });
    }),

  /** Remove an own-household entry (hard delete). */
  removeEntry: protectedProcedure
    .input(z.object({ entryId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const entry = await tx.planEntry.findUnique({ where: { id: input.entryId } });
        if (!entry || entry.householdId !== H) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Plan entry not found.' });
        }
        await tx.planEntry.delete({ where: { id: entry.id } });
        return { ok: true };
      });
    }),
});
