import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { activeConnectionsOf, requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { formatQuantity, mergeAmounts, scaleAmount } from '../plan-scale';
import { normalizeIngredientName } from '../recipe-parse';
import { protectedProcedure, router } from '../trpc';

/**
 * Shopping list (REWORK H2) — one persistent list per household, generated from
 * planned entries over a date range and hand-editable. NO money, NO ledger: the
 * only bridge to an order is a SUGGESTED lot the UI feeds to the existing
 * order.addToCart. Capability (A3a): every write needs `editRecipes`; list() is
 * an any-member read. 404 = not this household's item (existence never leaks).
 *
 * H2's load-bearing rules, honored here:
 *  - Nothing is ever silently removed (PTE's pantry lesson): generation UPSERTS
 *    into the (household, normalizedName, unit) natural key; only explicit user
 *    actions delete a row.
 *  - Merging is conservative: same (normalizedName, unit) only; numeric amounts
 *    sum, everything else stays an opaque string; DIFFERENT units never combine.
 *  - Availability is resolved ONLY for LINKED items (G2 IngredientLink), across
 *    the acting household's own pantries and the SHARED pantries of ACTIVE
 *    connections that grant it `pantry` — the 404-invisibility rule extends
 *    here: an ungranted/unconnected/private pantry is never even counted.
 */

const clientKeySchema = z.string().min(8).max(64).optional();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.');

/** Days between two YYYY-MM-DD strings (to − from), or NaN if unparseable. */
function dayDiff(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return (b - a) / 86_400_000;
}

/** Store the ''-normalized unit exactly as the merge key uses it. */
function normUnit(unit: string | null | undefined): string {
  return (unit ?? '').trim();
}

type AvailabilityRow = {
  pantryId: string;
  pantryName: string;
  householdName: string;
  own: boolean;
  available: number;
  suggestedLotId: string | null;
};

export const shoppingRouter = router({
  /**
   * The household's list with, per item: its learned product link (G2), and —
   * only when linked — availability badges. Availability sums remaining−reserved
   * per reachable pantry and preselects the FIFO-oldest orderable lot
   * (suggestedLotId), mirroring the pantry scan flow's oldest-first suggestion.
   * Sort: unchecked first, then category (nulls last, alpha), then title.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const H = ctx.user.householdId;
    const items = await db.shoppingItem.findMany({ where: { householdId: H } });

    // Resolve the learned name→product link for every distinct item name (G2).
    const names = [...new Set(items.map((i) => i.normalizedName))];
    const links = names.length
      ? await db.ingredientLink.findMany({
          where: { householdId: H, normalizedName: { in: names } },
          include: { product: { select: { id: true, name: true } } },
        })
      : [];
    const linkByName = new Map(
      links.map((l) => [
        l.normalizedName,
        { productId: l.product.id, productName: l.product.name },
      ]),
    );

    // Reachable pantries for availability: own (all, PRIVATE included) + the
    // pantries of ACTIVE connections that grant ME `pantry` and are VISIBLE to
    // the circle they placed me in (REWORK P4). Nothing else.
    const conns = await activeConnectionsOf(db, H);
    const pantryCircleByHousehold = new Map(
      conns.filter((c) => c.theyGrant.pantry).map((c) => [c.counterpartyId, c.theirCircleId]),
    );
    const candidates = await db.pantry.findMany({
      where: {
        OR: [
          { householdId: H },
          ...(pantryCircleByHousehold.size
            ? [{ householdId: { in: [...pantryCircleByHousehold.keys()] } }]
            : []),
        ],
      },
      include: {
        household: { select: { name: true } },
        circles: { select: { circleId: true } },
      },
    });
    const pantries = candidates.filter((p) => {
      if (p.householdId === H) return true;
      const theirCircleId = pantryCircleByHousehold.get(p.householdId);
      if (theirCircleId === undefined) return false;
      if (p.visibility === 'ALL') return true;
      if (p.visibility === 'PRIVATE') return false;
      return p.circles.some((c) => c.circleId === theirCircleId); // SELECT
    });
    const pantryInfo = new Map(
      pantries.map((p) => [
        p.id,
        { name: p.name, householdName: p.household.name, own: p.householdId === H },
      ]),
    );

    // Match maps from the linked items (availability resolves only for these):
    //  - own lots match by the linked productId (products are per-household, D1)
    //  - counterparty lots match by the linked product's NORMALIZED NAME, the
    //    only bridge across the per-household product namespace.
    const ownProductToNames = new Map<string, Set<string>>(); // productId → normalizedName[]
    const counterpartyNameToNames = new Map<string, Set<string>>(); // normProductName → normalizedName[]
    for (const item of items) {
      const link = linkByName.get(item.normalizedName);
      if (!link) continue;
      const add = (map: Map<string, Set<string>>, key: string) => {
        const s = map.get(key) ?? new Set<string>();
        s.add(item.normalizedName);
        map.set(key, s);
      };
      add(ownProductToNames, link.productId);
      add(counterpartyNameToNames, normalizeIngredientName(link.productName));
    }

    // availability[normalizedName][pantryId] = row (summed across that pantry's lots)
    const avail = new Map<string, Map<string, AvailabilityRow>>();
    const haveLinked = ownProductToNames.size > 0 || counterpartyNameToNames.size > 0;
    if (haveLinked && pantryInfo.size > 0) {
      const lots = await db.lot.findMany({
        where: {
          excluded: false,
          receivedCount: { gt: 0 },
          unitCostCents: { not: null },
          productId: { not: null },
          restock: {
            status: 'FINALIZED',
            voidedAt: null,
            pantryId: { in: [...pantryInfo.keys()] },
          },
        },
        include: {
          product: { select: { name: true } },
          restock: { select: { pantryId: true, purchasedAt: true, pantry: { select: { householdId: true } } } },
        },
        orderBy: { restock: { purchasedAt: 'asc' } }, // oldest-first → first seen is the FIFO suggestion
      });

      for (const lot of lots) {
        const available = lot.remainingCount - lot.reservedCount;
        if (available <= 0) continue;
        const pantryId = lot.restock.pantryId;
        const info = pantryInfo.get(pantryId);
        if (!info) continue;
        // Own pantry → productId match; counterparty pantry → product-name match.
        const matchedNames = info.own
          ? ownProductToNames.get(lot.productId!)
          : counterpartyNameToNames.get(normalizeIngredientName(lot.product?.name ?? ''));
        if (!matchedNames) continue;
        for (const normalizedName of matchedNames) {
          let perPantry = avail.get(normalizedName);
          if (!perPantry) {
            perPantry = new Map();
            avail.set(normalizedName, perPantry);
          }
          const row = perPantry.get(pantryId);
          if (row) {
            row.available += available;
          } else {
            perPantry.set(pantryId, {
              pantryId,
              pantryName: info.name,
              householdName: info.householdName,
              own: info.own,
              available,
              suggestedLotId: lot.id, // lots are oldest-first, so this is FIFO-oldest
            });
          }
        }
      }
    }

    const dtos = items.map((item) => {
      const link = linkByName.get(item.normalizedName) ?? null;
      const perPantry = avail.get(item.normalizedName);
      const availability: AvailabilityRow[] = perPantry
        ? [...perPantry.values()].sort(
            (a, b) =>
              Number(b.own) - Number(a.own) ||
              a.householdName.localeCompare(b.householdName) ||
              a.pantryName.localeCompare(b.pantryName),
          )
        : [];
      return {
        id: item.id,
        title: item.title,
        normalizedName: item.normalizedName,
        unit: item.unit,
        amounts: item.amounts,
        category: item.category,
        checked: item.checked,
        manual: item.manual,
        sourceNote: item.sourceNote,
        link,
        availability,
      };
    });

    // Unchecked first, then category (nulls last, alpha), then title.
    dtos.sort(
      (a, b) =>
        Number(a.checked) - Number(b.checked) ||
        (a.category ?? '￿').localeCompare(b.category ?? '￿') ||
        a.title.localeCompare(b.title),
    );
    return dtos;
  }),

  /**
   * Generate list rows from the household's planned entries over [from, to]
   * (≤ 31 days). kind=item → one line; kind=recipe → its item ingredient lines,
   * each amount scaled by the instance's servings override; kind=note ignored.
   * Lines MERGE conservatively into the (normalizedName, unit) natural key, then
   * UPSERT: an existing row keeps its checked/manual/title and gains the fresh
   * amounts/sourceNote (and a learned category only if it had none); a new row
   * is created. NOTHING is ever deleted by generate.
   *
   * clientKey: accepted for API symmetry, but the real replay guard is the
   * natural-key upsert — re-running merges into the same rows and never
   * duplicates (the schema keeps no per-generation record to key a replay on).
   */
  generate: protectedProcedure
    .input(z.object({ from: dateSchema, to: dateSchema, clientKey: clientKeySchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      const span = dayDiff(input.from, input.to);
      if (!Number.isFinite(span) || span < 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'End date must not precede the start.' });
      }
      if (span > 30) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick a range of 31 days or fewer.' });
      }

      const entries = await db.planEntry.findMany({
        where: { householdId: H, date: { gte: input.from, lte: input.to } },
        include: {
          recipe: {
            select: {
              title: true,
              servings: true,
              ingredients: {
                where: { kind: 'item' },
                select: { amount: true, unit: true, text: true },
                orderBy: { position: 'asc' },
              },
            },
          },
        },
      });

      // Accumulate lines under the merge key.
      type Bucket = {
        normalizedName: string;
        unit: string;
        title: string; // first-seen original casing
        amounts: (string | null)[];
        sources: string[]; // ordered, de-duplicated provenance labels
      };
      const buckets = new Map<string, Bucket>();
      const push = (title: string, unit: string, amount: string | null, source: string) => {
        const normalizedName = normalizeIngredientName(title);
        if (!normalizedName) return;
        const key = `${normalizedName} ${unit}`;
        let b = buckets.get(key);
        if (!b) {
          b = { normalizedName, unit, title: title.trim(), amounts: [], sources: [] };
          buckets.set(key, b);
        }
        b.amounts.push(amount);
        if (source && !b.sources.includes(source)) b.sources.push(source);
      };

      for (const e of entries) {
        if (e.kind === 'note') continue;
        if (e.kind === 'item') {
          if (e.text) push(e.text, '', null, e.text.trim());
          continue;
        }
        // kind === 'recipe'
        const recipe = e.recipe;
        if (!recipe) continue; // deleted-recipe tombstone contributes nothing
        const factor =
          e.servingsOverride && recipe.servings ? e.servingsOverride / recipe.servings : 1;
        const label =
          factor !== 1 ? `${recipe.title} ×${formatQuantity(factor)}` : recipe.title;
        for (const ing of recipe.ingredients) {
          const amount = ing.amount ? scaleAmount(ing.amount, factor) : null;
          push(ing.text, normUnit(ing.unit), amount, label);
        }
      }

      // Learned categories for the names we're about to write.
      const normNames = [...new Set([...buckets.values()].map((b) => b.normalizedName))];
      const assignments = normNames.length
        ? await db.categoryAssignment.findMany({
            where: { householdId: H, normalizedName: { in: normNames } },
          })
        : [];
      const catByName = new Map(assignments.map((a) => [a.normalizedName, a.category]));

      return dbTransaction(async (tx) => {
        let added = 0;
        let updated = 0;
        for (const b of buckets.values()) {
          const amounts = mergeAmounts(b.amounts);
          const sourceNote = b.sources.length ? b.sources.join(' · ') : null;
          const learnedCategory = catByName.get(b.normalizedName) ?? null;
          const existing = await tx.shoppingItem.findUnique({
            where: {
              householdId_normalizedName_unit: {
                householdId: H,
                normalizedName: b.normalizedName,
                unit: b.unit,
              },
            },
          });
          if (existing) {
            await tx.shoppingItem.update({
              where: { id: existing.id },
              data: {
                amounts,
                sourceNote,
                // Only fill a category when the row has none — never overwrite a
                // user's manual choice (the learning moment is setCategory).
                ...(existing.category === null && learnedCategory
                  ? { category: learnedCategory }
                  : {}),
              },
            });
            updated++;
          } else {
            await tx.shoppingItem.create({
              data: {
                householdId: H,
                title: b.title,
                normalizedName: b.normalizedName,
                unit: b.unit,
                amounts,
                category: learnedCategory,
                checked: false,
                manual: false,
                sourceNote,
              },
            });
            added++;
          }
        }
        return { added, updated };
      });
    }),

  /**
   * Add a manual list item (H3): a whole-thing line, unit ''. 409 if that name
   * is already on the list (the row is there — tell the user, don't duplicate).
   */
  addManual: protectedProcedure
    .input(z.object({ title: z.string().trim().min(1).max(200), clientKey: clientKeySchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      const normalizedName = normalizeIngredientName(input.title);
      if (!normalizedName) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter something to add.' });
      }
      return dbTransaction(async (tx) => {
        if (input.clientKey) {
          const prior = await tx.shoppingItem.findUnique({ where: { clientKey: input.clientKey } });
          if (prior) {
            if (prior.householdId !== H) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
            }
            return { id: prior.id };
          }
        }
        const existing = await tx.shoppingItem.findUnique({
          where: { householdId_normalizedName_unit: { householdId: H, normalizedName, unit: '' } },
        });
        if (existing) {
          throw new TRPCError({ code: 'CONFLICT', message: "That's already on your list." });
        }
        const category = (
          await tx.categoryAssignment.findUnique({
            where: { householdId_normalizedName: { householdId: H, normalizedName } },
          })
        )?.category ?? null;
        const item = await tx.shoppingItem.create({
          data: {
            clientKey: input.clientKey ?? null,
            householdId: H,
            title: input.title,
            normalizedName,
            unit: '',
            category,
            manual: true,
            checked: false,
          },
        });
        return { id: item.id };
      });
    }),

  /** Check/uncheck an own-household item ("shop at home first", H2). */
  setChecked: protectedProcedure
    .input(z.object({ itemId: z.string().min(1), checked: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const item = await tx.shoppingItem.findUnique({ where: { id: input.itemId } });
        if (!item || item.householdId !== H) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
        }
        await tx.shoppingItem.update({ where: { id: item.id }, data: { checked: input.checked } });
        return { checked: input.checked };
      });
    }),

  /** Delete an own-household item (explicit removal — never silent, H2). */
  removeItem: protectedProcedure
    .input(z.object({ itemId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const item = await tx.shoppingItem.findUnique({ where: { id: input.itemId } });
        if (!item || item.householdId !== H) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
        }
        await tx.shoppingItem.delete({ where: { id: item.id } });
        return { ok: true };
      });
    }),

  /** Clear all checked-off items in one go (explicit bulk removal). */
  clearChecked: protectedProcedure.mutation(async ({ ctx }) => {
    requireCapability(ctx.user, 'editRecipes');
    const res = await db.shoppingItem.deleteMany({
      where: { householdId: ctx.user.householdId, checked: true },
    });
    return { removed: res.count };
  }),

  /**
   * Set (or clear) an item's grocery category. A non-null value ALSO learns it
   * for this household (CategoryAssignment upsert) — the explicit, never-silent
   * learning moment (PTE's per-user category memory). null clears the ROW's
   * category only; the learned memory is kept.
   */
  setCategory: protectedProcedure
    .input(
      z.object({
        itemId: z.string().min(1),
        category: z.string().trim().min(1).max(40).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'editRecipes');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const item = await tx.shoppingItem.findUnique({ where: { id: input.itemId } });
        if (!item || item.householdId !== H) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
        }
        await tx.shoppingItem.update({
          where: { id: item.id },
          data: { category: input.category },
        });
        if (input.category !== null) {
          await tx.categoryAssignment.upsert({
            where: {
              householdId_normalizedName: { householdId: H, normalizedName: item.normalizedName },
            },
            create: { householdId: H, normalizedName: item.normalizedName, category: input.category },
            update: { category: input.category },
          });
        }
        return { category: input.category };
      });
    }),
});
