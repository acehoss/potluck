import { authenticator } from 'otplib';
import { FIXTURE_TOTP_SECRETS } from '../src/server/mfa/fixtures';

/**
 * Phase-3 Round-B auth fixtures — the single seam between the e2e suite and
 * auth-server's B1 surface. EVERY name that crosses the teammate boundary
 * (tRPC procedure paths, UI testids, the fixture-secret module) is pinned here
 * so a contract delta at the integration gate is a one-line fix in ONE file,
 * not a scatter across specs.
 *
 * INTEGRATION NOTE (awaits auth-server B1.6): imports the PURE leaf
 * `src/server/mfa/fixtures.ts` — string constants only, NO db/next/prisma
 * imports — so the Playwright esbuild loader pulls it in by relative path
 * without dragging server-only deps into the test process. `FIXTURE_TOTP_SECRETS`
 * is keyed by BOTH username and email (base32) so either identifier form
 * resolves. If auth-server ships the secrets differently, only the import above
 * and `fixtureSecretFor` change.
 */

/** The seeded demo account's fixed TOTP secret, by username OR email. */
export function fixtureSecretFor(identifier: string): string | undefined {
  return FIXTURE_TOTP_SECRETS[identifier.toLowerCase()];
}

/** True when the identifier maps to a seeded, already-enrolled demo account. */
export function isEnrolledFixture(identifier: string): boolean {
  return fixtureSecretFor(identifier) !== undefined;
}

/** A live 6-digit TOTP code for a seeded account (drives the login challenge). */
export function fixtureTotpCode(identifier: string): string {
  const secret = fixtureSecretFor(identifier);
  if (!secret) throw new Error(`no fixture TOTP secret for "${identifier}"`);
  return authenticator.generate(secret);
}

/** A live TOTP code for an ARBITRARY base32 secret (freshly enrolled in-test). */
export function totpCode(secret: string): string {
  return authenticator.generate(secret);
}

/**
 * tRPC procedure paths — RATIFIED via the team-lead interface lock
 * (2026-07-05). Login's MFA-challenge second step is public: it carries the
 * pendingToken, not a session. The only still-PROPOSED names are the emailed-
 * code ENROLL pair (beginEmail/confirmEmail) — auth-server confirming.
 */
export const PROC = {
  login: 'auth.login',
  logout: 'auth.logout',
  mfaChallenge: 'auth.mfaChallenge',
  emailStatus: 'auth.emailStatus',
  verifyEmail: 'auth.verifyEmail',
  resendVerification: 'auth.resendVerification',
  requestPasswordReset: 'auth.requestPasswordReset',
  resetPasswordInfo: 'auth.resetPasswordInfo',
  resetPassword: 'auth.resetPassword',
  requestMfaEmailCode: 'auth.requestMfaEmailCode',
  // MFA sub-router — ONE begin/confirm/disable trio parameterized by
  // `method: 'totp' | 'email'` (matches the landed mfa.ts router).
  mfaBegin: 'auth.mfa.begin',
  mfaConfirm: 'auth.mfa.confirm',
  mfaDisable: 'auth.mfa.disable',
} as const;

/**
 * UI testids the login-challenge, MFA-setup, verify, and reset screens expose —
 * RATIFIED (team-lead lock + auth-ui as-built). Only `loginMfaInput`/
 * `loginMfaSubmit` are load-bearing for the shared `login()` helper; the rest
 * document the surface for UI-driven assertions.
 */
export const TESTID = {
  // Login challenge
  loginMfaStep: 'login-mfa-step',
  loginMfaInput: 'login-mfa-input',
  loginMfaSubmit: 'login-mfa-submit', // label "Verify and sign in", NOT "Sign in"
  loginMfaRequestEmail: 'login-mfa-request-email',
  loginMfaBackupToggle: 'login-mfa-backup-toggle',
  // TOTP enrollment (More)
  mfaEnrollStart: 'mfa-enroll-start',
  mfaQr: 'mfa-qr',
  mfaSecret: 'mfa-secret',
  mfaConfirm: 'mfa-confirm',
  backupCodes: 'backup-codes',
  backupCodesAck: 'backup-codes-ack',
  // Emailed-code enrollment (More) — begin/confirm/disable, not a toggle
  mfaEmailSetup: 'mfa-email-setup',
  mfaEmailConfirm: 'mfa-email-confirm',
  mfaEmailConfirmSubmit: 'mfa-email-confirm-submit',
  mfaEmailOn: 'mfa-email-on',
  mfaEmailDisable: 'mfa-email-disable',
  mfaEmailDisableCode: 'mfa-email-disable-code',
  mfaEmailDisableSubmit: 'mfa-email-disable-submit',
  // Verify + reset screens
  verifyBanner: 'verify-banner',
  verifySuccess: 'verify-success',
  forgotForm: 'forgot-form',
  forgotSubmit: 'forgot-submit',
  forgotSent: 'forgot-sent',
  resetForm: 'reset-form',
  resetMfaCode: 'reset-mfa-code',
  resetSubmit: 'reset-submit',
} as const;
