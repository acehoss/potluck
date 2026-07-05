import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mintDeepLinkToken, verifyDeepLinkToken } from './deeplink';

/**
 * Phase-3 Round D — the navigation-only deep-link token (D1.1). PURE (node:crypto
 * + env only, like unsub.ts's HMAC leaf), so it unit-tests without a Prisma
 * client. The token grants NOTHING but a redirect + own-household switch, so the
 * whole security surface is: a valid mint round-trips, a bad signature / expired
 * / malformed token is rejected, and — the load-bearing guard — an unsafe
 * (open-redirect) path can NEVER become a usable token.
 *
 * INTEGRATION NOTE (awaits d-server D1.1): asserts the LANDED
 * `mintDeepLinkToken({ path, householdId })` / `verifyDeepLinkToken(token) ->
 * { path, householdId } | null`. The secret defaults to a dev string when
 * MAIL_UNSUB_SECRET is unset (mirrors unsub.ts), so this runs config-free.
 */

test('deeplink: mint -> verify round-trips path + householdId', () => {
  for (const path of ['/orders/abc123', '/', '/ledger', '/households/xyz', '/more', '/activity']) {
    const token = mintDeepLinkToken({ path, householdId: 'h-1' });
    assert.deepEqual(
      verifyDeepLinkToken(token),
      { path, householdId: 'h-1' },
      `safe path ${path} must round-trip`,
    );
  }
});

test('deeplink: a tampered signature verifies to null', () => {
  const token = mintDeepLinkToken({ path: '/orders/x', householdId: 'h-1' });
  // Flip a base64url char in the middle so the value still decodes but the HMAC
  // (or the payload it covers) no longer matches.
  const i = Math.floor(token.length / 2);
  const flipped = token[i] === 'A' ? 'B' : 'A';
  const tampered = token.slice(0, i) + flipped + token.slice(i + 1);
  assert.notEqual(tampered, token);
  assert.equal(verifyDeepLinkToken(tampered), null);
});

test('deeplink: malformed / empty tokens verify to null', () => {
  for (const junk of ['', 'not-a-token', 'a.b', 'a.b.c.d', '!!!!', '.....']) {
    assert.equal(verifyDeepLinkToken(junk), null, `junk ${JSON.stringify(junk)} -> null`);
  }
});

test('deeplink: an expired token verifies to null (24h TTL)', () => {
  const realNow = Date.now;
  try {
    const token = mintDeepLinkToken({ path: '/orders/x', householdId: 'h-1' });
    // Still valid at mint time.
    assert.deepEqual(verifyDeepLinkToken(token), { path: '/orders/x', householdId: 'h-1' });
    // Advance the clock past the 24h TTL; the inline `exp` is now in the past.
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    assert.equal(verifyDeepLinkToken(token), null, 'past-exp token is rejected');
  } finally {
    Date.now = realNow;
  }
});

test('deeplink: an unsafe (open-redirect) path can NEVER become a usable token', () => {
  // The guard may live at mint (throw) OR at verify (return null) — the contract
  // says validate at BOTH. Either way the invariant is the same: you cannot
  // obtain a token that verifies to an off-origin / scheme / userinfo path.
  const unsafe = [
    '//evil.com', // protocol-relative -> other origin
    'https://evil.com', // absolute scheme
    'http://evil.com',
    '\\\\evil.com', // backslash host (browsers normalize \ to /)
    '/\\evil.com',
    '/x@y', // '@' -> userinfo trick
    '/foo@evil.com',
    'javascript:alert(1)',
    'evil', // not rooted
    '', // empty
    ' /orders', // leading space then path
  ];
  for (const path of unsafe) {
    let token: string | null = null;
    try {
      token = mintDeepLinkToken({ path, householdId: 'h-1' });
    } catch {
      // mint refused the unsafe path — guard satisfied, nothing left to verify.
      continue;
    }
    assert.equal(
      verifyDeepLinkToken(token),
      null,
      `unsafe path ${JSON.stringify(path)} minted a token that must NOT verify`,
    );
  }
});

test('deeplink: a safe nested path with a query-ish tail still round-trips', () => {
  // Detail routes carry ids; make sure the safe-path guard is not so strict it
  // rejects a legitimate single-slash rooted path with hyphens/underscores.
  const path = '/orders/ckv9_abc-123';
  const token = mintDeepLinkToken({ path, householdId: 'h-neighbors' });
  assert.deepEqual(verifyDeepLinkToken(token), { path, householdId: 'h-neighbors' });
});
