/** Shared client-side date helpers for the lending screens. */

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Local calendar MM/DD for real timestamps (outAt/returnedAt) — same
 * convention as the ledger rows (an 8pm CDT checkout must read as today).
 */
export function localShortDate(iso: string) {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/**
 * MM/DD for date-only values (dueAt is stored as UTC midnight, so the UTC
 * parts ARE the calendar date — the same rule as best-by badges).
 */
export function dueShortDate(iso: string) {
  const d = new Date(iso);
  return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`;
}

/**
 * A loan is overdue once its due DATE is before today's local date — a pure
 * render-time comparison (blueprint kills loan-due schedulers/push in v1).
 * Due "today" is not overdue yet.
 */
export function isOverdue(dueAtIso: string | null) {
  if (!dueAtIso) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return dueAtIso.slice(0, 10) < today;
}
