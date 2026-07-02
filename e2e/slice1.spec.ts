import { expect, test } from '@playwright/test';

/**
 * Slice 1 acceptance: auth, invite-only registration, and the household
 * views, exercised against the real compose stack seeded with SEED_DEMO=1
 * (see prisma/seed.ts for the fixtures). Updated for the slice-2 shell:
 * the dashboard became the Pantries tab; members/invites live on /more.
 */

const PASSWORD = 'demo-password';
// Per-run token: registration emails must be fresh when the suite re-runs
// against a still-running stack.
const RUN = Date.now().toString(36);

async function login(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for the actual navigation — 'your household' alone would match the
  // login footer ("…a member of your household…") before the session lands.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
}

test('anonymous visitors are redirected to login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Private Coop' })).toBeVisible();
});

test('a member signs in and sees every household and pantry', async ({ page }) => {
  await login(page, 'aaron@demo.coop');

  // Pantries tab: both households' pantries, yours first (transparency).
  const groups = page.getByTestId('pantry-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toContainText('Heise');
  await expect(groups.last()).toContainText('In-Laws');
  await expect(page.getByTestId('pantry-row')).toHaveCount(2);

  // Members moved to the More tab.
  await page.goto('/more');
  await expect(page.getByTestId('household-card')).toHaveCount(2);
  await expect(page.getByText('Aaron', { exact: true })).toBeVisible();
  await expect(page.getByText('Dana', { exact: true })).toBeVisible();
});

test('login rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('aaron@demo.coop');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid email or password.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('a member invites someone, who registers and appears in the household', async ({ page }, testInfo) => {
  // Both browser projects share one database — keep invitees distinct.
  const invitee = `Terry-${testInfo.project.name}-${RUN}`;
  await login(page, 'aaron@demo.coop');
  await page.goto('/more');

  await page.getByPlaceholder('Name (optional)').fill(invitee);
  await page.getByRole('button', { name: 'Invite a member' }).click();
  const inviteUrl = await page.getByTestId('invite-url').textContent();
  expect(inviteUrl).toContain('/invite/');

  // Fresh browser state: the invitee opens the link, not the inviter.
  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await expect(page.getByText('invited to join the Heise household')).toBeVisible();
  await expect(page.getByLabel('Your name')).toHaveValue(invitee);

  await page.getByLabel('Email').fill(`terry-${testInfo.project.name}-${RUN}@demo.coop`);
  await page.getByLabel('Password').fill('terry-password-123');
  await page.getByRole('button', { name: 'Join household' }).click();

  await expect(page.getByText('your household')).toBeVisible();
  await page.goto('/more');
  const heiseCard = page.getByTestId('household-card').filter({ hasText: 'Heise' });
  await expect(heiseCard.getByText(invitee, { exact: true })).toBeVisible();
});

test('an invite link cannot be used twice', async ({ page }, testInfo) => {
  await login(page, 'dana@demo.coop');
  await page.goto('/more');

  await page.getByRole('button', { name: 'Invite a member' }).click();
  const inviteUrl = await page.getByTestId('invite-url').textContent();

  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await page.getByLabel('Your name').fill(`Robin-${testInfo.project.name}-${RUN}`);
  await page.getByLabel('Email').fill(`robin-${testInfo.project.name}-${RUN}@demo.coop`);
  await page.getByLabel('Password').fill('robin-password-123');
  await page.getByRole('button', { name: 'Join household' }).click();
  await expect(page.getByText('your household')).toBeVisible();

  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await expect(page.getByText('invalid, expired, or already used')).toBeVisible();
});

test('signing out ends the session', async ({ page }) => {
  await login(page, 'aaron@demo.coop');
  await page.goto('/more');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});
