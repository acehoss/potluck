/**
 * Navigation-only deep-link tokens (Phase 3 Round D; docs/REWORK.md N7).
 *
 * A notification (push OR email) carries a `/go?t=<token>` link. The token is a
 * stateless HMAC over {path, householdId, exp} that the `/go` route verifies to
 * do exactly two things: switch the acting household (only ever to one of the
 * viewer's OWN memberships — /go re-checks) and redirect to `path`. It is
 * NEVER accepted as authentication and can perform NO action or elevation — a
 * logged-out click lands on a normal login first (see src/app/go/route.ts). So
 * the token grants nothing but a navigation + own-household switch.
 *
 * Because it is nav-only, single-use is unnecessary: a replay just re-navigates
 * to the same screen and re-applies the same (idempotent) own-household switch.
 * The 24h TTL bounds a stale link; statelessness (no db row) keeps it cheap and
 * survives restarts. This mirrors `mfa/crypto.ts` mintPendingToken (inline exp,
 * base64url payload + HMAC, timingSafeEqual) and `mail/unsub.ts` (the secret,
 * domain-separated here so this key can never verify an unsub token).
 *
 * OPEN-REDIRECT DEFENSE: `path` is validated as a same-origin RELATIVE path at
 * BOTH mint and verify (isSafePath). A forged/tampered token that decodes to
 * `//evil.com`, `https://evil`, a backslash trick, or a userinfo `@` is rejected
 * and /go falls back to `/`. This module is PURE (node:crypto + env only) so the
 * guard is unit-testable without a db.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Control chars (0x00–0x1f), space (0x20), and DEL (0x7f) — none belong in a
// path we redirect to; a raw space/newline is an encoding or smuggling smell.
const CONTROL_OR_SPACE = /[\x00-\x20\x7f]/;

function deeplinkKey(): Buffer {
  // Domain-separated from the raw unsub secret: this derived key can never be
  // used to verify (or forge) an unsubscribe token, and vice-versa.
  const root = process.env.MAIL_UNSUB_SECRET || 'dev-unsub-secret-not-for-production';
  return createHmac('sha256', root).update('deeplink-v1').digest();
}

/**
 * True only for a same-origin absolute-path reference: starts with a single `/`,
 * never `//` or `/\` (protocol-relative), contains no backslash (browsers fold
 * `\`→`/`), no `@` (userinfo `//user@host` trick), and no control/whitespace.
 * A leading `/` already precludes a `scheme:` prefix. This is the whole
 * open-redirect guard; keep it strict. Shared by the login page's `next=` check.
 */
export function isSafePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path[0] !== '/') return false; // must be an absolute-path reference
  if (path[1] === '/' || path[1] === '\\') return false; // no //, no /\
  if (path.includes('\\')) return false; // no backslash anywhere
  if (path.includes('@')) return false; // no userinfo authority trick
  if (CONTROL_OR_SPACE.test(path)) return false; // no control chars or whitespace
  return true;
}

function sign(body: string): string {
  return createHmac('sha256', deeplinkKey()).update(body).digest('base64url');
}

/**
 * Mint a nav-only token for `{path, householdId}` with a 24h TTL. THROWS when
 * `path` fails the safe-path guard — the guard runs at mint (fail closed: you
 * cannot obtain a token for an off-origin path) as well as at verify. Callers
 * pass app-authored fixed paths, so this never throws in practice; the throw is
 * the belt to verify's suspenders (mirrors the `string`-returning shape of
 * `mintPendingToken` / `unsubToken`).
 */
export function mintDeepLinkToken(
  input: { path: string; householdId: string },
  now = Date.now(),
): string {
  if (!isSafePath(input.path)) {
    throw new Error('refusing to mint a deep-link token for an unsafe path');
  }
  const body = Buffer.from(
    JSON.stringify({ p: input.path, h: input.householdId, e: now + TTL_MS }),
    'utf8',
  ).toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * Verify a token and return its `{path, householdId}`, or null when the
 * signature is wrong, it is expired/malformed, or `path` is unsafe (the
 * open-redirect guard re-runs here — a tampered payload can't sneak a bad path
 * past mint).
 */
export function verifyDeepLinkToken(
  token: string | null | undefined,
  now = Date.now(),
): { path: string; householdId: string } | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const { p, h, e } = payload as { p?: unknown; h?: unknown; e?: unknown };
  if (!isSafePath(p)) return null;
  if (typeof h !== 'string' || h.length === 0) return null;
  if (typeof e !== 'number' || !Number.isFinite(e) || e < now) return null;
  return { path: p, householdId: h };
}

/** The `/go?t=…` link that carries a token. Relative — resolves against the app origin. */
export function deepLinkPath(token: string): string {
  return `/go?t=${token}`;
}
