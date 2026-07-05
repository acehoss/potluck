/**
 * Subscription unsubscribe token + header contract (contract A2.1, pipeline
 * half). The RFC-8058 one-click headers and the signed unsubscribe token are
 * pure (node:crypto + env), so their exact shape is proven here; that the
 * transactional pipeline carries NEITHER header and that suppression gates
 * subscription-only are proven end-to-end in e2e/mail.spec.ts (only observable
 * through the CapturedEmail row).
 *
 * Run: npm run test:unit  (tsx --test)
 *
 * INTEGRATION NOTE: imports the PURE `src/server/mail/unsub.ts` module (token +
 * header builders extracted from index.ts so a unit test can reach them without
 * dragging in ../db). Awaits mail-server landing that module — coordinated by
 * message. Round C's /unsub route verifies the same token from this module.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subscriptionHeaders, unsubToken } from './unsub';

/** Save/set/restore env around a body (extraction.unit.test.ts pattern). */
function withEnv(vars: Record<string, string | undefined>, body: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('subscriptionHeaders: RFC-8058 one-click List-Unsubscribe + List-Unsubscribe-Post', () => {
  const h = subscriptionHeaders('user-1', 'digest', 'someone@example.com');
  // List-Unsubscribe carries an https URL and a mailto, each angle-bracketed.
  assert.match(h['List-Unsubscribe'], /^<https:\/\/\S+>, <mailto:\S+>$/);
  assert.ok(h['List-Unsubscribe'].includes('/unsub?token='), 'points at the unsub route with a token');
  // One-click POST marker is the exact literal RFC 8058 requires.
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('subscriptionHeaders: the token in the header equals unsubToken for the same identity', () => {
  const h = subscriptionHeaders('user-1', 'digest', 'someone@example.com');
  const token = unsubToken('user-1', 'digest');
  assert.ok(h['List-Unsubscribe'].includes(encodeURIComponent(token)), 'header embeds the mintable token');
});

test('unsubToken: deterministic, base64url, and decodes to userId.category.sig', () => {
  const a = unsubToken('user-1', 'digest');
  const b = unsubToken('user-1', 'digest');
  assert.equal(a, b, 'same identity → same token (verifiable in Round C)');
  // base64url alphabet only — no +, /, or = padding.
  assert.match(a, /^[A-Za-z0-9_-]+$/);

  const decoded = Buffer.from(a, 'base64url').toString('utf8');
  const parts = decoded.split('.');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'user-1');
  assert.equal(parts[1], 'digest');
  assert.match(parts[2], /^[0-9a-f]{32}$/, 'signature is 32 hex chars of HMAC-SHA256');
});

test('unsubToken: different category yields a different token', () => {
  assert.notEqual(unsubToken('user-1', 'digest'), unsubToken('user-1', 'share'));
});

test('unsubToken: signature actually depends on the secret (HMAC, not a hash of public data)', () => {
  let withSecretA = '';
  let withSecretB = '';
  withEnv({ MAIL_UNSUB_SECRET: 'secret-a' }, () => {
    withSecretA = unsubToken('user-1', 'digest');
  });
  withEnv({ MAIL_UNSUB_SECRET: 'secret-b' }, () => {
    withSecretB = unsubToken('user-1', 'digest');
  });
  assert.notEqual(withSecretA, withSecretB, 'a forged token cannot be minted without MAIL_UNSUB_SECRET');
});
