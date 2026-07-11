/**
 * TOTP primitives (Phase 3 Round B; docs/archive/mutual-aid-rework-2026-07.md N8) — a thin, deliberately
 * small wrapper over otplib so the ±1-step skew window and the issuer/label
 * convention live in exactly one place. otplib's `authenticator` is a shared
 * singleton, so the window is set here at module load, once.
 *
 * The secret handled here is the RAW base32 string. Encryption at rest is the
 * caller's job (see `./crypto` `encryptSecret`/`decryptSecret`); this module
 * only generates/labels/verifies.
 */

import { authenticator } from 'otplib';

export const TOTP_ISSUER = 'Potluck';
const STEP_SECONDS = 30;

// ±1 step (≈30 s each side) tolerance for device clock drift (N8).
authenticator.options = { window: 1 };

/** A fresh base32 TOTP secret. */
export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/**
 * The `otpauth://totp/...` provisioning URI an authenticator app / 1Password
 * imports. `account` is the user's email; the issuer is fixed.
 */
export function totpUri(account: string, secret: string): string {
  return authenticator.keyuri(account, TOTP_ISSUER, secret);
}

/** The current 6-digit code for a secret (used by seed/e2e derive helpers). */
export function currentTotpCode(secret: string): string {
  return authenticator.generate(secret);
}

/** The absolute TOTP time-step index for a moment (drives the replay guard). */
export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * Verify a code and return the ABSOLUTE step it matched, or null. The step lets
 * the caller replay-reject a code from a step already consumed (a used TOTP
 * code must not sign a second login within its validity window). Non-numeric
 * input returns null without touching otplib.
 */
export function verifyTotpStep(code: string, secret: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null) return null;
  return totpStep(now) + delta;
}

/**
 * Boolean verify (secret first, then code) — the shape the enrollment/unit path
 * wants when the matched step is irrelevant. Garbage input returns false rather
 * than throwing.
 */
export function verifyTotp(secret: string, code: string): boolean {
  return verifyTotpStep(code, secret) !== null;
}
