import { execFileSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiLogin, login, PASSWORD } from './helpers';

/**
 * Phase-2 Round D acceptance — the global toolbar + Activity surface. Activity
 * is a DERIVED read (activity.list) whose inline actions reuse the EXISTING
 * order/restock/share/connection mutations at their existing guards. Two rules
 * are load-bearing and tested here:
 *   - can/hide: a row renders an action only for a user whose capabilities can
 *     perform it (Teen Theo — receiveStock yes, fulfill/manageConnections/spend
 *     NO — sees incoming rows but no advance/confirm/accept buttons).
 *   - money never fires from a list row: an order READY for pickup shows a LINK
 *     to its detail, never an inline pickup (the money moment stays on /orders).
 *
 * Seed topology (prisma/seed.ts): Heise = aaron (Owner+admin), marie (Owner;
 * also Adult in Neighbors — the multi-membership chip fixture), theo (Teen);
 * In-Laws = dana (Owner, fulfill); Neighbors = nia. Heise↔In-Laws ACTIVE full
 * grants. Rerun-safe against one accumulating DB across chromium+webkit: unique
 * per-run names, every created order driven to a terminal state (or its take
 * undone) and every draft/post/connection removed in a finally.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;
const TODAY = () => new Date().toISOString().slice(0, 10);

type Api = Pick<APIRequestContext, 'get' | 'post'>;

async function rpc(api: Api, path: string, data: Record<string, unknown>) {
  const res = await api.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}
async function ok(api: Api, path: string, data: Record<string, unknown>) {
  const r = await rpc(api, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)} → ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result.data;
}
async function overview(api: Api) {
  const res = await api.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string; pantries: { id: string; name: string }[] }[];
  };
}

type ActItem = { id: string; type: string; actionable: boolean };
async function activity(api: Api): Promise<{ items: ActItem[]; actionableCount: number }> {
  const res = await api.get('/api/trpc/activity.list');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data;
}
const byId = (items: ActItem[], id: string) => items.find((i) => i.id === id);

/** Receive one finalized 3-unit lot ($1/u) into the api's own pantry. */
async function receiveLotApi(api: Api, retailer: string) {
  const data = await overview(api);
  const own = data.households.find((h) => h.id === data.yourHouseholdId)!;
  const pantryId = own.pantries[0].id;
  const created = await ok(api, 'restock.create', {
    pantryId,
    retailer,
    purchasedAt: TODAY(),
    purchaserHouseholdId: data.yourHouseholdId,
    receiptTotalCents: null,
  });
  await ok(api, 'restock.saveLine', {
    restockId: created.id,
    newProductName: retailer,
    purchasedCount: 3,
    receivedCount: 3,
    lineTotalCents: 300,
    bestBy: null,
  });
  await ok(api, 'restock.finalize', { restockId: created.id, acknowledgedVarianceCents: null });
  const got = await api.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: created.id }))}`,
  );
  const lots = (await got.json()).result.data.lots as { id: string }[];
  return { pantryId, restockId: created.id, lotId: lots[0].id, product: retailer };
}

/** Clear any leftover DRAFT cart, then place + submit a fresh order. */
async function submitOrder(requester: Api, pantryId: string, lotId: string, qty: number) {
  const probe = await rpc(requester, 'order.addToCart', { pantryId, lotId, quantity: 1 });
  if (probe.status === 200) {
    await rpc(requester, 'order.cancel', { orderId: probe.body.result.data.orderId });
  }
  const cart = await ok(requester, 'order.addToCart', { pantryId, lotId, quantity: qty });
  await ok(requester, 'order.submit', { orderId: cart.orderId });
  return cart.orderId as string;
}

function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}
/** The Take id an order's pickup created (for a clean undo after READY). */
function takeIdForOrder(orderId: string): string {
  return execInApp(`
    const Database=require('better-sqlite3');
    const db=new Database(process.env.DATABASE_URL.replace(/^file:/,''));
    const row=db.prepare("SELECT t.id AS id FROM Take t JOIN OrderLine ol ON ol.takeId=t.id WHERE ol.orderId=?").get('${orderId}');
    process.stdout.write(row?row.id:'');
  `).trim();
}

// -------------------------------------------------------------------------

test('badge/count math is capability-gated: aaron advances, Theo only sees (can/hide)', async ({
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const ctxAaron = await browser.newContext({ baseURL: BASE });
  const ctxTheo = await browser.newContext({ baseURL: BASE });
  const aaron = await ctxAaron.newPage();
  const theo = await ctxTheo.newPage();
  const dana = await apiLogin('dana');

  let restockId = '';
  let orderId = '';
  try {
    await login(aaron, 'aaron');
    await login(theo, 'theo');

    // A finalized Heise lot to order against, and a SEPARATE open DRAFT (both
    // hold receiveStock). The incoming order onto the Heise pantry comes from
    // In-Laws — only fulfill-holders can advance it.
    const lot = await receiveLotApi(aaron.request, uniq('Badge Beans', P));
    const data = await overview(aaron.request);
    restockId = (
      await ok(aaron.request, 'restock.create', {
        pantryId: lot.pantryId,
        retailer: uniq('Badge Draft', P),
        purchasedAt: TODAY(),
        purchaserHouseholdId: data.yourHouseholdId,
        receiptTotalCents: null,
      })
    ).id;
    orderId = await submitOrder(dana, lot.pantryId, lot.lotId, 1);

    const aA = await activity(aaron.request);
    const tA = await activity(theo.request);

    // The draft is actionable for both — Theo is a Teen but has receiveStock.
    expect(byId(aA.items, `draft:${restockId}`)?.actionable).toBe(true);
    expect(byId(tA.items, `draft:${restockId}`)?.actionable).toBe(true);

    // The incoming order is visible to both, actionable only for aaron (fulfill).
    const inA = byId(aA.items, `order-in:${orderId}`);
    const inT = byId(tA.items, `order-in:${orderId}`);
    expect(inA?.actionable).toBe(true);
    expect(inT, 'Theo still SEES the incoming order').toBeTruthy();
    expect(inT?.actionable, 'Theo cannot advance it').toBe(false);

    // So aaron's actionable count exceeds Theo's by (at least) that order.
    expect(aA.actionableCount).toBeGreaterThan(tA.actionableCount);

    // Browser: aaron gets an advance button; Theo (no fulfill) gets NONE at all.
    await aaron.goto('/activity');
    await expect(aaron.getByTestId('activity-order-start-picking').first()).toBeVisible();
    await theo.goto('/activity');
    await expect(theo.getByTestId('activity-item').filter({ hasText: 'In-Laws' }).first()).toBeVisible();
    await expect(theo.getByTestId('activity-order-start-picking')).toHaveCount(0);
  } finally {
    if (orderId) await rpc(aaron.request, 'order.cancel', { orderId }); // owner declines REQUESTED
    if (restockId) await rpc(aaron.request, 'restock.deleteDraft', { restockId });
    await ctxAaron.close();
    await ctxTheo.close();
    await dana.dispose();
  }
});

test('draft lifecycle through Activity: appears, Resume deep-links, Abandon clears it', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const data = await overview(page.request);
  const own = data.households.find((h) => h.id === data.yourHouseholdId)!;
  const pantryId = own.pantries[0].id;

  const created = await ok(page.request, 'restock.create', {
    pantryId,
    retailer: uniq('Draft Trip', P),
    purchasedAt: TODAY(),
    purchaserHouseholdId: data.yourHouseholdId,
    receiptTotalCents: null,
  });
  const restockId = created.id as string;
  let abandoned = false;
  // The draft's row is the one whose Resume link deep-links to THIS restock.
  const mineRow = () =>
    page
      .getByTestId('activity-item')
      .filter({ has: page.locator(`a[href*="receive/${restockId}"]`) });
  try {
    await page.goto('/activity');
    expect(byId((await activity(page.request)).items, `draft:${restockId}`)?.actionable).toBe(true);
    // Resume deep-links straight into the wizard for this draft.
    await mineRow().first().getByTestId('activity-draft-resume').click();
    await expect(page).toHaveURL(new RegExp(`/receive/${restockId}`));

    // Back to Activity, Abandon removes it (deleteDraft) and the item is gone.
    await page.goto('/activity');
    page.once('dialog', (d) => d.accept());
    await mineRow().first().getByTestId('activity-draft-abandon').click();
    await expect(mineRow()).toHaveCount(0);
    abandoned = true;
    // The draft is truly gone from the server.
    expect(byId((await activity(page.request)).items, `draft:${restockId}`)).toBeUndefined();
  } finally {
    if (!abandoned) await rpc(page.request, 'restock.deleteDraft', { restockId });
  }
});

test('incoming order advances inline (dana) — same buttons as /orders/[id]; requester sees a pickup LINK, never a money button', async ({
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const ctxAaron = await browser.newContext({ baseURL: BASE });
  const ctxDana = await browser.newContext({ baseURL: BASE });
  const aaron = await ctxAaron.newPage();
  const dana = await ctxDana.newPage();

  let orderId = '';
  let pickedUp = false;
  try {
    await login(aaron, 'aaron');
    await login(dana, 'dana');

    // Heise (aaron) orders from an In-Laws pantry — In-Laws is the OWNER/fulfiller.
    const lot = await receiveLotApi(dana.request, uniq('Advance Oats', P));
    orderId = await submitOrder(aaron.request, lot.pantryId, lot.lotId, 1);

    // Row scoped to THIS order by its detail deep-link (avoids other lingering
    // orders on the same board).
    const danaRow = () =>
      dana.getByTestId('activity-item').filter({ has: dana.locator(`a[href$="/orders/${orderId}"]`) });

    // Duplication rule: the Start-picking action exists BOTH on Activity and on
    // the order detail for a REQUESTED order.
    await dana.goto('/activity');
    await expect(danaRow().getByTestId('activity-order-start-picking')).toBeVisible();
    await dana.goto(`/orders/${orderId}`);
    await expect(dana.getByTestId('order-start-picking')).toBeVisible();

    // Advance REQUESTED→PICKING→READY entirely from Activity's inline actions.
    await dana.goto('/activity');
    await danaRow().getByTestId('activity-order-start-picking').click();
    await expect(danaRow().getByTestId('activity-order-mark-ready')).toBeVisible();
    await danaRow().getByTestId('activity-order-mark-ready').click();
    await expect(danaRow().getByTestId('activity-order-mark-ready')).toHaveCount(0);

    // Requester side: the READY order shows a LINK to pickup, NEVER an inline
    // money button (data-testid order-pickup lives only on the detail).
    await aaron.goto('/activity');
    const outRow = aaron
      .getByTestId('activity-item')
      .filter({ has: aaron.locator(`a[href$="/orders/${orderId}"]`) })
      .filter({ has: aaron.getByTestId('activity-order-pickup-link') });
    await expect(outRow).toBeVisible();
    await expect(outRow).toContainText('go pick up');
    await expect(aaron.getByTestId('order-pickup')).toHaveCount(0); // no money action on the list
    // The link goes to the order detail, where the money button DOES live.
    await outRow.getByTestId('activity-order-pickup-link').click();
    await expect(aaron).toHaveURL(new RegExp(`/orders/${orderId}`));
    await expect(aaron.getByTestId('order-pickup')).toBeVisible();

    // Clean up honestly: pick up (money posts) then undo the take (net zero,
    // inventory restored) — Activity itself posted no money.
    await ok(aaron.request, 'order.pickup', { orderId, clientKey: `act-${orderId}`.slice(0, 40) });
    pickedUp = true;
    const takeId = takeIdForOrder(orderId);
    expect(takeId, 'pickup created a take to undo').not.toBe('');
    await ok(aaron.request, 'take.undo', { takeId });
  } finally {
    if (orderId && !pickedUp) {
      // Never reached READY cleanly — cancel while still cancelable.
      await rpc(aaron.request, 'order.cancel', { orderId });
    }
    await ctxAaron.close();
    await ctxDana.close();
  }
});

test('connection request is accepted from Activity with the circle picker', async ({
  page,
  browser,
}) => {
  const HH = 'e2e-activity-hh';
  const UID = 'e2e-activity-user';
  const EMAIL = 'ada.activity@demo.coop';
  const SLUG = 'e2e-activity-ada';
  const cleanup = `
    const Database=require('better-sqlite3');
    const db=new Database(process.env.DATABASE_URL.replace(/^file:/,''));
    db.prepare("DELETE FROM Session WHERE userId='${UID}'").run();
    db.prepare("DELETE FROM Membership WHERE userId='${UID}'").run();
    db.prepare("DELETE FROM Connection WHERE householdAId='${HH}' OR householdBId='${HH}'").run();
    db.prepare("DELETE FROM Circle WHERE householdId='${HH}'").run();
    db.prepare("DELETE FROM User WHERE id='${UID}'").run();
    db.prepare("DELETE FROM Household WHERE id='${HH}'").run();
  `;
  execInApp(cleanup);
  execInApp(`
    const { hashSync }=require('@node-rs/argon2');
    const Database=require('better-sqlite3');
    const db=new Database(process.env.DATABASE_URL.replace(/^file:/,''));
    db.prepare("INSERT OR IGNORE INTO Household (id,name,slug) VALUES ('${HH}','Ada (e2e)','${SLUG}')").run();
    const hash=hashSync('${PASSWORD}',{memoryCost:19456,timeCost:2,parallelism:1});
    db.prepare("INSERT OR IGNORE INTO User (id,username,name,email,passwordHash) VALUES ('${UID}','${UID}','Ada','${EMAIL}',?)").run(hash);
    db.prepare("INSERT OR IGNORE INTO Membership (id,userId,householdId,manageHousehold,manageConnections,receiveStock,placeOrders,spend,fulfill,adjustInventory,lendBorrow,postShares,editRecipes,settleMoney) VALUES ('m-${UID}','${UID}','${HH}',1,1,1,1,1,1,1,1,1,1,1)").run();
  `);

  const adaCtx = await browser.newContext({ baseURL: BASE });
  let connectionId = '';
  try {
    await login(page, 'aaron');
    const ada = await adaCtx.newPage();
    await login(ada, EMAIL);

    // Ada mints a circle and requests Heise by handle → Heise gets an incoming
    // PENDING request, which surfaces in aaron's Activity.
    const adaCircle = (
      await ok(ada.request, 'circle.create', {
        name: 'Friends',
        grants: { pantry: true, lending: true, recipes: true, shareTo: true, shareFrom: true, reshare: false },
      })
    ).id;
    connectionId = (await ok(ada.request, 'connection.request', { slug: 'heise', circleId: adaCircle })).id;

    await page.goto('/activity');
    const row = page
      .getByTestId('activity-item')
      .filter({ hasText: 'Ada (e2e)' })
      .filter({ has: page.getByTestId('activity-connection-accept') });
    await expect(row.first()).toBeVisible();

    // Accept opens the exported circle picker; choose a circle and connect.
    await row.first().getByTestId('activity-connection-accept').click();
    const picker = page.getByTestId('connection-circle-picker').first();
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('radio').first()).toBeVisible(); // circles loaded
    await page.getByTestId('activity-connection-accept-confirm').first().click();

    // The edge is now ACTIVE and no longer a pending request in Activity.
    await expect
      .poll(async () => {
        const list = (await (await page.request.get('/api/trpc/connection.list')).json()).result.data
          .connections as { id: string; status: string }[];
        return list.find((c) => c.id === connectionId)?.status;
      })
      .toBe('ACTIVE');
    expect(byId((await activity(page.request)).items, `connection:${connectionId}`)).toBeUndefined();
  } finally {
    if (connectionId) await rpc(page.request, 'connection.sever', { connectionId });
    execInApp(cleanup);
    await adaCtx.close();
  }
});

test('a claim on our post is confirmed from Activity (fulfill), the gift is free', async ({
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const ctxAaron = await browser.newContext({ baseURL: BASE });
  const aaron = await ctxAaron.newPage();
  const dana = await apiLogin('dana');

  let postId = '';
  const title = uniq('Activity Zucchini', P);
  try {
    await login(aaron, 'aaron');
    // aaron posts a SURPLUS (uncounted) that In-Laws can see; dana claims it.
    postId = (
      await ok(aaron.request, 'share.create', {
        type: 'SURPLUS',
        title,
        clientKey: `sc-${RUN}-${P}`.slice(0, 40),
      })
    ).id;
    const claim = await ok(dana, 'share.claim', {
      postId,
      clientKey: `cl-${RUN}-${P}`.slice(0, 40),
    });

    await aaron.goto('/activity');
    // Scope by the unique post title (the claim row reads '… wants "<title>"').
    const row = aaron.getByTestId('activity-item').filter({ hasText: title });
    await expect(row.first()).toBeVisible();
    await row.first().getByTestId('activity-claim-confirm').click();

    // The claim is CONFIRMED and no longer a pending attention item.
    await expect
      .poll(async () => byId((await activity(aaron.request)).items, `claim:${claim.id}`))
      .toBeUndefined();
  } finally {
    if (postId) await rpc(aaron.request, 'share.withdraw', { postId });
    await ctxAaron.close();
    await dana.dispose();
  }
});

test('the bell shows a badge and a preview popover that links to Activity', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const data = await overview(page.request);
  const own = data.households.find((h) => h.id === data.yourHouseholdId)!;
  const created = await ok(page.request, 'restock.create', {
    pantryId: own.pantries[0].id,
    retailer: uniq('Bell Trip', P),
    purchasedAt: TODAY(),
    purchaserHouseholdId: data.yourHouseholdId,
    receiptTotalCents: null,
  });
  const restockId = created.id as string;
  try {
    await page.goto('/');
    await expect(page.getByTestId('app-header')).toBeVisible();
    // aaron holds receiveStock and Heise has a pantry, so the Receive
    // quick-action renders (can/hide).
    await expect(page.getByTestId('header-receive')).toBeVisible();
    // The draft makes the badge non-zero.
    await expect(page.getByTestId('bell-badge')).toBeVisible();
    await page.getByTestId('header-bell').click();
    const popover = page.getByTestId('bell-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId('bell-item').first()).toBeVisible();
    await popover.getByTestId('bell-see-all').click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.getByTestId('activity-list')).toBeVisible();
  } finally {
    await rpc(page.request, 'restock.deleteDraft', { restockId });
  }
});

test('the acting-household chip shows for a multi-membership user (marie)', async ({ page }) => {
  await login(page, 'marie');
  await page.goto('/');
  await expect(page.getByTestId('header-household-chip')).toBeVisible();
});
