import { db } from './db';

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
