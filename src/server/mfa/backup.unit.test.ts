/**
 * MFA backup codes (contract B1.5 / B3 unit). Proves generation yields a batch
 * of distinct, non-trivial codes and that each hashes verifiably — the single
 * cryptographic property a unit can hold. SINGLE-USE (a code works exactly
 * once) is a database property, proven end-to-end in e2e/auth.spec.ts. The hash
 * is verified with `@node-rs/argon2` directly (not `../auth`, which drags in
 * db/next), keeping this runnable under `tsx --test`.
 *
 * Run: npm run test:unit
 *
 * INTEGRATION NOTE: imports the leaf `src/server/mfa/backup.ts`
 * (`generateBackupCodes`, `hashBackupCode`). Awaits auth-server B1.5.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verify as argon2Verify } from '@node-rs/argon2';
import { generateBackupCodes, hashBackupCode } from './backup';

test('generateBackupCodes: a batch of 8–10 distinct, non-empty codes', () => {
  const codes = generateBackupCodes();
  assert.ok(codes.length >= 8 && codes.length <= 10, `expected 8–10 codes, got ${codes.length}`);
  assert.equal(new Set(codes).size, codes.length, 'all codes are distinct');
  for (const c of codes) {
    assert.equal(typeof c, 'string');
    assert.ok(c.length >= 8, `code "${c}" is long enough to resist guessing`);
  }
});

test('hashBackupCode: the hash verifies its own code and rejects another', async () => {
  const codes = generateBackupCodes();
  const hash = await hashBackupCode(codes[0]);
  assert.notEqual(hash, codes[0], 'the stored hash is not the plaintext code');
  assert.equal(await argon2Verify(hash, codes[0]), true, 'right code verifies');
  assert.equal(await argon2Verify(hash, codes[1]), false, 'a different code does not');
});

test('hashBackupCode: two hashes of the same code differ (salted)', async () => {
  const codes = generateBackupCodes();
  const a = await hashBackupCode(codes[0]);
  const b = await hashBackupCode(codes[0]);
  assert.notEqual(a, b, 'per-hash salt means the stored hashes differ');
  assert.equal(await argon2Verify(a, codes[0]), true);
  assert.equal(await argon2Verify(b, codes[0]), true);
});
