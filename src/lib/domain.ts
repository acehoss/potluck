/**
 * Enum-ish string unions (SQLite has no native enums; blueprint 01).
 * Validated by zod at the tRPC boundary.
 */

import { apportionCents } from './money';

export const RESTOCK_STATUSES = ['DRAFT', 'FINALIZED'] as const;
export type RestockStatus = (typeof RESTOCK_STATUSES)[number];

/**
 * D7 reconciliation auto-pass threshold: |variance| ≤ 2¢ × lineCount.
 */
export function varianceAutoPasses(varianceCents: number, lineCount: number) {
  return Math.abs(varianceCents) <= 2 * lineCount;
}

/** D1: unit cost frozen at finalize, half-up rounding. */
export function unitCostCents(lineTotalCents: number, purchasedCount: number) {
  return Math.round(lineTotalCents / purchasedCount);
}

/**
 * Reconcile variance (D7, tax/fee aware): what the receipt total exceeds the
 * accounted-for amount by. The accounted amount is every line's printed total
 * plus the entered tax and fees, so once tax/fees are entered a taxed receipt
 * reconciles to ~0 instead of always reading "short". Null when no receipt
 * total was entered.
 */
export function reconcileVariance(
  receiptTotalCents: number | null,
  lineSumCents: number,
  taxCents: number | null,
  feesCents: number | null,
) {
  if (receiptTotalCents === null) return null;
  return receiptTotalCents - (lineSumCents + (taxCents ?? 0) + (feesCents ?? 0));
}

export type AllocationLot = {
  lineTotalCents: number;
  purchasedCount: number;
  taxable: boolean;
  excluded: boolean;
};

export type LotAllocation = {
  taxCentsAllocated: number;
  feeCentsAllocated: number;
  /** null for an excluded (non-inventory) line. */
  unitCostCents: number | null;
};

/**
 * Fold receipt tax and (optionally) fees into each lot's landed cost, in the
 * same order as `lots`. Tax is apportioned across taxable lines by pre-tax line
 * total; fees across ALL lines (incl. held-back and excluded) when distributed,
 * else zero (the purchaser eats them). Each lot's unit cost is then
 * `roundHalfUp((lineTotal + taxShare + feeShare) / purchasedCount)` — the D1
 * freeze, now tax-inclusive, so every take and credit is truly at cost.
 * Excluded lines carry their tax/fee share (the purchaser's own cost) but get
 * no unit cost — they never become inventory.
 */
export function allocateReceipt(
  lots: AllocationLot[],
  taxCents: number | null,
  feesCents: number | null,
  feesDistributed: boolean,
): LotAllocation[] {
  const taxShares = apportionCents(
    taxCents ?? 0,
    lots.map((l) => (l.taxable ? l.lineTotalCents : 0)),
  );
  const feeShares = feesDistributed
    ? apportionCents(feesCents ?? 0, lots.map((l) => l.lineTotalCents))
    : lots.map(() => 0);
  return lots.map((l, i) => {
    const effectiveTotal = l.lineTotalCents + taxShares[i] + feeShares[i];
    return {
      taxCentsAllocated: taxShares[i],
      feeCentsAllocated: feeShares[i],
      unitCostCents:
        l.excluded || l.purchasedCount <= 0 ? null : unitCostCents(effectiveTotal, l.purchasedCount),
    };
  });
}

export function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/** Display code for a finalized restock, e.g. "260702-01". */
export function restockCode(dateCode: string, seq: number) {
  return `${dateCode}-${pad2(seq)}`;
}

/**
 * D6: dateCode from the receipt date. Dates are stored as UTC midnight
 * (date-only input), so the UTC date parts are the coop-local calendar date.
 */
export function dateCodeFor(purchasedAt: Date) {
  const y = purchasedAt.getUTCFullYear() % 100;
  return `${pad2(y)}${pad2(purchasedAt.getUTCMonth() + 1)}${pad2(purchasedAt.getUTCDate())}`;
}
