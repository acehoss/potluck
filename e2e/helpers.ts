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
  await page.getByLabel('Username or email').fill(identifier);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for the actual navigation — 'your household' alone would match the
  // login footer ("…a member of your household…") before the session lands.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
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
