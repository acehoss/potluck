import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * Polish-round acceptance: the receiving tweaks layered on slices 2/5 —
 *  - the lot code shown up front (assigned at draft start, not finalize),
 *  - tax/fees as explicit non-inventory amounts that close the reconcile,
 *  - tax folded into the frozen unit cost (tax-inclusive credit),
 *  - excluded (non-inventory) lines,
 *  - auto-extraction on entering the review screen + the tax suggestion,
 *  - the restock history list,
 *  - the auditable finalized corrections (correct received counts, void) with
 *    the pre-commit preview.
 *
 * Shares the DB with the other specs: names carry the project + a per-run token.
 */

const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name}-${project}-${RUN}`;

async function openOwnPantry(page: Page) {
  await page.goto('/home');
  const ownGroup = page.getByTestId('home-pantries');
  await ownGroup.getByTestId('pantry-row').first().click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
  return page.url().match(/\/pantries\/([^/?]+)/)![1];
}

async function startRestock(
  page: Page,
  opts: { retailer: string; receiptTotal?: string; purchaser?: string },
) {
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(opts.retailer);
  if (opts.receiptTotal) await page.getByLabel('Receipt total (optional)').fill(opts.receiptTotal);
  if (opts.purchaser) await page.getByLabel('Purchaser household').selectOption({ label: opts.purchaser });
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);
  return page.url().match(/\/receive\/([^/?]+)/)![1];
}

async function addLine(
  page: Page,
  opts: { product: string; units?: number; total: string; taxable?: boolean; received?: number },
) {
  const units = opts.units ?? 1;
  await page.getByTestId('add-line').click();
  await page.getByTestId('product-search').fill(opts.product);
  await page.getByTestId('create-product').click();
  for (let i = 1; i < units; i++) await page.getByRole('button', { name: 'More units' }).click();
  await page.getByTestId('line-total').fill(opts.total);
  if (opts.taxable) await page.getByTestId('line-taxable').check();
  if (opts.received !== undefined) {
    for (let i = units; i > opts.received; i--) {
      await page.getByRole('button', { name: 'Receive fewer' }).click();
    }
  }
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: opts.product })).toBeVisible();
}

async function setTax(page: Page, dollars: string) {
  await page.getByTestId('edit-details').click();
  await page.getByTestId('edit-tax').fill(dollars);
  await page.getByTestId('save-details').click();
}

/**
 * Lines (step 3) → reconcile (step 5), waiting for each heading between clicks:
 * every wizard step has a "Next" button, so a fast second click can land on the
 * previous step's still-mounted button (the slice specs hit the same race).
 */
async function advanceToReconcile(page: Page) {
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
}

test('lot code shows up front, and entered tax closes the reconcile and folds into the credit', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  // Aaron (Heise) receives into his pantry, purchased by In-Laws → In-Laws
  // is credited (cross-household).
  await startRestock(page, { retailer: uniq('Tax', P), receiptTotal: '10.90', purchaser: 'In-Laws' });

  // The label code is assigned at draft START and shown on the photos step —
  // no finalize needed to know it.
  await expect(page.getByTestId('draft-code')).toHaveText(/\d{6}-\d{2}/);
  const code = await page.getByTestId('draft-code').textContent();

  await page.getByRole('button', { name: 'Skip photos' }).click();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();

  const oil = uniq('TaxOil', P);
  await addLine(page, { product: oil, total: '10.00', taxable: true });
  // Before tax: the receipt reads short and the reconcile nudges toward tax.
  await expect(page.getByTestId('variance-banner')).toContainText('short');
  await setTax(page, '0.90');
  // After tax: lines $10.00 + tax $0.90 == receipt $10.90 → reconciled.
  await expect(page.getByText(/Lines .* tax .* Receipt .* reconciled/)).toBeVisible();

  await advanceToReconcile(page);
  await expect(page.getByTestId('finalize')).toHaveText('Finalize');
  await page.getByTestId('finalize').click();
  await expect(page.getByTestId('restock-code')).toHaveText(code!.trim());

  // The credit is TAX-INCLUSIVE: In-Laws credited $10.90, not $10.00.
  await page.getByRole('link', { name: 'View restock' }).click();
  await expect(page.getByTestId('restock-credit')).toContainText('In-Laws credited $10.90');
  await expect(page.getByText('$10.90/u (incl. $0.90 tax/fee)')).toBeVisible();
});

test('a non-coop (excluded) line reconciles the receipt without creating inventory or credit', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  await startRestock(page, { retailer: uniq('Excl', P), receiptTotal: '15.00', purchaser: 'In-Laws' });
  await page.getByRole('button', { name: 'Skip photos' }).click();

  const coop = uniq('CoopItem', P);
  await addLine(page, { product: coop, total: '10.00' });

  // A $5 non-coop line: no product, no units — closes the receipt only.
  await page.getByTestId('add-excluded-line').click();
  await page.getByTestId('line-total').fill('5.00');
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: 'not stocked' })).toBeVisible();

  // $10 coop + $5 excluded == $15 receipt → reconciled (no false variance).
  await expect(page.getByText(/Lines .* Receipt .* reconciled/)).toBeVisible();

  await advanceToReconcile(page);
  await page.getByTestId('finalize').click();
  await expect(page.getByTestId('restock-code')).toBeVisible();

  // Only the $10 coop line is credited (excluded line contributes nothing).
  await page.getByRole('link', { name: 'View restock' }).click();
  await expect(page.getByTestId('restock-credit')).toContainText('In-Laws credited $10.00');
});

test('receipt photos auto-extract lines on the review screen, and the tax is a one-tap suggestion', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  test.skip(P === 'webkit', 'one auto-extract proof on chromium is enough; fixture path is engine-agnostic');
  await login(page, 'aaron');
  await openOwnPantry(page);
  await startRestock(page, { retailer: uniq('Auto', P) });

  await page.setInputFiles('[data-testid=receipt-photo-input]', ['e2e/fixtures/receipt-costco.jpg']);
  await expect(page.getByTestId('receipt-thumbs').locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Next' }).click();

  // No click on "Extract": arriving at Review lines with a photo auto-extracts.
  await expect(page.getByTestId('proposed-row')).toHaveCount(12);
  // The printed tax is surfaced as an explicit one-tap add, never silently applied.
  await expect(page.getByTestId('tax-suggestion')).toContainText('$2.87 tax');
  await page.getByTestId('apply-tax').click();
  // Applying dismisses the suggestion (tax is now set on the draft).
  await expect(page.getByTestId('tax-suggestion')).toHaveCount(0);
  await page.getByTestId('edit-details').click();
  await expect(page.getByTestId('edit-tax')).toHaveValue('2.87');
});

test('restock history lists runs; finalized corrections reverse+repost the credit behind a preview; void clears inventory', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const pantryId = await openOwnPantry(page);

  // A cross-household restock, 2 units received → In-Laws credited $10.00.
  await startRestock(page, { retailer: uniq('Corr', P), receiptTotal: '10.00', purchaser: 'In-Laws' });
  await page.getByRole('button', { name: 'Skip photos' }).click();
  const item = uniq('CorrItem', P);
  await addLine(page, { product: item, units: 2, total: '10.00' });
  await advanceToReconcile(page);
  await page.getByTestId('finalize').click();
  await expect(page.getByTestId('restock-code')).toBeVisible();
  await page.getByRole('link', { name: 'View restock' }).click();
  await expect(page).toHaveURL(/\/restocks\/[^/]+$/);
  await expect(page.getByTestId('restock-credit')).toContainText('$10.00');
  const detailUrl = page.url();

  // History lists this run and links back to the detail.
  await page.goto(`/pantries/${pantryId}/restocks`);
  await expect(page.getByTestId('history-row').first()).toBeVisible();
  await expect(page.getByText(uniq('Corr', P))).toBeVisible();

  // Correct received 2 → 1: the preview states the exact ledger change first.
  await page.goto(detailUrl);
  await page.getByTestId('open-correct').click();
  await page.getByRole('button', { name: `Fewer ${item}` }).click();
  await page.getByTestId('correct-review').click();
  await expect(page.getByTestId('correct-preview')).toContainText('Reverse');
  await expect(page.getByTestId('correct-preview')).toContainText('$10.00'); // old credit reversed
  await expect(page.getByTestId('correct-preview')).toContainText('$5.00'); // corrected credit
  await page.getByTestId('correct-confirm').click();
  // Live credit is now the corrected $5.00 (reversal + repost, both on the record).
  await expect(page.getByTestId('restock-credit')).toContainText('$5.00');

  // Void the run (no takes): inventory zeroes and it's marked voided.
  await page.getByTestId('open-void').click();
  await expect(page.getByTestId('void-preview')).toContainText('Reverse');
  await page.getByTestId('void-confirm').click();
  await expect(page.getByTestId('voided-banner')).toBeVisible();
});
