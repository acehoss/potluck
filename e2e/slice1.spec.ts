import { expect, test } from '@playwright/test';

/**
 * Slice 1 acceptance: auth, invite-only registration, and the household
 * dashboard, exercised against the real compose stack seeded with
 * SEED_DEMO=1 (see prisma/seed.ts for the fixtures).
 */

const PASSWORD = 'demo-password';

async function login(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('your household')).toBeVisible();
}

test('anonymous visitors are redirected to login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Private Coop' })).toBeVisible();
});

test('a member signs in and sees every household and pantry', async ({ page }) => {
  await login(page, 'aaron@demo.coop');

  const cards = page.getByTestId('household-card');
  await expect(cards).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Heise' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'In-Laws' })).toBeVisible();
  await expect(page.getByText('Basement Pantry')).toHaveCount(2);
  await expect(page.getByText('Aaron', { exact: true })).toBeVisible();
  await expect(page.getByText('Dana', { exact: true })).toBeVisible();

  // The other household's card shows the ledger placeholder, not yours.
  await expect(page.getByText('Net position:')).toHaveCount(1);
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
  const invitee = `Terry-${testInfo.project.name}`;
  await login(page, 'aaron@demo.coop');

  await page.getByPlaceholder('Name (optional)').fill(invitee);
  await page.getByRole('button', { name: 'Invite a member' }).click();
  const inviteUrl = await page.getByTestId('invite-url').textContent();
  expect(inviteUrl).toContain('/invite/');

  // Fresh browser state: the invitee opens the link, not the inviter.
  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await expect(page.getByText('invited to join the Heise household')).toBeVisible();
  await expect(page.getByLabel('Your name')).toHaveValue(invitee);

  await page.getByLabel('Email').fill(`terry-${testInfo.project.name}@demo.coop`);
  await page.getByLabel('Password').fill('terry-password-123');
  await page.getByRole('button', { name: 'Join household' }).click();

  await expect(page.getByText('your household')).toBeVisible();
  const heiseCard = page.getByTestId('household-card').filter({ hasText: 'Heise' });
  await expect(heiseCard.getByText(invitee, { exact: true })).toBeVisible();
});

test('an invite link cannot be used twice', async ({ page }, testInfo) => {
  await login(page, 'dana@demo.coop');

  await page.getByRole('button', { name: 'Invite a member' }).click();
  const inviteUrl = await page.getByTestId('invite-url').textContent();

  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await page.getByLabel('Your name').fill(`Robin-${testInfo.project.name}`);
  await page.getByLabel('Email').fill(`robin-${testInfo.project.name}@demo.coop`);
  await page.getByLabel('Password').fill('robin-password-123');
  await page.getByRole('button', { name: 'Join household' }).click();
  await expect(page.getByText('your household')).toBeVisible();

  await page.context().clearCookies();
  await page.goto(inviteUrl!);
  await expect(page.getByText('invalid, expired, or already used')).toBeVisible();
});

test('signing out ends the session', async ({ page }) => {
  await login(page, 'aaron@demo.coop');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});
