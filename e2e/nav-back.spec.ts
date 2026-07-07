import { expect, test } from '@playwright/test';
import { apiLogin, autoDismissFirstRun, gotoStable, login, openHome } from './helpers';

/**
 * History-aware back navigation (Round Q6). Hardcoded back hrefs lie when a page
 * is reachable from several places, so BackLink (src/app/nav-history.tsx) uses a
 * per-tab sessionStorage nav stack: with an in-app previous page it `router.back()`s
 * where the user actually came from; opened cold on a deep link it falls back to a
 * sensible parent instead. NavTracker (mounted once in the layout) records each
 * pathname. Testid `back-link`; the fallback is also its href (middle-click sane).
 *
 * Coverage:
 *  1. TRACKED — reach /items from /home in-app, then back-link returns to /home
 *     (the real previous page), not a hardcoded target.
 *  2. DEEP LINK — a FRESH tab opened straight on /items (empty stack) → back-link
 *     lands on the fallback /home. Built from an apiLogin session so the tab's
 *     first in-app navigation IS /items (no bounce through /login to seed the stack).
 *  3. Plan is a top-level tab → it has NO back control at all (Aaron's call).
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

test('back-link returns to the real previous page (/home → Items → back → /home)', async ({
  page,
}) => {
  await login(page, 'aaron'); // lands on / (Neighbors)
  await openHome(page); // /home — the page we expect to come back to
  await gotoStable(page, '/items');
  await expect(page).toHaveURL(/\/items$/);

  const back = page.getByTestId('back-link');
  await expect(back).toBeVisible();
  // href is the fallback, but with an in-app history the click goes router.back().
  await expect(back).toHaveAttribute('href', '/home');
  await back.click();
  await expect(page).toHaveURL(/\/home$/);
});

test('back-link falls back to /home on a cold deep link to /items', async ({ browser }) => {
  // An authenticated session with NO browser history, so the fresh tab's first
  // in-app navigation is /items itself (stack length 1 → push the fallback).
  const authed = await apiLogin('aaron');
  const context = await browser.newContext({ baseURL: BASE, storageState: await authed.storageState() });
  try {
    const page = await context.newPage();
    await autoDismissFirstRun(page); // no-op for seeded aaron; harmless
    await gotoStable(page, '/items');
    await expect(page).toHaveURL(/\/items$/);

    const back = page.getByTestId('back-link');
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/home$/);
  } finally {
    await context.close();
    await authed.dispose();
  }
});

test('the app body sizes to the dynamic viewport (min-h-dvh) so the tab bar rides the visual viewport', async ({
  page,
}) => {
  // Round T1: the body height chain moved from percentage (min-h-full, which
  // resolves against the stale toolbar-expanded layout viewport and stranded the
  // fixed bottom tab bar ~40px up on short pages) to min-h-dvh. Assert the class
  // is present on <body> — reverting to min-h-full (or any percentage height)
  // reintroduces the iOS-Safari tab-bar drift and fails here.
  await login(page, 'aaron');
  const bodyClass = await page.evaluate(() => document.body.className);
  expect(bodyClass.split(/\s+/)).toContain('min-h-dvh');
  expect(bodyClass.split(/\s+/)).not.toContain('min-h-full');
});

test('a Done-style round trip does not loop the back stack (view → Cook → Done → back)', async ({
  page,
}) => {
  // Round T follow-up (Aaron's report): cook-done pushes BACK to the recipe view,
  // which the tracker used to record as a FORWARD hop — the view's back-link then
  // "returned" to /cook. NavTracker now collapses an A→B→A round trip as a pop,
  // so back from the view goes where the user originally came from (/recipes).
  await login(page, 'aaron');
  const created = await page.request.post(`${BASE}/api/trpc/recipe.create`, {
    data: {
      title: `Navloop ${Date.now().toString(36)}`,
      servings: 2,
      directions: 'Step one.\nStep two.',
      ingredients: [{ kind: 'item', amount: '1', unit: 'cup', text: 'stock' }],
    },
  });
  const recipeId = (await created.json()).result.data.id as string;
  try {
    await gotoStable(page, '/recipes');
    await gotoStable(page, `/recipes/${recipeId}`);
    await page.getByTestId('recipe-cook').click();
    await expect(page).toHaveURL(/\/cook$/);
    await page.getByTestId('cook-done').click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${recipeId}$`));
    // The regression: this used to bounce forward to /cook again.
    await page.getByTestId('back-link').click();
    await expect(page).toHaveURL(/\/recipes$/);
  } finally {
    await page.request.post(`${BASE}/api/trpc/recipe.delete`, { data: { id: recipeId } });
  }
});

test('Plan is a top-level tab and shows no back control', async ({ page }) => {
  await login(page, 'aaron');
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Plan' }).click();
  await expect(page).toHaveURL(/\/plan$/);
  // No history-aware BackLink, and not the old hardcoded "Back to home" arrow
  // either (both would be wrong on a top-level tab).
  await expect(page.getByTestId('back-link')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to home' })).toHaveCount(0);
});
