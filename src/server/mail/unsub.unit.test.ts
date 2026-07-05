/**
 * Pure token round-trip for the RFC-8058 one-click unsubscribe (Phase 3 Round C,
 * C1.5 / C3). `unsub.ts` is db-free (node:crypto + env only), so the mint+verify
 * pair is exercised here without a Prisma client — e2e can't reach the tamper
 * branches (one real secret, one honest token) so the matrix lives in this unit.
 *
 * Run: npm run test:unit  (tsx --test)
 *
 * INTEGRATION NOTE (awaits notify-server C1.5): imports `verifyUnsubToken` from
 * `./unsub` (the pure verify Round C adds beside the existing `unsubToken` mint)
 * and the `SubscriptionCategory` extended to `pickups|circle|ledger|digest`. If
 * notify-server names the verify differently, only the import + the two call
 * sites below change. The secret is pinned in-process so the HMAC is
 * deterministic regardless of the ambient MAIL_UNSUB_SECRET.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Pin the secret BEFORE importing — unsubToken reads it at call time, but
// setting it up front keeps every case on the same key.
process.env.MAIL_UNSUB_SECRET = 'unit-test-fixed-secret';

import { unsubToken, verifyUnsubToken, type SubscriptionCategory } from './unsub';

const CATEGORIES: SubscriptionCategory[] = ['pickups', 'circle', 'ledger', 'digest'];

test('verifyUnsubToken round-trips every category a fresh mint produces', () => {
  for (const category of CATEGORIES) {
    const token = unsubToken('user-abc', category);
    const parsed = verifyUnsubToken(token);
    assert.deepEqual(parsed, { userId: 'user-abc', category }, `round-trip ${category}`);
  }
});

test('a mint for one user does not verify as another (userId is signed)', () => {
  const token = unsubToken('user-abc', 'digest');
  const parsed = verifyUnsubToken(token);
  assert.equal(parsed?.userId, 'user-abc');
  assert.notEqual(parsed?.userId, 'user-xyz');
});

test('tampering the signature is rejected (returns null)', () => {
  const token = unsubToken('user-abc', 'pickups');
  const raw = Buffer.from(token, 'base64url').toString('utf8'); // `${uid}.${cat}.${sig}`
  const [uid, cat, sig] = raw.split('.');
  // Flip the last sig char to something guaranteed different.
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
  const forged = Buffer.from(`${uid}.${cat}.${flipped}`, 'utf8').toString('base64url');
  assert.equal(verifyUnsubToken(forged), null);
});

test('swapping the category invalidates the signature (category is signed)', () => {
  // Take a valid pickups token, keep its sig, but claim it is a ledger token —
  // the recomputed HMAC over `${uid}:ledger` no longer matches.
  const token = unsubToken('user-abc', 'pickups');
  const [uid, , sig] = Buffer.from(token, 'base64url').toString('utf8').split('.');
  const swapped = Buffer.from(`${uid}.ledger.${sig}`, 'utf8').toString('base64url');
  assert.equal(verifyUnsubToken(swapped), null);
});

test('malformed inputs return null, never throw', () => {
  for (const bad of ['', 'not-base64url-!!!', Buffer.from('only.two', 'utf8').toString('base64url'), 'YWJjZA']) {
    assert.equal(verifyUnsubToken(bad), null, `malformed: ${JSON.stringify(bad)}`);
  }
});

test('a token minted under a different secret does not verify under ours', () => {
  const token = unsubToken('user-abc', 'digest');
  const saved = process.env.MAIL_UNSUB_SECRET;
  process.env.MAIL_UNSUB_SECRET = 'a-totally-different-secret';
  try {
    assert.equal(verifyUnsubToken(token), null);
  } finally {
    process.env.MAIL_UNSUB_SECRET = saved;
  }
});
