/**
 * Pure helpers for Round 2 needs & surpluses (REWORK F). No db, no I/O — kept
 * separate from the router so the money-adjacent bits (FIFO gift apportionment,
 * expiry defaults) are unit-testable in isolation.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Expiry may never be set further out than this (F1 hygiene). */
export const MAX_EXPIRY_MS = 60 * DAY_MS;

/** Default expiry when the poster doesn't pick one: SURPLUS +3d, NEED +14d (F1). */
export function defaultExpiresAt(type: 'NEED' | 'SURPLUS', now: Date): Date {
  return new Date(now.getTime() + (type === 'SURPLUS' ? 3 : 14) * DAY_MS);
}

/**
 * FIFO apportionment for a share gift: given each linked lot's current
 * availability in draw order (oldest purchase first), how many units come from
 * each to cover `need`. The caller sums the result and compares to `need` — a
 * total below `need` means the linked lots no longer cover the claim (the whole
 * confirm rolls back). Never returns a negative or over-draw per lot.
 */
export function apportionFifo(availabilities: number[], need: number): number[] {
  const taken: number[] = [];
  let left = Math.max(0, need);
  for (const avail of availabilities) {
    const t = Math.max(0, Math.min(left, avail));
    taken.push(t);
    left -= t;
  }
  return taken;
}
