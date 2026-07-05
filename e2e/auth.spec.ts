import { execFileSync } from 'node:child_process';
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { apiLogin, PASSWORD } from './helpers';
import { PROC, fixtureSecretFor, fixtureTotpCode, totpCode } from './auth-fixtures';

/**
 * Phase-3 Round-B acceptance — the account-security flows (email verification,
 * password reset, TOTP + emailed-code MFA, admin-required TOTP). Runs on the
 * fixture stack in MAIL_MODE=capture: every transactional send lands in
 * `CapturedEmail` and this spec reads the token/code back through the
 * better-sqlite3 container seam (connections.spec.ts:44 / mail.spec.ts). TOTP
 * codes are computed with otplib from the enrollment secret (fresh accounts) or
 * the committed fixture secret (seeded `aaron`, the N10 durability proof).
 *
 * ISOLATION (restore-invariant): the seeded three-household topology is
 * load-bearing for every other spec, so this file NEVER enrolls or resets a
 * seeded account. It bootstraps EPHEMERAL accounts through the REAL invite flow
 * (aaron mints `invite.createHousehold`; the newcomer `auth.acceptInvite`s),
 * scoped to `@authb.test` emails + `authb-` slugs, and a container-seam sweep
 * removes them plus every auth artifact (tokens/codes/backup) and CapturedEmail
 * row they produced — pre-clean AND in `finally`. The one seeded account it
 * touches is `aaron`, read-only (it only completes his login challenge).
 *
 * INTEGRATION NOTE: awaits auth-server B1 (procedures in `auth-fixtures.PROC`,
 * the new auth tables, the durable fixture TOTP secret) and rides Round A's
 * CapturedEmail table. Both engines on the coordinator's gate stack.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);

/** Run a Node one-liner inside the app container (connections.spec.ts:44). */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

/**
 * Remove every ephemeral account this spec creates (any run) and every auth
 * artifact tied to it. Households founded via `acceptInvite` get pantries +
 * circles + the first Connection edge (to the inviter's household), so FK order
 * matters — same teardown shape as onboarding.spec, extended with the Round-B
 * auth tables and the CapturedEmail rows. Reaches around the product's
 * append-only guards; this is test teardown, not an app flow.
 */
const sweep = `
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
  const users = db.prepare("SELECT id FROM User WHERE email LIKE '%@authb.test'").all().map(r => r.id);
  const hhs = db.prepare("SELECT id FROM Household WHERE slug LIKE 'authb%'").all().map(r => r.id);
  for (const uid of users) {
    // Round-B auth artifacts (cascade on user delete anyway, but be explicit so
    // a leftover FK never blocks the User delete on any engine).
    for (const t of ['EmailVerificationToken','PasswordResetToken','MfaBackupCode','EmailMfaCode']) {
      try { db.prepare('DELETE FROM ' + t + ' WHERE userId = ?').run(uid); } catch (e) {}
    }
    // Invites this user consumed (the household invite aaron minted for them).
    try { db.prepare('DELETE FROM Invite WHERE usedById = ?').run(uid); } catch (e) {}
  }
  for (const id of hhs) {
    db.prepare("DELETE FROM Invite WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Pantry WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Membership WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM LedgerEntry WHERE creditorHouseholdId = ? OR debtorHouseholdId = ?").run(id, id);
    db.prepare("DELETE FROM Connection WHERE householdAId = ? OR householdBId = ?").run(id, id);
    db.prepare("DELETE FROM PantryCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM ItemCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM MembershipCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM Circle WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Household WHERE id = ?").run(id);
  }
  for (const id of users) {
    db.prepare("DELETE FROM Session WHERE userId = ?").run(id);
    db.prepare("DELETE FROM Membership WHERE userId = ?").run(id);
    db.prepare("DELETE FROM User WHERE id = ?").run(id);
  }
  db.prepare("DELETE FROM CapturedEmail WHERE originalTo LIKE '%@authb.test'").run();
`;

type CapturedRow = { id: string; kind: string; subject: string; textBody: string; htmlBody: string | null };

/** Latest CapturedEmail of a given kind to a given recipient, or null. */
function latestEmail(originalTo: string, kind: string): CapturedRow | null {
  const out = execInApp(
    `const Database = require('better-sqlite3');
     const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
     const row = db.prepare('SELECT id, kind, subject, textBody, htmlBody FROM CapturedEmail WHERE originalTo = ? AND kind = ? ORDER BY createdAt DESC, id DESC LIMIT 1').get(${JSON.stringify(originalTo)}, ${JSON.stringify(kind)});
     process.stdout.write(JSON.stringify(row ?? null));`,
  );
  return JSON.parse(out.trim() || 'null');
}

type UserRow = {
  id: string;
  emailVerifiedAt: string | null;
  totpSecret: string | null;
  totpEnabledAt: string | null;
  mfaEmailEnabled: number;
};

/** Read the Round-B auth columns off a User row by email, or null. */
function userRow(email: string): UserRow | null {
  const out = execInApp(
    `const Database = require('better-sqlite3');
     const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
     const row = db.prepare('SELECT id, emailVerifiedAt, totpSecret, totpEnabledAt, mfaEmailEnabled FROM User WHERE email = ?').get(${JSON.stringify(email)});
     process.stdout.write(JSON.stringify(row ?? null));`,
  );
  return JSON.parse(out.trim() || 'null');
}

/** Count live Session rows for a user (proves reset revoked them). */
function sessionCount(userId: string): number {
  const out = execInApp(
    `const Database = require('better-sqlite3');
     const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
     process.stdout.write(String(db.prepare('SELECT COUNT(*) c FROM Session WHERE userId = ?').get(${JSON.stringify(userId)}).c));`,
  );
  return Number(out.trim());
}

/** The raw token in a `/verify?token=…` or `/reset?token=…` link (base64url). */
function tokenFromLink(textBody: string): string {
  const m = textBody.match(/[?&]token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no ?token= in email body:\n${textBody}`);
  return m[1];
}

/** The 6-digit emailed MFA code from the body. */
function codeFromEmail(textBody: string): string {
  const m = textBody.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`no 6-digit code in email body:\n${textBody}`);
  return m[1];
}

/** POST a tRPC mutation on a context; return the raw {status, body} envelope. */
async function rpc(ctx: APIRequestContext, proc: string, data: Record<string, unknown>) {
  const res = await ctx.post(`/api/trpc/${proc}`, { data });
  return { status: res.status(), body: (await res.json().catch(() => null)) as any };
}

/** POST and assert 200, returning result.data. */
async function ok(ctx: APIRequestContext, proc: string, data: Record<string, unknown>) {
  const r = await rpc(ctx, proc, data);
  expect(r.status, `${proc} ${JSON.stringify(data)} → ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result.data;
}

/**
 * Clear an account's TOTP replay-step guard via the SEED_DEMO dev route
 * (`POST /api/dev/mfa-reset-step {identifier}` → `{ok,cleared}`). The server
 * rejects a TOTP code whose step is ≤ the last CONSUMED step; enroll-confirm and
 * every prior challenge consume the current 30s step, so reusing a freshly
 * computed code inside that same window reads as a replay. Call this right
 * before any TOTP challenge that MUST succeed — NEVER before one asserted to be
 * replay-rejected.
 */
async function resetTotpStep(ctx: APIRequestContext, identifier: string) {
  const res = await ctx.post('/api/dev/mfa-reset-step', { data: { identifier } });
  expect(res.ok(), `mfa-reset-step ${identifier} → ${res.status()}`).toBe(true);
}

/**
 * Bootstrap a fresh, isolated account through the REAL invite flow: aaron mints
 * a household invite, the newcomer accepts it (founding their own `authb-`
 * household) and lands signed in. Returns the newcomer's own signed-in context
 * + identifiers. The verification email fires as a side effect of acceptInvite.
 */
async function bootstrapAccount(
  aaron: APIRequestContext,
  tag: string,
): Promise<{ ctx: APIRequestContext; email: string; username: string; userId: string }> {
  const minted = await ok(aaron, 'invite.createHousehold', {
    grants: { pantry: true, lending: true, recipes: true, shareTo: true, shareFrom: true, reshare: false },
  });
  const token = (minted.path as string).split('/invite/')[1];
  const email = `${tag}-${RUN}@authb.test`;
  const username = `${tag}-${RUN}`;
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  await ok(ctx, 'auth.acceptInvite', {
    token,
    name: `Authb ${tag}`,
    username,
    email,
    password: PASSWORD,
    householdName: `Authb ${tag} ${RUN}`,
  });
  const row = userRow(email);
  if (!row) throw new Error(`bootstrap failed: no User for ${email}`);
  return { ctx, email, username, userId: row.id };
}

test.beforeAll(() => {
  execInApp(sweep);
});
test.afterAll(() => {
  execInApp(sweep);
});

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------
test.describe('email verification', () => {
  test('accept invite emails a verify link; the token verifies once; resend is rate-limited', async ({}, testInfo) => {
    const aaron = await apiLogin('aaron');
    let acct: Awaited<ReturnType<typeof bootstrapAccount>> | null = null;
    try {
      acct = await bootstrapAccount(aaron, `verify-${testInfo.project.name}`);

      // New accounts start UNVERIFIED (usable, but the banner shows).
      expect(userRow(acct.email)!.emailVerifiedAt, 'unverified at signup').toBeNull();

      // acceptInvite fired a transactional `verify` email carrying the token.
      const mail = latestEmail(acct.email, 'verify');
      expect(mail, 'a verify email was captured').not.toBeNull();
      const token = tokenFromLink(mail!.textBody);

      // Consuming the token stamps emailVerifiedAt.
      await ok(acct.ctx, PROC.verifyEmail, { token });
      expect(userRow(acct.email)!.emailVerifiedAt, 'verified after consuming the token').not.toBeNull();

      // Single-use + enumeration-safe: replaying the used token and a bogus one
      // both return a generic 200 result — never a distinguishing error that
      // would leak which tokens are real/consumed.
      const replay = await rpc(acct.ctx, PROC.verifyEmail, { token });
      expect(replay.status, 'used token → generic result, not an error').toBe(200);
      const bogus = await rpc(acct.ctx, PROC.verifyEmail, { token: 'not-a-real-token' });
      expect(bogus.status, 'unknown token → generic result, not an error').toBe(200);

      // Resend is rate-limited: after a burst the protected endpoint 429s.
      let sawLimit = false;
      for (let i = 0; i < 12; i++) {
        const r = await rpc(acct.ctx, PROC.resendVerification, {});
        if (r.status === 429) { sawLimit = true; break; }
      }
      expect(sawLimit, 'resendVerification trips its rate limit within a burst').toBe(true);
    } finally {
      if (acct) await acct.ctx.dispose();
      await aaron.dispose();
      execInApp(sweep);
    }
  });
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------
test.describe('password reset', () => {
  test('enumeration-safe request; the token resets the password, revokes sessions, and logs in', async ({}, testInfo) => {
    const aaron = await apiLogin('aaron');
    let acct: Awaited<ReturnType<typeof bootstrapAccount>> | null = null;
    try {
      acct = await bootstrapAccount(aaron, `reset-${testInfo.project.name}`);

      // A request for a NONEXISTENT identifier returns the same generic 200 and
      // sends nothing — no oracle for account existence.
      const ghost = `ghost-${RUN}-${testInfo.project.name}@authb.test`;
      const ghostRes = await rpc(acct.ctx, PROC.requestPasswordReset, { identifier: ghost });
      expect(ghostRes.status, 'unknown identifier → generic 200').toBe(200);
      expect(latestEmail(ghost, 'reset'), 'no email for a nonexistent account').toBeNull();

      // A request for the REAL account emails a reset link.
      await ok(acct.ctx, PROC.requestPasswordReset, { identifier: acct.email });
      const mail = latestEmail(acct.email, 'reset');
      expect(mail, 'a reset email was captured').not.toBeNull();
      const token = tokenFromLink(mail!.textBody);

      // Resetting revokes every existing session…
      expect(sessionCount(acct.userId), 'has a live session before reset').toBeGreaterThan(0);
      const NEW_PASSWORD = 'reset-password-99';
      await ok(acct.ctx, PROC.resetPassword, { token, newPassword: NEW_PASSWORD });
      expect(sessionCount(acct.userId), 'reset revoked all sessions').toBe(0);

      // …the old context is now logged out (session gone)…
      const stale = await acct.ctx.get('/api/trpc/household.overview');
      expect(stale.status(), 'pre-reset session no longer authorizes').toBe(401);

      // …and the NEW password logs in (no MFA on this account → plain session).
      const fresh = await playwrightRequest.newContext({ baseURL: BASE });
      try {
        const relogin = await rpc(fresh, PROC.login, { identifier: acct.username, password: NEW_PASSWORD });
        expect(relogin.status, 'new password logs in').toBe(200);
        expect(relogin.body.result.data.mfaRequired, 'no MFA on this account').toBeFalsy();
      } finally {
        await fresh.dispose();
      }

      // The token is single-use — replaying it fails.
      const replay = await rpc(acct.ctx, PROC.resetPassword, { token, newPassword: 'another-pw-123' });
      expect(replay.status, 'used reset token is rejected').not.toBe(200);
    } finally {
      if (acct) await acct.ctx.dispose();
      await aaron.dispose();
      execInApp(sweep);
    }
  });

  test('a TOTP-enrolled account cannot reset without a valid code', async ({}, testInfo) => {
    const aaron = await apiLogin('aaron');
    let acct: Awaited<ReturnType<typeof bootstrapAccount>> | null = null;
    try {
      acct = await bootstrapAccount(aaron, `resetmfa-${testInfo.project.name}`);

      // Enroll TOTP so the reset must not become a second-factor bypass.
      const begin = await ok(acct.ctx, PROC.mfaBegin, { method: 'totp' });
      const secret = begin.secret as string;
      await ok(acct.ctx, PROC.mfaConfirm, { method: 'totp', code: totpCode(secret) });

      await ok(acct.ctx, PROC.requestPasswordReset, { identifier: acct.email });
      const token = tokenFromLink(latestEmail(acct.email, 'reset')!.textBody);

      // Without a code the reset is refused for an enrolled user.
      const noCode = await rpc(acct.ctx, PROC.resetPassword, { token, newPassword: 'no-code-pw-1' });
      expect(noCode.status, 'enrolled reset without a code is refused').not.toBe(200);

      // confirmTotp above consumed the current step; clear the replay guard so
      // the with-code reset (same 30s window) isn't rejected as a replay.
      await resetTotpStep(acct.ctx, acct.email);

      // With a valid TOTP code it succeeds (same token, still unused).
      const withCode = await rpc(acct.ctx, PROC.resetPassword, {
        token,
        newPassword: 'with-code-pw-1',
        code: totpCode(secret),
      });
      expect(withCode.status, 'enrolled reset with a valid code succeeds').toBe(200);
    } finally {
      if (acct) await acct.ctx.dispose();
      await aaron.dispose();
      execInApp(sweep);
    }
  });
});

// ---------------------------------------------------------------------------
// TOTP: enroll → challenge → backup code → replay
// ---------------------------------------------------------------------------
test.describe('TOTP MFA', () => {
  test('enroll, then login challenges; backup code works once; a replayed code is rejected', async ({}, testInfo) => {
    const aaron = await apiLogin('aaron');
    let acct: Awaited<ReturnType<typeof bootstrapAccount>> | null = null;
    try {
      acct = await bootstrapAccount(aaron, `totp-${testInfo.project.name}`);

      // Enrollment: begin returns a secret + otpauth URI + QR; confirm with a
      // live code flips it on and returns one-time backup codes.
      const begin = await ok(acct.ctx, PROC.mfaBegin, { method: 'totp' });
      const secret = begin.secret as string;
      expect(begin.otpauthUri, 'otpauth URI').toMatch(/^otpauth:\/\/totp\//);
      expect(String(begin.qrDataUrl), 'QR is a data URL').toMatch(/^data:image\//);
      // Not enrolled until confirmed.
      expect(userRow(acct.email)!.totpEnabledAt, 'not enrolled before confirm').toBeNull();

      const confirm = await ok(acct.ctx, PROC.mfaConfirm, { method: 'totp', code: totpCode(secret) });
      const backupCodes = confirm.backupCodes as string[];
      expect(Array.isArray(backupCodes) && backupCodes.length >= 8, 'backup codes issued').toBe(true);
      const row = userRow(acct.email)!;
      expect(row.totpEnabledAt, 'enrolled after confirm').not.toBeNull();
      expect(row.totpSecret, 'secret stored (encrypted blob, not the base32)').not.toBeNull();
      expect(row.totpSecret, 'stored secret is NOT the plaintext base32').not.toBe(secret);

      // Login now returns a challenge instead of a session.
      const login1 = await rpc(acct.ctx, PROC.login, { identifier: acct.username, password: PASSWORD });
      expect(login1.status).toBe(200);
      expect(login1.body.result.data.mfaRequired, 'enrolled login challenges').toBe(true);
      const pending1 = login1.body.result.data.pendingToken as string;
      expect(pending1, 'challenge carries a pending token').toBeTruthy();

      // confirmTotp consumed the enrollment step; clear the guard so this first
      // real challenge (same 30s window) succeeds.
      await resetTotpStep(acct.ctx, acct.username);
      // A computed TOTP code completes the challenge.
      const done = await rpc(acct.ctx, PROC.mfaChallenge, { pendingToken: pending1, code: totpCode(secret) });
      expect(done.status, 'valid TOTP completes sign-in').toBe(200);

      // A BACKUP code completes a fresh challenge — and only ONCE.
      const login2 = await rpc(acct.ctx, PROC.login, { identifier: acct.username, password: PASSWORD });
      const pending2 = login2.body.result.data.pendingToken as string;
      const back1 = await rpc(acct.ctx, PROC.mfaChallenge, { pendingToken: pending2, code: backupCodes[0] });
      expect(back1.status, 'backup code works').toBe(200);

      const login3 = await rpc(acct.ctx, PROC.login, { identifier: acct.username, password: PASSWORD });
      const pending3 = login3.body.result.data.pendingToken as string;
      const back2 = await rpc(acct.ctx, PROC.mfaChallenge, { pendingToken: pending3, code: backupCodes[0] });
      expect(back2.status, 'a used backup code is rejected').not.toBe(200);

      // TOTP replay: a code already consumed at a challenge step must not work
      // again at another challenge in the SAME time-step. Compute once and reuse
      // immediately; guard the 30s boundary so the assertion never straddles a
      // step roll (which would legitimately mint a new code).
      const code = totpCode(secret);
      const la = await rpc(acct.ctx, PROC.login, { identifier: acct.username, password: PASSWORD });
      // Clear the guard so the FIRST challenge consumes the step cleanly and
      // succeeds; deliberately do NOT clear before the second (reuse) challenge
      // below — that one MUST stay replay-rejected (the assertion).
      await resetTotpStep(acct.ctx, acct.username);
      const first = await rpc(acct.ctx, PROC.mfaChallenge, { pendingToken: la.body.result.data.pendingToken, code });
      if (first.status === 200 && totpCode(secret) === code) {
        const lb = await rpc(acct.ctx, PROC.login, { identifier: acct.username, password: PASSWORD });
        const second = await rpc(acct.ctx, PROC.mfaChallenge, {
          pendingToken: lb.body.result.data.pendingToken,
          code,
        });
        expect(second.status, 'replaying a consumed TOTP code is rejected').not.toBe(200);
      }
    } finally {
      if (acct) await acct.ctx.dispose();
      await aaron.dispose();
      execInApp(sweep);
    }
  });
});

// ---------------------------------------------------------------------------
// Emailed MFA code
// ---------------------------------------------------------------------------
test.describe('emailed MFA code', () => {
  test('request emails a code; it works once; wrong attempts trip the cap and kill it', async ({}, testInfo) => {
    const aaron = await apiLogin('aaron');
    let acct: Awaited<ReturnType<typeof bootstrapAccount>> | null = null;
    try {
      acct = await bootstrapAccount(aaron, `email-${testInfo.project.name}`);

      // Enroll emailed codes (no TOTP on this account → email is the factor).
      // Per-factor begin/confirm: beginEmail sends a setup code, confirmEmail enables.
      await ok(acct.ctx, PROC.mfaBegin, { method: 'email' });
      const setupCode = codeFromEmail(latestEmail(acct.email, 'mfa')!.textBody);
      await ok(acct.ctx, PROC.mfaConfirm, { method: 'email', code: setupCode });
      expect(userRow(acct.email)!.mfaEmailEnabled, 'emailed MFA enabled after confirm').toBeTruthy();

      // Login challenges; requesting a code (keyed off the pending token) emails it.
      const login1 = await rpc(acct.ctx, PROC.login, { identifier: acct.username, password: PASSWORD });
      expect(login1.body.result.data.mfaRequired, 'enabled login challenges').toBe(true);
      const pending1 = login1.body.result.data.pendingToken as string;
      await ok(acct.ctx, PROC.requestMfaEmailCode, { pendingToken: pending1 });
      const code = codeFromEmail(latestEmail(acct.email, 'mfa')!.textBody);

      const good = await rpc(acct.ctx, PROC.mfaChallenge, { pendingToken: pending1, code });
      expect(good.status, 'the emailed code completes sign-in').toBe(200);

      // Attempt cap: a fresh code dies after enough wrong guesses — after the
      // cap even the CORRECT code no longer works. (Probe generously; reconcile
      // the exact cap with EMAIL_MFA_MAX_ATTEMPTS at the gate.)
      const login2 = await rpc(acct.ctx, PROC.login, { identifier: acct.username, password: PASSWORD });
      const pending2 = login2.body.result.data.pendingToken as string;
      await ok(acct.ctx, PROC.requestMfaEmailCode, { pendingToken: pending2 });
      const realCode = codeFromEmail(latestEmail(acct.email, 'mfa')!.textBody);
      const wrong = realCode === '000000' ? '111111' : '000000';
      for (let i = 0; i < 8; i++) {
        await rpc(acct.ctx, PROC.mfaChallenge, { pendingToken: pending2, code: wrong });
      }
      const capped = await rpc(acct.ctx, PROC.mfaChallenge, { pendingToken: pending2, code: realCode });
      expect(capped.status, 'the code is dead after the attempt cap — even the right code fails').not.toBe(200);
    } finally {
      if (acct) await acct.ctx.dispose();
      await aaron.dispose();
      execInApp(sweep);
    }
  });
});

// ---------------------------------------------------------------------------
// Admin-required TOTP (N10) — the seeded admin boots enrolled and logs in via
// the challenge using the COMMITTED fixture secret. This is the durability
// proof: a fresh `down -v` + re-seed still yields a working enrolled admin.
// ---------------------------------------------------------------------------
test.describe('admin-required TOTP (N10 durability)', () => {
  test('seeded aaron boots TOTP-enrolled and completes the login challenge from the fixture secret', async () => {
    expect(fixtureSecretFor('aaron'), 'a committed fixture TOTP secret exists for aaron').toBeTruthy();

    // The seed itself booted him enrolled — the durability property.
    const row = userRow('aaron@demo.coop');
    expect(row?.totpEnabledAt, 'aaron is enrolled straight out of the seed').not.toBeNull();
    expect(row?.totpSecret, 'his encrypted secret is stored').not.toBeNull();

    // A raw login (bypassing the MFA-aware helper) returns a real challenge…
    const ctx = await playwrightRequest.newContext({ baseURL: BASE });
    try {
      const login = await rpc(ctx, PROC.login, { identifier: 'aaron', password: PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.result.data.mfaRequired, 'admin login is challenged').toBe(true);
      const pendingToken = login.body.result.data.pendingToken as string;

      // A prior apiLogin('aaron') in this 30s window consumed aaron's step (the
      // login helper completes his challenge), so a fresh fixture code would
      // read as a same-window replay. Clear the guard before this challenge.
      await resetTotpStep(ctx, 'aaron');

      // …which the committed fixture secret satisfies via otplib.
      const done = await rpc(ctx, PROC.mfaChallenge, { pendingToken, code: fixtureTotpCode('aaron') });
      expect(done.status, 'the fixture secret completes the admin challenge').toBe(200);

      // The signed-in session is real: a protected read authorizes.
      const overview = await ctx.get('/api/trpc/household.overview');
      expect(overview.ok(), 'the completed challenge yields a working session').toBe(true);
    } finally {
      await ctx.dispose();
    }
  });
});
