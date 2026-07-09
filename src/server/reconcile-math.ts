/**
 * PURITY CONTRACT: this module is imported by CLIENT code (the reconcile
 * review preview renders exactly what commit will compute) as well as the
 * server. It must stay dependency-free — no imports, no db, no env access,
 * no clock or randomness. The purity case in reconcile-math.unit.test.ts
 * fails the suite if someone adds any of those.
 *
 * Phase 4 Round 3 (REWORK S6/A6): the reconcile commit's conservation math,
 * pure so it is unit-testable. Counts are taken WHERE FOUND; at commit, for
 * each lot, matched deficits/surpluses across in-scope pantries decompose
 * into DERIVED transfers ("moved 5 kitchen→garage") and only the residual is
 * a true variance (short/found). The committer may reject a lot's pairing
 * (noMoveLots), decomposing it back into two acknowledged variances — a
 * coincidental same-lot offset must not launder real shrink.
 *
 * The math runs on LIVE stock values, not scope-entry baselines: the freeze
 * lets reserved pickups through (they shift count and reserved together), so
 * live values are the correct "app thinks" side of every delta. Shortage
 * detection (counted < liveReserved) is independent of move derivation —
 * commit is blocked until each shortage is explicitly resolved (A7).
 *
 * Deterministic: lines are processed per lot sorted by pantryId, deficits and
 * surpluses greedily paired in that order. No randomness, no clock.
 */

export type ReconcileMathLine = {
  stockId: string;
  lotId: string;
  pantryId: string;
  liveCount: number;
  liveReserved: number;
  counted: number;
};

export type DerivedMove = {
  lotId: string;
  fromStockId: string;
  fromPantryId: string;
  toStockId: string;
  toPantryId: string;
  quantity: number;
};

/** delta = counted − liveCount AFTER derived moves are accounted for. */
export type ReconcileVariance = {
  stockId: string;
  lotId: string;
  pantryId: string;
  delta: number;
};

export type ReconcileShortage = {
  stockId: string;
  lotId: string;
  pantryId: string;
  counted: number;
  liveReserved: number;
};

export type ReconcileMathResult = {
  moves: DerivedMove[];
  variances: ReconcileVariance[];
  shortages: ReconcileShortage[];
};

export function reconcileMath(
  lines: ReconcileMathLine[],
  opts: { noMoveLots?: ReadonlySet<string> } = {},
): ReconcileMathResult {
  const noMove = opts.noMoveLots ?? new Set<string>();
  const moves: DerivedMove[] = [];
  const variances: ReconcileVariance[] = [];
  const shortages: ReconcileShortage[] = [];

  const byLot = new Map<string, ReconcileMathLine[]>();
  for (const line of lines) {
    if (line.counted < 0) throw new Error(`negative count for stock ${line.stockId}`);
    const group = byLot.get(line.lotId);
    if (group) group.push(line);
    else byLot.set(line.lotId, [line]);
    if (line.counted < line.liveReserved) {
      shortages.push({
        stockId: line.stockId,
        lotId: line.lotId,
        pantryId: line.pantryId,
        counted: line.counted,
        liveReserved: line.liveReserved,
      });
    }
  }

  for (const [lotId, group] of [...byLot.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...group].sort((a, b) => a.pantryId.localeCompare(b.pantryId));
    const residual = new Map<string, number>(); // stockId → remaining delta
    for (const line of sorted) residual.set(line.stockId, line.counted - line.liveCount);

    if (!noMove.has(lotId) && sorted.length > 1) {
      const deficits = sorted.filter((l) => residual.get(l.stockId)! < 0);
      const surpluses = sorted.filter((l) => residual.get(l.stockId)! > 0);
      for (const deficit of deficits) {
        for (const surplus of surpluses) {
          const need = -residual.get(deficit.stockId)!;
          const have = residual.get(surplus.stockId)!;
          if (need <= 0) break;
          if (have <= 0) continue;
          const quantity = Math.min(need, have);
          moves.push({
            lotId,
            fromStockId: deficit.stockId,
            fromPantryId: deficit.pantryId,
            toStockId: surplus.stockId,
            toPantryId: surplus.pantryId,
            quantity,
          });
          residual.set(deficit.stockId, residual.get(deficit.stockId)! + quantity);
          residual.set(surplus.stockId, have - quantity);
        }
      }
    }

    for (const line of sorted) {
      const delta = residual.get(line.stockId)!;
      if (delta !== 0) {
        variances.push({ stockId: line.stockId, lotId, pantryId: line.pantryId, delta });
      }
    }
  }

  return { moves, variances, shortages };
}
