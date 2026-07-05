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

import { createHmac } from 'node:crypto';

/** Preference bucket a subscription message belongs to (Round C wires prefs). */
export type SubscriptionCategory = 'digest' | 'share' | 'activity';

export function unsubToken(userId: string, category: SubscriptionCategory): string {
  const secret = process.env.MAIL_UNSUB_SECRET || 'dev-unsub-secret-not-for-production';
  const sig = createHmac('sha256', secret).update(`${userId}:${category}`).digest('hex').slice(0, 32);
  return Buffer.from(`${userId}.${category}.${sig}`, 'utf8').toString('base64url');
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
