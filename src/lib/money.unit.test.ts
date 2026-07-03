import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocateReceipt, reconcileVariance } from './domain';
import { apportionCents } from './money';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

test('apportionCents: parts sum EXACTLY to the total', () => {
  const parts = apportionCents(172, [1000, 500, 899]);
  assert.equal(sum(parts), 172);
});

test('apportionCents: leftover pennies go to the largest remainders', () => {
  // 100¢ across three equal weights → 34/33/33 (first gets the extra penny).
  assert.deepEqual(apportionCents(100, [1, 1, 1]), [34, 33, 33]);
});

test('apportionCents: proportional to weight', () => {
  // 300¢ split 3:1 → 225/75.
  assert.deepEqual(apportionCents(300, [3, 1]), [225, 75]);
});

test('apportionCents: zero-weight lines never receive cents', () => {
  const parts = apportionCents(99, [0, 100, 0]);
  assert.deepEqual(parts, [0, 99, 0]);
});

test('apportionCents: zero total and empty weights', () => {
  assert.deepEqual(apportionCents(0, [10, 20]), [0, 0]);
  assert.deepEqual(apportionCents(500, []), []);
  assert.deepEqual(apportionCents(500, [0, 0]), [0, 0]);
});

test('reconcileVariance: tax + fees close the gap a bare line-sum would leave', () => {
  // Lines $70.12 - tax $1.72 already in receipt total $70.12? Use a clean case:
  // lines 6840, tax 172, fees 0, receipt 7012 → variance 0.
  assert.equal(reconcileVariance(7012, 6840, 172, 0), 0);
  // Without tax entered, the same receipt reads "$1.72 short".
  assert.equal(reconcileVariance(7012, 6840, null, null), 172);
  assert.equal(reconcileVariance(null, 6840, 172, 0), null);
});

test('allocateReceipt: tax lands only on taxable lines, folded into unit cost', () => {
  // Two lines $10.00 (taxable) and $5.00 (non-taxable), tax $0.90, no fees.
  const alloc = allocateReceipt(
    [
      { lineTotalCents: 1000, purchasedCount: 1, taxable: true, excluded: false },
      { lineTotalCents: 500, purchasedCount: 1, taxable: false, excluded: false },
    ],
    90,
    0,
    false,
  );
  // All tax (weight is all on the one taxable line) → 90¢ onto line 0.
  assert.equal(alloc[0].taxCentsAllocated, 90);
  assert.equal(alloc[1].taxCentsAllocated, 0);
  assert.equal(alloc[0].unitCostCents, 1090); // $10.00 + $0.90 tax
  assert.equal(alloc[1].unitCostCents, 500);
});

test('allocateReceipt: tax splits pro-rata across two taxable lines', () => {
  const alloc = allocateReceipt(
    [
      { lineTotalCents: 1000, purchasedCount: 4, taxable: true, excluded: false },
      { lineTotalCents: 1000, purchasedCount: 4, taxable: true, excluded: false },
    ],
    101, // odd — one line gets the leftover penny
    0,
    false,
  );
  assert.equal(alloc[0].taxCentsAllocated + alloc[1].taxCentsAllocated, 101);
  assert.deepEqual(
    [alloc[0].taxCentsAllocated, alloc[1].taxCentsAllocated].sort((a, b) => a - b),
    [50, 51],
  );
});

test('allocateReceipt: excluded line carries tax/fee share but gets no unit cost', () => {
  const alloc = allocateReceipt(
    [
      { lineTotalCents: 5000, purchasedCount: 0, taxable: true, excluded: true }, // personal, taxed
      { lineTotalCents: 5000, purchasedCount: 5, taxable: true, excluded: false }, // coop
    ],
    200,
    0,
    false,
  );
  assert.equal(alloc[0].unitCostCents, null); // excluded → no inventory cost
  assert.equal(alloc[0].taxCentsAllocated, 100); // still absorbs its half of tax
  assert.equal(alloc[1].taxCentsAllocated, 100);
  assert.equal(alloc[1].unitCostCents, 1020); // (5000 + 100) / 5
});

test('allocateReceipt: fees only distributed when opted in, across ALL lines', () => {
  const lots = [
    { lineTotalCents: 5000, purchasedCount: 5, taxable: false, excluded: true }, // personal
    { lineTotalCents: 5000, purchasedCount: 5, taxable: false, excluded: false }, // coop
  ];
  const off = allocateReceipt(lots, 0, 1000, false);
  assert.equal(off[0].feeCentsAllocated, 0);
  assert.equal(off[1].feeCentsAllocated, 0);
  assert.equal(off[1].unitCostCents, 1000); // fee eaten by purchaser

  const on = allocateReceipt(lots, 0, 1000, true);
  // $10 fee split 50/50; the coop line only bears its $5 share, not the whole.
  assert.equal(on[0].feeCentsAllocated, 500);
  assert.equal(on[1].feeCentsAllocated, 500);
  assert.equal(on[1].unitCostCents, 1100); // (5000 + 500) / 5
});
