/**
 * MFA backup codes (Phase 3 Round B; docs/REWORK.md N8). PURE except for the
 * argon2 hasher import (no db/env) so generation + hashing is unit-testable.
 *
 * 8–10 human-typeable one-time recovery codes, hashed with the PASSWORD hasher
 * (argon2id, random salt) — so a code is checked by VERIFYING the input against
 * each stored row, never by hashing-and-equals. Shown once at enrollment.
 */

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

// Crockford-ish base32 minus ambiguous chars (0/O, 1/I/L) — readable off a
// printed card, unambiguous when typed back.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const BACKUP_CODE_COUNT = 10;
const CODE_LENGTH = 10;

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * A batch of fresh backup codes (shown once, plaintext). Codes are already in
 * canonical form (lowercase, no separators) so `hashBackupCode(code)` and a
 * plain `argon2Verify(hash, code)` agree, and `normalizeBackupCode` is identity
 * on them — the display form and the hashed form are the same string.
 */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => randomChars(CODE_LENGTH));
}

/** Canonical form for comparison: lowercase, strip everything but [a-z0-9]. */
export function normalizeBackupCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashBackupCode(code: string): Promise<string> {
  return argon2Hash(normalizeBackupCode(code), ARGON2_OPTIONS);
}

export function verifyBackupCode(hash: string, input: string): Promise<boolean> {
  return argon2Verify(hash, normalizeBackupCode(input));
}
