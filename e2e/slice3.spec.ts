import { expect, test, type Page } from '@playwright/test';

/**
 * Slice 3 acceptance (blueprint 02 anchors): the two-tap take with FIFO
 * suggestion, own-pantry no-charge takes, the ledger with its net-position
 * hero, undo from the toast and from the ledger detail, and the server-side
 * stock/authz guards.
 *
 * Both browser projects share one database and the ledger accumulates across
 * runs, so every net-position assertion is a DELTA against a value read
 * before acting — never an absolute balance. Product names carry the project
 * name and a per-run token.
 */

const PASSWORD = 'demo-password';
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);

const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
}

/**
 * Open the first pantry of the household whose section matches `household`.
 * Navigates via the tab bar (client-side): a page.goto() that aborts an
 * in-flight RSC navigation/refresh makes Next fall back to a full-page load,
 * which then interrupts the goto — a real flake on both engines.
 */
async function openPantryOf(page: Page, household: string | 'own') {
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  await expect(page).toHaveURL(/\/$/);
  const group =
    household === 'own'
      ? page.getByTestId('pantry-group').filter({ hasText: 'your household' })
      : page.getByTestId('pantry-group').filter({ hasText: household });
  await group.getByTestId('pantry-row').first().click();
  await expect(page.getByTestId('product-row').first().or(page.getByText(/empty|Nothing to browse/i))).toBeVisible();
}

/**
 * Receive one product into the signed-in user's own pantry via the wizard
 * (skipping photos) and return the restock id and code. `existingProduct`
 * picks a search result instead of creating the product.
 */
async function receiveLot(
  page: Page,
  opts: {
    product: string;
    units: number;
    total: string;
    date?: string;
    existingProduct?: boolean;
    purchaser?: string; // household name; defaults to the signed-in user's
  },
) {
  await openPantryOf(page, 'own');
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(`Take3-${RUN}`);
  if (opts.date) await page.getByLabel('Receipt date').fill(opts.date);
  if (opts.purchaser) {
    await page.getByLabel('Purchaser household').selectOption({ label: opts.purchaser });
  }
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
  // Every step has a "Next": wait for each step's heading, or a fast second
  // click lands on the previous step's still-mounted button.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
  await page.getByTestId('finalize').click();
  const code = (await page.getByTestId('restock-code').textContent())!;
  expect(code).toMatch(/^\d{6}-\d{2,}$/);
  await page.getByRole('link', { name: 'Back to pantry' }).click();
  // Wait for the pantry to fully render, not just the URL: a goto() that
  // aborts the in-flight RSC navigation makes Next fall back to a full-page
  // load of the pantry, which then interrupts that goto (flaky on WebKit).
  await expect(page.getByTestId('receive-fab')).toBeVisible();
  return { restockId, code };
}

/** Signed net with the (single) counterparty, in cents, from /ledger's hero. */
async function netCents(page: Page) {
  // Tab-bar navigation for the same reason as openPantryOf; then a reload —
  // clicking the tab while already on /ledger reuses the router cache, and
  // the reload is race-free because the navigation has settled by then.
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Ledger' }).click();
  await expect(page.getByTestId('net-hero')).toBeVisible();
  await page.reload();
  const text = (await page.getByTestId('net-hero').textContent())!;
  const m = text.match(/You're (up|down) \$(\d+)\.(\d{2})/);
  if (!m) {
    expect(text).toContain("You're even");
    return 0;
  }
  const cents = Number(m[2]) * 100 + Number(m[3]);
  return m[1] === 'up' ? cents : -cents;
}

test('cross-household take debits the taker at unit cost and undo reverses it', async ({ page, browser }, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Diced Tomatoes', P);

  // Aaron stocks his own pantry: 3 units, $10.00 → $3.33/u (D1 half-up).
  await login(page, 'aaron@demo.coop');
  await receiveLot(page, { product, units: 3, total: '10.00' });
  const aaronBefore = await netCents(page);

  // Dana takes 2 from the Heise pantry — two taps: product row, then Take.
  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const danaBefore = await netCents(dana);

  await openPantryOf(dana, 'Heise');
  await dana.getByTestId('product-row').filter({ hasText: product }).getByRole('button').first().click();
  await expect(dana.getByTestId('take-sheet')).toBeVisible();
  await expect(dana.getByText('oldest ✓')).toBeVisible();
  await expect(dana.getByText('$3.33/u')).toBeVisible();
  await dana.getByRole('button', { name: 'Take more' }).click();
  await expect(dana.getByTestId('take-cost')).toHaveText("You'll owe Heise $6.66");
  await dana.getByTestId('take-submit').click();
  await expect(dana.getByTestId('take-toast')).toContainText(`Took 2 × ${product}`);

  // Inventory decremented live; ledger shows the entry from each side.
  await expect(
    dana.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
  ).toHaveText('1');
  expect(await netCents(dana)).toBe(danaBefore - 666);
  // hasText strings are case-insensitive, which would also match the later
  // "Undo take 2× …" row — a case-sensitive regex pins the original entry.
  const takeRowText = new RegExp(`Take 2× ${product}`);
  const danaRow = dana.getByTestId('ledger-row').filter({ hasText: takeRowText });
  await expect(danaRow).toContainText('−$6.66');
  expect(await netCents(page)).toBe(aaronBefore + 666);
  await expect(
    page.getByTestId('ledger-row').filter({ hasText: takeRowText }),
  ).toContainText('+$6.66');

  // Type chips: the take shows under Takes, not under Payments.
  await dana.getByRole('tab', { name: 'Takes' }).click();
  await expect(danaRow).toBeVisible();
  await dana.getByRole('tab', { name: 'Payments' }).click();
  await expect(danaRow).toHaveCount(0);
  await dana.getByRole('tab', { name: 'All' }).click();

  // Undo from the ledger detail posts a swapped REVERSAL; the original entry
  // stays (append-only) and the units return to the lot.
  await danaRow.getByRole('button').click();
  await dana.getByTestId('ledger-undo').click();
  await expect(
    dana.getByTestId('ledger-row').filter({ hasText: `Undo take 2× ${product}` }),
  ).toContainText('+$6.66');
  await expect(danaRow).toContainText('undone');
  expect(await netCents(dana)).toBe(danaBefore);
  await openPantryOf(dana, 'Heise');
  await expect(
    dana.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
  ).toHaveText('3');

  await danaContext.close();
});

test('own-pantry take is no-charge, logged, and undoable from the toast', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Olive Oil', P);

  await login(page, 'aaron@demo.coop');
  await receiveLot(page, { product, units: 2, total: '5.00' });
  const before = await netCents(page);

  await openPantryOf(page, 'own');
  const row = page.getByTestId('product-row').filter({ hasText: product });
  await row.getByRole('button').first().click();
  await expect(page.getByTestId('take-cost')).toHaveText('No charge — your pantry');
  await page.getByTestId('take-submit').click();
  await expect(page.getByTestId('take-toast')).toContainText(`Took 1 × ${product}`);
  await expect(row.getByTestId('product-total')).toHaveText('1');

  // No ledger movement for own-household takes (invariant 4).
  expect(await netCents(page)).toBe(before);
  await expect(page.getByTestId('ledger-row').filter({ hasText: product })).toHaveCount(0);

  // Take the last unit; the stepper blocks overtaking; toast-undo restores it.
  await openPantryOf(page, 'own');
  await row.getByRole('button').first().click();
  await expect(page.getByRole('button', { name: 'Take more' })).toBeDisabled();
  await page.getByTestId('take-submit').click();
  await expect(page.getByTestId('take-toast')).toBeVisible();
  // The product vanishes from inventory at 0 remaining…
  await expect(row).toHaveCount(0);
  // …and comes back when the toast's Undo returns the unit.
  await page.getByTestId('toast-undo').click();
  await expect(page.getByTestId('take-toast')).toHaveCount(0);
  await expect(row.getByTestId('product-total')).toHaveText('1');
});

test('the take sheet preselects the oldest lot as the FIFO suggestion', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Rice', P);

  await login(page, 'aaron@demo.coop');
  // Older restock first (explicit past date), then a second one dated today.
  const older = await receiveLot(page, { product, units: 2, total: '4.00', date: '2026-06-01' });
  const newer = await receiveLot(page, { product, units: 2, total: '4.40', existingProduct: true });

  await openPantryOf(page, 'own');
  await page.getByTestId('product-row').filter({ hasText: product }).getByRole('button').first().click();
  const lotSelect = page.getByTestId('take-lot');
  await expect(lotSelect.locator('option:checked')).toContainText(older.code);
  await expect(page.getByText('oldest ✓')).toBeVisible();

  // Overriding is allowed — suggested, never enforced — and drops the badge.
  await lotSelect.selectOption({ index: 1 });
  await expect(lotSelect.locator('option:checked')).toContainText(newer.code);
  await expect(page.getByText('oldest ✓')).toHaveCount(0);
});

test('the server guards stock, undo authz, and double undo', async ({ page, browser }, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Guard Beans', P);

  await login(page, 'aaron@demo.coop');
  const { restockId } = await receiveLot(page, { product, units: 2, total: '3.00' });
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const lotId = (await got.json()).result.data.lots[0].id as string;

  // Invalid quantities never reach the decrement: zod (.int().min(1)) rejects
  // them. A negative quantity passing through would *increment* stock and
  // post a negative-amount ledger entry.
  for (const quantity of [0, -1, 1.5]) {
    const bad = await page.request.post('/api/trpc/take.create', {
      data: { lotId, quantity },
    });
    expect(bad.status(), `quantity ${quantity} must be rejected`).toBe(400);
  }

  // Overtake: the conditional decrement misses → CONFLICT, nothing taken.
  const overtake = await page.request.post('/api/trpc/take.create', {
    data: { lotId, quantity: 5 },
  });
  expect(overtake.status()).toBe(409);

  // A real take; only the taking household may undo it.
  const taken = await page.request.post('/api/trpc/take.create', {
    data: { lotId, quantity: 1 },
  });
  expect(taken.ok()).toBe(true);
  const takeId = (await taken.json()).result.data.takeId as string;

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const foreignUndo = await dana.request.post('/api/trpc/take.undo', { data: { takeId } });
  expect(foreignUndo.status()).toBe(403);
  await danaContext.close();

  // The owner undoes once; a double-submit fails closed (D2 reversedAt guard).
  const undo = await page.request.post('/api/trpc/take.undo', { data: { takeId } });
  expect(undo.ok()).toBe(true);
  const again = await page.request.post('/api/trpc/take.undo', { data: { takeId } });
  expect(again.status()).toBe(409);

  // Double-submit guard: replaying take.create with the same clientKey (a
  // double-tap racing the disabled re-render) returns the original take and
  // decrements once — the lot's second unit is still takeable afterwards.
  const key = `idem-${P}-${RUN}`;
  const first = await page.request.post('/api/trpc/take.create', {
    data: { lotId, quantity: 1, clientKey: key },
  });
  expect(first.ok()).toBe(true);
  const firstTakeId = (await first.json()).result.data.takeId as string;
  const replay = await page.request.post('/api/trpc/take.create', {
    data: { lotId, quantity: 1, clientKey: key },
  });
  expect(replay.ok()).toBe(true);
  expect((await replay.json()).result.data.takeId).toBe(firstTakeId);
  const second = await page.request.post('/api/trpc/take.create', { data: { lotId, quantity: 1 } });
  expect(second.ok(), 'a double decrement would have emptied the lot').toBe(true);

  // Lots on a DRAFT restock are not takeable (status guard in the decrement).
  await openPantryOf(page, 'own');
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(`Draft-${P}-${RUN}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);
  const draftId = page.url().match(/\/receive\/([^/?]+)/)![1];
  await page.getByRole('button', { name: 'Skip photos' }).click();
  await page.getByTestId('add-line').click();
  const draftProduct = uniq('Draft Item', P);
  await page.getByTestId('product-search').fill(draftProduct);
  await page.getByTestId('create-product').click();
  await page.getByTestId('line-total').fill('1.00');
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: draftProduct })).toBeVisible();
  const draftGot = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: draftId }))}`,
  );
  const draftLotId = (await draftGot.json()).result.data.lots[0].id as string;
  const draftTake = await page.request.post('/api/trpc/take.create', {
    data: { lotId: draftLotId, quantity: 1 },
  });
  expect(draftTake.status()).toBe(409);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Abandon restock').click();
  // The wizard URL also starts with /pantries/ — assert we actually left it.
  await expect(page).not.toHaveURL(/\/receive\//);
});

test('a take that loses the stock race surfaces the server error in the sheet', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Race Salsa', P);

  await login(page, 'aaron@demo.coop');
  const { restockId } = await receiveLot(page, { product, units: 1, total: '2.00' });
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const lotId = (await got.json()).result.data.lots[0].id as string;

  await openPantryOf(page, 'own');
  await page.getByTestId('product-row').filter({ hasText: product }).getByRole('button').first().click();
  await expect(page.getByTestId('take-sheet')).toBeVisible();

  // The last unit vanishes while the sheet is open (someone else took it).
  const raced = await page.request.post('/api/trpc/take.create', { data: { lotId, quantity: 1 } });
  expect(raced.ok()).toBe(true);

  // Submit → 409 → the sheet shows the error and stays open for a retry.
  await page.getByTestId('take-submit').click();
  await expect(page.getByTestId('take-sheet').getByRole('alert')).toHaveText('Not enough left.');
  await expect(page.getByTestId('take-submit')).toBeEnabled();
  await expect(page.getByTestId('take-submit')).toHaveText('Take');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('take-sheet')).toHaveCount(0);
});

test('own takes stay undoable from the restock detail; a stale toast undo shows the error', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Pinto Beans', P);

  await login(page, 'aaron@demo.coop');
  const { restockId, code } = await receiveLot(page, { product, units: 2, total: '3.00' });
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const lotId = (await got.json()).result.data.lots[0].id as string;

  // Take one via the UI; the toast carries the take id.
  await openPantryOf(page, 'own');
  const row = page.getByTestId('product-row').filter({ hasText: product });
  await row.getByRole('button').first().click();
  await page.getByTestId('take-submit').click();
  const toast = page.getByTestId('take-toast');
  await expect(toast).toContainText(`Took 1 × ${product}`);
  const takeId = (await toast.getAttribute('data-take-id'))!;

  // Undone out-of-band (another device) → the stale toast's Undo must fail
  // *visibly* (toastError branch), not silently.
  const undone = await page.request.post('/api/trpc/take.undo', { data: { takeId } });
  expect(undone.ok()).toBe(true);
  await page.getByTestId('toast-undo').click();
  await expect(toast).toContainText('Already undone.');

  // The lot code in the pantry links to the restock detail…
  await openPantryOf(page, 'own');
  await row.getByTestId('product-expand').click();
  await page.getByRole('link', { name: code }).click();
  await expect(page).toHaveURL(/\/restocks\//);

  // …where the take history lives: the undone take is flagged, not undoable.
  const takeRows = page.getByTestId('restock-take-row');
  await expect(takeRows.filter({ hasText: 'undone' })).toHaveCount(1);
  await expect(takeRows.first()).toContainText('no charge');
  await expect(page.getByTestId('restock-take-undo')).toHaveCount(0);

  // A fresh own-household take (no ledger row, toast long gone) is undoable
  // right here — SPEC §4's "takes can be edited/undone" for the own-pantry case.
  const taken = await page.request.post('/api/trpc/take.create', { data: { lotId, quantity: 1 } });
  expect(taken.ok()).toBe(true);
  await page.reload();
  await expect(takeRows).toHaveCount(2);
  await page.getByTestId('restock-take-undo').click();
  await expect(takeRows.filter({ hasText: 'undone' })).toHaveCount(2);
  await expect(page.getByTestId('restock-take-undo')).toHaveCount(0);

  // Units are back on the shelf.
  await page.getByLabel('Back to pantry').click();
  await expect(row.getByTestId('product-total')).toHaveText('2');
});

test('the home net strip mirrors the ledger pair and the Credits chip filters restock credits', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const fmt = (cents: number) => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  const stripText = (n: number) =>
    n > 0
      ? `You're up ${fmt(n)} with In-Laws`
      : n < 0
        ? `You're down ${fmt(-n)} with In-Laws`
        : "You're even with In-Laws";

  await login(page, 'aaron@demo.coop');
  const before = await netCents(page);

  // The strip shows the same direction and amount as the ledger hero and
  // links to the pair via ?with=.
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  const strip = page.getByTestId('net-strip');
  await expect(strip).toContainText(stripText(before));
  const href = (await strip.getAttribute('href'))!;
  expect(href).toMatch(/^\/ledger\?with=.+/);
  await strip.click();
  await expect(page.getByTestId('net-hero')).toContainText('with In-Laws');

  // ?with= resolves the counterparty (and an unknown id falls back safely).
  await page.goto(href);
  await expect(page.getByTestId('net-hero')).toContainText('with In-Laws');
  await page.goto('/ledger?with=nope');
  await expect(page.getByTestId('net-hero')).toContainText('with In-Laws');

  // A cross-household restock (In-Laws paid for Aaron's pantry) posts a
  // credit: 3 units / $10.00 → $9.99 at cost (D1), debited from Aaron's side.
  const product = uniq('Credit Flour', P);
  const { code } = await receiveLot(page, {
    product,
    units: 3,
    total: '10.00',
    purchaser: 'In-Laws',
  });
  expect(await netCents(page)).toBe(before - 999);

  const creditRow = page.getByTestId('ledger-row').filter({ hasText: code });
  await expect(creditRow).toContainText('Restock credit');
  await expect(creditRow).toContainText('−$9.99');

  // The Credits chip shows it; the Takes chip hides it.
  await page.getByRole('tab', { name: 'Credits' }).click();
  await expect(creditRow).toBeVisible();
  await page.getByRole('tab', { name: 'Takes' }).click();
  await expect(creditRow).toHaveCount(0);
  await page.getByRole('tab', { name: 'All' }).click();

  // And the strip tracks the movement (a sign flip here would show "up").
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  await expect(strip).toContainText(stripText(before - 999));
});
