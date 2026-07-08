import { expect, test, type Page } from '@playwright/test';
import { login, openHome } from './helpers';

/**
 * Round 1 slice 2 acceptance — the network core behaves like a network:
 *
 *  - Acting-household switcher (REWORK A3b): multi-membership Marie switches
 *    between Heise and Neighbors and the whole app re-scopes; single-
 *    membership users never see the switcher.
 *  - Connection-scoped visibility (B2/B4): Nia (Neighbors) is share-only
 *    connected to Heise and NOT connected to In-Laws — she sees no foreign
 *    pantry groups, no In-Laws household, and cannot order against a Heise
 *    lot (404, never 403 — existence must not leak).
 *  - Membership capabilities (A3a): Teen-preset Theo can draft an order but
 *    not submit it cross-household (spend), and cannot settle, adjust
 *    inventory, or mint invites.
 *  - Receiving is a pantry-owner action: even a fully-granted counterparty
 *    cannot open a draft against another household's pantry; the purchaser
 *    attribution is constrained to connected households.
 *
 * Seed contract (prisma/seed.ts): Heise (aaron owner + instance admin, marie
 * owner, theo TEEN), In-Laws (dana owner), Neighbors (nia owner, marie
 * ADULT). Heise↔In-Laws full grants; Heise↔Neighbors share-only; In-Laws↔
 * Neighbors unconnected. Rerun-safe: per-run names, created orders canceled.
 */

const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

/** tRPC POST as the page's signed-in user; returns the parsed envelope. */
async function rpc(page: Page, path: string, data: Record<string, unknown>) {
  const res = await page.request.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** The signed-in user's overview (acting household + connected). */
async function overview(page: Page) {
  const res = await page.request.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string; pantries: { id: string; name: string }[] }[];
  };
}

/**
 * Receive one 3-unit lot into the signed-in user's own pantry through the
 * real API (draft → line → finalize), returning ids for cross-household
 * probes. No receipt total ⇒ no variance ⇒ finalize auto-passes.
 */
async function receiveLotApi(page: Page, retailer: string) {
  const data = await overview(page);
  const own = data.households.find((h) => h.id === data.yourHouseholdId)!;
  const pantryId = own.pantries[0].id;
  const created = await rpc(page, 'restock.create', {
    pantryId,
    retailer,
    purchasedAt: new Date().toISOString().slice(0, 10),
    purchaserHouseholdId: data.yourHouseholdId,
    receiptTotalCents: null,
  });
  expect(created.status).toBe(200);
  const restockId = created.body.result.data.id as string;
  const line = await rpc(page, 'restock.saveLine', {
    restockId,
    newProductName: retailer,
    purchasedCount: 3,
    receivedCount: 3,
    lineTotalCents: 300,
    bestBy: null,
  });
  expect(line.status).toBe(200);
  const done = await rpc(page, 'restock.finalize', {
    restockId,
    acknowledgedVarianceCents: null,
  });
  expect(done.status).toBe(200);
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  expect(got.ok()).toBe(true);
  const lots = (await got.json()).result.data.lots as { id: string; stockId: string }[];
  return { pantryId, restockId, lotId: lots[0].id, stockId: lots[0].stockId };
}

test('multi-membership: the switcher re-scopes the whole app; single-membership users never see it', async ({
  page,
  browser,
}) => {
  // Aaron has one membership — no switcher card.
  await login(page, 'aaron');
  await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
  await expect(page.getByRole('heading', { name: 'More' })).toBeVisible();
  await expect(page.getByTestId('household-switcher')).toHaveCount(0);

  // Marie (Heise owner + Neighbors adult) defaults to Heise…
  const marieContext = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  });
  const marie = await marieContext.newPage();
  await login(marie, 'marie');
  let data = await overview(marie);
  expect(data.households.find((h) => h.id === data.yourHouseholdId)?.name).toBe('Heise');

  // …sees the switcher, and switching to Neighbors re-scopes everything:
  // Neighbors becomes "your household", In-Laws (unconnected to Neighbors)
  // disappears, and the Neighbors pantry group is the only one (share-only
  // connection to Heise extends no pantry grant).
  await marie.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
  const switcher = marie.getByTestId('household-switcher');
  await expect(switcher).toBeVisible();
  await expect(switcher).toContainText('Heise');
  await expect(switcher).toContainText('Neighbors');
  await switcher.getByRole('button', { name: 'Switch' }).click();
  await marie.waitForURL(/\/$/);
  await expect(marie.getByTestId('tab-bar')).toBeVisible();

  data = await overview(marie);
  expect(data.households.find((h) => h.id === data.yourHouseholdId)?.name).toBe('Neighbors');
  expect(data.households.map((h) => h.name).sort()).toEqual(['Heise', 'Neighbors']);
  // The Home tab re-scopes too: the acting household is now Neighbors (its name
  // + "your household" head the page), showing its own Garage Shelves pantry.
  await openHome(marie);
  await expect(marie.getByRole('heading', { name: 'Neighbors' })).toBeVisible();
  await expect(marie.getByText('your household')).toBeVisible();
  await expect(
    marie.getByTestId('home-pantries').getByTestId('pantry-row').filter({ hasText: 'Garage Shelves' }),
  ).toBeVisible();

  // The choice is sticky across a fresh load of the app.
  await marie.goto('/home');
  await expect(marie.getByRole('heading', { name: 'Neighbors' })).toBeVisible();
  await expect(
    marie.getByTestId('home-pantries').getByTestId('pantry-row').filter({ hasText: 'Garage Shelves' }),
  ).toBeVisible();

  await marieContext.close();
});

test('unconnected and ungranted households are invisible: Nia sees only her own world', async ({
  page,
}) => {
  await login(page, 'nia');

  // Neighbors dashboard: one household section — the Heise connection — and
  // never In-Laws (unconnected).
  await expect(page.getByTestId('neighbors-household-section')).toHaveCount(1);
  await expect(page.getByTestId('neighbors-household-section')).toContainText('Heise');

  // Home tab — her own Neighbors pantry (Garage Shelves). Heise extends no
  // pantry grant on the share-only edge; In-Laws is not connected at all.
  await openHome(page);
  await expect(
    page.getByTestId('home-pantries').getByTestId('pantry-row').filter({ hasText: 'Garage Shelves' }),
  ).toBeVisible();

  const data = await overview(page);
  expect(data.households.map((h) => h.name).sort()).toEqual(['Heise', 'Neighbors']);
  // Heise is visible as a household but extends no pantry grant — its
  // pantries are not listed. (In-Laws' invisibility is proven above: the
  // Neighbors dashboard shows exactly one section, Heise — never In-Laws.)
  expect(data.households.find((h) => h.name === 'Heise')?.pantries).toEqual([]);
});

test('pantry grant gates ordering: a share-only neighbor gets 404 where a granted household succeeds', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  // Aaron receives a lot into his own pantry (the probe target).
  await login(page, 'aaron');
  const { pantryId, lotId } = await receiveLotApi(page, uniq('Probe Beans', P));

  // Nia (share-only connection): the lot reads as NOT FOUND — no pantry
  // grant means no existence leak, not a 403.
  const niaContext = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  });
  const nia = await niaContext.newPage();
  await login(nia, 'nia');
  const denied = await rpc(nia, 'order.addToCart', { pantryId, lotId, quantity: 1 });
  expect(denied.status).toBe(404);
  // The pantry page itself is invisible too.
  const pageRes = await nia.request.get(`/pantries/${pantryId}`);
  expect(pageRes.status()).toBe(404);
  await niaContext.close();

  // Dana (full-grant connection): the same call succeeds; cancel to clean up.
  const danaContext = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  });
  const dana = await danaContext.newPage();
  await login(dana, 'dana');
  const allowed = await rpc(dana, 'order.addToCart', { pantryId, lotId, quantity: 1 });
  expect(allowed.status).toBe(200);
  const canceled = await rpc(dana, 'order.cancel', {
    orderId: allowed.body.result.data.orderId,
  });
  expect(canceled.status).toBe(200);
  await danaContext.close();
});

test('Teen capabilities: draft yes, cross-household submit no; money and inventory ops denied', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  // Dana stocks her own pantry so Theo has something to order.
  await login(page, 'dana');
  const { pantryId, lotId } = await receiveLotApi(page, uniq('Teen Target', P));
  const danaHousehold = (await overview(page)).yourHouseholdId;

  const theoContext = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  });
  const theo = await theoContext.newPage();
  await login(theo, 'theo');
  const heiseHousehold = (await overview(theo)).yourHouseholdId;

  // placeOrders: drafting against a granted pantry works…
  const cart = await rpc(theo, 'order.addToCart', { pantryId, lotId, quantity: 1 });
  expect(cart.status).toBe(200);
  const orderId = cart.body.result.data.orderId as string;
  // …but a cross-household submission moves money at pickup — spend only.
  const submit = await rpc(theo, 'order.submit', { orderId });
  expect(submit.status).toBe(403);
  const cancel = await rpc(theo, 'order.cancel', { orderId });
  expect(cancel.status).toBe(200);

  // settleMoney denied.
  const settle = await rpc(theo, 'ledger.settle', {
    payerHouseholdId: heiseHousehold,
    payeeHouseholdId: danaHousehold,
    amountCents: 100,
    note: 'teen probe',
  });
  expect(settle.status).toBe(403);
  const adjust = await rpc(theo, 'ledger.adjust', {
    creditorHouseholdId: heiseHousehold,
    debtorHouseholdId: danaHousehold,
    amountCents: 100,
    note: 'teen probe',
  });
  expect(adjust.status).toBe(403);

  // adjustInventory denied — even against the OWN household's lot.
  // (Sign dana out first: /login bounces an already-authenticated page.)
  const out = await page.request.post('/api/trpc/auth.logout', { data: {} });
  expect(out.ok()).toBe(true);
  await login(page, 'aaron');
  const own = await receiveLotApi(page, uniq('Teen Recount', P));
  const recount = await rpc(theo, 'adjustment.recount', {
    stockId: own.stockId,
    countAfter: 1,
  });
  expect(recount.status).toBe(403);

  // manageHousehold denied: no invite affordance on the Home tab (where member
  // management lives after the Round-E IA flip), and the API refuses.
  await theo.goto('/home');
  await expect(theo.getByTestId('home-members')).toBeVisible();
  await expect(theo.getByTestId('invite-url')).toHaveCount(0);
  await expect(theo.getByRole('button', { name: 'Invite a member' })).toHaveCount(0);
  const invite = await rpc(theo, 'invite.create', {});
  expect(invite.status).toBe(403);

  // The spend gate holds through the whole submitted lifetime, not just at
  // submit: once a spend-holder (Aaron) has REQUESTED a cross-household
  // order, Theo cannot inflate it via setLine either.
  const aaronCart = await rpc(page, 'order.addToCart', { pantryId, lotId, quantity: 1 });
  expect(aaronCart.status).toBe(200);
  const aaronOrderId = aaronCart.body.result.data.orderId as string;
  const submitted = await rpc(page, 'order.submit', { orderId: aaronOrderId });
  expect(submitted.status).toBe(200);
  const inflate = await rpc(theo, 'order.setLine', {
    orderId: aaronOrderId,
    lotId,
    quantity: 2,
  });
  expect(inflate.status).toBe(403);
  const cleanup = await rpc(page, 'order.cancel', { orderId: aaronOrderId });
  expect(cleanup.status).toBe(200);

  await theoContext.close();
});

test('money cannot post between unconnected households — even by a user who belongs to both sides of the network', async ({
  browser,
}) => {
  // Marie holds memberships in Heise (connected to In-Laws) and Neighbors
  // (NOT connected to In-Laws). Acting as Neighbors, she knows In-Laws'
  // household id from her other life — but the pair has no connection edge,
  // so settle/adjust read as not-found (no oracle, no push spam, no entries
  // invisible to every ledger page).
  const ctx = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  });
  const marie = await ctx.newPage();
  await login(marie, 'marie');
  const asHeise = await overview(marie);
  const inLawsId = asHeise.households.find((h) => h.name === 'In-Laws')!.id;
  const neighborsId = asHeise.households.find((h) => h.name === 'Neighbors')!.id;

  const switched = await rpc(marie, 'auth.setActingHousehold', { householdId: neighborsId });
  expect(switched.status).toBe(200);

  const adjust = await rpc(marie, 'ledger.adjust', {
    creditorHouseholdId: neighborsId,
    debtorHouseholdId: inLawsId,
    amountCents: 100,
    note: 'unconnected probe',
  });
  expect(adjust.status).toBe(404);
  const settle = await rpc(marie, 'ledger.settle', {
    payerHouseholdId: neighborsId,
    payeeHouseholdId: inLawsId,
    amountCents: 100,
    note: 'unconnected probe',
  });
  expect(settle.status).toBe(404);

  await ctx.close();
});

test('receiving is a pantry-owner action; purchaser attribution must be a connected household', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const aaronData = await overview(page);
  const heisePantry = aaronData.households.find((h) => h.id === aaronData.yourHouseholdId)!
    .pantries[0].id;

  // Dana holds full grants on the Heise connection — but receiving into
  // Aaron's pantry is still an owner-household action.
  const danaContext = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  });
  const dana = await danaContext.newPage();
  await login(dana, 'dana');
  const foreign = await rpc(dana, 'restock.create', {
    pantryId: heisePantry,
    retailer: uniq('Foreign Receive', P),
    purchasedAt: new Date().toISOString().slice(0, 10),
    purchaserHouseholdId: (await overview(dana)).yourHouseholdId,
    receiptTotalCents: null,
  });
  expect(foreign.status).toBe(403);
  await danaContext.close();

  // Aaron receiving into his own pantry may attribute the purchase to any
  // ACTIVELY connected household (Neighbors qualifies, share-only or not)…
  const neighbors = aaronData.households.find((h) => h.name === 'Neighbors')!;
  const attributed = await rpc(page, 'restock.create', {
    pantryId: heisePantry,
    retailer: uniq('Neighbor Bought', P),
    purchasedAt: new Date().toISOString().slice(0, 10),
    purchaserHouseholdId: neighbors.id,
    receiptTotalCents: null,
  });
  expect(attributed.status).toBe(200);
  await rpc(page, 'restock.deleteDraft', {
    restockId: attributed.body.result.data.id,
  });

  // …but never to an unconnected/unknown household.
  const bogus = await rpc(page, 'restock.create', {
    pantryId: heisePantry,
    retailer: uniq('Bogus Purchaser', P),
    purchasedAt: new Date().toISOString().slice(0, 10),
    purchaserHouseholdId: 'not-a-household',
    receiptTotalCents: null,
  });
  expect(bogus.status).toBe(404);
});
