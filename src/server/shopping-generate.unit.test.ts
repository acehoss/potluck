import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketPlanEntries, type EntryForBucketing } from './shopping-generate';

/** A recipe plan entry with the given ingredient item lines. */
function recipeEntry(
  id: string,
  ingredients: { amount: string | null; unit: string | null; text: string }[],
  opts: { servings?: number | null; servingsOverride?: number | null; title?: string } = {},
): EntryForBucketing {
  return {
    id,
    kind: 'recipe',
    text: null,
    servingsOverride: opts.servingsOverride ?? null,
    recipe: {
      title: opts.title ?? 'Soup',
      servings: opts.servings ?? null,
      ingredients,
    },
  };
}

test('bucketPlanEntries: a recipe entry buckets its item ingredients and is consumed', () => {
  const { buckets, consumedEntryIds } = bucketPlanEntries([
    recipeEntry('e1', [
      { amount: '2', unit: 'cups', text: 'Flour' },
      { amount: '1', unit: null, text: 'Onion' },
    ]),
  ]);
  assert.deepEqual(consumedEntryIds, ['e1']);
  // Keyed by (normalizedName, unit); '' unit for the onion.
  const flour = buckets.get('flour cups');
  const onion = buckets.get('onion ');
  assert.ok(flour, 'flour bucket');
  assert.ok(onion, 'onion bucket');
  assert.deepEqual(flour!.amounts, ['2']);
  assert.equal(flour!.unit, 'cups');
});

test('bucketPlanEntries: same (name, unit) across entries accumulates amounts', () => {
  const { buckets } = bucketPlanEntries([
    recipeEntry('e1', [{ amount: '2', unit: 'cups', text: 'Flour' }]),
    recipeEntry('e2', [{ amount: '1', unit: 'cups', text: 'flour' }]),
  ]);
  const flour = buckets.get('flour cups');
  assert.ok(flour);
  assert.deepEqual(flour!.amounts, ['2', '1']); // caller merges these to "3"
});

test('bucketPlanEntries: different units never combine', () => {
  const { buckets } = bucketPlanEntries([
    recipeEntry('e1', [
      { amount: '2', unit: 'cups', text: 'Flour' },
      { amount: '100', unit: 'g', text: 'Flour' },
    ]),
  ]);
  assert.ok(buckets.get('flour cups'));
  assert.ok(buckets.get('flour g'));
  assert.equal(buckets.size, 2);
});

test('bucketPlanEntries: servingsOverride scales the amounts', () => {
  const { buckets } = bucketPlanEntries([
    recipeEntry('e1', [{ amount: '2', unit: 'cups', text: 'Flour' }], {
      servings: 4,
      servingsOverride: 8,
    }),
  ]);
  const flour = buckets.get('flour cups');
  assert.ok(flour);
  assert.deepEqual(flour!.amounts, ['4']); // 2 × (8/4)
});

test('bucketPlanEntries: item kind contributes a unit-less line, note kind ignored', () => {
  const { buckets, consumedEntryIds } = bucketPlanEntries([
    { id: 'i1', kind: 'item', text: 'Paper towels', servingsOverride: null, recipe: null },
    { id: 'n1', kind: 'note', text: 'buy soon', servingsOverride: null, recipe: null },
  ]);
  assert.deepEqual(consumedEntryIds, []); // only recipe entries are "consumed"
  assert.ok(buckets.get('paper towels '));
  assert.equal(buckets.size, 1);
});

test('bucketPlanEntries: a deleted-recipe tombstone contributes nothing and is not consumed', () => {
  const { buckets, consumedEntryIds } = bucketPlanEntries([
    { id: 't1', kind: 'recipe', text: null, servingsOverride: null, recipe: null },
  ]);
  assert.equal(buckets.size, 0);
  assert.deepEqual(consumedEntryIds, []);
});
