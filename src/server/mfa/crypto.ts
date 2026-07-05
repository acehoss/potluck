/**
 * MFA secret encryption + login-challenge pending tokens (Phase 3 Round B;
 * docs/REWORK.md N8).
 *
 * The TOTP secret is the long-lived shared key behind every code — a DB read
 * must NOT yield it, so it is stored AES-256-GCM-encrypted and only ever
 * decrypted in memory to verify a code. The key comes from `MFA_ENC_KEY` (a
 * base64 32-byte value in the environment), read at runtime and returned as
 * null when unset — mirroring `vapidConfig()`/`mailConfig()` so every consumer
 * branches on that null rather than sprinkling env reads around. When it is
 * null the MFA features refuse to operate (you cannot store a secret you can't
 * encrypt); the docker entrypoint makes a real key mandatory outside demo mode
 * and injects a committed dev key under SEED_DEMO=1.
 *
 * This module never logs a key or a secret value.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

/**
 * The 32-byte AES key, or null when `MFA_ENC_KEY` is unset/malformed. A
 * wrong-length key is treated as absent (fail-closed) rather than throwing at
 * read time — the entrypoint guard is the place that refuses to boot.
 */
export function mfaEncKey(): Buffer | null {
  const raw = process.env.MFA_ENC_KEY;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

/** True when MFA can operate (an encryption key is configured). */
export function mfaConfigured(): boolean {
  return mfaEncKey() !== null;
}

function requireKey(): Buffer {
  const key = mfaEncKey();
  if (!key) {
    throw new Error('MFA is not configured (MFA_ENC_KEY unset or not a base64 32-byte key)');
  }
  return key;
}

/**
 * Encrypt a TOTP secret (its base32 string) for storage. Output is
 * `base64(iv).base64(tag).base64(ciphertext)` — self-describing so the key can
 * rotate the algorithm later without a schema change.
 */
export function encryptSecret(plain: string): string {
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

/** Reverse of {@link encryptSecret}; throws on a tampered blob (GCM tag). */
export function decryptSecret(blob: string): string {
  const key = requireKey();
  const parts = blob.split('.');
  if (parts.length !== 3) throw new Error('malformed MFA secret blob');
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('malformed MFA secret blob');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// --- Login-challenge pending token -------------------------------------------

/**
 * When a password verifies but the account has an MFA factor, login returns a
 * short-lived signed pending token INSTEAD of a session. It carries only the
 * user id + an expiry, HMAC-signed with a key derived from `MFA_ENC_KEY` (a
 * per-instance server secret), so it cannot be forged and cannot be reused past
 * its window. It is NOT a session — presenting it only lets the holder ATTEMPT
 * the second factor.
 */
const PENDING_TTL_MS = 5 * 60 * 1000;

function pendingKey(): Buffer {
  // Domain-separated from the encryption use of the same root secret.
  return createHmac('sha256', requireKey()).update('mfa-pending-token-v1').digest();
}

export function mintPendingToken(userId: string, now = Date.now()): string {
  const exp = now + PENDING_TTL_MS;
  const payload = `${userId}.${exp}`;
  const sig = createHmac('sha256', pendingKey()).update(payload).digest('base64url');
  return Buffer.from(`${payload}.${sig}`, 'utf8').toString('base64url');
}

/** Returns the userId when the token is well-formed, signed, and unexpired. */
export function verifyPendingToken(token: string, now = Date.now()): string | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [userId, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now) return null;
  const expected = createHmac('sha256', pendingKey()).update(`${userId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}
