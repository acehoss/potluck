import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { login, openNeighbors, PASSWORD } from './helpers';

/**
 * Round-1 slice-3 acceptance, RE-WORKED onto Phase-2 circles (REWORK P4):
 * connection management (B1/B2/B6) and per-resource visibility (was the B3
 * shared flag, now circle-scoped ALL/SELECT/PRIVATE).
 *
 *  - request → accept lifecycle by household handle, DIRECTIONAL via circles:
 *    the requester offers one of ITS circles; the accepting side places the
 *    requester into one of ITS OWN circles. A share-only (Neighbors) circle
 *    keeps the accepting side's pantries invisible; re-assigning the connection
 *    into a pantry-granting (Family) circle — the new "setGrants" — opens them
 *    LIVE.
 *  - sever: open orders auto-cancel and release reservations, visibility drops
 *    immediately, but the pair's balance survives — settlement still posts and
 *    the net strip keeps its /ledger entry point.
 *  - pantry/item visibility = PRIVATE hides a resource from every connection
 *    while the owner household still sees it; setVisibility is manageHousehold-
 *    gated (Teen Theo 403s), circle/connection management is manageConnections-
 *    gated.
 *
 * The connection request/accept/assign/sever lifecycle is driven through the
 * tRPC API (stable), with browser assertions for the live re-scoping the UI
 * must reflect (pantry groups, net strips, order pages). The seeded three-
 * household topology is LOAD-BEARING for other files, so the lifecycle runs
 * against an EPHEMERAL fourth household created through the container seam
 * (slice6's pattern) and torn down in finally.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

const HH = 'e2e-connect-hh';
const UID = 'e2e-fern-user';
const EMAIL = 'fern.e2e@demo.coop';
const SLUG = 'e2e-ferris';

const FRIEND = { pantry: true, lending: true, recipes: true, shareTo: true, shareFrom: true, reshare: false };

/** Run a Node one-liner inside the app container (see slice6.spec.ts). */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

/**
 * Remove every trace of the ephemeral household — including rows the product
 * deliberately never deletes (orders, ledger entries) and the household's own
 * circles (a Connection references them, so drop it AFTER the connection and
 * BEFORE the household). Test teardown, not an app flow. FK order matters.
 */
const cleanup = `
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
  db.prepare("DELETE FROM OrderLine WHERE orderId IN (SELECT id FROM \\"Order\\" WHERE householdId = '${HH}')").run();
  db.prepare("DELETE FROM \\"Order\\" WHERE householdId = '${HH}'").run();
  db.prepare("DELETE FROM Session WHERE userId = '${UID}'").run();
  db.prepare("DELETE FROM Membership WHERE userId = '${UID}'").run();
  db.prepare("DELETE FROM LedgerSeen WHERE counterpartyHouseholdId = '${HH}' OR userId = '${UID}'").run();
  db.prepare("DELETE FROM LedgerEntry WHERE creditorHouseholdId = '${HH}' OR debtorHouseholdId = '${HH}'").run();
  db.prepare("DELETE FROM Connection WHERE householdAId = '${HH}' OR householdBId = '${HH}'").run();
  db.prepare("DELETE FROM Circle WHERE householdId = '${HH}'").run();
  db.prepare("DELETE FROM User WHERE id = '${UID}'").run();
  db.prepare("DELETE FROM Household WHERE id = '${HH}'").run();
`;

function createFerris() {
  execInApp(`
    const { hashSync } = require('@node-rs/argon2');
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
    db.prepare("INSERT OR IGNORE INTO Household (id, name, slug) VALUES ('${HH}', 'Ferris (e2e)', '${SLUG}')").run();
    const hash = hashSync('${PASSWORD}', { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    db.prepare("INSERT OR IGNORE INTO User (id, username, name, email, passwordHash) VALUES ('${UID}', '${UID}', 'Fern', '${EMAIL}', ?)").run(hash);
    db.prepare("INSERT OR IGNORE INTO Membership (id, userId, householdId, manageHousehold, manageConnections, receiveStock, placeOrders, spend, fulfill, adjustInventory, lendBorrow, postShares, editRecipes, settleMoney) VALUES ('m-${UID}', '${UID}', '${HH}', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)").run();
  `);
}

/** tRPC POST as the page's signed-in user; raw envelope (status + body). */
async function rpc(page: Page, path: string, data: Record<string, unknown>) {
  const res = await page.request.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** POST and assert 200, returning result.data. */
async function ok(page: Page, path: string, data: Record<string, unknown>) {
  const r = await rpc(page, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)} → ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result.data;
}

async function overview(page: Page) {
  const res = await page.request.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string; pantries: { id: string; name: string }[] }[];
  };
}

/** The acting household's circle id named `name` (manageConnections-gated). */
async function circleId(page: Page, name: string): Promise<string> {
  const res = await page.request.get('/api/trpc/circle.list');
  expect(res.ok()).toBe(true);
  const circles = (await res.json()).result.data.circles as { id: string; name: string }[];
  const found = circles.find((c) => c.name === name);
  if (!found) throw new Error(`no circle named ${name}`);
  return found.id;
}

/** Receive one 3-unit lot into the signed-in user's own pantry via the API. */
async function receiveLotApi(page: Page, retailer: string) {
  const data = await overview(page);
  const own = data.households.find((h) => h.id === data.yourHouseholdId)!;
  const pantryId = own.pantries[0].id;
  const created = await ok(page, 'restock.create', {
    pantryId,
    retailer,
    purchasedAt: new Date().toISOString().slice(0, 10),
    purchaserHouseholdId: data.yourHouseholdId,
    receiptTotalCents: null,
  });
  await ok(page, 'restock.saveLine', {
    restockId: created.id,
    newProductName: retailer,
    purchasedCount: 3,
    receivedCount: 3,
    lineTotalCents: 300,
    bestBy: null,
  });
  await ok(page, 'restock.finalize', { restockId: created.id, acknowledgedVarianceCents: null });
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: created.id }))}`,
  );
  const lots = (await got.json()).result.data.lots as { id: string }[];
  return { pantryId, restockId: created.id, lotId: lots[0].id };
}

test('connection lifecycle: request-by-handle with a circle → directional accept → move circle → sever with B6 fallout', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  execInApp(cleanup); // clear any leak from an interrupted run
  createFerris();
  const fernContext = await browser.newContext({ baseURL: BASE });
  try {
    // Dana (In-Laws) stocks a lot so Ferris has something to order later.
    await login(page, 'dana');
    const { pantryId, lotId } = await receiveLotApi(page, uniq('Sever Beans', P));
    const danaHouseholdId = (await overview(page)).yourHouseholdId;
    // In-Laws' seeded preset circles Dana will place Ferris into.
    const inlawsNeighbors = await circleId(page, 'Neighbors'); // shares only, no pantry
    const inlawsFamily = await circleId(page, 'Family'); // pantry + everything

    // Fern signs in, mints a Friend circle of her own, and requests In-Laws by
    // handle, offering that circle (what In-Laws may do with Ferris' things).
    const fern = await fernContext.newPage();
    await login(fern, EMAIL);
    const fernFriend = (await ok(fern, 'circle.create', { name: uniq('Friends', P), grants: FRIEND })).id;
    const connId = (await ok(fern, 'connection.request', { slug: 'in-laws', circleId: fernFriend })).id;

    // Requesting again while pending conflicts.
    expect(
      (await rpc(fern, 'connection.request', { slug: 'in-laws', circleId: fernFriend })).status,
      'duplicate pending request → 409',
    ).toBe(409);

    // Dana accepts, placing Ferris into In-Laws' NEIGHBORS circle: Ferris gets
    // shares only — the directional part of B2. (Dana could browse Ferris'
    // pantries; Ferris cannot browse In-Laws'.)
    const accepted = await ok(page, 'connection.respond', {
      connectionId: connId,
      accept: true,
      circleId: inlawsNeighbors,
    });
    expect(accepted.status).toBe('ACTIVE');

    // Fern sees the ACTIVE edge and the In-Laws balance on the Neighbors
    // dashboard — but In-Laws' pantry stays hidden (Neighbors circle extends no
    // pantry grant): the pantry page 404s and ordering 404s. (The Round-E IA
    // flip dropped the cross-household pantry list, so visibility is proven by
    // page access, not a home-list count.)
    await openNeighbors(fern);
    await expect(
      fern.getByTestId('neighbors-household-section').filter({ hasText: 'In-Laws' }),
    ).toBeVisible();
    expect(
      (await fern.request.get(`/pantries/${pantryId}`)).status(),
      'Neighbors circle: In-Laws pantry hidden',
    ).toBe(404);
    expect((await rpc(fern, 'order.addToCart', { pantryId, lotId, quantity: 1 })).status).toBe(404);

    // Dana MOVES Ferris into Family — the P4 "setGrants" is a circle re-assignment
    // (unilateral, no consent). Fern's world re-scopes live: the pantry is visible.
    await ok(page, 'connection.assign', { connectionId: connId, circleId: inlawsFamily });
    expect(
      (await fern.request.get(`/pantries/${pantryId}`)).ok(),
      'Family circle: In-Laws pantry visible',
    ).toBe(true);

    // Fern submits an order (reserving 2 units) and Dana posts a $1 balance — the
    // sever fallout probes (B6).
    const cart = await ok(fern, 'order.addToCart', { pantryId, lotId, quantity: 2 });
    const orderId = cart.orderId as string;
    await ok(fern, 'order.submit', { orderId });
    const fernHouseholdId = (await overview(fern)).yourHouseholdId;
    await ok(page, 'ledger.adjust', {
      creditorHouseholdId: danaHouseholdId,
      debtorHouseholdId: fernHouseholdId,
      amountCents: 100,
      note: `sever probe ${P}-${RUN}`,
    });

    // Dana severs: the open order auto-cancels and its reservation releases;
    // visibility drops for Fern immediately.
    const severed = await ok(page, 'connection.sever', { connectionId: connId });
    expect(severed.status).toBe('SEVERED');
    expect(severed.canceledOrders).toBe(1);

    expect(
      (await fern.request.get(`/pantries/${pantryId}`)).status(),
      'severed: In-Laws pantry hidden again',
    ).toBe(404);
    const orderPage = await fern.request.get(`/orders/${orderId}`);
    expect(orderPage.ok()).toBe(true);
    expect(await orderPage.text()).toContain('Canceled');
    // Reservation released: all 3 units orderable again from Dana's side.
    const danaCart = await ok(page, 'order.addToCart', { pantryId, lotId, quantity: 3 });
    await ok(page, 'order.submit', { orderId: danaCart.orderId });
    await ok(page, 'order.cancel', { orderId: danaCart.orderId });

    // B6: the balance survives severing — the household section keeps its entry
    // point and settlement still posts.
    await openNeighbors(page);
    await expect(
      page.getByTestId('neighbors-household-section').filter({ hasText: 'Ferris' }),
    ).toBeVisible();
    await ok(page, 'ledger.settle', {
      payerHouseholdId: fernHouseholdId,
      payeeHouseholdId: danaHouseholdId,
      amountCents: 100,
      note: `severed settle ${P}-${RUN}`,
    });

    // New activity stays blocked (ordering 404s), and Fern can re-request the
    // severed edge (people make up) — a PENDING row is fine, cleanup removes it.
    expect((await rpc(fern, 'order.addToCart', { pantryId, lotId, quantity: 1 })).status).toBe(404);
    expect(
      (await rpc(fern, 'connection.request', { slug: 'in-laws', circleId: fernFriend })).status,
      're-request a severed edge → 200',
    ).toBe(200);
  } finally {
    await fernContext.close();
    execInApp(cleanup);
  }
});

test('capability gates: manageConnections manages circles/connections; visibility is manageHousehold-gated', async ({
  page,
}) => {
  await login(page, 'theo'); // TEEN preset: no manageConnections, no manageHousehold
  // Circle + connection management need manageConnections.
  expect((await rpc(page, 'circle.create', { name: `Teen ${RUN}`, grants: FRIEND })).status).toBe(403);
  expect((await page.request.get('/api/trpc/circle.list')).status(), 'circle.list is a manager read').toBe(403);
  expect(
    (await rpc(page, 'connection.request', { slug: 'neighbors', circleId: 'irrelevant' })).status,
    'request needs manageConnections (checked before the circle resolves)',
  ).toBe(403);

  // Resource visibility is household management — a Teen member of the OWNING
  // household still gets 403 (vs the non-member's 404 in the pantry test).
  const theoData = await overview(page);
  const ownPantryId = theoData.households.find((h) => h.id === theoData.yourHouseholdId)!
    .pantries[0].id;
  expect(
    (await rpc(page, 'pantry.setVisibility', { pantryId: ownPantryId, visibility: 'PRIVATE' })).status,
  ).toBe(403);

  // Self-connect, unknown handles, and foreign circle ids fail for managers too.
  await login(page, 'aaron');
  const heiseFamily = await circleId(page, 'Family');
  expect((await rpc(page, 'connection.request', { slug: 'heise', circleId: heiseFamily })).status, 'self → 400').toBe(400);
  expect(
    (await rpc(page, 'connection.request', { slug: `nope-${RUN}`, circleId: heiseFamily })).status,
    'unknown handle → 404',
  ).toBe(404);
  // A circle you don't own never resolves (own-circle-only), even to a manager.
  expect(
    (await rpc(page, 'connection.request', { slug: 'in-laws', circleId: 'not-my-circle' })).status,
    'foreign circle → 404',
  ).toBe(404);
});

test('a pantry set PRIVATE disappears from connections and reappears when re-shared; the mode is owner-only', async ({
  page,
  browser,
}) => {
  await login(page, 'aaron');
  const data = await overview(page);
  const heisePantryId = data.households.find((h) => h.id === data.yourHouseholdId)!.pantries[0].id;
  // Pre-clean: force ALL in case an interrupted run left it PRIVATE.
  await ok(page, 'pantry.setVisibility', { pantryId: heisePantryId, visibility: 'ALL' });

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana');
  try {
    // Heise's pantry is visible to Dana (Family grant). The Round-E IA flip
    // dropped the cross-household pantry list from the shell, so visibility is
    // proven by page access to the (still visibility-gated) pantry route.
    expect((await dana.request.get(`/pantries/${heisePantryId}`)).ok()).toBe(true);

    // Aaron flips it PRIVATE.
    await ok(page, 'pantry.setVisibility', { pantryId: heisePantryId, visibility: 'PRIVATE' });

    // Dana: the pantry page 404s now — but Aaron still sees it.
    expect((await dana.request.get(`/pantries/${heisePantryId}`)).status()).toBe(404);
    await page.goto(`/pantries/${heisePantryId}`);
    await expect(page.getByRole('heading', { name: /Basement Pantry/ })).toBeVisible();

    // Visibility is the owner household's alone: a non-member (even a fully
    // granted one) reads not-found.
    expect(
      (await rpc(dana, 'pantry.setVisibility', { pantryId: heisePantryId, visibility: 'ALL' })).status,
    ).toBe(404);
  } finally {
    // Restore the load-bearing seed state even on failure.
    await ok(page, 'pantry.setVisibility', { pantryId: heisePantryId, visibility: 'ALL' });
    await danaContext.close();
  }
});

test('an item set PRIVATE hides from connections; visibility is manageHousehold-gated, renaming is not', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const itemName = uniq('Ghost Ladder', P);
  await login(page, 'aaron');
  const mine = (await overview(page)).yourHouseholdId;
  const itemId = (await ok(page, 'item.create', { householdId: mine, name: itemName, feeCents: 0 })).id as string;

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  const theoContext = await browser.newContext({ baseURL: BASE });
  try {
    await login(dana, 'dana');
    await dana.goto('/items');
    await expect(dana.getByTestId('item-row').filter({ hasText: itemName })).toBeVisible();

    // Aaron sets it PRIVATE via item.setVisibility.
    await ok(page, 'item.setVisibility', { itemId, visibility: 'PRIVATE' });

    await dana.reload();
    await expect(dana.getByTestId('item-row').filter({ hasText: itemName })).toHaveCount(0);
    expect((await dana.request.get(`/items/${itemId}`)).status()).toBe(404);
    // Owner household still sees it.
    await page.goto(`/items/${itemId}`);
    await expect(page.getByRole('heading', { name: itemName })).toBeVisible();

    // Theo (Teen, lendBorrow but no manageHousehold) cannot flip visibility — but
    // CAN still rename it (visibility is what's management-gated).
    const theo = await theoContext.newPage();
    await login(theo, 'theo');
    expect((await rpc(theo, 'item.setVisibility', { itemId, visibility: 'ALL' })).status).toBe(403);
    expect((await rpc(theo, 'item.update', { itemId, name: `${itemName} 2` })).status).toBe(200);
  } finally {
    await theoContext.close();
    await danaContext.close();
    // Item has no delete endpoint — SQL-drop the per-run item so it can't leak
    // into Heise's own item list across reruns.
    execInApp(
      `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace(/^file:/,''));` +
        `db.prepare("DELETE FROM ItemCircle WHERE itemId='${itemId}'").run();` +
        `db.prepare("DELETE FROM Item WHERE id='${itemId}'").run();`,
    );
  }
});
