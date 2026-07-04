import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * Slice 2 acceptance (blueprint 02 anchors): the full receiving wizard —
 * receipt photo upload, manual line review with a hold-back line, unit
 * photo, reconcile, finalize with code screen — plus pantry inventory,
 * cross-household purchaser credit, draft resume/abandon, the draft
 * edit/delete surface, and the server-side authz/variance/upload guards.
 *
 * Both browser projects share one database: product/retailer names carry the
 * project name, and no test asserts absolute pantry-wide unit counts. Names
 * also carry a per-run token so the suite stays green when re-run against a
 * still-running stack (the create-product flow depends on the product not
 * existing yet).
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);

const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

/** Open the signed-in user's own Basement Pantry from the Pantries tab. */
async function openOwnPantry(page: Page) {
  await page.goto('/');
  const ownGroup = page.getByTestId('pantry-group').filter({ hasText: 'your household' });
  await ownGroup.getByTestId('pantry-row').first().click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
}

async function startRestock(
  page: Page,
  opts: { retailer: string; receiptTotal?: string; purchaser?: string },
) {
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(opts.retailer);
  if (opts.receiptTotal) {
    await page.getByLabel('Receipt total (optional)').fill(opts.receiptTotal);
  }
  if (opts.purchaser) {
    await page.getByLabel('Purchaser household').selectOption({ label: opts.purchaser });
  }
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);
  return page.url().match(/\/receive\/([^/?]+)/)![1];
}

async function addLine(
  page: Page,
  opts: { product: string; units: number; total: string; received?: number },
) {
  await page.getByTestId('add-line').click();
  await page.getByTestId('product-search').fill(opts.product);
  await page.getByTestId('create-product').click();
  for (let i = 1; i < opts.units; i++) {
    await page.getByRole('button', { name: 'More units' }).click();
  }
  await page.getByTestId('line-total').fill(opts.total);
  if (opts.received !== undefined) {
    for (let i = opts.units; i > opts.received; i--) {
      await page.getByRole('button', { name: 'Receive fewer' }).click();
    }
  }
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: opts.product })).toBeVisible();
}

test('full receive wizard: photos, lines with hold-back, unit photo, reconcile, code', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);

  // Step 1: start sheet. Lines will sum to $26.48 vs receipt $27.47 → $0.99 short.
  await startRestock(page, { retailer: `Costco-${P}-${RUN}`, receiptTotal: '27.47' });

  // Step 2: receipt photo uploads immediately and round-trips authenticated.
  await page.setInputFiles('[data-testid=receipt-photo-input]', 'e2e/fixtures/receipt-costco.jpg');
  const thumb = page.getByTestId('receipt-thumbs').locator('img').first();
  await expect(thumb).toBeVisible();
  const imageOk = await thumb.evaluate(async (img: HTMLImageElement) => {
    const res = await fetch(img.src);
    return res.ok && res.headers.get('content-type') === 'image/jpeg';
  });
  expect(imageOk).toBe(true);
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 3: one received line (8 × $8.99 → $1.12/u) and one full hold-back.
  await addLine(page, { product: uniq('Diced Tomatoes', P), units: 8, total: '8.99' });
  await expect(page.getByText('$1.12/u')).toBeVisible();
  await addLine(page, { product: uniq('Olive Oil', P), units: 1, total: '17.49', received: 0 });
  await expect(page.getByText('held back')).toBeVisible();

  // Reconcile banner: outside the 2¢ × 2-line auto-pass window → amber.
  await expect(page.getByTestId('variance-banner')).toContainText('$0.99 short');
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 4: only the received line asks for a unit photo.
  await expect(page.getByTestId('unit-photo-card')).toHaveCount(1);
  await page.setInputFiles('[data-testid=unit-photo-input-1]', 'e2e/fixtures/unit-tomatoes.jpg');
  await expect(page.getByRole('button', { name: 'Retake' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 5: outside the window finalizing takes an extra "Finalize anyway"
  // confirm tap — the first tap only arms the button (blueprint 02, D7).
  const finalize = page.getByTestId('finalize');
  await expect(finalize).toHaveText('Finalize');
  await finalize.click();
  await expect(finalize).toContainText('receipt differs by $0.99');
  await finalize.click();

  // Step 6: the restock code, big, for physical labeling.
  const code = await page.getByTestId('restock-code').textContent();
  expect(code).toMatch(/^\d{6}-\d{2,}$/);

  // Restock detail keeps the code and the full line breakdown.
  await page.getByRole('link', { name: 'View restock' }).click();
  await expect(page.getByTestId('restock-code')).toHaveText(code!);
  await expect(page.getByText(uniq('Diced Tomatoes', P))).toBeVisible();
  await expect(page.getByText('recv 8/8')).toBeVisible();
  await expect(page.getByText('recv 0/1')).toBeVisible();
  // Own-household purchase: no purchaser credit.
  await expect(page.getByTestId('restock-credit')).toHaveCount(0);

  // Inventory: the received lot is there under its code; the hold-back is not.
  await page.getByLabel('Back to pantry').click();
  const productRow = page
    .getByTestId('product-row')
    .filter({ hasText: uniq('Diced Tomatoes', P) });
  await expect(productRow).toContainText('8');
  // Row tap opens the take sheet since slice 3 — lots expand via the chevron.
  await productRow.getByTestId('product-expand').click();
  await expect(productRow.getByTestId('lot-row')).toContainText(`${code} · 8 left`);
  await expect(page.getByText(uniq('Olive Oil', P))).toHaveCount(0);
});

test('cross-household purchaser is credited at cost for received units', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  // Dana receives into the In-Laws pantry a trip that Heise paid for.
  await login(page, 'dana');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `CrossShop-${P}-${RUN}`, purchaser: 'Heise' });

  // Skip photos (manual entry works standalone).
  await page.getByRole('button', { name: 'Skip photos' }).click();

  // 3 units at $10.00 → unit cost $3.33; credit = 3 × $3.33 = $9.99,
  // not the $10.00 line total (D1: all money moves as count × unitCost).
  await addLine(page, { product: uniq('Tomato Flat', P), units: 3, total: '10.00' });
  // Each step has a "Next" — wait for the next step's heading, or a fast
  // second click lands on the previous step's still-mounted button.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();

  await expect(page.getByText('Heise will be credited at cost')).toBeVisible();
  const finalize = page.getByTestId('finalize');
  await expect(finalize).toHaveText('Finalize'); // no receipt total → auto-pass, one tap
  await finalize.click();

  await expect(page.getByTestId('restock-code')).toBeVisible();
  await page.getByRole('link', { name: 'View restock' }).click();
  await expect(page.getByTestId('restock-credit')).toHaveText('Heise credited $9.99 at cost');
});

test('a draft survives refresh, resumes from the pantry, and can be abandoned', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  const pantryUrl = page.url();
  await startRestock(page, { retailer: `Resume-${P}-${RUN}` });

  // The draft lives server-side: a hard reload keeps the wizard state.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Receipt photos' })).toBeVisible();

  // Back on the pantry, the resume banner points at the same draft.
  await page.goto(pantryUrl);
  const banner = page.getByTestId('resume-draft');
  await expect(banner).toContainText(`Resume-${P}-${RUN}`);
  await banner.click();
  await expect(page.getByRole('heading', { name: 'Receipt photos' })).toBeVisible();

  // ✕ now just CLOSES — no confirm, no deletion. Back on the pantry the draft
  // is still there, so its resume banner survives (Round A: the ✕ stopped
  // abandoning; explicit Abandon is a separate button).
  await page.getByLabel('Close (draft is saved)').click();
  await expect(page).toHaveURL(pantryUrl);
  await expect(
    page.getByTestId('resume-draft').filter({ hasText: `Resume-${P}-${RUN}` }),
  ).toBeVisible();

  // Resume, then abandon for real via the explicit button — confirm, then the
  // draft (and its banner) is gone. Assert on THIS draft's retailer, not banner
  // count — a crashed earlier run can leave an unrelated draft behind, and the
  // banner shows whichever is newest.
  await page.getByTestId('resume-draft').filter({ hasText: `Resume-${P}-${RUN}` }).click();
  await expect(page.getByRole('heading', { name: 'Receipt photos' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page).toHaveURL(pantryUrl);
  await expect(
    page.getByTestId('resume-draft').filter({ hasText: `Resume-${P}-${RUN}` }),
  ).toHaveCount(0);
});

test('draft lines, photos, and header details stay editable until finalize', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  // The receipt total is typoed at step 1 and fixed later via Edit details.
  const restockId = await startRestock(page, { retailer: `Edit-${P}-${RUN}`, receiptTotal: '68.02' });

  // Two receipt pages; removing one while DRAFT deletes the file from disk.
  await page.setInputFiles('[data-testid=receipt-photo-input]', [
    'e2e/fixtures/receipt-costco.jpg',
    'e2e/fixtures/receipt-costco.jpg',
  ]);
  await expect(page.getByTestId('receipt-thumbs').locator('img')).toHaveCount(2);
  const removedSrc = await page
    .getByTestId('receipt-thumbs')
    .locator('img')
    .first()
    .getAttribute('src');
  await page.getByLabel('Remove page 1').click();
  await expect(page.getByTestId('receipt-thumbs').locator('img')).toHaveCount(1);
  expect((await page.request.get(removedSrc!)).status()).toBe(404);

  await page.getByRole('button', { name: 'Next' }).click();

  // Edit an existing line: 8 → 9 units, new total; received tracks units.
  const rice = uniq('Rice', P);
  await addLine(page, { product: rice, units: 8, total: '8.99' });
  await page.getByTestId('line-row').filter({ hasText: rice }).click();
  await page.getByRole('button', { name: 'More units' }).click();
  await page.getByTestId('line-total').fill('9.99');
  await page.getByTestId('save-line').click();
  const riceRow = page.getByTestId('line-row').filter({ hasText: rice });
  await expect(riceRow).toContainText('9 units');
  await expect(riceRow).toContainText('recv 9/9');

  // Delete a mistaken line from its sheet.
  const oops = uniq('Oops', P);
  await addLine(page, { product: oops, units: 1, total: '5.00' });
  await page.getByTestId('line-row').filter({ hasText: oops }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('line-row').filter({ hasText: oops })).toHaveCount(0);

  // Fix the typoed receipt total from the always-visible header affordance.
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-receipt-total').fill('9.99');
  await page.getByTestId('save-details').click();
  await expect(page.getByTestId('edit-details')).toContainText('receipt $9.99');

  // Variance is now zero → reconciled, single-tap finalize.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
  const finalize = page.getByTestId('finalize');
  await expect(finalize).toHaveText('Finalize');
  await finalize.click();
  await expect(page.getByTestId('restock-code')).toBeVisible();

  // Receipt photos are permanent once finalized: removeImage is refused.
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const imageId = (await got.json()).result.data.images[0].id as string;
  const refused = await page.request.post('/api/trpc/restock.removeImage', {
    data: { imageId },
  });
  expect(refused.status()).toBe(412);
});

test('the server rejects a missing or stale variance acknowledgment', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  const restockId = await startRestock(page, {
    retailer: `Variance-${P}-${RUN}`,
    receiptTotal: '27.47',
  });
  await page.getByRole('button', { name: 'Skip photos' }).click();
  await addLine(page, { product: uniq('Beans', P), units: 8, total: '8.99' });
  // True variance: $27.47 − $8.99 = $18.48, far outside the auto-pass window.

  // No acknowledgment → the D7 consent gate rejects (PRECONDITION_FAILED).
  const unacknowledged = await page.request.post('/api/trpc/restock.finalize', {
    data: { restockId, acknowledgedVarianceCents: null },
  });
  expect(unacknowledged.status()).toBe(412);
  // A stale echo — a variance the user never saw — is rejected the same way.
  const stale = await page.request.post('/api/trpc/restock.finalize', {
    data: { restockId, acknowledgedVarianceCents: 99 },
  });
  expect(stale.status()).toBe(412);

  // The rejected attempts left the draft intact; the UI's two-tap confirm
  // echoes the variance it actually displays and succeeds.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
  const finalize = page.getByTestId('finalize');
  await expect(finalize).toHaveText('Finalize');
  await finalize.click();
  await expect(finalize).toContainText('receipt differs by $18.48');
  await finalize.click();
  await expect(page.getByTestId('restock-code')).toBeVisible();
});

test('finalize and abandon are gated to the pantry-owner household', async ({ page, browser }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  const pantryUrl = page.url();
  // Purchaser defaults to Heise: Dana has NO standing on this draft, so per
  // the B4 convention she reads not-found — a draft's existence never leaks
  // to households outside the owner/purchaser pair (Potluck R1S2; pre-rework
  // this was a 403).
  const restockId = await startRestock(page, { retailer: `Gate-${P}-${RUN}` });

  const danaContext = await browser.newContext({ baseURL: BASE });
  const danaPage = await danaContext.newPage();
  await login(danaPage, 'dana');
  const finalize = await danaPage.request.post('/api/trpc/restock.finalize', {
    data: { restockId, acknowledgedVarianceCents: null },
  });
  expect(finalize.status()).toBe(404);
  const abandon = await danaPage.request.post('/api/trpc/restock.deleteDraft', {
    data: { restockId },
  });
  expect(abandon.status()).toBe(404);
  await danaContext.close();

  // The creator can still abandon their own draft (via the explicit button).
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page).toHaveURL(pantryUrl);
});

test('image serving and uploads reject unauthenticated and invalid requests', async ({ page, request }) => {
  // The `request` fixture carries no session cookie.
  const unauthImage = await request.get(
    '/api/images/receipts/00000000000000000000000000000000.jpg',
  );
  expect(unauthImage.status()).toBe(401);

  const jpeg = fs.readFileSync('e2e/fixtures/receipt-costco.jpg');
  const unauthUpload = await request.post('/api/upload/receipts', {
    multipart: { file: { name: 'x.jpg', mimeType: 'image/jpeg', buffer: jpeg } },
  });
  expect(unauthUpload.status()).toBe(401);

  await login(page, 'aaron');
  // Path traversal out of the images root is refused even when signed in.
  const traversal = await page.request.get('/api/images/receipts%2F..%2F..%2Fcoop.db');
  expect(traversal.status()).toBe(400);
  // Non-JPEG content fails the magic-byte check…
  const png = await page.request.post('/api/upload/receipts', {
    multipart: {
      file: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('\x89PNG not a jpeg') },
    },
  });
  expect(png.status()).toBe(415);
  // …and unknown kinds fail the whitelist.
  const badKind = await page.request.post('/api/upload/evil', {
    multipart: { file: { name: 'x.jpg', mimeType: 'image/jpeg', buffer: jpeg } },
  });
  expect(badKind.status()).toBe(400);
  // Attach mutations refuse paths that are not fresh, server-named uploads.
  const forged = await page.request.post('/api/trpc/restock.addImage', {
    data: { restockId: 'whatever', path: '../coop.db' },
  });
  expect(forged.status()).toBe(400);
});
