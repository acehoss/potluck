/**
 * Enum-ish string unions (SQLite has no native enums; blueprint 01).
 * Validated by zod at the tRPC boundary.
 */

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
