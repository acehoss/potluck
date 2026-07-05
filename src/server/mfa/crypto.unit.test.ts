/**
 * MFA secret-at-rest crypto (contract B1.1 / B3 unit). The TOTP secret is
 * stored AES-256-GCM-encrypted under `MFA_ENC_KEY`; this proves the pure
 * round-trip, that ciphertext is non-deterministic (per-message IV), and that
 * GCM authentication rejects both tampering and the wrong key. Pure node:crypto
 * — no db, no next/headers — so it runs under `tsx --test`.
 *
 * Run: npm run test:unit
 *
 * INTEGRATION NOTE: imports the leaf `src/server/mfa/crypto.ts`
 * (`encryptSecret`/`decryptSecret`), which reads `MFA_ENC_KEY` (base64, 32
 * bytes) at CALL time so the env can be set per-test. Awaits auth-server B1.1.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decryptSecret, encryptSecret } from './crypto';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const SECRET = 'JBSWY3DPEHPK3PXP'; // a canonical base32 TOTP secret

/** Save/set/restore MFA_ENC_KEY around a body (extraction.unit.test pattern). */
function withKey<T>(key: string, body: () => T): T {
  const prev = process.env.MFA_ENC_KEY;
  process.env.MFA_ENC_KEY = key;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env.MFA_ENC_KEY;
    else process.env.MFA_ENC_KEY = prev;
  }
}

test('encrypt → decrypt round-trips the plaintext', () => {
  withKey(KEY, () => {
    const blob = encryptSecret(SECRET);
    assert.notEqual(blob, SECRET, 'the stored blob is not the plaintext');
    assert.equal(decryptSecret(blob), SECRET);
  });
});

test('encryption is non-deterministic — same plaintext, different ciphertext (per-message IV)', () => {
  withKey(KEY, () => {
    const a = encryptSecret(SECRET);
    const b = encryptSecret(SECRET);
    assert.notEqual(a, b, 'a fresh IV each call means ciphertext must differ');
    // …yet both decrypt back to the same secret.
    assert.equal(decryptSecret(a), SECRET);
    assert.equal(decryptSecret(b), SECRET);
  });
});

test('a tampered blob is rejected (GCM auth tag)', () => {
  withKey(KEY, () => {
    const blob = encryptSecret(SECRET);
    // Flip one character in the middle of the blob; GCM must refuse to decrypt.
    const i = Math.floor(blob.length / 2);
    const swap = blob[i] === 'A' ? 'B' : 'A';
    const tampered = blob.slice(0, i) + swap + blob.slice(i + 1);
    assert.throws(() => decryptSecret(tampered), 'GCM rejects a mutated ciphertext/tag');
  });
});

test('the wrong key cannot decrypt', () => {
  const blob = withKey(KEY, () => encryptSecret(SECRET));
  withKey(OTHER_KEY, () => {
    assert.throws(() => decryptSecret(blob), 'decrypt under a different key fails');
  });
});
