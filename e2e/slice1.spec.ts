import { expect, test } from '@playwright/test';
import { login, openHome } from './helpers';

/**
 * Slice 1 acceptance: auth, invite-only registration, and the household
 * views, exercised against the real compose stack seeded with SEED_DEMO=1
 * (see prisma/seed.ts for the fixtures). Updated for the slice-2 shell:
 * the dashboard became the Pantries tab; members/invites live on /more.
 */

// Per-run token: registration emails must be fresh when the suite re-runs
// against a still-running stack.
const RUN = Date.now().toString(36);

test('anonymous visitors are redirected to login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Potluck' })).toBeVisible();
});

test('a member signs in and sees the households their connections grant', async ({ page }) => {
  await login(page, 'aaron');

  // Neighbors dashboard (the root after the Round-E IA flip): one section per
  // connected counterparty — In-Laws (full grant) and Neighbors (share-only) —
  // and each section carries that household's visible members. In-Laws → Dana.
  const sections = page.getByTestId('neighbors-household-section');
  await expect(sections).toHaveCount(2);
  await expect(sections.filter({ hasText: 'In-Laws' })).toContainText('Dana');
  await expect(sections.filter({ hasText: 'Neighbors' })).toBeVisible();

  // Home tab: the acting household's OWN pantries and members only — the
  // network's pantries/members live on Neighbors, not here (REWORK P1).
  await openHome(page);
  await expect(
    page.getByTestId('home-pantries').getByTestId('pantry-row').filter({ hasText: 'Basement Pantry' }),
  ).toBeVisible();
  await expect(page.getByTestId('home-members').getByText('Aaron', { exact: true })).toBeVisible();
});

test('login rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username or email').fill('aaron@demo.coop');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid username or password.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('login works by username and by email', async ({ page }) => {
  // The username is the identity now, but the email still resolves the same
  // account — the server disambiguates on '@' (REWORK A2).
  await login(page, 'dana');
  // tRPC mutations want a JSON body even when the input is void — a bodyless
  // POST 400s and would leave the session alive (the next login() would then
  // bounce straight off /login's already-signed-in redirect).
  const out = await page.request.post('/api/trpc/auth.logout', { data: {} });
  expect(out.ok()).toBe(true);
  await login(page, 'dana@demo.coop');
});

test('a member invites someone, who registers and appears in the household', async ({ page }, testInfo) => {
  // Both browser projects share one database — keep invitees distinct.
  const invitee = `Terry-${testInfo.project.name}-${RUN}`;
  // Username identity (REWORK A2): lowercase ^[a-z0-9_-]{3,30}$ — truncate the
  // project name to 4 chars so 'terry-<project>-<run>' always fits the cap.
  const username = `terry-${testInfo.project.name.slice(0, 4)}-${RUN}`;
  await login(page, 'aaron');
  // Member management moved to the Home tab in the Round-E IA flip.
  await page.goto('/home');

  await page.getByPlaceholder('Name (optional)').fill(invitee);
  await page.getByRole('button', { name: 'Invite a member' }).click();
  const inviteUrl = await page.getByTestId('invite-url').textContent();
  expect(inviteUrl).toContain('/invite/');

  // Fresh browser state: the invitee opens the link, not the inviter.
  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await expect(page.getByText('invited to join the Heise household')).toBeVisible();
  await expect(page.getByLabel('Your name')).toHaveValue(invitee);

  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Email').fill(`terry-${testInfo.project.name}-${RUN}@demo.coop`);
  await page.getByLabel('Password').fill('terry-password-123');
  await page.getByRole('button', { name: 'Join household' }).click();

  // Signed in, landed on the Neighbors dashboard; they now appear among Heise's
  // members on the Home tab.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
  await page.goto('/home');
  await expect(page.getByTestId('home-members').getByText(invitee, { exact: true })).toBeVisible();
});

test('an invite link cannot be used twice', async ({ page }, testInfo) => {
  await login(page, 'dana');
  await page.goto('/home');

  await page.getByRole('button', { name: 'Invite a member' }).click();
  const inviteUrl = await page.getByTestId('invite-url').textContent();

  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await page.getByLabel('Your name').fill(`Robin-${testInfo.project.name}-${RUN}`);
  await page.getByLabel('Email').fill(`robin-${testInfo.project.name}-${RUN}@demo.coop`);
  await page.getByLabel('Password').fill('robin-password-123');

  // A taken username is rejected (server CONFLICT) before the invite is spent —
  // 'aaron' is always seeded, so this is stable across re-runs.
  await page.getByLabel('Username').fill('aaron');
  await page.getByRole('button', { name: 'Join household' }).click();
  await expect(page.getByText('That username is taken.')).toBeVisible();

  // Correct the username and finish; the invite is only claimed on success.
  await page.getByLabel('Username').fill(`robin-${testInfo.project.name.slice(0, 4)}-${RUN}`);
  await page.getByRole('button', { name: 'Join household' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();

  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await expect(page.getByText('invalid, expired, or already used')).toBeVisible();
});

test('signing out ends the session', async ({ page }) => {
  await login(page, 'aaron');
  await page.goto('/more');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});
