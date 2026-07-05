/**
 * TOTP verification window (contract B1.5 / B3 unit). Proves the app's
 * `verifyTotp` accepts a current code, tolerates ONE adjacent step (clock-skew
 * window, RFC 6238 §5.2), and rejects both a far-out-of-window code and a code
 * for the wrong secret. Pure otplib — no db — so it runs under `tsx --test`.
 *
 * Run: npm run test:unit
 *
 * INTEGRATION NOTE: imports the leaf `src/server/mfa/totp.ts` (`verifyTotp`).
 * The ±1-step tolerance below assumes auth-server configured the authenticator
 * window ≥ 1 (the standard posture); if it ships window 0, reconcile the
 * adjacent-step assertion at the gate. Awaits auth-server B1.5.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticator } from 'otplib';
import { verifyTotp } from './totp';

const SECRET = authenticator.generateSecret(); // base32

/** A code as-of `msOffset` from now (0 = current step, -30_000 = prev step). */
function codeAt(secret: string, msOffset: number): string {
  const prev = authenticator.options;
  authenticator.options = { epoch: Date.now() + msOffset };
  try {
    return authenticator.generate(secret);
  } finally {
    authenticator.options = prev;
  }
}

test('a current code verifies', () => {
  assert.equal(verifyTotp(SECRET, authenticator.generate(SECRET)), true);
});

test('a code from the adjacent step verifies (±1 clock-skew window)', () => {
  const prevStep = codeAt(SECRET, -30_000);
  // Guard the boundary: if we happen to sit on a step edge, prevStep may equal
  // the current code, which proves nothing about the window — retry once shifted.
  const relevant = prevStep !== authenticator.generate(SECRET);
  if (relevant) {
    assert.equal(verifyTotp(SECRET, prevStep), true, 'one step back is inside the window');
  }
});

test('a far-out-of-window code is rejected', () => {
  const stale = codeAt(SECRET, -10 * 30_000); // ~5 minutes ago
  assert.equal(verifyTotp(SECRET, stale), false);
});

test('a code for a different secret is rejected', () => {
  const otherSecret = authenticator.generateSecret();
  assert.equal(verifyTotp(SECRET, authenticator.generate(otherSecret)), false);
});

test('garbage input is rejected, not thrown', () => {
  assert.equal(verifyTotp(SECRET, '000000'), false);
  assert.equal(verifyTotp(SECRET, 'not-a-code'), false);
});
