import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Slice 6 acceptance (blueprint 02 anchors): items visible across households,
 * checkout posting the LOAN_FEE at exactly feeCents, zero-fee and own-
 * household checkouts posting nothing, clientKey replay charging once, the
 * one-active-loan guard, returns with condition notes, double-return failing
 * closed, the overdue badge, and the item authz gates.
 *
 * Both browser projects share one database and the ledger accumulates across
 * runs, so every net-position assertion is a DELTA against a value read
 * before acting. Item names carry the project name and a per-run token.
 *
 * Two branches have no product-reachable trigger and use a `docker compose
 * exec` seam into the app container (see execInApp): the undo grace-window
 * expiry (needs a backdated outAt) and the third-household authz gates
 * (invites only join existing households).
 */

const PASSWORD = 'demo-password';
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);

const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;
const pad2 = (n: number) => String(n).padStart(2, '0');

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
}

/** Navigate to the Items tab via the tab bar (client-side, like slice 3+). */
async function openItems(page: Page) {
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Items' }).click();
  await expect(page).toHaveURL(/\/items$/);
  await expect(page.getByTestId('item-group').first()).toBeVisible();
}

/** Signed net with the (single) counterparty, in cents, from /ledger's hero. */
async function netCents(page: Page) {
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

/** Household ids as this page's user sees them (mine + the other one). */
async function householdIds(page: Page) {
  const res = await page.request.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  const data = (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string }[];
  };
  const other = data.households.find((h) => h.id !== data.yourHouseholdId)!;
  return { mine: data.yourHouseholdId, other: other.id };
}

/** Create an item through the real API as the page's signed-in user. */
async function createItem(page: Page, name: string, feeCents: number) {
  const { mine } = await householdIds(page);
  const res = await page.request.post('/api/trpc/item.create', {
    data: { householdId: mine, name, feeCents },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data.id as string;
}

/**
 * Run a Node one-liner inside the app container. The stack is a black box
 * over HTTP for everything the product can express; this seam covers the two
 * things it can't: backdating a loan past the undo grace window (no clock
 * control) and a THIRD household (the invite flow only joins EXISTING
 * households — creating one has no product surface in v1).
 */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('add item with fee; cross-household checkout posts the fee; return with condition note', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const item = uniq('Pressure Canner', P);

  // Aaron adds the item via the UI, $5/loan.
  await login(page, 'aaron@demo.coop');
  await openItems(page);
  await page.getByTestId('add-item').click();
  await page.getByTestId('item-name').fill(item);
  await page.getByTestId('item-notes').fill('Gaskets in the lid box');
  await page.getByTestId('item-fee').fill('5.00');
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('add-item-sheet')).toHaveCount(0);
  const aaronRow = page.getByTestId('item-row').filter({ hasText: item });
  await expect(aaronRow).toBeVisible();
  await expect(aaronRow.getByTestId('fee-badge')).toHaveText('$5.00/loan');
  await expect(aaronRow.getByTestId('item-status')).toContainText('Available');
  const aaronBefore = await netCents(page);

  // Dana sees it under the Heise group, with the fee badge.
  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const danaBefore = await netCents(dana);
  await openItems(dana);
  const heiseGroup = dana.getByTestId('item-group').filter({ hasText: 'Heise' });
  const danaRow = heiseGroup.getByTestId('item-row').filter({ hasText: item });
  await expect(danaRow.getByTestId('fee-badge')).toHaveText('$5.00/loan');

  // Check out: borrower is Dana herself (no picker); the fee is read-only
  // with the "posts to the ledger now" warning (blueprint 02).
  await danaRow.click();
  await expect(dana.getByRole('heading', { name: item })).toBeVisible();
  await dana.getByTestId('open-checkout').click();
  const sheet = dana.getByTestId('checkout-sheet');
  // Borrower = the acting user, stated — never picked (blueprint 02 / A6).
  await expect(sheet).toContainText("You're the borrower");
  await expect(sheet.locator('select')).toHaveCount(0);
  await expect(dana.getByTestId('checkout-fee-note')).toContainText(
    '$5.00 — posts to the ledger now',
  );
  await dana.getByTestId('checkout-submit').click();
  const toast = dana.getByTestId('checkout-toast');
  await expect(toast).toContainText(`Checked out ${item}`);
  const loanId = (await toast.getAttribute('data-loan-id'))!;
  await expect(dana.getByTestId('item-status')).toContainText('Out to Dana since');

  // The fee moved the net by exactly feeCents, both directions.
  expect(await netCents(dana)).toBe(danaBefore - 500);
  const danaFeeRow = dana.getByTestId('ledger-row').filter({ hasText: `Loan fee · ${item}` });
  await expect(danaFeeRow).toContainText('−$5.00');
  expect(await netCents(page)).toBe(aaronBefore + 500);
  await expect(
    page.getByTestId('ledger-row').filter({ hasText: `Loan fee · ${item}` }),
  ).toContainText('+$5.00');

  // The owner's list shows where it went.
  await openItems(page);
  await expect(aaronRow.getByTestId('item-status')).toContainText('Out → In-Laws');

  // Dana returns it with a condition note; the note lands in loan history.
  const note = uniq('Left it clean', P);
  await openItems(dana);
  await danaRow.click();
  await dana.getByTestId('open-return').click();
  await dana.getByTestId('return-note').fill(note);
  await dana.getByTestId('return-submit').click();
  await expect(dana.getByTestId('item-status')).toContainText('Available');
  const loanRow = dana.getByTestId('loan-row').filter({ hasText: 'Dana' });
  await expect(loanRow.getByTestId('loan-condition')).toContainText(note);
  await expect(loanRow).toContainText('fee $5.00');

  // The fee stays posted after the return (it posted at checkout, SPEC §4)…
  expect(await netCents(dana)).toBe(danaBefore - 500);

  // …and a double return fails closed (guarded updateMany on returnedAt).
  const again = await dana.request.post('/api/trpc/loan.return', { data: { loanId } });
  expect(again.status()).toBe(409);

  await danaContext.close();
});

test('zero-fee and own-household checkouts post no ledger entry', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;

  await login(page, 'aaron@demo.coop');
  const freeItem = uniq('Ladder', P);
  const ownFeeItem = uniq('Chainsaw', P);
  const freeItemId = await createItem(page, freeItem, 0);
  await createItem(page, ownFeeItem, 700);
  const aaronBefore = await netCents(page);

  // Cross-household but $0 fee: inventory-style tracking only, no money.
  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const danaBefore = await netCents(dana);
  const out = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId: freeItemId, clientKey: `free-${P}-${RUN}` },
  });
  expect(out.ok()).toBe(true);
  const freeLoanId = (await out.json()).result.data.loanId as string;
  expect(await netCents(dana)).toBe(danaBefore);
  await expect(dana.getByTestId('ledger-row').filter({ hasText: freeItem })).toHaveCount(0);

  // Own-household checkout of a fee item: the sheet says no fee posts, and
  // none does (invariant 10 — borrower household = item household).
  await openItems(page);
  await page.getByTestId('item-row').filter({ hasText: ownFeeItem }).click();
  await page.getByTestId('open-checkout').click();
  await expect(page.getByTestId('checkout-fee-note')).toContainText(
    'No fee — your household',
  );
  await page.getByTestId('checkout-submit').click();
  await expect(page.getByTestId('item-status')).toContainText('Out to Aaron since');
  expect(await netCents(page)).toBe(aaronBefore);
  await expect(page.getByTestId('ledger-row').filter({ hasText: ownFeeItem })).toHaveCount(0);

  // Owner household may record the return of a borrowed item too.
  const ret = await page.request.post('/api/trpc/loan.return', { data: { loanId: freeLoanId } });
  expect(ret.ok()).toBe(true);

  await danaContext.close();
});

test('checkout guards: clientKey replay charges once, second active loan rejected, undo reverses the fee', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const item = uniq('Tile Saw', P);

  await login(page, 'aaron@demo.coop');
  const itemId = await createItem(page, item, 300);

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const before = await netCents(dana);

  // Replay with the same clientKey (double-tap racing the disabled
  // re-render) returns the SAME loan and charges exactly once.
  const key = `loan-${P}-${RUN}`;
  const first = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, clientKey: key },
  });
  expect(first.ok()).toBe(true);
  const loanId = (await first.json()).result.data.loanId as string;
  const replay = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, clientKey: key },
  });
  expect(replay.ok()).toBe(true);
  expect((await replay.json()).result.data.loanId).toBe(loanId);
  expect(await netCents(dana)).toBe(before - 300);

  // A second concurrent checkout (different key) is rejected — one active
  // loan per item (in-tx guard + the partial unique index backstop).
  const second = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, clientKey: `second-${P}-${RUN}` },
  });
  expect(second.status()).toBe(409);
  // …even by another user (Aaron, the owner).
  const byOwner = await page.request.post('/api/trpc/loan.checkout', {
    data: { itemId, clientKey: `owner-${P}-${RUN}` },
  });
  expect(byOwner.status()).toBe(409);

  // Undo within the grace window: swapped-party REVERSAL, net restored, the
  // original LOAN_FEE row stays (append-only ledger).
  const undo = await dana.request.post('/api/trpc/loan.undoCheckout', { data: { loanId } });
  expect(undo.ok()).toBe(true);
  expect(await netCents(dana)).toBe(before);
  // hasText strings are case-insensitive ("Loan fee · X" would also match the
  // "Undo loan fee · X" row) — case-sensitive regexes pin each entry.
  await expect(
    dana.getByTestId('ledger-row').filter({ hasText: new RegExp(`Loan fee · ${item}`) }),
  ).toContainText('−$3.00');
  await expect(
    dana.getByTestId('ledger-row').filter({ hasText: new RegExp(`Undo loan fee · ${item}`) }),
  ).toContainText('+$3.00');
  // Item is available again; a second undo fails closed.
  const undoAgain = await dana.request.post('/api/trpc/loan.undoCheckout', { data: { loanId } });
  expect(undoAgain.status()).toBe(409);
  await openItems(dana);
  await expect(
    dana.getByTestId('item-row').filter({ hasText: item }).getByTestId('item-status'),
  ).toContainText('Available');

  // Item history never claims money that netted $0: the undone loan's fee is
  // annotated as reversed, not shown as a standing $3.00 charge.
  await dana.getByTestId('item-row').filter({ hasText: item }).click();
  await expect(dana.getByRole('heading', { name: item })).toBeVisible();
  const undoneRow = dana.getByTestId('loan-row').filter({ hasText: 'Dana' });
  await expect(undoneRow.getByTestId('loan-fee-reversed')).toContainText('fee $3.00');
  await expect(undoneRow.getByTestId('loan-fee-reversed')).toContainText('reversed');

  // Input guards: unknown item 404, impossible due date 400.
  const missing = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId: 'nope', clientKey: `missing-${P}-${RUN}` },
  });
  expect(missing.status()).toBe(404);
  const badDate = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, dueAt: '2026-99-99', clientKey: `baddate-${P}-${RUN}` },
  });
  expect(badDate.status()).toBe(400);

  await danaContext.close();
});

test('item create/update are owner-household-only', async ({ page, browser }, testInfo) => {
  const P = testInfo.project.name;
  const item = uniq('Genny', P);

  await login(page, 'aaron@demo.coop');
  const { other } = await householdIds(page);

  // Creating an item FOR the other household is forbidden.
  const forged = await page.request.post('/api/trpc/item.create', {
    data: { householdId: other, name: uniq('Forged', P), feeCents: 0 },
  });
  expect(forged.status()).toBe(403);

  const itemId = await createItem(page, item, 100);

  // clientKey replay (double-tap racing the disabled re-render): the second
  // create returns the SAME item instead of minting a twin.
  const { mine } = await householdIds(page);
  const key = `item-${P}-${RUN}`;
  const twinInput = { householdId: mine, name: uniq('Twin', P), feeCents: 0, clientKey: key };
  const first = await page.request.post('/api/trpc/item.create', { data: twinInput });
  expect(first.ok()).toBe(true);
  const replay = await page.request.post('/api/trpc/item.create', { data: twinInput });
  expect(replay.ok()).toBe(true);
  expect((await replay.json()).result.data.id).toBe((await first.json()).result.data.id);

  // A non-owner cannot edit the item (name or feeCents).
  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const foreignEdit = await dana.request.post('/api/trpc/item.update', {
    data: { itemId, feeCents: 99_999 },
  });
  expect(foreignEdit.status()).toBe(403);
  // …and sees no Edit affordance on the foreign item's detail.
  await openItems(dana);
  await dana.getByTestId('item-row').filter({ hasText: item }).click();
  await expect(dana.getByRole('heading', { name: item })).toBeVisible();
  await expect(dana.getByTestId('edit-item')).toHaveCount(0);
  await danaContext.close();

  // The owner edits the fee; this proves the edit path itself. The snapshot
  // rule (edits never touch already-posted loans) has its own dedicated test.
  await openItems(page);
  await page.getByTestId('item-row').filter({ hasText: item }).click();
  await page.getByTestId('edit-item').click();
  await page.getByTestId('edit-item-fee').fill('2.50');
  await page.getByTestId('edit-item-save').click();
  await expect(page.getByTestId('edit-item-sheet')).toHaveCount(0);
  await expect(page.getByTestId('fee-badge')).toHaveText('$2.50/loan');
});

test('item photo pipeline: fresh-upload contract, attach uniqueness, unlink on replace/remove', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron@demo.coop');
  const { mine } = await householdIds(page);
  const jpeg = fs.readFileSync('e2e/fixtures/receipt-costco.jpg');

  const upload = async (kind: string) => {
    const res = await page.request.post(`/api/upload/${kind}`, {
      multipart: { file: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: jpeg } },
    });
    expect(res.ok()).toBe(true);
    return (await res.json()).path as string;
  };
  const p1 = await upload('items');
  const p2 = await upload('items');

  const create = (name: string, photoPath: string) =>
    page.request.post('/api/trpc/item.create', {
      data: { householdId: mine, name, feeCents: 0, photoPath },
    });

  // Attach guards: only fresh, server-named uploads of kind "items" pass —
  // a client string that later drives a file unlink is never trusted.
  expect((await create(uniq('Forged', P), '../coop.db')).status()).toBe(400);
  expect((await create(uniq('WrongKind', P), await upload('receipts'))).status()).toBe(400);
  expect((await create(uniq('Missing', P), `items/${'0'.repeat(32)}.jpg`)).status()).toBe(400);

  // Happy path: attach p1, it serves and renders on the detail page.
  const created = await create(uniq('Canner Photo', P), p1);
  expect(created.ok()).toBe(true);
  const itemId = (await created.json()).result.data.id as string;
  expect((await page.request.get(`/api/images/${p1}`)).status()).toBe(200);
  await page.goto(`/items/${itemId}`);
  await expect(page.locator(`img[src="/api/images/${p1}"]`)).toBeVisible();

  // Attach uniqueness: a second item may not claim the same file — and the
  // rejected attach must not delete the file the first item still shows.
  expect((await create(uniq('Dup Photo', P), p1)).status()).toBe(409);
  expect((await page.request.get(`/api/images/${p1}`)).status()).toBe(200);

  // Replace p1 → p2: the replaced file is unlinked post-commit, p2 serves.
  const replaced = await page.request.post('/api/trpc/item.update', {
    data: { itemId, photoPath: p2 },
  });
  expect(replaced.ok()).toBe(true);
  expect((await page.request.get(`/api/images/${p1}`)).status()).toBe(404);
  expect((await page.request.get(`/api/images/${p2}`)).status()).toBe(200);

  // Re-attaching a path that's already attached (even to this item) is
  // refused without touching the file.
  const reattach = await page.request.post('/api/trpc/item.update', {
    data: { itemId, photoPath: p2 },
  });
  expect(reattach.status()).toBe(409);
  expect((await page.request.get(`/api/images/${p2}`)).status()).toBe(200);

  // Remove the photo: the now-unreferenced file is unlinked.
  const removed = await page.request.post('/api/trpc/item.update', {
    data: { itemId, photoPath: null },
  });
  expect(removed.ok()).toBe(true);
  expect((await page.request.get(`/api/images/${p2}`)).status()).toBe(404);
});

test('fee edits touch future loans only: posted fee immutable, stale checkout sheets rejected', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const item = uniq('Wood Chipper', P);
  await login(page, 'aaron@demo.coop');
  const itemId = await createItem(page, item, 400);

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const before = await netCents(dana);

  // Dana checks out at the $4.00 she was shown (expectedFeeCents matches).
  const out = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, expectedFeeCents: 400, clientKey: `snap1-${P}-${RUN}` },
  });
  expect(out.ok()).toBe(true);
  const loanId = (await out.json()).result.data.loanId as string;
  expect(await netCents(dana)).toBe(before - 400);

  // The owner rewrites the fee WHILE the loan is open…
  const edit = await page.request.post('/api/trpc/item.update', {
    data: { itemId, feeCents: 100 },
  });
  expect(edit.ok()).toBe(true);

  // …and nothing already posted moves: net, ledger row, and loan history all
  // still carry the $4.00 snapshot (Loan.feeCents is immutable at checkout).
  expect(await netCents(dana)).toBe(before - 400);
  await expect(
    dana.getByTestId('ledger-row').filter({ hasText: new RegExp(`Loan fee · ${item}`) }),
  ).toContainText('−$4.00');
  const ret = await dana.request.post('/api/trpc/loan.return', { data: { loanId } });
  expect(ret.ok()).toBe(true);
  await dana.goto(`/items/${itemId}`);
  await expect(dana.getByTestId('loan-row')).toContainText('fee $4.00');

  // A checkout replaying the fee the sheet DISPLAYED before the edit is
  // rejected (412), never charged at the amount the borrower didn't see.
  const stale = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, expectedFeeCents: 400, clientKey: `snap2-${P}-${RUN}` },
  });
  expect(stale.status()).toBe(412);
  expect(await netCents(dana)).toBe(before - 400);

  // A fresh sheet showing the new $1.00 fee charges exactly that; each
  // history row keeps its own snapshot.
  const fresh = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, expectedFeeCents: 100, clientKey: `snap3-${P}-${RUN}` },
  });
  expect(fresh.ok()).toBe(true);
  expect(await netCents(dana)).toBe(before - 500);
  await dana.goto(`/items/${itemId}`);
  await expect(dana.getByTestId('loan-row').first()).toContainText('fee $1.00');
  await expect(dana.getByTestId('loan-row').last()).toContainText('fee $4.00');
  await danaContext.close();
});

test('undoCheckout outside the grace window fails 412 and the fee stands', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const item = uniq('Log Splitter', P);
  await login(page, 'aaron@demo.coop');
  const itemId = await createItem(page, item, 200);

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const before = await netCents(dana);
  const out = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, clientKey: `grace-${P}-${RUN}` },
  });
  expect(out.ok()).toBe(true);
  const loanId = (await out.json()).result.data.loanId as string;
  expect(await netCents(dana)).toBe(before - 200);

  // Backdate outAt 16 minutes through the container seam (UNDO_GRACE_MS is
  // 15) — the only way to reach this branch without clock control.
  execInApp(`
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
    const row = db.prepare('SELECT outAt FROM Loan WHERE id = ?').get(${JSON.stringify(loanId)});
    if (!row) throw new Error('loan not found');
    const shifted = typeof row.outAt === 'number'
      ? row.outAt - 16 * 60_000
      : new Date(new Date(row.outAt).getTime() - 16 * 60_000).toISOString().replace('Z', '+00:00');
    db.prepare('UPDATE Loan SET outAt = ? WHERE id = ?').run(shifted, ${JSON.stringify(loanId)});
  `);

  // Outside the window the fee is no longer reversible — by ANYONE.
  const undo = await dana.request.post('/api/trpc/loan.undoCheckout', { data: { loanId } });
  expect(undo.status()).toBe(412);
  const undoByOwner = await page.request.post('/api/trpc/loan.undoCheckout', {
    data: { loanId },
  });
  expect(undoByOwner.status()).toBe(412);
  expect(await netCents(dana)).toBe(before - 200);

  // A normal return still works, and the fee still stands after it.
  const ret = await dana.request.post('/api/trpc/loan.return', { data: { loanId } });
  expect(ret.ok()).toBe(true);
  expect(await netCents(dana)).toBe(before - 200);
  await danaContext.close();
});

test("a third household cannot return or undo other households' loans", async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const item = uniq('Cider Press', P);
  await login(page, 'aaron@demo.coop');
  const itemId = await createItem(page, item, 100);

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const out = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, clientKey: `third-${P}-${RUN}` },
  });
  expect(out.ok()).toBe(true);
  const loanId = (await out.json()).result.data.loanId as string;

  // Ephemeral third household + member through the container seam (invites
  // only join EXISTING households; v1 has no create-household surface).
  // Fixed ids keep it idempotent; removed in finally — slice-1 asserts the
  // two seeded households exactly.
  const HH = 'e2e-neighbors-hh';
  const UID = 'e2e-nia-user';
  const EMAIL = 'nia.e2e@demo.coop';
  const cleanup = `
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
    db.prepare("DELETE FROM Session WHERE userId = '${UID}'").run();
    db.prepare("DELETE FROM User WHERE id = '${UID}'").run();
    db.prepare("DELETE FROM Household WHERE id = '${HH}'").run();
  `;
  execInApp(cleanup); // clear any leak from a previously interrupted run
  const niaContext = await browser.newContext({ baseURL: BASE });
  try {
    execInApp(`
      const { hashSync } = require('@node-rs/argon2');
      const Database = require('better-sqlite3');
      const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
      db.prepare("INSERT OR IGNORE INTO Household (id, name) VALUES ('${HH}', 'Neighbors (e2e)')").run();
      const hash = hashSync('${PASSWORD}', { memoryCost: 19456, timeCost: 2, parallelism: 1 });
      db.prepare("INSERT OR IGNORE INTO User (id, householdId, name, email, passwordHash) VALUES ('${UID}', '${HH}', 'Nia', '${EMAIL}', ?)").run(hash);
    `);
    const nia = niaContext.request;
    const loginRes = await nia.post('/api/trpc/auth.login', {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(loginRes.ok()).toBe(true);

    // Neither the borrower's nor the owner's household: both gates fail
    // closed — no third party can return items or post fee REVERSALs.
    const ret = await nia.post('/api/trpc/loan.return', { data: { loanId } });
    expect(ret.status()).toBe(403);
    const undo = await nia.post('/api/trpc/loan.undoCheckout', { data: { loanId } });
    expect(undo.status()).toBe(403);

    // The gate rejected the actor, not the operation: the borrower returns fine.
    const realReturn = await dana.request.post('/api/trpc/loan.return', { data: { loanId } });
    expect(realReturn.ok()).toBe(true);
  } finally {
    await niaContext.close();
    execInApp(cleanup);
  }
  await danaContext.close();
});

test('a loan past its due date shows the overdue badge (render-time only)', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const item = uniq('Post Digger', P);

  await login(page, 'aaron@demo.coop');
  const itemId = await createItem(page, item, 0);

  // Dana borrows it, due three days ago (created via the real API — the UI
  // date input doesn't stop past dates either, but this pins the fixture).
  const d = new Date(Date.now() - 3 * 86_400_000);
  const pastDue = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const out = await dana.request.post('/api/trpc/loan.checkout', {
    data: { itemId, dueAt: pastDue, clientKey: `overdue-${P}-${RUN}` },
  });
  expect(out.ok()).toBe(true);
  await danaContext.close();

  // Badge renders on the owner's list row and on the detail — no scheduler,
  // no push, purely a render-time comparison (blueprint kills loan-due push).
  await openItems(page);
  const row = page.getByTestId('item-row').filter({ hasText: item });
  await expect(row.getByTestId('item-status')).toContainText('Out → In-Laws');
  await expect(row.getByTestId('overdue-badge')).toBeVisible();
  await row.click();
  await expect(page.getByRole('heading', { name: item })).toBeVisible();
  await expect(
    page.getByTestId('item-status').getByTestId('overdue-badge'),
  ).toBeVisible();
});
