import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * Slice 5 acceptance (blueprint 02/04 §3): VLM extraction prefilling the
 * receiving review screen, in fixture mode — real HTTP against the compose
 * stack running EXTRACTION_MODE=fixture, no mocks (single exception: the
 * off-mode affordance test, see there). The committed receipt images
 * (e2e/fixtures/receipt-*.jpg) are keyed by sha256 to
 * src/server/extraction-fixtures/<sha>.json; the client hashes the ORIGINAL
 * selected file before the canvas downscale, so the lookup is deterministic
 * on both engines.
 *
 * Covered: extract → Process/Ignore each proposal → lines in draft → finalize
 * (Round A: the one-tap Confirm is gone — every proposal is dispositioned via
 * the Process sheet or Ignore); proposal persistence across step-back and
 * reload (blueprint 02's survival contract); re-extract deduping
 * already-confirmed lines; proposal→product match suggestions;
 * edit-prefilled proposal with hold-back; dismiss
 * (persisted); hostile model output sanitized (edge fixture); zero-line
 * extraction; unknown-sha simulated failure + retry + dismissible notice +
 * untouched manual path; off-mode affordance hiding; authz and rate-limit
 * negatives via raw API.
 *
 * Budget note: extraction is rate-limited per user — 20/15 min in live mode,
 * 200 in fixture/off (no API spend), so repeated full-suite runs never poison
 * each other through the shared in-memory window. Happy-path extracts run as
 * aaron, failure/edge paths as dana, and the exhaustion test as marie.
 */

const RUN = Date.now().toString(36);

const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

// Static descriptions printed on the committed fixture receipts.
const MARINARA = 'KS MARINARA 3CT';
const CHICKEN = 'ROTISSERIE CHICKEN';
const EGGS = 'CAGE FREE EGGS 24CT';
const CHIPS = 'TORTILLA CHIPS 2LB';
// Mirrors EDGE_LONG_DESCRIPTION in scripts/generate-receipt-fixture.ts (240
// chars; the client must slice it to saveLine's 200-char product-name cap).
const EDGE_LONG_DESCRIPTION =
  'ORGANIC FAIR TRADE SHADE GROWN WHOLE BEAN ESPRESSO ROAST COFFEE '.repeat(4).slice(0, 240);

/**
 * Requests from a service-worker-controlled page bypass page.route() in
 * WebKit, so the slice-7 SW (push-only, harmless functionally) silently
 * disarms response interception. Tests that rely on page.route() must call
 * this BEFORE the first navigation. (Playwright's serviceWorkers:'block'
 * context option is not usable instead: under it WebKit's second-and-later
 * contexts intermittently hang on their first goto.)
 */
async function disableServiceWorker(page: Page) {
  await page.addInitScript(() => {
    // Prototype-level: WebKit ignores instance-level overrides of some
    // platform methods (seen with mediaDevices.getUserMedia in slice7).
    if (typeof ServiceWorkerContainer !== 'undefined') {
      ServiceWorkerContainer.prototype.register = () =>
        Promise.reject(new Error('SW disabled by this test (route interception in use)'));
    }
  });
}

async function openOwnPantry(page: Page) {
  await page.goto('/home');
  const ownGroup = page.getByTestId('home-pantries');
  await ownGroup.getByTestId('pantry-row').first().click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
}

async function startRestock(page: Page, opts: { retailer: string; receiptTotal?: string }) {
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(opts.retailer);
  if (opts.receiptTotal) {
    await page.getByLabel('Receipt total (optional)').fill(opts.receiptTotal);
  }
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);
  return page.url().match(/\/receive\/([^/?]+)/)![1];
}

/** Upload a receipt photo on step 2 and land on the line-review step. */
async function uploadReceiptAndGoToLines(page: Page, fixture: string) {
  await page.setInputFiles('[data-testid=receipt-photo-input]', fixture);
  await expect(page.getByTestId('receipt-thumbs').locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();
}

async function addLine(page: Page, opts: { product: string; units: number; total: string }) {
  await page.getByTestId('add-line').click();
  await page.getByTestId('product-search').fill(opts.product);
  await page.getByTestId('create-product').click();
  for (let i = 1; i < opts.units; i++) {
    await page.getByRole('button', { name: 'More units' }).click();
  }
  await page.getByTestId('line-total').fill(opts.total);
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: opts.product })).toBeVisible();
}

/**
 * In an open line sheet, pick the named product if it already exists, else
 * create it. Decides pick-vs-create from the search RESPONSE, not the racing
 * DOM (the create affordance renders optimistically and detaches once an exact
 * match arrives). Keeps tests deterministic on a fresh stack AND on the shared,
 * accumulated one both engines run against.
 */
async function pickOrCreateProduct(page: Page, name: string) {
  const searched = page.waitForResponse(
    (r) => r.url().includes('product.search') && decodeURIComponent(r.url()).includes(name),
  );
  await page.getByTestId('product-search').fill(name);
  type SearchItem = { result?: { data?: { name: string }[] } };
  const payload: SearchItem | SearchItem[] = await (await searched).json();
  const items = (Array.isArray(payload) ? payload : [payload]).flatMap(
    (item) => item?.result?.data ?? [],
  );
  if (items.some((p) => p.name === name)) {
    await page.getByRole('button', { name, exact: true }).first().click();
  } else {
    await page.getByTestId('create-product').click();
  }
}

/** Add a manual line, picking or creating the named product. */
async function addLineWithProduct(page: Page, name: string, total: string) {
  await page.getByTestId('add-line').click();
  await pickOrCreateProduct(page, name);
  await page.getByTestId('line-total').fill(total);
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: name })).toBeVisible();
}

const proposedRow = (page: Page, text: string) =>
  page.getByTestId('proposed-row').filter({ hasText: text });
const lineRow = (page: Page, text: string) =>
  page.getByTestId('line-row').filter({ hasText: text });

/**
 * Resolve a proposed line into a real draft line, deterministically on any
 * stack state. Round A: there is no one-tap Confirm — EVERY proposal is
 * dispositioned through the Process sheet. A matched proposal opens with the
 * product already picked (Save straight through); an unmatched one opens with
 * an empty picker, so we pick/create a real product — the receipt description
 * is never auto-adopted as a product name. Waits for the async match to settle
 * so the sheet's prefill is deterministic.
 */
async function landProposal(page: Page, name: string) {
  const row = proposedRow(page, name);
  await expect(row.getByTestId('proposed-match')).not.toHaveText('matching…');
  await row.getByTestId('proposed-edit').click(); // "Process"
  await expect(page.getByRole('heading', { name: 'Process line' })).toBeVisible();
  // Matched proposals prefill the product (no search field); unmatched ones
  // need a product chosen before Save.
  if (await page.getByTestId('product-search').count()) {
    await pickOrCreateProduct(page, name);
  }
  await page.getByTestId('save-line').click();
  await expect(lineRow(page, name)).toBeVisible();
}

test('extract → land/process/ignore proposals → lines land in the draft → finalize', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  // No receipt total: the reconcile step auto-passes, single-tap finalize.
  await startRestock(page, { retailer: `Extract-${P}-${RUN}` });
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/receipt-costco.jpg');

  // Fire extraction; all 12 fixture lines come back as advisory proposals.
  await page.getByTestId('extract').click();
  await expect(page.getByTestId('proposed-row')).toHaveCount(12);
  // Nothing was written to the draft: proposals never become lots unconfirmed.
  await expect(page.getByTestId('line-row')).toHaveCount(0);

  // Survival, part 1 (blueprint 02): proposals are server state — stepping
  // back to add another receipt page and returning loses nothing and spends
  // no extra extract call.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Receipt photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();
  await expect(page.getByTestId('proposed-row')).toHaveCount(12);

  // Land a proposal as a real draft line: Process opens the sheet prefilled
  // (matched product already picked, or an empty picker to name an unmatched
  // one) and Save lands it — landProposal handles whichever the stack calls for.
  await landProposal(page, MARINARA);
  await expect(proposedRow(page, MARINARA)).toHaveCount(0);
  // D1 preview on the landed line: $8.99 / 3 units → $3.00/u.
  await expect(lineRow(page, MARINARA)).toContainText('3 units');
  await expect(lineRow(page, MARINARA)).toContainText('$8.99');
  await expect(lineRow(page, MARINARA)).toContainText('$3.00/u');

  await landProposal(page, CHICKEN);

  // Process opens the normal line sheet prefilled from the proposal; hold one
  // unit back to prove the full sheet (not a shortcut path) is in play. An
  // unmatched proposal opens with an empty picker (pick/create first); a
  // matched one arrives with the product already set.
  await expect(proposedRow(page, EGGS).getByTestId('proposed-match')).not.toHaveText('matching…');
  await proposedRow(page, EGGS).getByTestId('proposed-edit').click();
  await expect(page.getByRole('heading', { name: 'Process line' })).toBeVisible();
  if (await page.getByTestId('product-search').count()) {
    await pickOrCreateProduct(page, EGGS);
  }
  await expect(page.getByTestId('units-value')).toHaveText('24');
  await expect(page.getByTestId('line-total')).toHaveValue('6.79');
  await page.getByRole('button', { name: 'Receive fewer' }).click();
  await page.getByTestId('save-line').click();
  await expect(lineRow(page, EGGS)).toContainText('recv 23/24');
  await expect(proposedRow(page, EGGS)).toHaveCount(0);

  // Ignore drops the proposal without touching the draft.
  await proposedRow(page, CHIPS).getByTestId('proposed-dismiss').click();
  await expect(proposedRow(page, CHIPS)).toHaveCount(0);
  await expect(lineRow(page, CHIPS)).toHaveCount(0);

  await expect(page.getByTestId('line-row')).toHaveCount(3);
  await expect(page.getByTestId('proposed-row')).toHaveCount(8);

  // Survival, part 2: refresh (≈ tab-kill and reopen) mid-review. Confirmed
  // lines, the dismissal, and the 8 pending proposals all persist.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();
  await expect(page.getByTestId('line-row')).toHaveCount(3);
  await expect(page.getByTestId('proposed-row')).toHaveCount(8);
  await expect(proposedRow(page, CHIPS)).toHaveCount(0);

  // The rest of the wizard is untouched slice-2 behavior.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await expect(page.getByTestId('unit-photo-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
  const finalize = page.getByTestId('finalize');
  await expect(finalize).toHaveText('Finalize');
  await finalize.click();
  await expect(page.getByTestId('restock-code')).toBeVisible();
  expect(await page.getByTestId('restock-code').textContent()).toMatch(/^\d{6}-\d{2,}$/);
});

test('no proposal offers one-tap Confirm; Process forces a real product name for an unmatched line', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `Unmatched-${P}-${RUN}` });
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/receipt-costco.jpg');
  await page.getByTestId('extract').click();
  await expect(page.getByTestId('proposed-row')).toHaveCount(12);

  // Round A: the one-tap Confirm is gone entirely — NO proposal row, matched
  // or not, carries a Confirm affordance. Every line goes through Process/Ignore.
  await expect(page.getByTestId('proposed-confirm')).toHaveCount(0);

  // TORTILLA CHIPS is never turned into a product anywhere in this suite, so
  // its proposal is deterministically UNMATCHED on every engine and re-run.
  const row = proposedRow(page, CHIPS);
  await expect(row.getByTestId('proposed-match')).toContainText('no match');

  // Process opens the sheet with the raw receipt text for reference but an
  // EMPTY product picker — the user must decide.
  await row.getByTestId('proposed-edit').click();
  await expect(page.getByRole('heading', { name: 'Process line' })).toBeVisible();
  await expect(page.getByTestId('line-receipt-text')).toBeVisible();
  await expect(page.getByTestId('product-search')).toBeVisible();

  // Saving with no product chosen is blocked — pick-or-create is mandatory.
  await page.getByTestId('save-line').click();
  await expect(page.getByText('Pick a product or create one.')).toBeVisible();

  // Give it a real, clean name (unique, so 'TORTILLA CHIPS 2LB' never becomes a
  // product — keeps this line unmatched for the next run/engine).
  const cleanName = uniq('Corn Chips', P);
  await page.getByTestId('product-search').fill(cleanName);
  await page.getByTestId('create-product').click();
  await page.getByTestId('save-line').click();

  await expect(lineRow(page, cleanName)).toBeVisible();
  await expect(proposedRow(page, CHIPS)).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
});

test('proposals match existing products; re-extract never re-proposes confirmed lines', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `Match-${P}-${RUN}` });
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/receipt-costco.jpg');

  // Self-sufficient: ensure the product exists (created here on a fresh
  // stack, reused otherwise). 1 unit @ $1.00 differs from the receipt line,
  // so the lot dedupe cannot hide the marinara proposal.
  await addLineWithProduct(page, MARINARA, '1.00');

  await page.getByTestId('extract').click();
  await expect(page.getByTestId('proposed-row')).toHaveCount(12);

  // The suggestion runs through the existing product.search (word match).
  const marinara = proposedRow(page, MARINARA);
  await expect(marinara.getByTestId('proposed-match')).toContainText(`matches ${MARINARA}`);
  // Process opens the sheet with the matched product already prefilled (no
  // picker); Save lands the receipt's $8.99 lot alongside the pre-created one.
  await marinara.getByTestId('proposed-edit').click();
  await expect(page.getByRole('heading', { name: 'Process line' })).toBeVisible();
  await expect(page.getByTestId('product-search')).toHaveCount(0);
  await page.getByTestId('save-line').click();
  await expect(
    page.getByTestId('line-row').filter({ hasText: MARINARA }).filter({ hasText: '$8.99' }),
  ).toBeVisible();
  await expect(page.getByTestId('proposed-row')).toHaveCount(11);

  // Re-extract re-proposes everything EXCEPT lines already confirmed into
  // lots (dedupe on name+units+total) — no 1-tap double-count path.
  const reextracted = page.waitForResponse((r) => r.url().includes('restock.extract'));
  const refetched = page.waitForResponse((r) => r.url().includes('restock.get'));
  await page.getByRole('button', { name: 'Re-extract from receipt' }).click();
  await reextracted;
  await refetched;
  await expect(page.getByTestId('proposed-row')).toHaveCount(11);
  await expect(proposedRow(page, MARINARA)).toHaveCount(0);

  // Abandon: this draft only exists to prove the match/dedupe paths.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
});

test('hostile model output is sanitized: clamps, 200-char cap, discounts dropped', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'dana');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `Edge-${P}-${RUN}` });
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/receipt-edge.jpg');

  await page.getByTestId('extract').click();
  // 5 fixture lines → 3 proposals: the −$3.00 discount line and the $0.00
  // promo line are DROPPED (never clamped to $0.00 — that would overstate
  // the purchaser credit on discounted receipts).
  await expect(page.getByTestId('proposed-row')).toHaveCount(3);
  await expect(proposedRow(page, 'INSTANT SVG')).toHaveCount(0);
  await expect(proposedRow(page, 'FREE PROMO ITEM')).toHaveCount(0);

  // unitCount clamps into saveLine's 1–10,000 range.
  await expect(proposedRow(page, 'ZERO COUNT ITEM')).toContainText('1 unit');
  await expect(proposedRow(page, 'MEGA PACK NAPKINS')).toContainText('10000 units');

  // The 240-char description renders truncated to the 200-char cap in the
  // proposal; it's never adopted as a product name — landing the line goes
  // through Process, where the product name comes from the user (server-capped
  // at 200), so a hostile-length description can't break the flow.
  const longRow = proposedRow(page, 'ESPRESSO ROAST COFFEE');
  await expect(longRow).toContainText(EDGE_LONG_DESCRIPTION.slice(0, 200).trimEnd());
  await landProposal(page, 'ESPRESSO ROAST COFFEE');
  await expect(page.getByTestId('proposed-row')).toHaveCount(2);

  // Dismissal persists (server-side resolution), proven across a reload.
  await proposedRow(page, 'ZERO COUNT ITEM').getByTestId('proposed-dismiss').click();
  await expect(page.getByTestId('proposed-row')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();
  await expect(page.getByTestId('proposed-row')).toHaveCount(1);
  await expect(proposedRow(page, 'ZERO COUNT ITEM')).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
});

test('zero-line extraction shows a dismissible notice', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'dana');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `Empty-${P}-${RUN}` });
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/receipt-empty.jpg');

  await page.getByTestId('extract').click();
  const notice = page.getByTestId('extract-error');
  await expect(notice).toContainText('No lines found');
  await expect(page.getByTestId('proposed-row')).toHaveCount(0);

  // Blueprint 04 §3: the notice is dismissible — manual entry proceeds with
  // no permanent banner squatting above the line list.
  await page.getByTestId('extract-error-dismiss').click();
  await expect(notice).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
});

test('unknown receipt fails extraction with a retriable notice; manual entry is untouched', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'dana');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `Fail-${P}-${RUN}` });
  // unit-tomatoes.jpg has no committed extraction fixture: its sha256 is
  // unknown, which fixture mode treats as the simulated failure.
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/unit-tomatoes.jpg');

  await page.getByTestId('extract').click();
  const notice = page.getByTestId('extract-error');
  await expect(notice).toContainText('unavailable');
  await expect(notice).toContainText('enter lines manually');

  // Retriable — assert the retry actually fires a second extract call (the
  // pre-click notice staying visible would otherwise pass vacuously) and
  // deterministically fails the same way.
  const retried = page.waitForResponse((r) => r.url().includes('restock.extract'));
  await page.getByTestId('extract-retry').click();
  const res = await retried;
  expect(res.status()).toBe(200);
  expect(JSON.stringify(await res.json())).toContain('unavailable');
  await expect(notice).toBeVisible();

  // The manual path is exactly slice-2 behavior, extraction failure or not.
  const product = uniq('Manual Pickles', P);
  await addLine(page, { product, units: 2, total: '7.98' });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
  await page.getByTestId('finalize').click();
  await expect(page.getByTestId('restock-code')).toBeVisible();
});

test('extract affordance hides when the server reports extraction disabled', async ({ page }, testInfo) => {
  // The standard stack runs EXTRACTION_MODE=fixture and the flag is
  // env-derived, so real off-mode is covered by `npm run e2e:off` (the test
  // below). This test regression-guards the CLIENT affordance (`canExtract`)
  // on every run by rewriting extractionEnabled in restock.get's response —
  // the single mocked seam in this suite, kept because the alternative is a
  // second compose stack per run.
  await disableServiceWorker(page); // WebKit: SW-controlled pages bypass page.route()
  type TrpcItem = { result?: { data?: { extractionEnabled?: boolean } } };
  await page.route(
    (url) => url.pathname.startsWith('/api/trpc/') && url.pathname.includes('restock.get'),
    async (route) => {
      const response = await route.fetch();
      const json: TrpcItem | TrpcItem[] = await response.json();
      const procs = new URL(route.request().url()).pathname.split('/').pop()!.split(',');
      const patch = (item?: TrpcItem) => {
        if (item?.result?.data) item.result.data.extractionEnabled = false;
      };
      if (Array.isArray(json)) {
        procs.forEach((p, i) => {
          if (p === 'restock.get') patch(json[i]);
        });
      } else {
        patch(json);
      }
      await route.fulfill({ response, json });
    },
  );

  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `OffClient-${P}-${RUN}` });
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/receipt-costco.jpg');

  // Photos uploaded, yet no extract button — pure manual entry.
  await expect(page.getByTestId('add-line')).toBeVisible();
  await expect(page.getByTestId('extract')).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
});

test('off mode hides the extraction affordance', async ({ page }, testInfo) => {
  // The main suite runs the stack with EXTRACTION_MODE=fixture, so this test
  // self-skips there; `npm run e2e:off` runs it for real against an
  // EXTRACTION_MODE=off stack (down → up → this test → down). The
  // server-derived flag is what's under test here; the client affordance is
  // covered on every standard run by the interception test above.
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  const restockId = await startRestock(page, { retailer: `Off-${P}-${RUN}` });
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/receipt-costco.jpg');

  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const enabled = (await got.json()).result.data.extractionEnabled as boolean;

  if (!enabled) {
    // Off mode: photos uploaded, yet no extract button — pure manual entry.
    await expect(page.getByTestId('extract')).toHaveCount(0);
    await expect(page.getByTestId('add-line')).toBeVisible();
  }

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();

  test.skip(enabled, 'stack is not running EXTRACTION_MODE=off — run via `npm run e2e:off`');
});

test('extract is rejected for unauthenticated callers and finalized restocks', async ({ page, request }, testInfo) => {
  const P = testInfo.project.name;
  // No session cookie → 401 before anything else.
  const unauth = await request.post('/api/trpc/restock.extract', {
    data: { restockId: 'whatever' },
  });
  expect(unauth.status()).toBe(401);

  // FINALIZED restocks refuse extraction (412) — and do so before consuming
  // any of the caller's extraction budget.
  await login(page, 'aaron');
  await openOwnPantry(page);
  const restockId = await startRestock(page, { retailer: `Sealed-${P}-${RUN}` });
  await page.getByRole('button', { name: 'Skip photos' }).click();
  await addLine(page, { product: uniq('Sealed Jam', P), units: 1, total: '4.00' });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
  await page.getByTestId('finalize').click();
  await expect(page.getByTestId('restock-code')).toBeVisible();

  const sealed = await page.request.post('/api/trpc/restock.extract', {
    data: { restockId },
  });
  expect(sealed.status()).toBe(412);

  const missing = await page.request.post('/api/trpc/restock.extract', {
    data: { restockId: 'nope' },
  });
  expect(missing.status()).toBe(404);
});

test('extraction is rate-limited per user', async ({ page }, testInfo) => {
  test.setTimeout(120_000); // up to ~205 sequential API calls
  const P = testInfo.project.name;
  // Marie is the dedicated rate-limit user: exhausting her budget must not
  // starve the happy-path users, across engines or immediate re-runs. The
  // fixture-mode budget is 200/15 min (20 in live mode — see restock.ts).
  await login(page, 'marie');
  await openOwnPantry(page);
  const restockId = await startRestock(page, { retailer: `Limit-${P}-${RUN}` });

  const statuses: number[] = [];
  for (let i = 0; i < 205 && !statuses.includes(429); i++) {
    const res = await page.request.post('/api/trpc/restock.extract', {
      data: { restockId },
    });
    statuses.push(res.status());
  }
  // Pre-limit calls succeed as advisory "unavailable" (draft has no photos);
  // the budget trips within the window regardless.
  expect(statuses).toContain(429);
  expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
});

test('a matched proposal shows no Confirm; Process opens prefilled with the matched product and shows the lot code', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `Matched-${P}-${RUN}` });
  await uploadReceiptAndGoToLines(page, 'e2e/fixtures/receipt-costco.jpg');

  // Pre-create the product so the CHICKEN proposal deterministically MATCHES on
  // every engine/run (a $1.00 line, unlike the receipt's $4.99, so the lot
  // dedupe can't hide the proposal).
  await addLineWithProduct(page, CHICKEN, '1.00');

  await page.getByTestId('extract').click();
  const row = proposedRow(page, CHICKEN);
  await expect(row.getByTestId('proposed-match')).toContainText('matches', { timeout: 10_000 });
  // Round A: even a matched proposal carries NO one-tap Confirm — Process is the
  // only disposition besides Ignore.
  await expect(row.getByTestId('proposed-confirm')).toHaveCount(0);

  // Process opens the sheet prefilled with the matched product (no picker), and
  // the sheet shows the restock's lot code so the user can label the jar without
  // the sheet covering the code behind it.
  await row.getByTestId('proposed-edit').click();
  await expect(page.getByRole('heading', { name: 'Process line' })).toBeVisible();
  await expect(page.getByTestId('product-search')).toHaveCount(0);
  await expect(page.getByTestId('line-lot-code')).toHaveText(/^\d{6}-\d{2,}$/);

  // Save lands the receipt's $4.99 CHICKEN lot alongside the pre-created one,
  // and the proposal is consumed.
  await page.getByTestId('save-line').click();
  await expect(
    page.getByTestId('line-row').filter({ hasText: CHICKEN }).filter({ hasText: '$4.99' }),
  ).toBeVisible();
  await expect(proposedRow(page, CHICKEN)).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
});

test('the line sheet captures a unit photo that lands on the lot and shows already-set at step 4', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  await openOwnPantry(page);
  await startRestock(page, { retailer: `SheetPhoto-${P}-${RUN}` });
  await page.getByRole('button', { name: 'Skip photos' }).click();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();

  // A single manual line, so there's exactly one lot to disambiguate at step 4.
  const product = uniq('Sheet Photo Jam', P);
  await page.getByTestId('add-line').click();
  await page.getByTestId('product-search').fill(product);
  await page.getByTestId('create-product').click();
  await page.getByTestId('line-total').fill('5.00');

  // The lot code is shown in the sheet header (label-the-jar affordance).
  await expect(page.getByTestId('line-lot-code')).toHaveText(/^\d{6}-\d{2,}$/);

  // Capture a unit photo right here in the sheet — a thumb appears and the
  // button flips to Retake once the upload lands.
  const photo = page.getByTestId('line-unit-photo');
  await expect(photo.getByRole('button', { name: 'Photo' })).toBeVisible();
  await page.setInputFiles('[data-testid=line-unit-photo-input]', 'e2e/fixtures/unit-tomatoes.jpg');
  await expect(photo.locator('img')).toBeVisible();
  await expect(photo.getByRole('button', { name: 'Retake' })).toBeVisible();
  await page.getByTestId('save-line').click();
  await expect(lineRow(page, product)).toBeVisible();

  // The photo landed on the lot atomically with the save: step 4 shows the
  // lot's card already carrying an image, with a Retake (not a first-time Photo)
  // control.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  const card = page.getByTestId('unit-photo-card').filter({ hasText: product });
  await expect(card.locator('img')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retake' })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('abandon-restock').click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
});
