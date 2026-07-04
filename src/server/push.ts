import webpush from 'web-push';
import { formatCents } from '@/lib/money';
import { db } from './db';
import { isAllowedPushEndpoint } from './push-endpoint';

/**
 * Web push sender (blueprint 04 §4). Exactly two events in v1 — settlement
 * recorded and manual ledger adjustment posted — sent to every member of BOTH
 * involved households EXCEPT the creating user (matching the ledger "new"
 * marker semantics: the recorder's housemates are notified too).
 *
 * Sends are fire-and-forget AFTER the money transaction commits: a push
 * failure is logged and never fails the mutation. Subscriptions the push
 * service reports gone (404/410) are pruned — iOS silently drops them when
 * the PWA icon is deleted.
 *
 * VAPID keys come from the environment at runtime (no NEXT_PUBLIC_ inlining —
 * blueprint 04 §4 decision); when unset, push is disabled and the UI says so.
 */

function vapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  };
}


/** The runtime VAPID public key, or null when push is not configured. */
export function pushPublicKey(): string | null {
  return vapidConfig()?.publicKey ?? null;
}

export type PushPayload = { title: string; body: string; url: string };

/**
 * Send one payload to every subscription of the given users; prune dead rows.
 *
 * Uses web-push's `generateRequestDetails` (real VAPID signing + aes128gcm
 * payload encryption) but delivers via `fetch` rather than
 * `webpush.sendNotification`, which hardcodes node's `https` module and
 * refuses plain-http endpoints — the e2e suite's push sink (an in-app route
 * standing in for FCM/APNs, which headless browsers can't reach) lives on
 * http. Real push services are always https, so production behavior is
 * identical.
 */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  const config = vapidConfig();
  if (!config || userIds.length === 0) return;
  const subs = await db.pushSubscription.findMany({ where: { userId: { in: userIds } } });
  if (subs.length === 0) return;
  const json = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      // Defense in depth: never fetch an endpoint the subscribe guard would
      // reject today, no matter what the row says.
      if (!isAllowedPushEndpoint(sub.endpoint)) {
        console.error('[push] skipping disallowed endpoint for a stored subscription');
        return;
      }
      try {
        const details = webpush.generateRequestDetails(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          json,
          {
            vapidDetails: {
              subject: config.subject,
              publicKey: config.publicKey,
              privateKey: config.privateKey,
            },
            TTL: 24 * 3600,
          },
        );
        const res = await fetch(details.endpoint, {
          method: details.method,
          headers: Object.fromEntries(
            Object.entries(details.headers).map(([k, v]) => [k, String(v)]),
          ),
          body: details.body === null ? undefined : new Uint8Array(details.body),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404 || res.status === 410) {
          // Expired/uninstalled endpoint — prune (blueprint 04 §4).
          await db.pushSubscription
            .deleteMany({ where: { id: sub.id } })
            .catch((pruneErr) => console.error('[push] prune failed:', pruneErr));
        } else if (res.status < 200 || res.status >= 300) {
          console.error(`[push] push service answered ${res.status} for a subscription`);
        }
      } catch (e) {
        // Encryption error or network failure — log, never propagate.
        console.error('[push] send failed:', e instanceof Error ? e.message : e);
      }
    }),
  );
}

/**
 * Notify both households of a pair about a ledger event, except the creator.
 * Call AFTER the transaction commits, without awaiting:
 *   void notifyLedgerEvent(...) — it never throws.
 */
export async function notifyLedgerEvent(opts: {
  creatorId: string;
  householdIds: [string, string];
  title: string;
  body: string;
}): Promise<void> {
  try {
    if (!vapidConfig()) return;
    // Membership fan-out: one push per USER (a member of both households of
    // the pair still gets exactly one), creator excluded per-user.
    const memberships = await db.membership.findMany({
      where: { householdId: { in: opts.householdIds }, userId: { not: opts.creatorId } },
      select: { userId: true },
    });
    await sendPushToUsers(
      [...new Set(memberships.map((m) => m.userId))],
      { title: opts.title, body: opts.body, url: '/ledger' },
    );
  } catch (e) {
    console.error('[push] notifyLedgerEvent failed:', e instanceof Error ? e.message : e);
  }
}

/** Copy helpers so the two call sites and the tests agree on wording. */
export function settlementPushBody(creatorName: string, amountCents: number, note: string) {
  return `${creatorName} recorded ${formatCents(amountCents)} — ${note}`;
}

export function adjustmentPushBody(creatorName: string, amountCents: number, note: string) {
  return `${creatorName} posted ${formatCents(amountCents)} — ${note}`;
}
