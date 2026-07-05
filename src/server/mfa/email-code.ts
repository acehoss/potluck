/**
 * Emailed MFA code — generation + the pure lifecycle state machine (Phase 3
 * Round B; docs/REWORK.md N8). A 6-digit convenience/enrollment code, hashed at
 * rest with an HMAC keyed by the per-instance MFA key (a bare sha256 of a
 * 6-digit value is a 10^6 lookup; the keyed pepper makes a leaked hash useless
 * without the server secret). Short-TTL, attempt-capped, single-use.
 *
 * `emailCodeState` decides only whether a stored code is still USABLE (expiry /
 * attempt cap / already-consumed); the actual code MATCH is a separate,
 * constant-cost hash compare in the db layer. Pure except the MFA-key read in
 * `hashEmailCode`, so the state machine is unit-testable without a clock or db.
 */

import { createHmac } from 'node:crypto';
import { mfaEncKey } from './crypto';

export const EMAIL_MFA_MAX_ATTEMPTS = 5;
export const EMAIL_MFA_CODE_TTL_MS = 10 * 60 * 1000;

/** A fresh 6-digit emailed code (leading zeros preserved). */
export function generateEmailCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, '0');
}

/**
 * Keyed hash for an emailed code. Requires the MFA key (the entrypoint
 * guarantees it wherever MFA operates); throws if absent so a misconfigured
 * stack fails closed rather than storing a guessable bare digest.
 */
export function hashEmailCode(code: string): string {
  const key = mfaEncKey();
  if (!key) throw new Error('MFA is not configured (MFA_ENC_KEY unset)');
  return createHmac('sha256', key).update(code.trim()).digest('hex');
}

export type EmailCodeRow = { expiresAt: Date; attempts: number; usedAt: Date | null };
export type EmailCodeState = 'valid' | 'expired' | 'exhausted' | 'used';

/**
 * The usability of a stored emailed code, independent of the guess. `used` and
 * `expired`/`exhausted` all mean the code is dead; only `valid` may be matched.
 * Precedence is deliberately independent — each terminal condition is checked
 * regardless of the others so the caller can rely on any single one.
 */
export function emailCodeState(row: EmailCodeRow, now: Date = new Date()): EmailCodeState {
  if (row.usedAt) return 'used';
  if (row.expiresAt.getTime() < now.getTime()) return 'expired';
  if (row.attempts >= EMAIL_MFA_MAX_ATTEMPTS) return 'exhausted';
  return 'valid';
}
