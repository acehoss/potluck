import { db } from './db';
import { notify } from './push';

/**
 * Phase 4 Round 4: transactional notification outbox. A mutation whose
 * transaction makes a notification NECESSARY (first consumer: reconcile
 * commit reducing/canceling a neighbor's order line) writes a NotifyOutbox
 * row inside that same transaction, then calls drainNotifyOutbox() after it
 * commits. If the process dies in between, the in-process scheduler's tick
 * drains the leftovers — the notice is late, never lost. Rows that fail
 * MAX_ATTEMPTS deliveries stay unsent-but-parked so one poisoned payload
 * can't wedge the drain.
 *
 * SCOPE: the outbox closes the crash window between commit and send. Actual
 * delivery reliability is notify()'s semantics — it treats channel failures
 * (push endpoint gone, mail down) as non-fatal by design, same as every
 * other notification in the app. If notify() ever grows a strict result
 * contract, deliver() should propagate it so attempts can retry real
 * channel failures too.
 */

const MAX_ATTEMPTS = 10;

type ReconcileShortagePayload = {
  orderId: string;
  requesterHouseholdId: string;
  actorId: string;
};

async function deliver(row: { kind: string; payload: string }): Promise<void> {
  if (row.kind === 'reconcile-shortage') {
    const p = JSON.parse(row.payload) as ReconcileShortagePayload;
    // Category-only content (N4): no counterparty name, no quantities.
    await notify({
      recipientHouseholdIds: [p.requesterHouseholdId],
      excludeUserId: p.actorId,
      category: 'pickups',
      url: `/orders/${p.orderId}`,
      title: 'An order changed',
      body: 'A pantry recount affected your order.',
    });
    return;
  }
  throw new Error(`unknown outbox kind: ${row.kind}`);
}

export async function drainNotifyOutbox(limit = 20): Promise<number> {
  const rows = await db.notifyOutbox.findMany({
    where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let sent = 0;
  for (const row of rows) {
    // Optimistic claim: two drains can run concurrently (post-commit + the
    // scheduler tick); the attempts bump doubles as a claim version so a row
    // is delivered once. A crash after the claim leaves the row unsent with
    // attempts+1 — retried by a later drain, parked after MAX_ATTEMPTS.
    const claimed = await db.notifyOutbox.updateMany({
      where: { id: row.id, sentAt: null, attempts: row.attempts },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;
    try {
      await deliver(row);
      await db.notifyOutbox.update({ where: { id: row.id }, data: { sentAt: new Date() } });
      sent += 1;
    } catch (err) {
      console.warn('[notify-outbox] delivery failed:', err instanceof Error ? err.message : err);
    }
  }
  return sent;
}
