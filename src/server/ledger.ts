import { db } from './db';

/**
 * Net position per counterparty household (blueprint 01): what each `them`
 * owes `me` in cents — positive = they owe you. One pass over every entry
 * involving `me`; antisymmetry is by construction (single table, symmetric
 * predicate), and at 2–10 households the ledger is small enough to fold in
 * JS rather than raw SQL.
 */
export async function netByCounterparty(me: string) {
  const entries = await db.ledgerEntry.findMany({
    where: { OR: [{ creditorHouseholdId: me }, { debtorHouseholdId: me }] },
    select: { creditorHouseholdId: true, debtorHouseholdId: true, amountCents: true },
  });
  const net = new Map<string, number>();
  for (const e of entries) {
    const iAmCreditor = e.creditorHouseholdId === me;
    const them = iAmCreditor ? e.debtorHouseholdId : e.creditorHouseholdId;
    net.set(them, (net.get(them) ?? 0) + (iAmCreditor ? e.amountCents : -e.amountCents));
  }
  return net;
}

/**
 * The unreversed RESTOCK_CREDIT among a restock's ledger rows, or null. A
 * restock corrected by the correct-credit op (blueprint 01 Immutability +
 * invariant 5) carries the reversed original credit AND its replacement —
 * both with the same `restockId` for the audit trail — so any read of "the
 * live credit" must pick the entry no REVERSAL points at, never "whichever
 * row SQLite yields first". Pure so both the global-`db` reader below and the
 * in-transaction correct-credit path (`restock.correctCredit`) share it.
 */
export function pickActiveRestockCredit<
  T extends { id: string; type: string; reversesId: string | null; createdAt: Date },
>(entries: T[]): T | null {
  const reversedIds = new Set(
    entries.filter((e) => e.type === 'REVERSAL' && e.reversesId).map((e) => e.reversesId),
  );
  return (
    entries
      .filter((e) => e.type === 'RESTOCK_CREDIT' && !reversedIds.has(e.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  );
}

/** Convenience reader for display paths (restock.get, etc.). */
export async function getActiveRestockCredit(restockId: string) {
  const entries = await db.ledgerEntry.findMany({ where: { restockId } });
  return pickActiveRestockCredit(entries);
}
