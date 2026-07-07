import webpush from 'web-push';
import { appUrl } from './app-url';
import { db } from './db';
import { deepLinkPath, mintDeepLinkToken } from './deeplink';
import { sendSubscription } from './mail';
import { channelPrefsForUsers, type NotifyCategory } from './notifications';
import { isAllowedPushEndpoint } from './push-endpoint';

/**
 * Web push sender + the `notify()` fan-out (blueprint 04 §4/§8). Events ride
 * the three opt-out categories — pickups/circle/ledger, defaults in
 * `notify/defaults.ts` — resolved per user against NotificationPreference.
 * Ledger events go to every member of BOTH involved households EXCEPT the
 * creating user (matching the ledger "new" marker semantics: the recorder's
 * housemates are notified too).
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

/** The `{household}` placeholder in a notify title/body → recipient's own name. */
const HOUSEHOLD_TOKEN = '{household}';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minimal html body for a notification email: the generic line + an "Open
 * Potluck" anchor to the nav-only `/go?t=` link. Body is app-authored but may
 * carry a household name, so it is escaped; the link is our own base64url token.
 */
function ctaEmailHtml(body: string, link: string): string {
  return `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">Open Potluck</a></p>`;
}

export type NotifyOptions = {
  /** Households whose members should be notified (deduped to one per user). */
  recipientHouseholdIds: string[];
  /** The actor USER — excluded so you're never notified of your own action. */
  excludeUserId: string;
  /** Which opt-out bucket this belongs to; drives per-user push/email prefs. */
  category: NotifyCategory;
  /**
   * The TARGET screen a notification tap lands on (e.g. `/orders/<id>`). notify()
   * wraps it per-recipient in a nav-only `/go?t=…` deep link (Round D, N7) that
   * also switches the recipient to their own household — so pass the bare app
   * path, not a `/go` url.
   */
  url: string;
  /**
   * Generic title (N4): a category-only message + the recipient's OWN household
   * name via the `{household}` token. NEVER a counterparty name/$/address/item.
   */
  title: string;
  /** Generic body, same `{household}` substitution + same no-PII rule as title. */
  body: string;
  /**
   * The counterparty household NAME, appended to the body ONLY for recipients
   * whose `showDetails` is on (N4 opt-in). Still no dollars/addresses. Omit for
   * two-sided events (a ledger settle/adjust) where "the counterparty" differs
   * per recipient household.
   */
  detail?: string;
};

/**
 * The generalized post-commit notifier (Phase 3 Round C, N4/N5). Resolves the
 * recipient households' members (excluding the actor), and per user fans the
 * message out to whichever channels their NotificationPreference (or the
 * category default) has ON: push via the encrypted web-push sender, email via
 * the RFC-8058 subscription pipeline (which re-checks the same email pref +
 * suppression before sending). Content is generic and stamped with each
 * recipient's OWN household name (N4) — a member of two recipient households is
 * notified once, under the first.
 *
 * Call AFTER the transaction commits, without awaiting:
 *   void notify(...) — it never throws.
 */
export async function notify(opts: NotifyOptions): Promise<void> {
  try {
    const householdIds = [...new Set(opts.recipientHouseholdIds)];
    if (householdIds.length === 0) return;

    const [households, memberships] = await Promise.all([
      db.household.findMany({ where: { id: { in: householdIds } }, select: { id: true, name: true } }),
      db.membership.findMany({
        where: { householdId: { in: householdIds }, userId: { not: opts.excludeUserId } },
        select: { userId: true, householdId: true },
      }),
    ]);
    const nameByHousehold = new Map(households.map((h) => [h.id, h.name]));

    // One notification per USER, stamped with the first recipient household they
    // belong to (a two-household member isn't double-notified).
    const householdByUser = new Map<string, string>();
    for (const m of memberships) {
      if (!householdByUser.has(m.userId)) householdByUser.set(m.userId, m.householdId);
    }
    const userIds = [...householdByUser.keys()];
    if (userIds.length === 0) return;

    const [users, prefs] = await Promise.all([
      db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, showDetails: true },
      }),
      channelPrefsForUsers(userIds, opts.category),
    ]);

    await Promise.all(
      users.map(async (user) => {
        const pref = prefs.get(user.id) ?? { push: false, email: false };
        if (!pref.push && !pref.email) return;
        const recipientHousehold = householdByUser.get(user.id)!;
        const householdName = nameByHousehold.get(recipientHousehold) ?? 'your household';
        const title = opts.title.split(HOUSEHOLD_TOKEN).join(householdName);
        let body = opts.body.split(HOUSEHOLD_TOKEN).join(householdName);
        if (user.showDetails && opts.detail) body = `${body} ${opts.detail}`;

        // Per-recipient nav-only deep link (N7): tapping it switches THEM to
        // their own recipient household and opens the target screen. Push takes
        // the relative `/go?t=` (the SW resolves it against the origin); email —
        // opened in a browser, logged-out — takes the absolute one.
        const goPath = deepLinkPath(
          mintDeepLinkToken({ path: opts.url, householdId: recipientHousehold }),
        );
        const link = appUrl(goPath);

        const jobs: Promise<unknown>[] = [];
        if (pref.push) jobs.push(sendPushToUsers([user.id], { title, body, url: goPath }));
        if (pref.email) {
          jobs.push(
            sendSubscription({
              to: user.email,
              userId: user.id,
              category: opts.category,
              kind: opts.category,
              subject: title,
              text: `${body}\n\nOpen Potluck: ${link}`,
              html: ctaEmailHtml(body, link),
            }),
          );
        }
        await Promise.all(jobs);
      }),
    );
  } catch (e) {
    console.error('[notify] failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Ledger settle/adjust notifier, now riding the generalized matrix (category
 * `ledger`, which per N5 defaults to push+email OFF — money noise is opt-in;
 * ledger events still surface in-app + the digest). Content is generic (N4): no
 * counterparty name, amount, or note in the push/subject. A two-sided event, so
 * no `detail` — the "other household" differs for each recipient side.
 */
export async function notifyLedgerEvent(opts: {
  creatorId: string;
  householdIds: [string, string];
  title: string;
  body: string;
}): Promise<void> {
  await notify({
    recipientHouseholdIds: opts.householdIds,
    excludeUserId: opts.creatorId,
    category: 'ledger',
    url: '/ledger',
    title: opts.title,
    body: opts.body,
  });
}
