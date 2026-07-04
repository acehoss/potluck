import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apportionFifo, defaultExpiresAt, MAX_EXPIRY_MS } from './shares';

test('apportionFifo: draws oldest-first until the need is met', () => {
  assert.deepEqual(apportionFifo([5, 5, 5], 7), [5, 2, 0]);
});

test('apportionFifo: a fully covered need stops early', () => {
  assert.deepEqual(apportionFifo([10, 3], 4), [4, 0]);
});

test('apportionFifo: exact fit takes exactly what each lot has', () => {
  assert.deepEqual(apportionFifo([2, 3, 4], 9), [2, 3, 4]);
});

test('apportionFifo: a shortfall is visible as a total below need', () => {
  const taken = apportionFifo([2, 1], 10);
  assert.deepEqual(taken, [2, 1]);
  assert.equal(
    taken.reduce((s, t) => s + t, 0),
    3,
    'caller detects 3 < 10 as a shortfall',
  );
});

test('apportionFifo: skips depleted lots (zero availability)', () => {
  assert.deepEqual(apportionFifo([0, 0, 6], 4), [0, 0, 4]);
});

test('apportionFifo: a zero/negative need draws nothing', () => {
  assert.deepEqual(apportionFifo([5, 5], 0), [0, 0]);
  assert.deepEqual(apportionFifo([5, 5], -3), [0, 0]);
});

test('defaultExpiresAt: surplus is +3 days, need is +14 days', () => {
  const now = new Date('2026-07-04T12:00:00.000Z');
  assert.equal(defaultExpiresAt('SURPLUS', now).toISOString(), '2026-07-07T12:00:00.000Z');
  assert.equal(defaultExpiresAt('NEED', now).toISOString(), '2026-07-18T12:00:00.000Z');
});

test('defaultExpiresAt: both defaults sit within the 60-day cap', () => {
  const now = new Date('2026-07-04T12:00:00.000Z');
  for (const type of ['SURPLUS', 'NEED'] as const) {
    assert.ok(defaultExpiresAt(type, now).getTime() - now.getTime() <= MAX_EXPIRY_MS);
  }
});
