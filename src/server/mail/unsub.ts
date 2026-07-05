/**
 * Unsubscribe token + RFC-8058 header builders — PURE (node:crypto + env only,
 * NO db/nodemailer import) so they can be unit-tested without constructing the
 * Prisma client, and so Round C's /unsub route can import the same mint/verify
 * home that the subscription pipeline mints from.
 *
 * Token contract (the /unsub route that HONORS it lands in Round C; this only
 * MINTS a well-formed value so the List-Unsubscribe header is valid now):
 *
 *   token = base64url( `${userId}.${category}.${sigHex}` ) where
 *     sigHex = HMAC_SHA256( `${userId}:${category}`, MAIL_UNSUB_SECRET ).slice(0,32)
 *
 * Round C: recompute the HMAC from the decoded userId+category and constant-
 * time compare the signature before honoring a one-click unsubscribe. The
 * secret defaults to a fixed dev string when unset so demo/e2e stacks produce
 * a stable, verifiable token without configuration.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

function unsubSecret(): string {
  return process.env.MAIL_UNSUB_SECRET || 'dev-unsub-secret-not-for-production';
}

const CATEGORIES: readonly SubscriptionCategory[] = ['digest', 'pickups', 'circle', 'ledger'];

function signature(userId: string, category: SubscriptionCategory): string {
  return createHmac('sha256', unsubSecret())
    .update(`${userId}:${category}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Preference bucket a subscription message belongs to. The weekly `digest` plus
 * the three opt-out notification categories (Round C, N5) — each an unsubscribe
 * target for the RFC-8058 one-click token. (`account` transactional mail is
 * never a subscription and never appears here.)
 */
export type SubscriptionCategory = 'digest' | 'pickups' | 'circle' | 'ledger';

export function unsubToken(userId: string, category: SubscriptionCategory): string {
  const sig = signature(userId, category);
  return Buffer.from(`${userId}.${category}.${sig}`, 'utf8').toString('base64url');
}

/**
 * Verify a one-click unsubscribe token and return its (userId, category), or
 * null when it is malformed, names an unknown category, or its HMAC doesn't
 * match (recomputed from the decoded fields, constant-time compared). PURE
 * (crypto + env only) so the /unsub route and a unit test share one verifier.
 * A cuid userId and a word category contain no dots, so the 3-field split is
 * unambiguous.
 */
export function verifyUnsubToken(
  token: string,
): { userId: string; category: SubscriptionCategory } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [userId, category, sig] = parts;
  if (!userId || !CATEGORIES.includes(category as SubscriptionCategory)) return null;
  const expected = signature(userId, category as SubscriptionCategory);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { userId, category: category as SubscriptionCategory };
}

function publicBaseUrl(): string {
  return (process.env.MAIL_PUBLIC_URL || 'https://potluckmutualaid.app').replace(/\/+$/, '');
}

/** RFC-8058 one-click unsubscribe headers for a subscription message. */
export function subscriptionHeaders(
  userId: string,
  category: SubscriptionCategory,
  toAddress: string,
): Record<string, string> {
  const token = unsubToken(userId, category);
  const httpUrl = `${publicBaseUrl()}/unsub?token=${encodeURIComponent(token)}`;
  const mailto = `mailto:${process.env.EMAIL_FROM || 'no-reply@potluckmutualaid.app'}?subject=${encodeURIComponent(
    `unsubscribe ${token}`,
  )}`;
  return {
    'List-Unsubscribe': `<${httpUrl}>, <${mailto}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'List-Id': `${category} <${category}.${toAddress.split('@')[1] ?? 'potluck'}>`,
  };
}
