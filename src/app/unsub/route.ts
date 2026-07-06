/**
 * RFC-8058 one-click unsubscribe (Phase 3 Round C; docs/REWORK.md N3/N5). Honors
 * the HMAC token minted into every subscription message's List-Unsubscribe
 * header (Round A). NO session required — the signed token IS the authorization
 * (constant-time HMAC verify in `verifyUnsubToken`); it can only ever turn a
 * preference OFF, so a leaked/guessed token can't harm an account.
 *
 *   POST (List-Unsubscribe-Post: List-Unsubscribe=One-Click) — the machine
 *     one-click a mail client fires. Returns 200 text/plain.
 *   GET  — the human landing when someone clicks the link; performs the same
 *     idempotent unsubscribe and renders a plain confirmation page.
 *
 * Effect per category: 'digest' → User.digestCadence = 'off'; 'pickups'|'circle'|
 * 'ledger' → NotificationPreference.email = false (push untouched). Idempotent.
 * `account` transactional mail is never a subscription and has no token here.
 */

import { db } from '@/server/db';
import { CATEGORY_DEFAULTS, isNotifyCategory } from '@/server/notifications';
import { type SubscriptionCategory, verifyUnsubToken } from '@/server/mail';

const CATEGORY_LABEL: Record<SubscriptionCategory, string> = {
  digest: 'the weekly digest',
  pickups: 'pickup & waiting-on-you emails',
  circle: 'neighborhood-activity emails',
  ledger: 'money & settling-up emails',
};

/** Apply the unsubscribe for a verified (userId, category). Idempotent. */
async function applyUnsub(userId: string, category: SubscriptionCategory): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return false;
  if (category === 'digest') {
    await db.user.update({ where: { id: userId }, data: { digestCadence: 'off' } });
    return true;
  }
  if (isNotifyCategory(category)) {
    await db.notificationPreference.upsert({
      where: { userId_category: { userId, category } },
      // A new row pins push to the category default and email OFF; an existing
      // row just flips email off (keeping the user's push choice).
      create: { userId, category, push: CATEGORY_DEFAULTS[category].push, email: false },
      update: { email: false },
    });
    return true;
  }
  return false;
}

function tokenFrom(req: Request): string | null {
  return new URL(req.url).searchParams.get('token');
}

export async function POST(req: Request) {
  const token = tokenFrom(req);
  const verified = token ? verifyUnsubToken(token) : null;
  if (!verified) return new Response('Invalid or expired unsubscribe link.', { status: 400 });
  const ok = await applyUnsub(verified.userId, verified.category);
  if (!ok) return new Response('Invalid or expired unsubscribe link.', { status: 400 });
  return new Response('You have been unsubscribed.', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export async function GET(req: Request) {
  const token = tokenFrom(req);
  const verified = token ? verifyUnsubToken(token) : null;
  const page = (title: string, msg: string, status: number) =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${msg}</p></body></html>`,
      { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );

  if (!verified) {
    return page('Unsubscribe', 'This unsubscribe link is invalid or has expired.', 400);
  }
  const ok = await applyUnsub(verified.userId, verified.category);
  if (!ok) {
    return page('Unsubscribe', 'This unsubscribe link is invalid or has expired.', 400);
  }
  return page(
    'Unsubscribed',
    `You've been unsubscribed from ${CATEGORY_LABEL[verified.category]}. You can turn it back on any time from Potluck's notification settings.`,
    200,
  );
}
