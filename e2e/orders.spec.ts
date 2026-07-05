import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { gotoStable, login, openHome } from './helpers';

/**
 * Orders engine (PLAN "Orders & requests + receiving refinement", Slice B):
 * the DRAFT → REQUESTED(reserve) → PICKING(lock) → READY → PICKED_UP(ledger) /
 * CANCELED(release) lifecycle, proven against the real compose stack. The
 * lifecycle mutations are driven through the tRPC API (the requester/owner UI
 * arrives in Slices C/D); reservation is OBSERVED through the rendered pantry
 * availability (remainingCount − reservedCount) and the money through the
 * ledger hero — both real browser reads.
 *
 * Both engines share one accumulating DB, so every balance/availability
 * assertion is a DELTA against a value read before acting, and every product
 * name carries the project + a per-run token.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);

const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

async function openOwnPantry(page: Page) {
  await openHome(page);
  await page.getByTestId('home-pantries').getByTestId('pantry-row').first().click();
  // Wait for the pantry DETAIL (its always-present back link) rather than a
  // product-row/empty check — on a freshly reseeded stack the home page's own
  // "empty" pantry labels make that ambiguous. (The history link is no longer
  // the sentinel: it's owner-only since R1S3 — the history page is the
  // household's books.)
  await expect(page).toHaveURL(/\/pantries\/[^/]+$/);
  await expect(page.getByLabel('Back to pantries')).toBeVisible();
}

/** Receive one product into the signed-in user's own pantry; returns ids/cost. */
async function receiveLot(
  page: Page,
  opts: { product: string; units: number; total: string; date?: string; existingProduct?: boolean },
): Promise<{ restockId: string; pantryId: string; lotId: string }> {
  await openOwnPantry(page);
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(`Orders-${RUN}`);
  if (opts.date) await page.getByLabel('Receipt date').fill(opts.date);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);
  const restockId = page.url().match(/\/receive\/([^/?]+)/)![1];

  await page.getByRole('button', { name: 'Skip photos' }).click();
  await page.getByTestId('add-line').click();
  await page.getByTestId('product-search').fill(opts.product);
  if (opts.existingProduct) {
    await page.getByRole('button', { name: opts.product, exact: true }).click();
  } else {
    await page.getByTestId('create-product').click();
  }
  for (let i = 1; i < opts.units; i++) {
    await page.getByRole('button', { name: 'More units' }).click();
  }
  await page.getByTestId('line-total').fill(opts.total);
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: opts.product })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
  await page.getByTestId('finalize').click();
  await expect(page.getByTestId('restock-code')).toBeVisible();
  await page.getByRole('link', { name: 'Back to pantry' }).click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
  const realPantryId = page.url().match(/\/pantries\/([^/?]+)/)![1];

  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const lotId = (await got.json()).result.data.lots[0].id as string;
  return { restockId, pantryId: realPantryId, lotId };
}

/** Signed net with the (single) counterparty, in cents, from /ledger's hero. */
async function netCents(page: Page): Promise<number> {
  await gotoStable(page, '/ledger');
  await expect(page.getByTestId('net-hero')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('net-hero')).toBeVisible();
  const text = (await page.getByTestId('net-hero').textContent())!;
  const m = text.match(/You're (up|down) \$(\d+)\.(\d{2})/);
  if (!m) {
    expect(text).toContain("You're even");
    return 0;
  }
  const cents = Number(m[2]) * 100 + Number(m[3]);
  return m[1] === 'up' ? cents : -cents;
}

/** Availability (remaining − reserved) shown for a product on a pantry page. */
async function availability(page: Page, pantryId: string, product: string): Promise<number> {
  await page.goto(`/pantries/${pantryId}`);
  await expect(page.getByLabel('Back to pantries')).toBeVisible(); // page rendered
  const row = page.getByTestId('product-row').filter({ hasText: product });
  // A product with zero availability is filtered off the page entirely.
  if ((await row.count()) === 0) return 0;
  return Number(((await row.getByTestId('product-total').textContent()) ?? '0').trim());
}

/** POST a single order mutation as the page's user; returns the raw response. */
function orderPost(page: Page, proc: string, input: object): Promise<APIResponse> {
  return page.request.post(`/api/trpc/order.${proc}`, { data: input });
}

/** POST and assert 200, returning result.data. */
async function orderOk(page: Page, proc: string, input: object) {
  const res = await orderPost(page, proc, input);
  expect(res.status(), `${proc} should succeed`).toBe(200);
  return (await res.json()).result.data;
}

/**
 * Drop any leftover DRAFT cart this household has against the pantry. There
 * is ONE cart per (household, pantry) shared across runs, so a run that died
 * between addToCart and submit/cancel leaves stale lines that poison every
 * later submit (a consumed old lot 409s the whole reservation). addToCart
 * find-or-creates the cart, which hands us its id to cancel.
 */
async function freshCart(page: Page, pantryId: string, lotId: string) {
  const probe = await orderPost(page, 'addToCart', { pantryId, lotId, quantity: 1 });
  if (probe.ok()) {
    const { orderId } = (await probe.json()).result.data as { orderId: string };
    await orderPost(page, 'cancel', { orderId });
  }
}

const clientKey = (label: string) => `${label}-${RUN}-key-000`.slice(0, 40);

test('order lifecycle: request reserves, picking locks, pickup posts the ledger', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('OrderMaters', P);

  // Owner (In-Laws / Dana) stocks their pantry: 5 units @ $10.00 → $2.00/u.
  await login(page, 'dana');
  const { pantryId, lotId } = await receiveLot(page, { product, units: 5, total: '10.00' });

  // Requester (Heise / Aaron) in a second context.
  const ctx = await browser.newContext({ baseURL: BASE });
  const aaron = await ctx.newPage();
  await login(aaron, 'aaron');

  try {
    // Baseline availability = 5 (nothing reserved yet).
    expect(await availability(aaron, pantryId, product)).toBe(5);

    // Build a DRAFT cart (2 units) — reserves nothing.
    await freshCart(aaron, pantryId, lotId);
    const { orderId } = await orderOk(aaron, 'addToCart', { pantryId, lotId, quantity: 2 });
    expect(await availability(aaron, pantryId, product)).toBe(5);

    // Submit → REQUESTED: the 2 units are now reserved and unavailable.
    await orderOk(aaron, 'submit', { orderId });
    expect(await availability(aaron, pantryId, product)).toBe(3);

    // Owner starts picking → edits LOCK.
    await orderOk(page, 'startPicking', { orderId });
    const lockedEdit = await orderPost(aaron, 'setLine', { orderId, lotId, quantity: 4 });
    expect(lockedEdit.status(), 'editing a picking order is rejected').toBe(409);
    expect(await availability(aaron, pantryId, product)).toBe(3); // unchanged

    await orderOk(page, 'markReady', { orderId });

    // Money has NOT moved yet (reservation holds goods only).
    const ownerBefore = await netCents(page);
    const reqBefore = await netCents(aaron);

    // Pickup → the TAKE ledger entries post here.
    await orderOk(aaron, 'pickup', { orderId, clientKey: clientKey('pickup') });

    // Requester owes In-Laws 2 × $2.00 = $4.00; the owner is up the same.
    expect(await netCents(aaron)).toBe(reqBefore - 400);
    expect(await netCents(page)).toBe(ownerBefore + 400);
    // Stock is gone: remaining 5→3, reserved 2→0 → availability 3.
    expect(await availability(aaron, pantryId, product)).toBe(3);

    // Idempotent pickup replay posts nothing more.
    await orderOk(aaron, 'pickup', { orderId, clientKey: clientKey('pickup') });
    expect(await netCents(aaron)).toBe(reqBefore - 400);
  } finally {
    await ctx.close();
  }
});

test('canceling a requested order releases the reservation with no ledger movement', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('CancelKale', P);

  await login(page, 'dana');
  const { pantryId, lotId } = await receiveLot(page, { product, units: 4, total: '8.00' });

  const ctx = await browser.newContext({ baseURL: BASE });
  const aaron = await ctx.newPage();
  await login(aaron, 'aaron');
  try {
    const before = await netCents(aaron);
    await freshCart(aaron, pantryId, lotId);
    const { orderId } = await orderOk(aaron, 'addToCart', { pantryId, lotId, quantity: 3 });
    await orderOk(aaron, 'submit', { orderId });
    expect(await availability(aaron, pantryId, product)).toBe(1); // 4 − 3 reserved

    await orderOk(aaron, 'cancel', { orderId });
    // Reservation released; the ledger never moved (money posts only at pickup).
    expect(await availability(aaron, pantryId, product)).toBe(4);
    expect(await netCents(aaron)).toBe(before);

    // A canceled order can't be picked up.
    const late = await orderPost(aaron, 'pickup', { orderId, clientKey: clientKey('late') });
    expect(late.status()).toBe(409);
  } finally {
    await ctx.close();
  }
});

test('own-pantry order runs the full flow but posts no ledger entry', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('OwnBeans', P);

  await login(page, 'aaron');
  const { pantryId, lotId } = await receiveLot(page, { product, units: 3, total: '6.00' });

  const before = await netCents(page);
  await freshCart(page, pantryId, lotId);
  const { orderId } = await orderOk(page, 'addToCart', { pantryId, lotId, quantity: 2 });
  await orderOk(page, 'submit', { orderId });
  await orderOk(page, 'startPicking', { orderId });
  await orderOk(page, 'markReady', { orderId });
  await orderOk(page, 'pickup', { orderId, clientKey: clientKey('own') });

  // Own-household movement is inventory-only (invariant 4): no ledger delta.
  expect(await netCents(page)).toBe(before);
  expect(await availability(page, pantryId, product)).toBe(1); // 3 − 2 taken
});

test('server guards: zod, ownership, over-reserve, and wrong-state transitions', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('GuardRice', P);

  await login(page, 'dana');
  const { pantryId, lotId } = await receiveLot(page, { product, units: 2, total: '4.00' });

  const ctx = await browser.newContext({ baseURL: BASE });
  const aaron = await ctx.newPage();
  await login(aaron, 'aaron');
  try {
    // zod: quantity must be ≥ 1.
    expect((await orderPost(aaron, 'addToCart', { pantryId, lotId, quantity: 0 })).status()).toBe(400);

    // Over-reserve: cart 5 of a 2-unit lot → submit fails 409, nothing reserved.
    await freshCart(aaron, pantryId, lotId);
    const { orderId } = await orderOk(aaron, 'addToCart', { pantryId, lotId, quantity: 5 });
    expect((await orderPost(aaron, 'submit', { orderId })).status()).toBe(409);
    expect(await availability(aaron, pantryId, product)).toBe(2); // untouched

    // Owner can't submit the requester's order; requester can't pick their own.
    expect((await orderPost(page, 'submit', { orderId })).status()).toBe(403);
    expect((await orderPost(aaron, 'startPicking', { orderId })).status()).toBe(403);

    // Fix the cart to 2 and submit for real.
    await orderOk(aaron, 'setLine', { orderId, lotId, quantity: 2 });
    await orderOk(aaron, 'submit', { orderId });
    expect(await availability(aaron, pantryId, product)).toBe(0);

    // Can't pick up before READY; a foreign household can't touch it at all.
    expect((await orderPost(aaron, 'pickup', { orderId, clientKey: clientKey('early') })).status()).toBe(409);

    // Cancel restores the reservation.
    await orderOk(aaron, 'cancel', { orderId });
    expect(await availability(aaron, pantryId, product)).toBe(2);
  } finally {
    await ctx.close();
  }
});

/** Drive an order through to pickup via the API; returns the orderId. */
async function orderThroughPickup(
  requester: Page,
  owner: Page,
  pantryId: string,
  lotId: string,
  quantity: number,
) {
  await freshCart(requester, pantryId, lotId);
  const { orderId } = await orderOk(requester, 'addToCart', { pantryId, lotId, quantity });
  await orderOk(requester, 'submit', { orderId });
  await orderOk(owner, 'startPicking', { orderId });
  await orderOk(owner, 'markReady', { orderId });
  await orderOk(requester, 'pickup', { orderId, clientKey: clientKey(`p-${orderId}`.slice(0, 20)) });
  return orderId;
}

test('the order flow works end to end through the UI (both households)', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('UIButternut', P);

  // Owner (In-Laws / Dana) stocks 4 units @ $8.00 → $2.00/u.
  await login(page, 'dana');
  const { pantryId, lotId } = await receiveLot(page, { product, units: 4, total: '8.00' });

  const ctx = await browser.newContext({ baseURL: BASE });
  const aaron = await ctx.newPage();
  await login(aaron, 'aaron');
  try {
    // Requester adds 2 to an order via the sheet, then opens the cart. Aaron
    // reaches In-Laws' pantry the way a user does: the Neighbors dashboard's
    // In-Laws section lists its shared pantries, and the row deep-links to the
    // pantry page (the Round-E "Shared pantries" list on each granted section).
    await freshCart(aaron, pantryId, lotId);
    await aaron.goto('/');
    await aaron
      .getByTestId('neighbors-household-section')
      .filter({ hasText: 'In-Laws' })
      .getByTestId('neighbors-pantry-row')
      .first()
      .click();
    await expect(aaron).toHaveURL(/\/pantries\//);
    await aaron.getByTestId('product-row').filter({ hasText: product }).getByRole('button').first().click();
    await expect(aaron.getByTestId('order-sheet')).toBeVisible();
    await aaron.getByRole('button', { name: 'More' }).click();
    await expect(aaron.getByTestId('order-qty')).toHaveText('2');
    await aaron.getByTestId('order-add').click();
    await expect(aaron.getByTestId('cart-bar')).toContainText('2 units');
    await aaron.getByTestId('cart-bar').click();
    await expect(aaron).toHaveURL(/\/orders\/[^/]+$/);
    const orderId = aaron.url().match(/\/orders\/([^/?]+)/)![1];

    // Request it → REQUESTED, and the 2 units are now reserved.
    await expect(aaron.getByTestId('order-status')).toHaveText('Draft');
    await aaron.getByTestId('order-request').click();
    await expect(aaron.getByTestId('order-status')).toHaveText('Requested');
    expect(await availability(aaron, pantryId, product)).toBe(2);

    // Owner sees it in the incoming list, then fulfills it (start → ready).
    await page.goto('/orders');
    await expect(page.getByTestId('incoming-row').first()).toBeVisible();
    await page.goto(`/orders/${orderId}`);
    await page.getByTestId('order-start-picking').click();
    await expect(page.getByTestId('order-status')).toHaveText('Being picked');
    // Editing is locked once picking (no stepper for the owner anyway).
    await page.getByTestId('order-mark-ready').click();
    await expect(page.getByTestId('order-status')).toHaveText('Ready for pickup');

    // Money hasn't moved yet.
    const reqBefore = await netCents(aaron);
    const ownerBefore = await netCents(page);

    // Requester picks up → ledger posts, redirected to the orders list.
    await aaron.goto(`/orders/${orderId}`);
    await aaron.getByTestId('order-pickup').click();
    await expect(aaron).toHaveURL(/\/orders$/);

    expect(await netCents(aaron)).toBe(reqBefore - 400);
    expect(await netCents(page)).toBe(ownerBefore + 400);
    expect(await availability(aaron, pantryId, product)).toBe(2);
  } finally {
    await ctx.close();
  }
});

test('a picked-up cross-household order posts a TAKE both sides, filed under Takes, undoable from the ledger', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('LedgerLentils', P);

  await login(page, 'dana');
  const { pantryId, lotId } = await receiveLot(page, { product, units: 3, total: '9.00' }); // $3.00/u

  const ctx = await browser.newContext({ baseURL: BASE });
  const aaron = await ctx.newPage();
  await login(aaron, 'aaron');
  try {
    const aaronBefore = await netCents(aaron);
    const danaBefore = await netCents(page);
    await orderThroughPickup(aaron, page, pantryId, lotId, 2); // owes $6.00
    expect(await netCents(aaron)).toBe(aaronBefore - 600);
    expect(await netCents(page)).toBe(danaBefore + 600);

    // The TAKE row renders from both sides, labelled from the take.
    const takeRow = new RegExp(`Take 2× ${product}`);
    const aaronRow = aaron.getByTestId('ledger-row').filter({ hasText: takeRow });
    await expect(aaronRow).toContainText('−$6.00');
    await expect(page.getByTestId('ledger-row').filter({ hasText: takeRow })).toContainText('+$6.00');

    // Type chips: under Takes, not Payments.
    await aaron.getByRole('tab', { name: 'Takes' }).click();
    await expect(aaronRow).toBeVisible();
    await aaron.getByRole('tab', { name: 'Payments' }).click();
    await expect(aaronRow).toHaveCount(0);
    await aaron.getByRole('tab', { name: 'All' }).click();

    // Undo from the ledger detail → swapped REVERSAL, original stays, stock back.
    await aaronRow.getByRole('button').first().click();
    await aaron.getByTestId('ledger-undo').click();
    await expect(
      aaron.getByTestId('ledger-row').filter({ hasText: `Undo take 2× ${product}` }),
    ).toContainText('+$6.00');
    await expect(aaronRow).toContainText('undone');
    expect(await netCents(aaron)).toBe(aaronBefore);
    expect(await availability(aaron, pantryId, product)).toBe(3); // returned to the shelf
  } finally {
    await ctx.close();
  }
});

test('own-pantry pickup logs a no-charge take in the restock detail, undoable there', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('RestockRice', P);

  await login(page, 'aaron');
  const { restockId, pantryId, lotId } = await receiveLot(page, { product, units: 2, total: '4.00' });
  await orderThroughPickup(page, page, pantryId, lotId, 1); // own pantry: $0

  await page.goto(`/restocks/${restockId}`);
  const takeRows = page.getByTestId('restock-take-row');
  await expect(takeRows).toHaveCount(1);
  await expect(takeRows.first()).toContainText('no charge');
  await page.getByTestId('restock-take-undo').click();
  await expect(takeRows.filter({ hasText: 'undone' })).toHaveCount(1);
  await expect(page.getByTestId('restock-take-undo')).toHaveCount(0);
  expect(await availability(page, pantryId, product)).toBe(2); // unit back
});

test('the add-to-order sheet preselects the oldest lot (FIFO)', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('FifoFarro', P);

  await login(page, 'aaron');
  // Older restock (explicit past date), then a second dated today.
  await receiveLot(page, { product, units: 2, total: '4.00', date: '2026-06-01' });
  await receiveLot(page, { product, units: 2, total: '4.40', existingProduct: true });

  await openOwnPantry(page);
  await page.getByTestId('product-row').filter({ hasText: product }).getByRole('button').first().click();
  const lotSelect = page.getByTestId('order-lot');
  // The oldest lot (dated 2026-06-01 → code 260601-NN) is preselected (FIFO);
  // the badge only shows on lot index 0.
  await expect(lotSelect.locator('option:checked')).toContainText('260601');
  await expect(page.getByText('oldest ✓')).toBeVisible();
  // Overriding drops the badge (suggested, never enforced).
  await lotSelect.selectOption({ index: 1 });
  await expect(page.getByText('oldest ✓')).toHaveCount(0);
});

test('open-order reservations block a below-reserved write-off/recount and a restock void', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('GuardGrain', P);

  await login(page, 'dana');
  const { restockId, pantryId, lotId } = await receiveLot(page, { product, units: 5, total: '10.00' });

  const ctx = await browser.newContext({ baseURL: BASE });
  const aaron = await ctx.newPage();
  await login(aaron, 'aaron');
  try {
    // Aaron reserves 3 of 5.
    await freshCart(aaron, pantryId, lotId);
    const { orderId } = await orderOk(aaron, 'addToCart', { pantryId, lotId, quantity: 3 });
    await orderOk(aaron, 'submit', { orderId });
    expect(await availability(aaron, pantryId, product)).toBe(2);

    // Owner can't drop physical stock below the 3 reserved units.
    const wo = await page.request.post('/api/trpc/adjustment.writeOff', {
      data: { lotId, count: 3, reason: 'spoiled', clientKey: clientKey('wo1') },
    });
    expect(wo.status(), 'write-off below reserved is rejected').toBe(409);
    const rc = await page.request.post('/api/trpc/adjustment.recount', {
      data: { lotId, countAfter: 1, clientKey: clientKey('rc1') },
    });
    expect(rc.status(), 'recount below reserved is rejected').toBe(409);

    // A write-off within the free stock (2) is allowed.
    const woOk = await page.request.post('/api/trpc/adjustment.writeOff', {
      data: { lotId, count: 2, reason: 'spoiled', clientKey: clientKey('wo2') },
    });
    expect(woOk.ok()).toBe(true);

    // Voiding the restock is blocked while the reservation is open.
    const voided = await page.request.post('/api/trpc/restock.voidInError', { data: { restockId } });
    expect(voided.status(), 'void blocked by open reservation').toBe(412);

    // Nothing was stranded — the order still completes.
    await orderOk(page, 'startPicking', { orderId });
    await orderOk(page, 'markReady', { orderId });
    await orderOk(aaron, 'pickup', { orderId, clientKey: clientKey('gp') });
  } finally {
    await ctx.close();
  }
});
