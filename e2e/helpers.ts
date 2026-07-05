import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

/**
 * Shared login helpers for the e2e suite. Identity is now username-or-email
 * (REWORK A2 — the server disambiguates on '@'); seeded users are aaron,
 * marie, dana, all with this password.
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
  const res = await ctx.post('/api/trpc/auth.login', {
    data: { identifier, password: PASSWORD },
  });
  expect(res.ok()).toBe(true);
  return ctx;
}
