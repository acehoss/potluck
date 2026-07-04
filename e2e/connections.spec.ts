import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { login, PASSWORD } from './helpers';

/**
 * Round 1 slice 3 acceptance — connection management (REWORK B1/B2/B6) and
 * the shared/private flags (B3):
 *
 *  - request → accept lifecycle by household handle, with DIRECTIONAL grants:
 *    the accepting side's Neighbor preset keeps its pantries invisible while
 *    the requester's Friend offer opens theirs; a unilateral grant edit flips
 *    visibility live.
 *  - sever: open orders auto-cancel and release reservations, visibility
 *    drops immediately, but the pair's balance survives — settlement still
 *    posts and the net strip keeps its /ledger entry point.
 *  - Pantry.shared / Item.shared hide resources from every connection while
 *    the owner household still sees them; the toggles are manageHousehold-
 *    gated (Teen Theo 403s).
 *
 * The seeded three-household topology (Heise↔In-Laws full, Heise↔Neighbors
 * share-only, In-Laws↔Neighbors unconnected) is LOAD-BEARING for other specs,
 * so the lifecycle runs against an EPHEMERAL fourth household created through
 * the container seam (slice6's pattern — household creation has no product
 * surface until R1S4's onboarding) and torn down in finally.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

const HH = 'e2e-connect-hh';
const UID = 'e2e-fern-user';
const EMAIL = 'fern.e2e@demo.coop';
const SLUG = 'e2e-ferris';

/** Run a Node one-liner inside the app container (see slice6.spec.ts). */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

/**
 * Remove every trace of the ephemeral household — including rows the product
 * deliberately never deletes (orders, ledger entries): this is test teardown,
 * not an app flow. Order matters for the FK chain.
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

/** tRPC POST as the page's signed-in user. */
async function rpc(page: Page, path: string, data: Record<string, unknown>) {
  const res = await page.request.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

async function overview(page: Page) {
  const res = await page.request.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string; pantries: { id: string; name: string }[] }[];
  };
}

/** Receive one 3-unit lot into the signed-in user's own pantry via the API. */
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
  const done = await rpc(page, 'restock.finalize', { restockId, acknowledgedVarianceCents: null });
  expect(done.status).toBe(200);
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const lots = (await got.json()).result.data.lots as { id: string }[];
  return { pantryId, restockId, lotId: lots[0].id };
}

async function openMore(page: Page) {
  await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
  await expect(page.getByRole('heading', { name: 'More' })).toBeVisible();
}

test('connection lifecycle: request by handle → directional accept → grant edit → sever with B6 fallout', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  execInApp(cleanup); // clear any leak from an interrupted run
  createFerris();
  const fernContext = await browser.newContext({ baseURL: BASE });
  try {
    // Dana stocks a lot so Ferris has something to order later.
    await login(page, 'dana');
    const { pantryId, lotId } = await receiveLotApi(page, uniq('Sever Beans', P));
    const danaHouseholdId = (await overview(page)).yourHouseholdId;

    // Fern requests In-Laws by handle, offering the Friend preset.
    const fern = await fernContext.newPage();
    await login(fern, EMAIL);
    await openMore(fern);
    await fern.getByTestId('connect-open').click();
    await fern.getByTestId('connect-handle').fill('in-laws');
    await fern.getByTestId('preset-friend').click();
    await fern.getByTestId('connect-submit').click();
    await expect(
      fern.getByTestId('connection-row').filter({ hasText: 'In-Laws' }),
    ).toContainText('request sent');

    // Requesting again while pending conflicts; the addressee must answer.
    const dup = await rpc(fern, 'connection.request', {
      slug: 'in-laws',
      grants: { pantry: true, lending: true, recipes: true, shareTo: true, shareFrom: true, reshare: false },
    });
    expect(dup.status).toBe(409);

    // Dana accepts with the NEIGHBOR preset: Ferris gets shares only — the
    // directional part of B2. (Dana could browse Ferris' pantries; Ferris
    // cannot browse In-Laws'.)
    await openMore(page);
    const ferrisRow = page.getByTestId('connection-row').filter({ hasText: 'Ferris' });
    await expect(ferrisRow).toContainText('wants to connect');
    await ferrisRow.getByTestId('connection-accept').click();
    await ferrisRow.getByTestId('preset-neighbor').click();
    await ferrisRow.getByTestId('connection-accept-confirm').click();
    await expect(ferrisRow).toContainText('connected');

    // Fern sees the ACTIVE edge and the In-Laws net strip — but NO In-Laws
    // pantry group (no pantry grant on Dana's side yet).
    await fern.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
    await expect(fern.getByTestId('net-strip').filter({ hasText: 'In-Laws' })).toBeVisible();
    await expect(fern.getByTestId('pantry-group')).toHaveCount(1);
    const denied = await rpc(fern, 'order.addToCart', { pantryId, lotId, quantity: 1 });
    expect(denied.status).toBe(404);

    // Dana unilaterally grants pantry access — Fern's world re-scopes live.
    await ferrisRow.getByTestId('connection-edit').click();
    await ferrisRow.getByTestId('grant-pantry').check();
    await ferrisRow.getByTestId('grants-save').click();
    await expect(ferrisRow.getByTestId('grants-save')).toHaveCount(0);
    await fern.reload();
    await expect(fern.getByTestId('pantry-group')).toHaveCount(2);

    // Fern submits an order (reserving a unit) and Dana posts a $1 balance —
    // the sever fallout probes (B6).
    const cart = await rpc(fern, 'order.addToCart', { pantryId, lotId, quantity: 2 });
    expect(cart.status).toBe(200);
    const orderId = cart.body.result.data.orderId as string;
    expect((await rpc(fern, 'order.submit', { orderId })).status).toBe(200);
    const fernHouseholdId = (await overview(fern)).yourHouseholdId;
    const adjust = await rpc(page, 'ledger.adjust', {
      creditorHouseholdId: danaHouseholdId,
      debtorHouseholdId: fernHouseholdId,
      amountCents: 100,
      note: `sever probe ${P}-${RUN}`,
    });
    expect(adjust.status).toBe(200);

    // Dana severs. Confirm dialog → the open order auto-cancels and its
    // reservation releases; visibility drops for Fern immediately.
    page.once('dialog', (dialog) => dialog.accept());
    await ferrisRow.getByTestId('connection-edit').click();
    await ferrisRow.getByTestId('connection-sever').click();
    await expect(ferrisRow).toContainText('severed');

    await fern.reload();
    await expect(fern.getByTestId('pantry-group')).toHaveCount(1);
    const orderPage = await fern.request.get(`/orders/${orderId}`);
    expect(orderPage.ok()).toBe(true);
    expect(await orderPage.text()).toContain('Canceled');
    // Reservation released: all 3 units orderable again from Dana's side —
    // her own cart can take the full lot.
    const danaCart = await rpc(page, 'order.addToCart', { pantryId, lotId, quantity: 3 });
    expect(danaCart.status).toBe(200);
    expect((await rpc(page, 'order.submit', { orderId: danaCart.body.result.data.orderId })).status).toBe(200);
    expect((await rpc(page, 'order.cancel', { orderId: danaCart.body.result.data.orderId })).status).toBe(200);

    // B6: the balance survives severing — the net strip keeps its entry
    // point and settlement still posts.
    await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
    await expect(page.getByTestId('net-strip').filter({ hasText: 'Ferris' })).toBeVisible();
    const settle = await rpc(page, 'ledger.settle', {
      payerHouseholdId: fernHouseholdId,
      payeeHouseholdId: danaHouseholdId,
      amountCents: 100,
      note: `severed settle ${P}-${RUN}`,
    });
    expect(settle.status).toBe(200);

    // New activity stays blocked: ordering 404s (no grant), and Fern can
    // re-request the severed edge (people make up) — leaving it PENDING is
    // fine, cleanup removes the row.
    const blocked = await rpc(fern, 'order.addToCart', { pantryId, lotId, quantity: 1 });
    expect(blocked.status).toBe(404);
    const rerequest = await rpc(fern, 'connection.request', {
      slug: 'in-laws',
      grants: { pantry: false, lending: false, recipes: false, shareTo: true, shareFrom: true, reshare: false },
    });
    expect(rerequest.status).toBe(200);
  } finally {
    await fernContext.close();
    execInApp(cleanup);
  }
});

test('capability gates: only manageConnections may run the connection lifecycle', async ({
  page,
}) => {
  await login(page, 'theo'); // TEEN preset: no manageConnections, no manageHousehold
  const req = await rpc(page, 'connection.request', {
    slug: 'neighbors',
    grants: { pantry: false, lending: false, recipes: false, shareTo: true, shareFrom: true, reshare: false },
  });
  expect(req.status).toBe(403);
  // Shared flags are household management — a Teen member of the OWNING
  // household still gets 403 (vs the non-member's 404 in the pantry test).
  const theoData = await overview(page);
  const ownPantryId = theoData.households.find((h) => h.id === theoData.yourHouseholdId)!
    .pantries[0].id;
  const flagDenied = await rpc(page, 'pantry.setShared', { pantryId: ownPantryId, shared: false });
  expect(flagDenied.status).toBe(403);
  // Self-connect and unknown handles fail for managers too.
  await login(page, 'aaron');
  const self = await rpc(page, 'connection.request', {
    slug: 'heise',
    grants: { pantry: false, lending: false, recipes: false, shareTo: true, shareFrom: true, reshare: false },
  });
  expect(self.status).toBe(400);
  const unknown = await rpc(page, 'connection.request', {
    slug: `nope-${RUN}`,
    grants: { pantry: false, lending: false, recipes: false, shareTo: true, shareFrom: true, reshare: false },
  });
  expect(unknown.status).toBe(404);
});

test('a private pantry disappears from connections and reappears when re-shared', async ({
  page,
  browser,
}) => {
  await login(page, 'aaron');
  const data = await overview(page);
  const heisePantryId = data.households.find((h) => h.id === data.yourHouseholdId)!.pantries[0].id;
  // Pre-clean: force shared in case an interrupted run left it private.
  await rpc(page, 'pantry.setShared', { pantryId: heisePantryId, shared: true });

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana');
  try {
    await expect(
      dana.getByTestId('pantry-group').filter({ hasText: 'Heise' }).getByTestId('pantry-row'),
    ).toHaveCount(1);

    // Aaron flips it private via the header chip.
    await page.goto(`/pantries/${heisePantryId}`);
    await page.getByTestId('pantry-shared-toggle').click();
    await expect(page.getByTestId('pantry-shared-toggle')).toHaveText('private');

    // Dana: the pantry row is gone and the page 404s — but Aaron still sees it.
    await dana.reload();
    await expect(
      dana.getByTestId('pantry-group').filter({ hasText: 'Heise' }).getByTestId('pantry-row'),
    ).toHaveCount(0);
    expect((await dana.request.get(`/pantries/${heisePantryId}`)).status()).toBe(404);
    await expect(page.getByRole('heading', { name: /Basement Pantry/ })).toBeVisible();

    // The flag is the owner household's alone: a non-member (even a fully
    // granted one) reads not-found.
    const foreignDenied = await rpc(dana, 'pantry.setShared', {
      pantryId: heisePantryId,
      shared: true,
    });
    expect(foreignDenied.status).toBe(404);
  } finally {
    // Restore the load-bearing seed state even on failure.
    await rpc(page, 'pantry.setShared', { pantryId: heisePantryId, shared: true });
    await danaContext.close();
  }
});

test('a private item hides from connections; the flag is manageHousehold-gated', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const itemName = uniq('Ghost Ladder', P);
  await login(page, 'aaron');
  const mine = (await overview(page)).yourHouseholdId;
  const created = await rpc(page, 'item.create', { householdId: mine, name: itemName, feeCents: 0 });
  expect(created.status).toBe(200);
  const itemId = created.body.result.data.id as string;

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana');
  await dana.goto('/items');
  await expect(dana.getByTestId('item-row').filter({ hasText: itemName })).toBeVisible();

  // Aaron unshares it via the edit sheet.
  await page.goto(`/items/${itemId}`);
  await page.getByTestId('edit-item').click();
  await page.getByTestId('edit-item-shared').uncheck();
  await page.getByTestId('edit-item-save').click();
  await expect(page.getByTestId('edit-item-sheet')).toHaveCount(0);

  await dana.reload();
  await expect(dana.getByTestId('item-row').filter({ hasText: itemName })).toHaveCount(0);
  expect((await dana.request.get(`/items/${itemId}`)).status()).toBe(404);
  // Owner household still sees and can borrow it.
  await expect(page.getByRole('heading', { name: itemName })).toBeVisible();

  // Theo (Teen, lendBorrow but no manageHousehold) cannot flip the flag —
  // but CAN still edit the name (the flag is what's management-gated).
  const theoContext = await browser.newContext({ baseURL: BASE });
  const theo = await theoContext.newPage();
  await login(theo, 'theo');
  const flagDenied = await rpc(theo, 'item.update', { itemId, shared: true });
  expect(flagDenied.status).toBe(403);
  const renameOk = await rpc(theo, 'item.update', { itemId, name: `${itemName} 2` });
  expect(renameOk.status).toBe(200);
  await theoContext.close();
  await danaContext.close();
});
