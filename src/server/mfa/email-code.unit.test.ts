/**
 * Emailed MFA code — expiry + attempt-cap decision logic (contract B1.5 / B3
 * unit). The pure pieces: a 6-digit generator (leading zeros preserved) and the
 * state machine that decides whether a stored code is still usable. The e2e
 * spec proves the same cap end-to-end against the real challenge; this pins the
 * boundaries without a clock or a database.
 *
 * Run: npm run test:unit
 *
 * INTEGRATION NOTE: imports the leaf `src/server/mfa/email-code.ts`
 * (`emailCodeState`, `generateEmailCode`, `EMAIL_MFA_MAX_ATTEMPTS`,
 * `EMAIL_MFA_CODE_TTL_MS`). Each `emailCodeState` case below sets exactly ONE
 * failing condition so the test is independent of the precedence ordering
 * between them. Awaits auth-server B1.5.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMAIL_MFA_CODE_TTL_MS,
  EMAIL_MFA_MAX_ATTEMPTS,
  emailCodeState,
  generateEmailCode,
} from './email-code';

const NOW = new Date('2026-07-05T12:00:00Z');
const future = new Date(NOW.getTime() + 60_000);
const past = new Date(NOW.getTime() - 60_000);

test('generateEmailCode: always exactly six digits (leading zeros kept)', () => {
  for (let i = 0; i < 500; i++) {
    assert.match(generateEmailCode(), /^\d{6}$/);
  }
});

test('constants: a small attempt cap and a short (1–30 min) TTL', () => {
  assert.ok(EMAIL_MFA_MAX_ATTEMPTS >= 1 && EMAIL_MFA_MAX_ATTEMPTS <= 10, 'cap is small');
  assert.ok(
    EMAIL_MFA_CODE_TTL_MS >= 60_000 && EMAIL_MFA_CODE_TTL_MS <= 30 * 60_000,
    'TTL is between 1 and 30 minutes',
  );
});

test('emailCodeState: a fresh unused code is valid', () => {
  assert.equal(emailCodeState({ expiresAt: future, attempts: 0, usedAt: null }, NOW), 'valid');
});

test('emailCodeState: past expiry is expired', () => {
  assert.equal(emailCodeState({ expiresAt: past, attempts: 0, usedAt: null }, NOW), 'expired');
});

test('emailCodeState: at/over the attempt cap is exhausted', () => {
  assert.equal(
    emailCodeState({ expiresAt: future, attempts: EMAIL_MFA_MAX_ATTEMPTS, usedAt: null }, NOW),
    'exhausted',
  );
});

test('emailCodeState: an already-consumed code is used', () => {
  assert.equal(emailCodeState({ expiresAt: future, attempts: 0, usedAt: NOW }, NOW), 'used');
});
