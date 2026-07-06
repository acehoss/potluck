/**
 * Shared shopping-list generation core (round S). Extracted from
 * shopping.generate so the range generator AND the new single-entry
 * shopping.addFromEntry fold plan entries into the list through EXACTLY the same
 * scale/bucket/upsert path — no duplicated merge logic that could drift.
 *
 * Two pieces:
 *  - bucketPlanEntries — PURE (no db, unit-testable): folds plan entries into
 *    (normalizedName, unit) merge buckets and reports which recipe entries it
 *    consumed (the ones to stamp addedToShoppingAt).
 *  - upsertBuckets — writes those buckets into a household's list inside a caller
 *    -owned transaction, honoring H2's never-silently-remove / conservative-merge
 *    rules (UPSERT on the natural key; only fill a category the row lacks).
 */

import type { Prisma } from '@/generated/prisma/client';
import { formatQuantity, mergeAmounts, scaleAmount } from './plan-scale';
import { normalizeIngredientName } from './recipe-parse';

/** Store the ''-normalized unit exactly as the merge key uses it. */
function normUnit(unit: string | null | undefined): string {
  return (unit ?? '').trim();
}

/**
 * The Prisma include both generate and addFromEntry use to load the item
 * ingredient lines a plan entry contributes. Shared so the two call sites can
 * never disagree on which ingredients feed the list.
 */
export const planEntryRecipeInclude = {
  recipe: {
    select: {
      title: true,
      servings: true,
      ingredients: {
        where: { kind: 'item' as const },
        select: { amount: true, unit: true, text: true },
        orderBy: { position: 'asc' as const },
      },
    },
  },
} satisfies Prisma.PlanEntryInclude;

/** The minimal plan-entry shape bucketPlanEntries reads (a superset of the
 * planEntryRecipeInclude query result). */
export type EntryForBucketing = {
  id: string;
  kind: string;
  text: string | null;
  servingsOverride: number | null;
  recipe: {
    title: string;
    servings: number | null;
    ingredients: { amount: string | null; unit: string | null; text: string }[];
  } | null;
};

type Bucket = {
  normalizedName: string;
  unit: string;
  title: string; // first-seen original casing
  amounts: (string | null)[];
  sources: string[]; // ordered, de-duplicated provenance labels
};

/**
 * Fold plan entries into merge buckets keyed by (normalizedName, unit). kind=item
 * → one line; kind=recipe → its item ingredient lines each scaled by the entry's
 * servings override; kind=note ignored. Returns the buckets AND the ids of the
 * recipe entries that actually contributed (a live recipe present) — the entries
 * generation "consumed" and whose addedToShoppingAt the caller stamps. A
 * deleted-recipe tombstone (kind=recipe, recipe null) contributes nothing and is
 * NOT reported as consumed.
 */
export function bucketPlanEntries(entries: EntryForBucketing[]): {
  buckets: Map<string, Bucket>;
  consumedEntryIds: string[];
} {
  const buckets = new Map<string, Bucket>();
  const consumedEntryIds: string[] = [];
  const push = (title: string, unit: string, amount: string | null, source: string) => {
    const normalizedName = normalizeIngredientName(title);
    if (!normalizedName) return;
    const key = `${normalizedName} ${unit}`;
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
    consumedEntryIds.push(e.id);
    const factor =
      e.servingsOverride && recipe.servings ? e.servingsOverride / recipe.servings : 1;
    const label = factor !== 1 ? `${recipe.title} ×${formatQuantity(factor)}` : recipe.title;
    for (const ing of recipe.ingredients) {
      const amount = ing.amount ? scaleAmount(ing.amount, factor) : null;
      push(ing.text, normUnit(ing.unit), amount, label);
    }
  }

  return { buckets, consumedEntryIds };
}

/**
 * Write buckets into a household's shopping list inside the caller's
 * transaction. H2 rules: UPSERT on the (household, normalizedName, unit) natural
 * key — an existing row keeps its checked/manual/title and gains the fresh
 * amounts/sourceNote (and a learned category only if it had none); a new row is
 * created. Nothing is ever deleted here. Returns the added/updated counts.
 */
export async function upsertBuckets(
  tx: Prisma.TransactionClient,
  householdId: string,
  buckets: Map<string, Bucket>,
): Promise<{ added: number; updated: number }> {
  // Learned categories for the names we're about to write.
  const normNames = [...new Set([...buckets.values()].map((b) => b.normalizedName))];
  const assignments = normNames.length
    ? await tx.categoryAssignment.findMany({
        where: { householdId, normalizedName: { in: normNames } },
      })
    : [];
  const catByName = new Map(assignments.map((a) => [a.normalizedName, a.category]));

  let added = 0;
  let updated = 0;
  for (const b of buckets.values()) {
    const amounts = mergeAmounts(b.amounts);
    const sourceNote = b.sources.length ? b.sources.join(' · ') : null;
    const learnedCategory = catByName.get(b.normalizedName) ?? null;
    const existing = await tx.shoppingItem.findUnique({
      where: {
        householdId_normalizedName_unit: {
          householdId,
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
          householdId,
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
}
