import fs from 'node:fs';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { login, openHome } from './helpers';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const IMAGE = 'e2e/fixtures/unit-tomatoes.jpg';
const PDF = 'e2e/fixtures/manual.pdf';

const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

type Api = Pick<APIRequestContext, 'get' | 'post'>;
type GalleryPrefix = 'product' | 'item';
type TestRoot = Page | Locator;

type RpcEnvelope<T> = { result?: { data?: T }; error?: unknown };
type Overview = {
  yourHouseholdId: string;
  households: { id: string; name: string; pantries: { id: string; name: string }[] }[];
};
type UploadResult = { path: string; name?: string };
type ItemGet = { notes: string | null };
type ItemImageInput = { path: string; label: 'nutrition' | 'ingredients' | 'angle' | null };

let serial = 0;
const key = (prefix: string, project: string) =>
  `${prefix}-${project}-${RUN}-${++serial}`.slice(0, 64);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function rpc(api: Api, path: string, data: Record<string, unknown>) {
  const res = await api.post(`/api/trpc/${path}`, { data });
  const body = (await res.json().catch(() => null)) as RpcEnvelope<unknown> | null;
  return { status: res.status(), body };
}

async function ok<T>(
  api: Api,
  path: string,
  data: Record<string, unknown>,
): Promise<T> {
  const res = await rpc(api, path, data);
  expect(res.status, `${path} ${JSON.stringify(data)} -> ${JSON.stringify(res.body)}`).toBe(200);
  return (res.body as RpcEnvelope<T>).result!.data!;
}

async function overview(api: Api) {
  const res = await api.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as RpcEnvelope<Overview>).result!.data!;
}

async function itemGet(api: Api, itemId: string) {
  const res = await api.get(
    `/api/trpc/item.get?input=${encodeURIComponent(JSON.stringify({ itemId }))}`,
  );
  expect(res.ok()).toBe(true);
  return ((await res.json()) as RpcEnvelope<ItemGet>).result!.data!;
}

async function uploadImage(api: Api, kind: 'items' | 'products' = 'items') {
  const res = await api.post(`/api/upload/${kind}`, {
    multipart: {
      file: {
        name: 'unit-tomatoes.jpg',
        mimeType: 'image/jpeg',
        buffer: fs.readFileSync(IMAGE),
      },
    },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as UploadResult).path;
}

async function uploadAttachment(api: Api) {
  // The server ignores the multipart filename (it names stored files); the
  // DISPLAY name rides the ?name= query param, mirroring the UI's upload.
  const res = await api.post('/api/upload/attachments?name=manual.pdf', {
    multipart: {
      file: {
        name: 'manual.pdf',
        mimeType: 'application/pdf',
        buffer: fs.readFileSync(PDF),
      },
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as UploadResult;
}

async function createItemApi(
  api: Api,
  project: string,
  name: string,
  opts: { feeCents?: number; photos?: ItemImageInput[] } = {},
) {
  const data: Record<string, unknown> = {
    householdId: (await overview(api)).yourHouseholdId,
    name,
    feeCents: opts.feeCents ?? 0,
    clientKey: key('item', project),
  };
  if (opts.photos) data.photos = opts.photos;
  return (
    await ok<{ id: string }>(api, 'item.create', data)
  ).id;
}

async function attachManualApi(api: Api, itemId: string) {
  const uploaded = await uploadAttachment(api);
  return ok<{ id: string; name: string; sizeBytes: number }>(api, 'item.addAttachment', {
    itemId,
    path: uploaded.path,
    name: uploaded.name ?? 'manual.pdf',
    sizeBytes: fs.statSync(PDF).size,
  });
}

async function openItems(page: Page) {
  await page.goto('/items');
  await expect(page).toHaveURL(/\/items$/);
  await expect(page.getByTestId('item-group').first()).toBeVisible();
}

async function openOwnPantry(page: Page) {
  await openHome(page);
  await page.getByTestId('home-pantries').getByTestId('pantry-row').first().click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
  const match = page.url().match(/\/pantries\/([^/?]+)/);
  if (!match) throw new Error(`could not read pantry id from ${page.url()}`);
  return match[1];
}

async function addRestockLine(
  page: Page,
  opts: { product: string; units: number; total: string },
) {
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

async function receiveProductWithUnitPhoto(page: Page, product: string) {
  const pantryId = await openOwnPantry(page);
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(`Media ${product}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);

  await page.getByRole('button', { name: 'Skip photos' }).click();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();
  await addRestockLine(page, { product, units: 1, total: '1.00' });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Unit photos' })).toBeVisible();
  await page.setInputFiles('[data-testid=unit-photo-input-1]', IMAGE);
  await expect(page.getByRole('button', { name: 'Retake' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Reconcile' })).toBeVisible();
  await page.getByTestId('finalize').click();
  await expect(page.getByTestId('restock-code')).toBeVisible();
  await page.getByRole('link', { name: 'Back to pantry' }).click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();
  return { pantryId };
}

function productRow(page: Page, product: string) {
  return page.getByTestId('product-row').filter({ hasText: product });
}

async function openProductSheet(page: Page, product: string) {
  const row = productRow(page, product);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: new RegExp(escapeRegExp(product)) }).first().click();
  const sheet = page.getByTestId('product-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

function galleryThumbs(root: TestRoot, prefix: GalleryPrefix) {
  return root.getByTestId(new RegExp(`^${prefix}-thumb-\\d+$`));
}

function galleryThumb(root: TestRoot, prefix: GalleryPrefix, index: number) {
  return root.getByTestId(`${prefix}-thumb-${index}`);
}

function galleryHero(root: TestRoot, prefix: GalleryPrefix) {
  return root.getByTestId(`${prefix}-photo-hero`);
}

async function imageSrc(locator: Locator) {
  return locator.evaluate((node) => {
    const image = node instanceof HTMLImageElement ? node : node.querySelector('img');
    return image?.src ?? '';
  });
}

async function expectImageSrc(locator: Locator, expected: string) {
  await expect.poll(async () => imageSrc(locator)).toBe(expected);
}

async function addGalleryPhoto(
  page: Page,
  root: TestRoot,
  prefix: GalleryPrefix,
  index: number,
) {
  await page.setInputFiles(`[data-testid=${prefix}-photo-add]`, IMAGE);
  const thumb = galleryThumb(root, prefix, index);
  await expect(thumb).toBeVisible();
  return imageSrc(thumb);
}

async function setGalleryLabel(root: TestRoot, prefix: GalleryPrefix, label: string) {
  await root.getByTestId(`${prefix}-photo-label-select`).selectOption({ label });
  await expect(root.getByTestId('photo-label-chip').filter({ hasText: label })).toBeVisible();
}

async function setMainGalleryPhoto(root: TestRoot, prefix: GalleryPrefix, index: number) {
  const thumb = galleryThumb(root, prefix, index);
  await thumb.click();
  const src = await imageSrc(thumb);
  await root.getByTestId(`${prefix}-photo-set-main`).click();
  await expectImageSrc(galleryThumb(root, prefix, 0), src);
  await expectImageSrc(galleryHero(root, prefix), src);
  return src;
}

async function createItemWithPhotoViaUi(page: Page, name: string) {
  await openItems(page);
  await page.getByTestId('add-item').click();
  await page.getByTestId('item-name').fill(name);
  await page.setInputFiles('[data-testid=item-photo-input]', IMAGE);
  await expect(page.getByRole('button', { name: 'Retake photo' })).toBeVisible();
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('add-item-sheet')).toHaveCount(0);
  await expect(page.getByTestId('item-row').filter({ hasText: name })).toBeVisible();
}

async function hrefFrom(row: Locator) {
  const own = await row.getAttribute('href');
  if (own) return own;
  const child = await row.locator('a').first().getAttribute('href');
  expect(child).toBeTruthy();
  return child!;
}

async function setNotesAndWait(page: Page, itemId: string, notes: string) {
  const input = page.getByTestId('item-notes-input');
  await input.fill(notes);
  await input.blur();
  await expect.poll(async () => (await itemGet(page.request, itemId)).notes).toBe(notes);
}

test.describe('product gallery', () => {
  test('product sheet starts from the lot photo and lets the owner curate the gallery', async ({
    page,
  }, testInfo) => {
    const P = testInfo.project.name;
    const product = uniq('Media Tomatoes', P);

    await login(page, 'aaron');
    await receiveProductWithUnitPhoto(page, product);
    const row = productRow(page, product);
    await expect(row.locator('img')).toBeVisible();
    const derivedSrc = await imageSrc(row);
    expect(derivedSrc).toContain('/api/images/units/');

    const sheet = await openProductSheet(page, product);
    await expect(galleryHero(sheet, 'product')).toBeVisible();
    await expectImageSrc(galleryHero(sheet, 'product'), derivedSrc);

    await addGalleryPhoto(page, sheet, 'product', 0);
    await setGalleryLabel(sheet, 'product', 'Nutrition facts');
    await addGalleryPhoto(page, sheet, 'product', 1);
    await expect(galleryThumbs(sheet, 'product')).toHaveCount(2);

    await setMainGalleryPhoto(sheet, 'product', 1);
    await sheet.getByTestId('product-photo-remove').click();
    await expect(galleryThumbs(sheet, 'product')).toHaveCount(1);
  });
});

test.describe('product gallery reach', () => {
  test('pantry grants can read the product gallery while share-only neighbors still 404', async ({
    page,
    browser,
  }, testInfo) => {
    const P = testInfo.project.name;
    const product = uniq('Read Only Sauce', P);

    await login(page, 'aaron');
    const { pantryId } = await receiveProductWithUnitPhoto(page, product);
    const ownerSheet = await openProductSheet(page, product);
    await addGalleryPhoto(page, ownerSheet, 'product', 0);
    await setGalleryLabel(ownerSheet, 'product', 'Nutrition facts');
    await addGalleryPhoto(page, ownerSheet, 'product', 1);
    await expect(galleryThumbs(ownerSheet, 'product')).toHaveCount(2);

    const danaContext = await browser.newContext({ baseURL: BASE });
    const dana = await danaContext.newPage();
    await login(dana, 'dana');
    await dana.goto(`/pantries/${pantryId}`);
    const danaSheet = await openProductSheet(dana, product);
    await expect(galleryHero(danaSheet, 'product')).toBeVisible();
    await expect(
      danaSheet.getByTestId('photo-label-chip').filter({ hasText: 'Nutrition facts' }),
    ).toBeVisible();
    await galleryThumb(danaSheet, 'product', 1).click();
    await expect(danaSheet.getByTestId('product-photo-add')).toHaveCount(0);
    await expect(danaSheet.getByTestId('product-photo-set-main')).toHaveCount(0);
    await expect(danaSheet.getByTestId('product-photo-remove')).toHaveCount(0);
    await danaContext.close();

    const niaContext = await browser.newContext({ baseURL: BASE });
    const nia = await niaContext.newPage();
    await login(nia, 'nia');
    expect((await nia.request.get(`/pantries/${pantryId}`)).status()).toBe(404);
    await niaContext.close();
  });
});

test.describe('item gallery', () => {
  test('item detail gallery reorders, labels, removes, and drives the list thumbnail', async ({
    page,
  }, testInfo) => {
    const P = testInfo.project.name;
    const item = uniq('Media Canner', P);

    await login(page, 'aaron');
    await createItemWithPhotoViaUi(page, item);
    const originalRow = page.getByTestId('item-row').filter({ hasText: item });
    const originalSrc = await imageSrc(originalRow);
    expect(originalSrc).toContain('/api/images/items/');

    await originalRow.click();
    await expect(page.getByRole('heading', { name: item })).toBeVisible();
    await expect(galleryHero(page, 'item')).toBeVisible();
    await expectImageSrc(galleryHero(page, 'item'), originalSrc);

    await addGalleryPhoto(page, page, 'item', 1);
    await expect(galleryThumbs(page, 'item')).toHaveCount(2);
    const mainSrc = await setMainGalleryPhoto(page, 'item', 1);
    await setGalleryLabel(page, 'item', 'Ingredients');

    await openItems(page);
    const updatedRow = page.getByTestId('item-row').filter({ hasText: item });
    await expect(updatedRow).toBeVisible();
    await expectImageSrc(updatedRow, mainSrc);

    await updatedRow.click();
    await expect(page.getByRole('heading', { name: item })).toBeVisible();
    await galleryThumb(page, 'item', 0).click();
    await page.getByTestId('item-photo-remove').click();
    await expect(galleryThumbs(page, 'item')).toHaveCount(1);
  });
});

test.describe('attachments', () => {
  test('PDF attachments render, serve inline only to authenticated users, and remove cleanly', async ({
    page,
  }, testInfo) => {
    const P = testInfo.project.name;
    const item = uniq('Manual Press', P);

    await login(page, 'aaron');
    const itemId = await createItemApi(page.request, P, item);
    await page.goto(`/items/${itemId}`);
    await expect(page.getByRole('heading', { name: item })).toBeVisible();

    await page.setInputFiles('[data-testid=item-attachment-add]', PDF);
    const row = page.getByTestId('item-attachment-row').filter({ hasText: 'manual.pdf' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('manual.pdf');
    await expect(row).toContainText(/\d+(\.\d+)?\s*(B|KB|MB)/i);

    const href = await hrefFrom(row);
    const served = await page.request.get(href);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toContain('application/pdf');
    expect(served.headers()['content-disposition']).toContain('inline');
    expect(served.headers()['x-content-type-options']).toBe('nosniff');

    const anonymous = await playwrightRequest.newContext({ baseURL: BASE });
    try {
      expect((await anonymous.get(href)).status()).not.toBe(200);
    } finally {
      await anonymous.dispose();
    }

    await row.getByTestId('item-attachment-remove').click();
    await expect(row).toHaveCount(0);
    // The remove unlinked the now-unreferenced file — the old URL is dead
    // even for an authenticated user.
    await expect(async () => {
      expect((await page.request.get(href)).status()).toBe(404);
    }).toPass({ timeout: 5000 });
  });
});

test.describe('notes auto-link', () => {
  test('item notes link safe URLs, reject javascript URLs, and keep long multiline text', async ({
    page,
  }, testInfo) => {
    const P = testInfo.project.name;
    const item = uniq('Manual Notes', P);

    await login(page, 'aaron');
    const itemId = await createItemApi(page.request, P, item);
    await page.goto(`/items/${itemId}`);
    await expect(page.getByRole('heading', { name: item })).toBeVisible();

    // Scope text assertions to the linkified display block — the owner's
    // editor textarea above it contains the same raw text.
    const display = page.getByTestId('item-notes-display');
    await setNotesAndWait(page, itemId, 'Manual at https://example.com/manual. Beware.');
    const link = display.locator('a[href="https://example.com/manual"]');
    await expect(link).toHaveText('https://example.com/manual');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(display).toContainText('Manual at');
    await expect(display).toContainText('Beware.');

    await setNotesAndWait(page, itemId, 'Do not link javascript:alert(1).');
    await expect(display).toContainText('javascript:alert(1)');
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /javascript:alert\(1\)/ })).toHaveCount(0);

    const longNote = `First line ${'x'.repeat(620)}\nSecond line survives the old cap.`;
    await setNotesAndWait(page, itemId, longNote);
    await page.reload();
    await expect(page.getByTestId('item-notes-input')).toHaveValue(longNote);
  });
});

test.describe('lending still works', () => {
  test('a gallery item with an attachment can still be borrowed and returned', async ({
    page,
    browser,
  }, testInfo) => {
    const P = testInfo.project.name;
    const item = uniq('Loanable Media Kit', P);

    await login(page, 'aaron');
    const first = await uploadImage(page.request, 'items');
    const second = await uploadImage(page.request, 'items');
    const itemId = await createItemApi(page.request, P, item, {
      photos: [
        { path: first, label: null },
        { path: second, label: 'ingredients' },
      ],
    });
    await attachManualApi(page.request, itemId);

    const danaContext = await browser.newContext({ baseURL: BASE });
    const dana = await danaContext.newPage();
    await login(dana, 'dana');
    await openItems(dana);
    const danaRow = dana
      .getByTestId('item-group')
      .filter({ hasText: 'Heise' })
      .getByTestId('item-row')
      .filter({ hasText: item });
    await expect(danaRow).toBeVisible();
    await danaRow.click();
    await expect(dana.getByRole('heading', { name: item })).toBeVisible();
    await expect(galleryHero(dana, 'item')).toBeVisible();
    await expect(dana.getByTestId('item-attachment-row').filter({ hasText: 'manual.pdf' })).toBeVisible();

    await dana.getByTestId('open-checkout').click();
    await dana.getByTestId('checkout-submit').click();
    await expect(dana.getByTestId('item-status')).toContainText('Out to Dana since');

    await dana.getByTestId('open-return').click();
    await dana.getByTestId('return-note').fill(uniq('Still clean', P));
    await dana.getByTestId('return-submit').click();
    await expect(dana.getByTestId('item-status')).toContainText('Available');
    await danaContext.close();
  });
});
