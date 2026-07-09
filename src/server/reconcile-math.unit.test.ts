import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reconcileMath, type ReconcileMathLine } from './reconcile-math';

const line = (over: Partial<ReconcileMathLine> & Pick<ReconcileMathLine, 'stockId'>): ReconcileMathLine => ({
  lotId: 'lot1',
  pantryId: 'p1',
  liveCount: 0,
  liveReserved: 0,
  counted: 0,
  ...over,
});

test('exact match: no moves, no variances, no shortages', () => {
  const r = reconcileMath([line({ stockId: 's1', liveCount: 5, counted: 5 })]);
  assert.deepEqual(r, { moves: [], variances: [], shortages: [] });
});

test('pure shrink in one pantry is a negative variance', () => {
  const r = reconcileMath([line({ stockId: 's1', liveCount: 5, counted: 3 })]);
  assert.equal(r.moves.length, 0);
  assert.deepEqual(r.variances, [{ stockId: 's1', lotId: 'lot1', pantryId: 'p1', delta: -2 }]);
});

test('matched deficit/surplus of one lot becomes a derived move, no variance', () => {
  const r = reconcileMath([
    line({ stockId: 'sA', pantryId: 'pA', liveCount: 5, counted: 2 }),
    line({ stockId: 'sB', pantryId: 'pB', liveCount: 0, counted: 3 }),
  ]);
  assert.deepEqual(r.moves, [
    { lotId: 'lot1', fromStockId: 'sA', fromPantryId: 'pA', toStockId: 'sB', toPantryId: 'pB', quantity: 3 },
  ]);
  assert.equal(r.variances.length, 0);
});

test('partial offset: move covers the overlap, residual shrink stays visible', () => {
  const r = reconcileMath([
    line({ stockId: 'sA', pantryId: 'pA', liveCount: 10, counted: 3 }), // −7
    line({ stockId: 'sB', pantryId: 'pB', liveCount: 0, counted: 5 }), // +5
  ]);
  assert.deepEqual(r.moves.map((m) => m.quantity), [5]);
  assert.deepEqual(r.variances, [{ stockId: 'sA', lotId: 'lot1', pantryId: 'pA', delta: -2 }]);
});

test('three pantries pair deterministically by pantryId order', () => {
  const r = reconcileMath([
    line({ stockId: 's3', pantryId: 'p3', liveCount: 0, counted: 4 }), // +4
    line({ stockId: 's1', pantryId: 'p1', liveCount: 6, counted: 0 }), // −6
    line({ stockId: 's2', pantryId: 'p2', liveCount: 0, counted: 2 }), // +2
  ]);
  assert.deepEqual(
    r.moves.map((m) => [m.fromPantryId, m.toPantryId, m.quantity]),
    [
      ['p1', 'p2', 2],
      ['p1', 'p3', 4],
    ],
  );
  assert.equal(r.variances.length, 0);
});

test('different lots never pair — each keeps its own variance', () => {
  const r = reconcileMath([
    line({ stockId: 'sA', lotId: 'lotA', pantryId: 'pA', liveCount: 5, counted: 2 }),
    line({ stockId: 'sB', lotId: 'lotB', pantryId: 'pB', liveCount: 0, counted: 3 }),
  ]);
  assert.equal(r.moves.length, 0);
  assert.equal(r.variances.length, 2);
});

test('noMoveLots rejects the pairing: decomposes into two variances', () => {
  const r = reconcileMath(
    [
      line({ stockId: 'sA', pantryId: 'pA', liveCount: 5, counted: 2 }),
      line({ stockId: 'sB', pantryId: 'pB', liveCount: 0, counted: 3 }),
    ],
    { noMoveLots: new Set(['lot1']) },
  );
  assert.equal(r.moves.length, 0);
  assert.deepEqual(
    r.variances.map((v) => v.delta).sort(),
    [-3, 3],
  );
});

test('shortage: counted below live reservations is flagged, independent of moves', () => {
  const r = reconcileMath([
    line({ stockId: 'sA', pantryId: 'pA', liveCount: 5, liveReserved: 4, counted: 3 }),
    line({ stockId: 'sB', pantryId: 'pB', liveCount: 0, counted: 2 }),
  ]);
  assert.deepEqual(r.shortages, [
    { stockId: 'sA', lotId: 'lot1', pantryId: 'pA', counted: 3, liveReserved: 4 },
  ]);
  // The move math still ran (2 of the missing units were found in pB).
  assert.equal(r.moves.length, 1);
});

test('counted-zero everywhere: full shrink variance per placement', () => {
  const r = reconcileMath([
    line({ stockId: 'sA', pantryId: 'pA', liveCount: 3, counted: 0 }),
    line({ stockId: 'sB', pantryId: 'pB', liveCount: 2, counted: 0 }),
  ]);
  assert.equal(r.moves.length, 0);
  assert.deepEqual(r.variances.map((v) => v.delta), [-3, -2]);
});

test('negative counted throws (guarded upstream by zod, belt here)', () => {
  assert.throws(() => reconcileMath([line({ stockId: 's1', counted: -1 })]));
});

test('PURITY: the module is client-importable — no runtime imports, no server/env/clock access', () => {
  // reconcile-view.tsx imports this module so the review preview matches the
  // commit byte-for-byte. Anything below would break the client bundle or
  // drag server code toward it; adding a dependency here means splitting the
  // module, not weakening this test.
  const source = readFileSync(fileURLToPath(new URL('./reconcile-math.ts', import.meta.url)), 'utf8');
  const runtimeImports = source
    .split('\n')
    .filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
  assert.deepEqual(runtimeImports, [], 'no runtime imports allowed');
  for (const banned of ['require(', 'process.', 'node:', 'Date.now', 'Math.random', 'globalThis']) {
    assert.ok(!source.includes(banned), `banned reference in reconcile-math.ts: ${banned}`);
  }
});
