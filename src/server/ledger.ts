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
 * The live RESTOCK_CREDIT for a restock. Once the slice-3/4 correct-credit op
 * exists, a corrected restock carries the reversed original credit plus its
 * replacement — both with the same `restockId` (blueprint 01, invariant 5) —
 * so display reads must pick the unreversed entry, never "whichever row
 * SQLite yields first".
 */
export async function getActiveRestockCredit(restockId: string) {
  const entries = await db.ledgerEntry.findMany({ where: { restockId } });
  const reversedIds = new Set(
    entries.filter((e) => e.type === 'REVERSAL' && e.reversesId).map((e) => e.reversesId),
  );
  return (
    entries
      .filter((e) => e.type === 'RESTOCK_CREDIT' && !reversedIds.has(e.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  );
}
