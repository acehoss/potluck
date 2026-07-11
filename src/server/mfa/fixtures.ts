/**
 * Durable demo-only MFA fixtures (Phase 3 Round B; docs/archive/mutual-aid-rework-2026-07.md N10).
 *
 * PURE leaf — string constants + otplib only, NO db/next/prisma imports — so the
 * Playwright loader and the seed can both pull it by relative path without
 * dragging server-only deps into the test process.
 *
 * These base32 TOTP secrets are COMMITTED and DEMO-ONLY — the same class as the
 * committed dev VAPID/MFA keys in `docker-entrypoint.sh`. Seeded accounts boot
 * already-enrolled with them (encrypted at rest with the dev MFA key), so a
 * `down -v` + reseed restores identical secrets and `scripts/dump-demo-creds`
 * emits a stable, 1Password-importable `otpauth://` URI. The e2e suite computes
 * a live code from the same secret to drive the TOTP login challenge on both
 * engines — that end-to-end computability IS the N10 proof. Never used outside
 * SEED_DEMO: the entrypoint refuses a non-demo stack that carries the dev key.
 */

import { currentTotpCode, totpUri } from './totp';

/**
 * The committed dev MFA-encryption key the entrypoint injects under SEED_DEMO=1
 * (base64, 32 bytes) — demo-only, MUST match docker-entrypoint.sh's
 * DEV_MFA_ENC_KEY. Exported so auth-e2e's crypto unit test can encrypt/decrypt
 * against the same key the demo stack uses. Never protects a real deployment:
 * the entrypoint refuses a non-demo stack that carries it.
 */
export const DEV_MFA_ENC_KEY = 'U0/0qjKE9eRehZQL3Oooz3MQ2676Ggxj8cDFOt90O2Q=';

/** username → committed base32 TOTP secret. */
const BY_USERNAME: Record<string, string> = {
  aaron: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  marie: 'KRSXG5BAKRSXG5BAKRSXG5BAKRSXG5BA',
  theo: 'MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK',
  dana: 'NBSWY3DPO5XXE3DENBSWY3DPO5XXE3DE',
  nia: 'ONXW2ZLUEBLW64TMMQXW2ZLUEBLW64TM',
};

/** username → seeded demo email (keeps the by-email keys in sync with the seed). */
const EMAIL_BY_USERNAME: Record<string, string> = {
  aaron: 'aaron@demo.coop',
  marie: 'marie@demo.coop',
  theo: 'theo@demo.coop',
  dana: 'dana@demo.coop',
  nia: 'nia@demo.coop',
};

/**
 * The seeded demo account's fixed TOTP secret, keyed by BOTH username AND email
 * (all lowercase) so either identifier form resolves. auth-e2e imports this to
 * compute a live challenge code; the seed reads it per-username to enroll.
 */
export const FIXTURE_TOTP_SECRETS: Record<string, string> = Object.fromEntries(
  Object.entries(BY_USERNAME).flatMap(([username, secret]) => [
    [username, secret],
    [EMAIL_BY_USERNAME[username], secret],
  ]),
);

/** The usernames the seed enrolls (drives dump-demo-creds + seed iteration). */
export const FIXTURE_USERNAMES = Object.keys(BY_USERNAME);

/** Fixed backup codes every demo account boots with (shown by dump-demo-creds). */
export const DEMO_BACKUP_CODES = [
  'demo-aaaa',
  'demo-bbbb',
  'demo-cccc',
  'demo-dddd',
  'demo-eeee',
] as const;

/** The `otpauth://` provisioning URI for a demo account (by username or email). */
export function demoTotpUri(identifier: string, email: string): string {
  const secret = FIXTURE_TOTP_SECRETS[identifier.toLowerCase()];
  if (!secret) throw new Error(`no demo TOTP secret for ${identifier}`);
  return totpUri(email, secret);
}

/** A live 6-digit code for a demo account right now (by username or email). */
export function deriveDemoTotpCode(identifier: string): string {
  const secret = FIXTURE_TOTP_SECRETS[identifier.toLowerCase()];
  if (!secret) throw new Error(`no demo TOTP secret for ${identifier}`);
  return currentTotpCode(secret);
}
