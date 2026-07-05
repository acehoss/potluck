import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { PROC, TESTID, fixtureTotpCode } from './auth-fixtures';

/**
 * Shared login helpers for the e2e suite. Identity is now username-or-email
 * (REWORK A2 — the server disambiguates on '@'); seeded users are aaron,
 * marie, dana, all with this password.
 *
 * Phase-3 Round B: seeded accounts may boot MFA-enrolled (N10 — `aaron`, the
 * instance admin, always is). When they do, `auth.login` returns an mfaRequired
 * challenge instead of a session, so BOTH helpers below complete the second
 * factor transparently with a computed TOTP code (fixture secret + otplib).
 * This keeps all ~230 existing login call sites working AND exercises the
 * admin-required-TOTP path on every aaron login. The branch is inert until an
 * account is actually enrolled (login just returns `{id,name}`), so the change
 * is backward-compatible with the pre-Round-B stack.
 */
export const PASSWORD = 'demo-password';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

/** The canonical UI login: identifier is a username OR an email. */
export async function login(page: Page, identifier: string) {
  await page.goto('/login');
  // An already-authenticated page bounces off /login (server redirect) and
  // the form never renders — sign out and come back, so tests can switch
  // users on one page without per-test logout ceremony.
  if (!/\/login$/.test(page.url())) {
    await page.request.post('/api/trpc/auth.logout', { data: {} });
    await page.goto('/login');
  }
  await page.getByLabel('Username or email').fill(identifier);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Post-password, one of two things renders: the app shell (no MFA) or the
  // MFA-challenge input (enrolled account). Wait for EITHER so we never hang on
  // the branch that didn't happen, then complete the challenge if it appeared.
  const mfaInput = page.getByTestId(TESTID.loginMfaInput);
  await expect(page.getByTestId('tab-bar').or(mfaInput)).toBeVisible();
  if (await mfaInput.isVisible().catch(() => false)) {
    // A fixture TOTP step is single-use; clear the last-consumed marker
    // server-side (SEED_DEMO dev route) before this setup challenge so the
    // computed code is never a same-window replay across the suite's many logins.
    await page.request.post('/api/dev/mfa-reset-step', { data: { identifier } }).catch(() => {});
    // Complete the challenge, retrying once with a freshly computed code — the
    // only expected rejection here is a TOTP step that rolled between generation
    // and validation (a ~1-in-15 boundary), which a recompute one step later
    // fixes. A second rejection is a real failure and surfaces.
    for (let attempt = 0; attempt < 2; attempt++) {
      await mfaInput.fill(fixtureTotpCode(identifier));
      // The challenge submit is testid'd; its label is "Verify and sign in"
      // (NOT "Sign in"), so match on the testid, never the button name.
      await page.getByTestId(TESTID.loginMfaSubmit).click();
      try {
        await expect(page).toHaveURL(/\/$/, { timeout: 5_000 });
        break;
      } catch (e) {
        if (attempt === 1) throw e; // failed twice — a genuine MFA failure
      }
    }
  }
  // Wait for the actual navigation — 'your household' alone would match the
  // login footer ("…a member of your household…") before the session lands.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
}

/**
 * Round-E IA flip (2026-07-04): the bottom tabs are Neighbors(/) · Plan · Home ·
 * More. The acting household's pantry cards + Receive FAB moved to /home; the
 * root became the Neighbors dashboard (attention · shares · per-household
 * sections). Ledger/Orders/Items kept their ROUTES but lost their tabs, so the
 * suite reaches them with page.goto(). These two helpers are the suite's single
 * source of truth for the moved tab destinations — if the shell relabels a tab
 * or moves a route, this is the one place to fix.
 */

/** Home tab: the acting household's pantry cards (pantry-group / pantry-row). */
export async function openHome(page: Page) {
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/** Neighbors tab: the network dashboard at the root. */
export async function openNeighbors(page: Page) {
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Neighbors' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * page.goto that tolerates WebKit's "interrupted by another navigation" race:
 * the App Router occasionally issues a soft navigation to the same URL while a
 * goto is still loading (seen on /ledger after the Round-E flip moved these
 * reads off a tab click onto a full goto), which aborts the goto even though the
 * page ends up exactly where we asked. Retry on that one error only.
 */
export async function gotoStable(page: Page, url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url);
      return;
    } catch (e) {
      if (!/interrupted by another navigation/i.test(String(e))) throw e;
    }
  }
  await page.goto(url);
}

/**
 * A signed-in raw-API session with NO browser page. The push tests drive
 * their second/third users purely through the API, and WebKit intermittently
 * hangs the first navigation of second-and-later browser contexts on long
 * runs (traced: dana's goto('/login') never even issued a request while the
 * server sat idle) — so those users skip the browser entirely.
 */
export async function apiLogin(identifier: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  const res = await ctx.post(`/api/trpc/${PROC.login}`, {
    data: { identifier, password: PASSWORD },
  });
  expect(res.ok(), `login ${identifier} → ${res.status()}`).toBe(true);
  // Enrolled accounts get an mfaRequired challenge instead of a session; the
  // ctx retains cookies across requests, so completing the second factor here
  // lands the real session on the SAME context. (Inert for non-enrolled: the
  // response is `{id,name}` with no `mfaRequired`.)
  const data = (await res.json())?.result?.data as { mfaRequired?: boolean; pendingToken?: string };
  if (data?.mfaRequired) {
    // See login(): clear the single-use TOTP step before challenging so a
    // fixture code reused within its 30s window isn't replay-rejected.
    await ctx.post('/api/dev/mfa-reset-step', { data: { identifier } }).catch(() => {});
    // Retry once with a fresh code to absorb a TOTP step-boundary roll between
    // generation and validation (same rationale as the browser `login` above).
    let challenge = await ctx.post(`/api/trpc/${PROC.mfaChallenge}`, {
      data: { pendingToken: data.pendingToken, code: fixtureTotpCode(identifier) },
    });
    if (!challenge.ok()) {
      challenge = await ctx.post(`/api/trpc/${PROC.mfaChallenge}`, {
        data: { pendingToken: data.pendingToken, code: fixtureTotpCode(identifier) },
      });
    }
    expect(challenge.ok(), `mfaChallenge ${identifier} → ${challenge.status()}`).toBe(true);
  }
  return ctx;
}
