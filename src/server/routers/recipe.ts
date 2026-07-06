import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { activeConnectionsOf, hasActiveGrant, requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { deleteImageFile, imageFileExists, isStoredImagePath, writeImageFile } from '../images';
import { checkRateLimit } from '../rate-limit';
import { importRecipeFromUrl, type ImportResult } from '../recipe-import';
import { normalizeIngredientName, parseIngredientLine, parseRecipeText } from '../recipe-parse';
import { protectedProcedure, router } from '../trpc';

/**
 * Recipe book (REWORK G). PTE-shaped structured ingredient lines + section
 * headings; only title required (G1). Recipes touch NO money and NO ledger.
 * Cross-household browsing rides the `recipes` grant over an ACTIVE edge plus
 * the per-recipe `private` flag (G3); saving a foreign recipe FORKS it
 * (browse-live, fork-on-save — author edits never propagate to copies).
 *
 * Capability (A3a): `editRecipes` gates every write (create/update/delete/fork)
 * and the two editor assists (parseText/importUrl — read-shaped, but they exist
 * to feed the editor). Reads (list/get/suggestions) are any-member. Error
 * convention (authz.ts): 404 = not visible (existence never leaks), 403 =
 * capability failure on a visible thing, 409 = state conflict.
 *
 * IngredientLink (G2) is the learned per-household name→product map, written
 * only on explicit confirmation and resolved at read time for EVERY visible
 * recipe. Quantities never convert across the link — the UI shows recipe amount
 * and pantry count side by side; the server just resolves the product.
 */

const clientKeySchema = z.string().min(8).max(64).optional();

const ingredientInput = z.object({
  kind: z.enum(['item', 'heading']),
  amount: z.string().trim().max(50).optional(),
  unit: z.string().trim().max(50).optional(),
  text: z.string().trim().min(1).max(300),
  note: z.string().trim().max(300).optional(),
});

/** The editor-supplied recipe body, shared by create and update. */
const recipeBody = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  directions: z.string().trim().max(10000).optional(),
  prepMinutes: z.number().int().min(0).max(6000).optional(),
  cookMinutes: z.number().int().min(0).max(6000).optional(),
  servings: z.number().int().min(1).max(999).optional(),
  yieldText: z.string().trim().max(100).optional(),
  course: z.string().trim().max(50).optional(),
  cuisine: z.string().trim().max(50).optional(),
  tags: z.string().trim().max(300).optional(),
  sourceUrl: z.string().trim().max(500).optional(),
  private: z.boolean().optional(),
  ingredients: z.array(ingredientInput).max(100),
};

type IngredientInput = z.infer<typeof ingredientInput>;

/** Comma-separated tags in → trimmed/de-blanked/re-joined, or null when empty. */
function normalizeTags(tags: string | undefined): string | null {
  if (!tags) return null;
  const parts = tags.split(',').map((t) => t.trim()).filter(Boolean);
  return parts.length ? parts.join(',') : null;
}

function splitTags(tags: string | null): string[] {
  return tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
}

/** Scalar columns from the editor body (create sets or clears every field). */
function recipeScalars(input: z.infer<z.ZodObject<typeof recipeBody>>) {
  return {
    title: input.title,
    description: input.description ?? null,
    directions: input.directions ?? null,
    prepMinutes: input.prepMinutes ?? null,
    cookMinutes: input.cookMinutes ?? null,
    servings: input.servings ?? null,
    yieldText: input.yieldText ?? null,
    course: input.course ?? null,
    cuisine: input.cuisine ?? null,
    tags: normalizeTags(input.tags),
    private: input.private ?? false,
    sourceUrl: input.sourceUrl ?? null,
  };
}

/** Ingredient rows are value objects: positions come from array order; a
 * heading carries only its text (amount/unit/note nulled). */
async function writeIngredients(
  tx: Prisma.TransactionClient,
  recipeId: string,
  ingredients: IngredientInput[],
) {
  for (let i = 0; i < ingredients.length; i++) {
    const ing = ingredients[i];
    const heading = ing.kind === 'heading';
    await tx.recipeIngredient.create({
      data: {
        recipeId,
        position: i,
        kind: ing.kind,
        amount: heading ? null : ing.amount ?? null,
        unit: heading ? null : ing.unit ?? null,
        text: ing.text,
        note: heading ? null : ing.note ?? null,
      },
    });
  }
}

/**
 * A recipe photo may only reference a freshly uploaded file of kind "recipes"
 * (mirrors item.assertFreshItemPhoto): server-generated name, present on disk,
 * referenced by no other Recipe. Never trust a client string that drives a file
 * unlink. NOT used by fork — a fork copies an already-referenced path.
 */
async function assertFreshRecipePhoto(tx: Prisma.TransactionClient, path: string) {
  if (!isStoredImagePath('recipes', path)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an uploaded image path.' });
  }
  if (!(await imageFileExists(path))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Image not found — upload it first.' });
  }
  const inUse = await tx.recipe.findFirst({ where: { photoPath: path } });
  if (inUse) throw new TRPCError({ code: 'CONFLICT', message: 'That image is already attached.' });
}

/** Recipe photos are referenced only by Recipe.photoPath; unlink when orphaned
 * (a fork sharing the file keeps it alive). */
async function unlinkRecipePhotoIfUnreferenced(tx: Prisma.TransactionClient, path: string) {
  const stillUsed = await tx.recipe.findFirst({ where: { photoPath: path } });
  if (!stillUsed) await deleteImageFile(path);
}

/** Slim card DTO for list; householdName only present for shared recipes. */
function slimDto(
  r: {
    id: string;
    title: string;
    course: string | null;
    cuisine: string | null;
    tags: string | null;
    photoPath: string | null;
    servings: number | null;
    prepMinutes: number | null;
    cookMinutes: number | null;
    private: boolean;
    forkedFromTitle: string | null;
    forkedFromHouseholdName: string | null;
  },
  householdName?: string,
) {
  return {
    id: r.id,
    title: r.title,
    course: r.course,
    cuisine: r.cuisine,
    tags: splitTags(r.tags),
    photoPath: r.photoPath,
    servings: r.servings,
    prepMinutes: r.prepMinutes,
    cookMinutes: r.cookMinutes,
    private: r.private,
    forkedFromTitle: r.forkedFromTitle,
    forkedFromHouseholdName: r.forkedFromHouseholdName,
    ...(householdName !== undefined ? { householdName } : {}),
  };
}

/**
 * SEED_DEMO-only import fixture. The SSRF guard blocks localhost, so e2e can't
 * have the app fetch a page it serves itself, and CI has no outbound network —
 * so import's EDITOR wiring is exercised deterministically through this branch
 * (mail-test-style). Never reachable in prod: SEED_DEMO is unset there.
 *   - fixture.potluck.test/import/with-photo  → ok + a really-written photoPath
 *   - fixture.potluck.test/import/photo-note  → ok, photoUrl set, photoPath null
 */
const FIXTURE_IMPORT_HOST = 'fixture.potluck.test';
// A valid 1×1 baseline JPEG (FF D8 … FF D9) — a real file for the editor preview.
const FIXTURE_IMPORT_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
    'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
    'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
    'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
    'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
    'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA' +
    'AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx' +
    'BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK' +
    'U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3' +
    'uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii' +
    'gD//2Q==',
  'base64',
);

async function fixtureImportResult(pathname: string): Promise<ImportResult> {
  const data = {
    title: 'Fixture Skillet Cornbread',
    description: 'A deterministic recipe used only by e2e import tests.',
    ingredients: [
      '1 cup cornmeal',
      '1 cup all-purpose flour',
      '1 tablespoon baking powder',
      '1 teaspoon salt',
      '1 cup buttermilk',
      '1 large egg',
      '4 tablespoons butter, melted',
    ].map(parseIngredientLine),
    directions: [
      'Preheat the oven to 425°F with a cast-iron skillet inside to heat.',
      'Whisk the cornmeal, flour, baking powder, and salt together.',
      'Beat in the buttermilk, egg, and melted butter until just combined.',
      'Carefully pour the batter into the hot skillet.',
      'Bake for 20 to 25 minutes, until golden and springy.',
      'Cool 5 minutes, then turn out and slice.',
    ].join('\n'),
    servings: 8,
    sourceUrl: `https://${FIXTURE_IMPORT_HOST}${pathname}`,
    photoUrl: `https://${FIXTURE_IMPORT_HOST}/photo.jpg`,
    photoPath: null as string | null,
  };
  if (pathname === '/import/with-photo') {
    data.photoPath = await writeImageFile('recipes', FIXTURE_IMPORT_JPEG);
  }
  return { status: 'ok' as const, data };
}

export const recipeRouter = router({
  /**
   * The acting household's book: `mine` (all its recipes, private included) and
   * `shared` (for each ACTIVE connection that grants ME `recipes`, that
   * household's non-private recipes). Title-asc within each group.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const H = ctx.user.householdId;
    const mineRows = await db.recipe.findMany({
      where: { householdId: H },
      orderBy: { title: 'asc' },
    });

    const conns = await activeConnectionsOf(db, H);
    const granterIds = conns.filter((c) => c.theyGrant.recipes).map((c) => c.counterpartyId);
    const sharedRows = granterIds.length
      ? await db.recipe.findMany({
          where: { householdId: { in: granterIds }, private: false },
          orderBy: { title: 'asc' },
          include: { household: { select: { name: true } } },
        })
      : [];

    return {
      mine: mineRows.map((r) => slimDto(r)),
      shared: sharedRows.map((r) => slimDto(r, r.household.name)),
    };
  }),

  /**
   * Full recipe with ordered ingredients. Visible = own household OR (non-private
   * AND poster grants me `recipes` over an ACTIVE edge) — else 404. Each item
   * line carries the acting household's IngredientLink resolution (G2), resolved
   * for every visible recipe, not just own.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const H = ctx.user.householdId;
      const recipe = await db.recipe.findUnique({
        where: { id: input.id },
        include: {
          ingredients: { orderBy: { position: 'asc' } },
          household: { select: { name: true } },
        },
      });
      if (!recipe) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
      const mine = recipe.householdId === H;
      if (!mine) {
        const visible =
          !recipe.private && (await hasActiveGrant(db, recipe.householdId, H, 'recipes'));
        if (!visible) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
      }

      const itemNames = [
        ...new Set(
          recipe.ingredients
            .filter((i) => i.kind === 'item')
            .map((i) => normalizeIngredientName(i.text)),
        ),
      ];
      const links = itemNames.length
        ? await db.ingredientLink.findMany({
            where: { householdId: H, normalizedName: { in: itemNames } },
            include: { product: { select: { id: true, name: true } } },
          })
        : [];
      const linkByName = new Map(links.map((l) => [l.normalizedName, l]));

      return {
        id: recipe.id,
        title: recipe.title,
        description: recipe.description,
        directions: recipe.directions,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        servings: recipe.servings,
        yieldText: recipe.yieldText,
        course: recipe.course,
        cuisine: recipe.cuisine,
        tags: splitTags(recipe.tags),
        photoPath: recipe.photoPath,
        private: recipe.private,
        sourceUrl: recipe.sourceUrl,
        forkedFromTitle: recipe.forkedFromTitle,
        forkedFromHouseholdName: recipe.forkedFromHouseholdName,
        mine,
        householdName: recipe.household.name,
        ingredients: recipe.ingredients.map((i) => {
          const link = i.kind === 'item' ? linkByName.get(normalizeIngredientName(i.text)) : null;
          return {
            id: i.id,
            position: i.position,
            kind: i.kind,
            amount: i.amount,
            unit: i.unit,
            text: i.text,
            note: i.note,
            link: link ? { productId: link.product.id, productName: link.product.name } : null,
          };
        }),
      };
    }),

  /** Create a recipe in the acting household. Positions come from array order. */
  create: protectedProcedure
    .input(z.object({ ...recipeBody, photoPath: z.string().min(1).max(300).optional(), clientKey: clientKeySchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        if (input.clientKey) {
          const prior = await tx.recipe.findUnique({ where: { clientKey: input.clientKey } });
          if (prior) {
            if (prior.householdId !== H) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
            }
            return { id: prior.id };
          }
        }
        if (input.photoPath) await assertFreshRecipePhoto(tx, input.photoPath);
        const recipe = await tx.recipe.create({
          data: {
            ...recipeScalars(input),
            clientKey: input.clientKey ?? null,
            householdId: H,
            createdById: ctx.user.id,
            photoPath: input.photoPath ?? null,
          },
        });
        await writeIngredients(tx, recipe.id, input.ingredients);
        return { id: recipe.id };
      });
    }),

  /**
   * Edit an own-household recipe; the ingredient array REPLACES the whole set
   * (value objects — delete + recreate). photoPath: undefined = keep, null =
   * remove, string = replace with a fresh upload. Every other field is set from
   * the submitted body or cleared (the editor resubmits the whole recipe).
   */
  update: protectedProcedure
    .input(
      z.object({
        recipeId: z.string().min(1),
        ...recipeBody,
        photoPath: z.string().min(1).max(300).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      const oldPhoto = await dbTransaction(async (tx) => {
        const recipe = await tx.recipe.findUnique({ where: { id: input.recipeId } });
        if (!recipe) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
        if (recipe.householdId !== H) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the owning household can edit a recipe.',
          });
        }
        if (typeof input.photoPath === 'string') await assertFreshRecipePhoto(tx, input.photoPath);

        await tx.recipe.update({
          where: { id: recipe.id },
          data: {
            ...recipeScalars(input),
            // undefined = leave the current photo untouched; null/string handled.
            photoPath: input.photoPath === undefined ? undefined : input.photoPath,
          },
        });
        await tx.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
        await writeIngredients(tx, recipe.id, input.ingredients);

        return input.photoPath !== undefined && recipe.photoPath !== input.photoPath
          ? recipe.photoPath
          : null;
      });
      if (oldPhoto) await dbTransaction((tx) => unlinkRecipePhotoIfUnreferenced(tx, oldPhoto));
      return { ok: true };
    }),

  /** Hard-delete an own recipe (cascades ingredients; forks are copies and
   * unaffected). Unlinks the photo file if no recipe still references it. */
  delete: protectedProcedure
    .input(z.object({ recipeId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      const oldPhoto = await dbTransaction(async (tx) => {
        const recipe = await tx.recipe.findUnique({ where: { id: input.recipeId } });
        if (!recipe) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
        if (recipe.householdId !== H) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the owning household can delete a recipe.',
          });
        }
        await tx.recipe.delete({ where: { id: recipe.id } });
        return recipe.photoPath;
      });
      if (oldPhoto) await dbTransaction((tx) => unlinkRecipePhotoIfUnreferenced(tx, oldPhoto));
      return { ok: true };
    }),

  /**
   * Fork a VISIBLE, not-own recipe into the acting household's book (G3): copies
   * every field + ingredients + the photo reference, sets private=true (forks
   * aren't re-shared onward), and snapshots fork attribution (deliberately not
   * FKs — the source may vanish later). Author edits never propagate: it's a
   * plain copy.
   */
  fork: protectedProcedure
    .input(z.object({ recipeId: z.string().min(1), clientKey: clientKeySchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        if (input.clientKey) {
          const prior = await tx.recipe.findUnique({ where: { clientKey: input.clientKey } });
          if (prior) {
            if (prior.householdId !== H) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
            }
            return { id: prior.id };
          }
        }
        const source = await tx.recipe.findUnique({
          where: { id: input.recipeId },
          include: {
            ingredients: { orderBy: { position: 'asc' } },
            household: { select: { name: true } },
          },
        });
        if (!source) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
        if (source.householdId === H) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: "You can't fork your own recipe." });
        }
        const visible =
          !source.private && (await hasActiveGrant(tx, source.householdId, H, 'recipes'));
        if (!visible) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });

        const copy = await tx.recipe.create({
          data: {
            clientKey: input.clientKey ?? null,
            householdId: H,
            createdById: ctx.user.id,
            title: source.title,
            description: source.description,
            directions: source.directions,
            prepMinutes: source.prepMinutes,
            cookMinutes: source.cookMinutes,
            servings: source.servings,
            yieldText: source.yieldText,
            course: source.course,
            cuisine: source.cuisine,
            tags: source.tags,
            photoPath: source.photoPath, // shared file reference; sweep/unlink honor it
            private: true,
            sourceUrl: source.sourceUrl,
            forkedFromTitle: source.title,
            forkedFromHouseholdName: source.household.name,
          },
        });
        for (const ing of source.ingredients) {
          await tx.recipeIngredient.create({
            data: {
              recipeId: copy.id,
              position: ing.position,
              kind: ing.kind,
              amount: ing.amount,
              unit: ing.unit,
              text: ing.text,
              note: ing.note,
            },
          });
        }
        return { id: copy.id };
      });
    }),

  /** Paste-to-parse assist (G4): pure heuristic, reviewed in the editor. */
  parseText: protectedProcedure
    .input(z.object({ text: z.string().max(20000) }))
    .mutation(({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      return parseRecipeText(input.text);
    }),

  /**
   * URL import (G4): fetch a page server-side and extract schema.org/Recipe.
   * SSRF-guarded, rate-limited, and advisory — failures return
   * { status: 'unavailable', reason } exactly like extraction, never a 500.
   */
  importUrl: protectedProcedure
    .input(z.object({ url: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      if (process.env.SEED_DEMO === '1') {
        try {
          const u = new URL(input.url);
          if (u.hostname === FIXTURE_IMPORT_HOST) return fixtureImportResult(u.pathname);
        } catch {
          // Not a parseable URL — fall through to the real (guarded) import.
        }
      }
      if (!checkRateLimit(`recipe-import:${ctx.user.id}`, 10)) {
        return {
          status: 'unavailable' as const,
          reason: 'Too many imports — wait a few minutes and try again.',
        };
      }
      return importRecipeFromUrl(input.url);
    }),

  /**
   * Learn (or re-point) an ingredient-name → product mapping for the acting
   * household (G2). The product must belong to the acting household (404 else,
   * existence never leaks). Upsert on the normalized ingredient text.
   */
  linkIngredient: protectedProcedure
    .input(z.object({ text: z.string().trim().min(1).max(300), productId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      const normalizedName = normalizeIngredientName(input.text);
      if (!normalizedName) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nothing to link.' });
      }
      return dbTransaction(async (tx) => {
        const product = await tx.product.findUnique({ where: { id: input.productId } });
        if (!product || product.householdId !== H) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
        }
        await tx.ingredientLink.upsert({
          where: { householdId_normalizedName: { householdId: H, normalizedName } },
          create: { householdId: H, normalizedName, productId: input.productId },
          update: { productId: input.productId },
        });
        return { normalizedName, productId: product.id, productName: product.name };
      });
    }),

  /** Forget the acting household's mapping for an ingredient name (idempotent). */
  unlinkIngredient: protectedProcedure
    .input(z.object({ text: z.string().trim().min(1).max(300) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const normalizedName = normalizeIngredientName(input.text);
      await db.ingredientLink.deleteMany({
        where: { householdId: ctx.user.householdId, normalizedName },
      });
      return { ok: true };
    }),

  /**
   * Up to 5 acting-household products whose name fuzzily relates to the given
   * ingredient text (case-insensitive substring, either direction, on
   * normalized forms) — feeds the "link this ingredient" picker. Never
   * auto-links (G2). Any-member read.
   */
  suggestions: protectedProcedure
    .input(z.object({ text: z.string().trim().max(300) }))
    .query(async ({ ctx, input }) => {
      const norm = normalizeIngredientName(input.text);
      if (!norm) return [];
      const products = await db.product.findMany({
        where: { householdId: ctx.user.householdId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      return products
        .filter((p) => {
          const pn = normalizeIngredientName(p.name);
          return pn.includes(norm) || norm.includes(pn);
        })
        .slice(0, 5);
    }),
});
