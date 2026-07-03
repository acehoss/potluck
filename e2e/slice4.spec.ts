import { expect, test, type Page } from '@playwright/test';

/**
 * Slice 4 acceptance (blueprint 02 anchors): settle-to-zero with prefills,
 * recount up/down, write-off with required reason, the manual ledger
 * adjustment, and the LedgerSeen "new" markers (tab dot + row highlight).
 *
 * Both browser projects share one database and the ledger accumulates across
 * runs, so every net-position assertion is a DELTA (or an explicit
 * settle-to-zero) against a value read before acting. Product names and notes
 * carry the project name and a per-run token.
 */

const PASSWORD = 'demo-password';
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);

const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;
const fmt = (cents: number) =>
  `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
/** Matches the UI's signed rendering: "+$1.23" / "−$1.23" (U+2212 minus). */
const fmtSigned = (cents: number) => `${cents > 0 ? '+' : '−'}${fmt(Math.abs(cents))}`;

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
}

/** Open the first pantry of the matching household section, via the tab bar. */
async function openPantryOf(page: Page, household: string | 'own') {
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  await expect(page).toHaveURL(/\/$/);
  const group =
    household === 'own'
      ? page.getByTestId('pantry-group').filter({ hasText: 'your household' })
      : page.getByTestId('pantry-group').filter({ hasText: household });
  await group.getByTestId('pantry-row').first().click();
  await expect(
    page.getByTestId('product-row').first().or(page.getByText('Nothing here yet.')),
  ).toBeVisible();
}

/**
 * Receive one product into the signed-in user's own pantry (photos skipped)
 * and return the restock id, code, and first lot id.
 */
async function receiveLot(
  page: Page,
  opts: { product: string; units: number; total: string },
) {
  await openPantryOf(page, 'own');
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(`S4-${RUN}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);
  const restockId = page.url().match(/\/receive\/([^/?]+)/)![1];

  await page.getByRole('button', { name: 'Skip photos' }).click();
  await page.getByTestId('add-line').click();
  await page.getByTestId('product-search').fill(opts.product);
  await page.getByTestId('create-product').click();
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
  const code = (await page.getByTestId('restock-code').textContent())!;
  expect(code).toMatch(/^\d{6}-\d{2,}$/);
  await page.getByRole('link', { name: 'Back to pantry' }).click();
  await expect(page.getByTestId('receive-fab')).toBeVisible();

  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const lotId = (await got.json()).result.data.lots[0].id as string;
  return { restockId, code, lotId };
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

/** Expand a product's lots (if collapsed) and open its first lot's ⋯ menu. */
async function openLotMenu(page: Page, product: string) {
  const row = page.getByTestId('product-row').filter({ hasText: product });
  if ((await row.getByTestId('lot-menu').count()) === 0) {
    await row.getByTestId('product-expand').click();
  }
  await row.getByTestId('lot-menu').first().click();
  await expect(page.getByTestId('lot-menu-sheet')).toBeVisible();
}

test('settle up prefills toward zero, zeroes the pair, and renders from both sides', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Settle Corn', P);
  const noteToken = `sett-${P}-${RUN}`;

  // Aaron stocks 3 units at $10.00 → $3.33/u; Dana takes 2 → owes $6.66.
  await login(page, 'aaron@demo.coop');
  const { lotId } = await receiveLot(page, { product, units: 3, total: '10.00' });

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const take = await dana.request.post('/api/trpc/take.create', {
    data: { lotId, quantity: 2 },
  });
  expect(take.ok()).toBe(true);

  let net = await netCents(page);
  if (net === 0) {
    // Residue from earlier runs exactly cancelled the take — unbalance again
    // so the prefill assertions below have a direction to point at.
    const extra = await dana.request.post('/api/trpc/take.create', {
      data: { lotId, quantity: 1 },
    });
    expect(extra.ok()).toBe(true);
    net = await netCents(page);
  }
  expect(net).not.toBe(0);

  // Settle sheet: amount prefilled to bring the pair to zero, direction
  // prefilled toward zero (payer = whoever owes), method chips + note.
  await page.getByTestId('settle-up').click();
  const sheet = page.getByTestId('settle-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('settle-amount')).toHaveValue((Math.abs(net) / 100).toFixed(2));
  await expect(page.getByTestId('settle-direction')).toHaveValue(net > 0 ? 'them' : 'us');
  await sheet.getByRole('radio', { name: 'Venmo' }).click();
  await page.getByTestId('settle-note').fill(noteToken);
  await page.getByTestId('settle-submit').click();
  await expect(sheet).toHaveCount(0);

  // The pair reads zero from BOTH households' ledgers.
  expect(await netCents(page)).toBe(0);
  expect(await netCents(dana)).toBe(0);

  // The SETTLEMENT row renders with mirrored signs and files under Payments.
  const rowText = new RegExp(`Settlement · Venmo — ${noteToken}`);
  const aaronRow = page.getByTestId('ledger-row').filter({ hasText: rowText });
  await expect(aaronRow).toContainText(fmtSigned(-net));
  await page.getByRole('tab', { name: 'Payments' }).click();
  await expect(aaronRow).toBeVisible();
  await page.getByRole('tab', { name: 'Takes' }).click();
  await expect(aaronRow).toHaveCount(0);
  const danaRow = dana.getByTestId('ledger-row').filter({ hasText: rowText });
  await expect(danaRow).toContainText(fmtSigned(net));

  // Blueprint 02 / SPEC §5: BOTH households see a settlement flagged "new"
  // until viewed — including the recording household's OTHER members. Marie
  // (Aaron's housemate, who did not record it) gets the tab dot and the row
  // highlight; only the recording user himself is excluded.
  const marieContext = await browser.newContext({ baseURL: BASE });
  const marie = await marieContext.newPage();
  await login(marie, 'marie@demo.coop');
  await expect(marie.getByTestId('ledger-new-dot')).toBeVisible();
  await marie.getByTestId('tab-bar').getByRole('link', { name: 'Ledger' }).click();
  const marieRow = marie.getByTestId('ledger-row').filter({ hasText: rowText });
  await expect(marieRow.getByTestId('ledger-row-new')).toBeVisible();
  expect(await marieRow.getAttribute('data-new')).toBe('true');
  await marieContext.close();

  // Guards: zero/negative/float amounts and a same-household pair are 400s.
  for (const amountCents of [0, -100, 1.5]) {
    const bad = await page.request.post('/api/trpc/ledger.settle', {
      data: { payerHouseholdId: 'a', payeeHouseholdId: 'b', amountCents, note: 'x' },
    });
    expect(bad.status(), `amountCents ${amountCents} must be rejected`).toBe(400);
  }
  const samePair = await page.request.post('/api/trpc/ledger.settle', {
    data: { payerHouseholdId: 'a', payeeHouseholdId: 'a', amountCents: 100, note: 'x' },
  });
  expect(samePair.status()).toBe(400);

  await danaContext.close();
});

test('recount fixes drift up and down, is owner-only, and never touches the ledger', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Recount Peas', P);

  await login(page, 'aaron@demo.coop');
  const { lotId, code } = await receiveLot(page, { product, units: 5, total: '5.00' });
  const before = await netCents(page);
  await openPantryOf(page, 'own');
  const row = page.getByTestId('product-row').filter({ hasText: product });

  // Recount down: 5 → 3. The sheet shows the app's current count.
  await openLotMenu(page, product);
  await page.getByTestId('menu-recount').click();
  const sheet = page.getByTestId('recount-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('(app says 5)');
  await expect(page.getByTestId('recount-count')).toHaveValue('5');
  await page.getByTestId('recount-count').fill('3');
  await page.getByTestId('recount-submit').click();
  await expect(sheet).toHaveCount(0);
  await expect(row.getByTestId('product-total')).toHaveText('3');

  // Recount up: 3 → 6 (found units behind the freezer).
  await openLotMenu(page, product);
  await page.getByTestId('menu-recount').click();
  await expect(page.getByTestId('recount-sheet')).toContainText('(app says 3)');
  await page.getByTestId('recount-count').fill('6');
  await page.getByTestId('recount-submit').click();
  await expect(row.getByTestId('product-total')).toHaveText('6');

  // Adjustments are amountless (invariant 8): the ledger never moved.
  expect(await netCents(page)).toBe(before);

  // Both recounts are on the restock detail's adjustment history.
  await openPantryOf(page, 'own');
  await row.getByTestId('product-expand').click();
  await page.getByRole('link', { name: code }).click();
  await expect(page).toHaveURL(/\/restocks\//);
  const adjRows = page.getByTestId('restock-adjustment-row');
  await expect(adjRows.filter({ hasText: `recounted ${product}: 3 → 6` })).toBeVisible();
  await expect(adjRows.filter({ hasText: `recounted ${product}: 5 → 3` })).toBeVisible();

  // Owner-only (authz matrix): Dana can't recount Aaron's lot, and never
  // sees the ⋯ menu on a pantry that isn't her household's.
  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const foreign = await dana.request.post('/api/trpc/adjustment.recount', {
    data: { lotId, countAfter: 0 },
  });
  expect(foreign.status()).toBe(403);
  await openPantryOf(dana, 'Heise');
  const danaRow = dana.getByTestId('product-row').filter({ hasText: product });
  await danaRow.getByTestId('product-expand').click();
  await expect(danaRow.getByTestId('lot-row').first()).toBeVisible();
  await expect(danaRow.getByTestId('lot-menu')).toHaveCount(0);
  await danaContext.close();

  // Bad counts are rejected before any write.
  const negative = await page.request.post('/api/trpc/adjustment.recount', {
    data: { lotId, countAfter: -1 },
  });
  expect(negative.status()).toBe(400);
});

test('write-off requires a reason, decrements, and the owner eats the cost', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Writeoff Salsa', P);

  await login(page, 'aaron@demo.coop');
  const { lotId, code } = await receiveLot(page, { product, units: 4, total: '8.00' });
  const before = await netCents(page);
  await openPantryOf(page, 'own');
  const row = page.getByTestId('product-row').filter({ hasText: product });

  // Sheet: count defaults to all remaining; take it down to 3, pick Damaged.
  await openLotMenu(page, product);
  await page.getByTestId('menu-writeoff').click();
  const sheet = page.getByTestId('writeoff-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('writeoff-count')).toHaveText('4');
  await sheet.getByRole('button', { name: 'Fewer' }).click();
  await sheet.getByRole('radio', { name: 'Damaged' }).click();
  await page.getByTestId('writeoff-note').fill('dented cans');
  await page.getByTestId('writeoff-submit').click();
  await expect(sheet).toHaveCount(0);
  await expect(row.getByTestId('product-total')).toHaveText('1');

  // No ledger movement (invariant 8) — the owner ate it.
  expect(await netCents(page)).toBe(before);

  // History shows the write-off with its reason, typed distinctly.
  await openPantryOf(page, 'own');
  await row.getByTestId('product-expand').click();
  await page.getByRole('link', { name: code }).click();
  const adj = page
    .getByTestId('restock-adjustment-row')
    .filter({ hasText: `wrote off 3 × ${product}` });
  await expect(adj).toContainText('Damaged — dented cans');
  await expect(adj).toContainText('write-off');

  // Reason is required; counts are guarded (0 → 400, > remaining → 409).
  const noReason = await page.request.post('/api/trpc/adjustment.writeOff', {
    data: { lotId, count: 1 },
  });
  expect(noReason.status()).toBe(400);
  const blankReason = await page.request.post('/api/trpc/adjustment.writeOff', {
    data: { lotId, count: 1, reason: '   ' },
  });
  expect(blankReason.status()).toBe(400);
  const zero = await page.request.post('/api/trpc/adjustment.writeOff', {
    data: { lotId, count: 0, reason: 'Expired' },
  });
  expect(zero.status()).toBe(400);
  const tooMany = await page.request.post('/api/trpc/adjustment.writeOff', {
    data: { lotId, count: 99, reason: 'Expired' },
  });
  expect(tooMany.status()).toBe(409);
});

test('manual adjustment requires a note and moves the net in the chosen direction', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const noteUp = `adj-up-${P}-${RUN}`;
  const noteDown = `adj-down-${P}-${RUN}`;

  await login(page, 'aaron@demo.coop');
  const before = await netCents(page);

  // "In-Laws owes us" $1.23 → net moves up by 123.
  await page.getByTestId('ledger-menu').click();
  await page.getByTestId('open-adjust').click();
  const sheet = page.getByTestId('adjust-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('adjust-direction')).toHaveValue('they-owe');
  await page.getByTestId('adjust-amount').fill('1.23');
  await page.getByTestId('adjust-note').fill(noteUp);
  await page.getByTestId('adjust-submit').click();
  await expect(sheet).toHaveCount(0);
  expect(await netCents(page)).toBe(before + 123);
  const upRow = page
    .getByTestId('ledger-row')
    .filter({ hasText: 'Manual adjustment' })
    .filter({ hasText: '+$1.23' })
    .first();
  await expect(upRow).toBeVisible();

  // "We owe In-Laws" $0.23 → net moves down by 23. Note lands in the detail.
  await page.getByTestId('ledger-menu').click();
  await page.getByTestId('open-adjust').click();
  await page.getByTestId('adjust-amount').fill('0.23');
  await page.getByTestId('adjust-direction').selectOption('we-owe');
  await page.getByTestId('adjust-note').fill(noteDown);
  await page.getByTestId('adjust-submit').click();
  await expect(page.getByTestId('adjust-sheet')).toHaveCount(0);
  expect(await netCents(page)).toBe(before + 123 - 23);
  const downRow = page
    .getByTestId('ledger-row')
    .filter({ hasText: 'Manual adjustment' })
    .filter({ hasText: '−$0.23' })
    .first();
  await downRow.getByRole('button').first().click();
  await expect(downRow).toContainText(noteDown);

  // Adjustments file under Payments with settlements.
  await page.getByRole('tab', { name: 'Payments' }).click();
  await expect(downRow).toBeVisible();
  await page.getByRole('tab', { name: 'All' }).click();

  // The note is REQUIRED server-side; household ids come from the net strips.
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  const inLawsId = (await page.getByTestId('net-strip').getAttribute('href'))!.split('with=')[1];
  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  const heiseId = (await dana.getByTestId('net-strip').getAttribute('href'))!.split('with=')[1];
  await danaContext.close();

  const noNote = await page.request.post('/api/trpc/ledger.adjust', {
    data: { creditorHouseholdId: heiseId, debtorHouseholdId: inLawsId, amountCents: 100 },
  });
  expect(noNote.status()).toBe(400);
  const blankNote = await page.request.post('/api/trpc/ledger.adjust', {
    data: { creditorHouseholdId: heiseId, debtorHouseholdId: inLawsId, amountCents: 100, note: ' ' },
  });
  expect(blankNote.status()).toBe(400);

  // Membership gate (authz matrix): a member can't forge money entries
  // between two households when their own is NEITHER party. The FORBIDDEN
  // check fires before the existence lookup, so one real foreign id plus a
  // valid-shape unknown id exercises it (the seed has only two households).
  const forbiddenSettle = await page.request.post('/api/trpc/ledger.settle', {
    data: {
      payerHouseholdId: inLawsId,
      payeeHouseholdId: 'someone-elses-household',
      amountCents: 100,
      note: 'forged',
    },
  });
  expect(forbiddenSettle.status()).toBe(403);
  const forbiddenAdjust = await page.request.post('/api/trpc/ledger.adjust', {
    data: {
      creditorHouseholdId: inLawsId,
      debtorHouseholdId: 'someone-elses-household',
      amountCents: 100,
      note: 'forged',
    },
  });
  expect(forbiddenAdjust.status()).toBe(403);
});

test('the counterparty gets the new marker and viewing the ledger clears it', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const noteToken = `new-${P}-${RUN}`;

  // Dana baselines her per-pair seen watermark by viewing the ledger, then leaves.
  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana@demo.coop');
  await dana.getByTestId('tab-bar').getByRole('link', { name: 'Ledger' }).click();
  await expect(dana.getByTestId('net-hero')).toBeVisible();
  await expect(dana.getByTestId('ledger-new-dot')).toHaveCount(0); // markSeen landed
  await dana.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  await expect(dana).toHaveURL(/\/$/);

  // Aaron posts a manual adjustment — the v1 counterparty notification is
  // the in-app "new" marker (push arrives in slice 7).
  await login(page, 'aaron@demo.coop');
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Ledger' }).click();
  await page.getByTestId('ledger-menu').click();
  await page.getByTestId('open-adjust').click();
  await page.getByTestId('adjust-amount').fill('0.11');
  await page.getByTestId('adjust-note').fill(noteToken);
  await page.getByTestId('adjust-submit').click();
  await expect(page.getByTestId('adjust-sheet')).toHaveCount(0);

  // The creator HIMSELF never sees his own entries as new (his housemates
  // do — see the settle test). The tab dot is driven by an async hasNew
  // refetch on route change, so wait for that response and assert on its
  // payload — a bare toHaveCount(0) could pass vacuously against the stale
  // pre-adjustment cache while the refetch is still in flight.
  const hasNewSettled = page.waitForResponse((r) => r.url().includes('ledger.hasNew'));
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  await expect(page.getByTestId('net-strip')).toBeVisible();
  const hasNewBody = await (await hasNewSettled).json();
  const hasNewPayload = Array.isArray(hasNewBody) ? hasNewBody[0] : hasNewBody;
  expect(hasNewPayload.result.data.hasNew).toBe(false);
  await expect(page.getByTestId('ledger-new-dot')).toHaveCount(0);
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Ledger' }).click();
  const aaronRow = page
    .getByTestId('ledger-row')
    .filter({ hasText: 'Manual adjustment' })
    .first();
  await expect(aaronRow.getByTestId('ledger-row-new')).toHaveCount(0);

  // Dana: tab dot appears on her next navigation…
  await dana.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
  await expect(dana.getByTestId('ledger-new-dot')).toBeVisible();

  // …the ledger highlights the new row (marker + data-new)…
  await dana.getByTestId('tab-bar').getByRole('link', { name: 'Ledger' }).click();
  // Aaron chose "In-Laws owes us": from Dana's side the entry reads −$0.11.
  const danaRow = dana
    .getByTestId('ledger-row')
    .filter({ hasText: 'Manual adjustment' })
    .filter({ hasText: '−$0.11' })
    .first();
  await expect(danaRow.getByTestId('ledger-row-new')).toBeVisible();
  expect(await danaRow.getAttribute('data-new')).toBe('true');

  // …viewing IS the acknowledgment: the dot clears now, the highlight on the
  // next visit.
  await expect(dana.getByTestId('ledger-new-dot')).toHaveCount(0);
  await dana.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  await expect(dana.getByTestId('net-strip')).toBeVisible();
  await expect(dana.getByTestId('ledger-new-dot')).toHaveCount(0);
  await dana.getByTestId('tab-bar').getByRole('link', { name: 'Ledger' }).click();
  await expect(dana.getByTestId('net-hero')).toBeVisible();
  await expect(danaRow.getByTestId('ledger-row-new')).toHaveCount(0);

  await danaContext.close();
});

test('settle, adjust, and write-off replays with the same clientKey post once', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Idem Yogurt', P);

  await login(page, 'aaron@demo.coop');
  const { restockId, lotId } = await receiveLot(page, { product, units: 4, total: '4.00' });
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const heiseId = (await got.json()).result.data.pantry.householdId as string;
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  const inLawsId = (await page.getByTestId('net-strip').getAttribute('href'))!.split('with=')[1];
  const before = await netCents(page);

  // Settlement: a replay (double-tap / retry after a lost response) returns
  // the ORIGINAL entry — the pair moves by $0.77 once, not twice.
  const settleKey = `idem-settle-${P}-${RUN}`;
  const settleBody = {
    payerHouseholdId: inLawsId,
    payeeHouseholdId: heiseId,
    amountCents: 77,
    note: `Venmo — idem-${P}-${RUN}`,
    clientKey: settleKey,
  };
  const settle1 = await page.request.post('/api/trpc/ledger.settle', { data: settleBody });
  expect(settle1.ok()).toBe(true);
  const settleId = (await settle1.json()).result.data.id as string;
  const settle2 = await page.request.post('/api/trpc/ledger.settle', { data: settleBody });
  expect(settle2.ok()).toBe(true);
  expect((await settle2.json()).result.data.id).toBe(settleId);

  // Manual adjustment: same guard.
  const adjustBody = {
    creditorHouseholdId: heiseId,
    debtorHouseholdId: inLawsId,
    amountCents: 55,
    note: `idem-adjust-${P}-${RUN}`,
    clientKey: `idem-adjust-${P}-${RUN}`,
  };
  const adjust1 = await page.request.post('/api/trpc/ledger.adjust', { data: adjustBody });
  expect(adjust1.ok()).toBe(true);
  const adjustId = (await adjust1.json()).result.data.id as string;
  const adjust2 = await page.request.post('/api/trpc/ledger.adjust', { data: adjustBody });
  expect(adjust2.ok()).toBe(true);
  expect((await adjust2.json()).result.data.id).toBe(adjustId);

  // Each posted exactly once: −$0.77 (they paid us) + $0.55 (they owe us).
  expect(await netCents(page)).toBe(before - 77 + 55);

  // Reusing a key across mutation types fails closed instead of replaying.
  const crossType = await page.request.post('/api/trpc/ledger.adjust', {
    data: { ...adjustBody, clientKey: settleKey },
  });
  expect(crossType.status()).toBe(409);

  // Write-off is CUMULATIVE, so this is the one where a double-post would
  // corrupt inventory: the replay returns the original adjustment and the
  // lot decrements once (4 → 3, not 2).
  const writeOffBody = {
    lotId,
    count: 1,
    reason: 'Expired',
    clientKey: `idem-writeoff-${P}-${RUN}`,
  };
  const writeOff1 = await page.request.post('/api/trpc/adjustment.writeOff', {
    data: writeOffBody,
  });
  expect(writeOff1.ok()).toBe(true);
  const writeOff1Data = (await writeOff1.json()).result.data;
  expect(writeOff1Data.countBefore).toBe(4);
  expect(writeOff1Data.countAfter).toBe(3);
  const writeOff2 = await page.request.post('/api/trpc/adjustment.writeOff', {
    data: writeOffBody,
  });
  expect(writeOff2.ok()).toBe(true);
  expect((await writeOff2.json()).result.data).toEqual(writeOff1Data);
  await openPantryOf(page, 'own');
  await expect(
    page.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
  ).toHaveText('3');
});

test('recount and write-off are rejected while the restock is a draft', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Draft Gate Beans', P);

  // A draft restock with one line: its lot exists but is not adjustable —
  // finalize will overwrite remainingCount, so adjustments against it would
  // record counts that never described the shelf (invariant 9).
  await login(page, 'aaron@demo.coop');
  await openPantryOf(page, 'own');
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(`S4-draft-${RUN}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);
  const restockId = page.url().match(/\/receive\/([^/?]+)/)![1];
  await page.getByRole('button', { name: 'Skip photos' }).click();
  await page.getByTestId('add-line').click();
  await page.getByTestId('product-search').fill(product);
  await page.getByTestId('create-product').click();
  await page.getByTestId('line-total').fill('2.00');
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: product })).toBeVisible();
  const got = await page.request.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
  );
  const lotId = (await got.json()).result.data.lots[0].id as string;

  const recount = await page.request.post('/api/trpc/adjustment.recount', {
    data: { lotId, countAfter: 1 },
  });
  expect(recount.status()).toBe(412);
  const writeOff = await page.request.post('/api/trpc/adjustment.writeOff', {
    data: { lotId, count: 1, reason: 'Expired' },
  });
  expect(writeOff.status()).toBe(412);

  // Clean up so the draft doesn't linger in later runs' resume banners.
  const del = await page.request.post('/api/trpc/restock.deleteDraft', { data: { restockId } });
  expect(del.ok()).toBe(true);
});

test('a skipped unit photo can be added later from the lot ⋯ menu', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  const product = uniq('Photo Later Chili', P);

  // receiveLot skips photos — exactly the wizard path whose copy promises
  // "You can add photos later" (blueprint 02 receiving step 4).
  await login(page, 'aaron@demo.coop');
  await receiveLot(page, { product, units: 2, total: '3.00' });
  await openPantryOf(page, 'own');
  const row = page.getByTestId('product-row').filter({ hasText: product });
  await expect(row.locator('img')).toHaveCount(0); // placeholder, no photo yet

  await openLotMenu(page, product);
  await expect(page.getByTestId('menu-photo')).toHaveText('Add unit photo');
  await page.setInputFiles('[data-testid=menu-photo-input]', 'e2e/fixtures/unit-tomatoes.jpg');
  await expect(page.getByTestId('lot-menu-sheet')).toHaveCount(0); // closes on success

  // D8: the lot's new photo becomes the product's display photo.
  await expect(row.locator('img')).toHaveAttribute('src', /\/api\/images\/units\//);

  // The menu now offers replacement.
  await openLotMenu(page, product);
  await expect(page.getByTestId('menu-photo')).toHaveText('Replace unit photo');
});

test('backup.sh tars images before the DB snapshot and cleans up its temp files', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'host-side script — one engine is enough');
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-backup-'));
  try {
    execFileSync('sh', ['scripts/backup.sh', dir], { stdio: 'pipe' });
    const tars = fs.readdirSync(dir).filter((f) => f.endsWith('.tar'));
    expect(tars).toHaveLength(1);
    const listing = execFileSync('tar', ['-tf', path.join(dir, tars[0])], { encoding: 'utf8' });
    // Both halves of the deliverable are present…
    expect(listing).toContain('coop-backup.db');
    expect(listing).toMatch(/(^|\n)images\//);
    // …and images were archived BEFORE the snapshot was taken, the ordering
    // that makes a restored DB row referencing a deleted image impossible.
    expect(listing.indexOf('images/')).toBeLessThan(listing.indexOf('coop-backup.db'));
    // No partial file on the host, no temp files left inside the container.
    expect(fs.readdirSync(dir).filter((f) => f.includes('partial'))).toHaveLength(0);
    const dataDir = execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'app', 'ls', '-A', '/data'],
      { encoding: 'utf8' },
    );
    expect(dataDir).not.toContain('coop-backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The correct-credit op (blueprint 01 Immutability + invariant 5): the only
 * auditable fix for a RESTOCK_CREDIT posted against a wrong receivedCount
 * caught after finalize. A REVERSAL of the old credit (same restockId) plus a
 * corrected RESTOCK_CREDIT, gated to the purchaser or pantry-owning household.
 * Built entirely through the API (the op has no dedicated UI in v1); nets to
 * zero on the pair so it doesn't skew the delta-based tests above.
 */
test('correct-credit reverses a wrong restock credit and reposts the right amount', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron@demo.coop');

  const ov = (await (await page.request.get('/api/trpc/household.overview')).json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; pantries: { id: string }[] }[];
  };
  const mine = ov.yourHouseholdId;
  const heise = ov.households.find((h) => h.id === mine)!;
  const inLaws = ov.households.find((h) => h.id !== mine)!;
  const pantryId = heise.pantries[0].id;

  // In-Laws paid for Aaron's (Heise) pantry. receivedCount typo'd to 24 when
  // only 12 arrived; unitCost = 100¢ → credit posts at 2400¢.
  const create = await page.request.post('/api/trpc/restock.create', {
    data: {
      pantryId,
      retailer: `S4cc-${P}-${RUN}`,
      purchasedAt: new Date().toISOString().slice(0, 10),
      purchaserHouseholdId: inLaws.id,
      receiptTotalCents: null,
    },
  });
  const restockId = (await create.json()).result.data.id as string;
  const line = await page.request.post('/api/trpc/restock.saveLine', {
    data: {
      restockId,
      newProductName: `CC Beans ${P}-${RUN}`,
      purchasedCount: 24,
      receivedCount: 24,
      lineTotalCents: 2400,
      bestBy: null,
    },
  });
  const lotId = (await line.json()).result.data.lotId as string;
  const fin = await page.request.post('/api/trpc/restock.finalize', {
    data: { restockId, acknowledgedVarianceCents: null },
  });
  expect((await fin.json()).result.data.creditCents).toBe(2400);

  const creditNow = async () => {
    const res = await page.request.get(
      `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: restockId }))}`,
    );
    return (await res.json()).result.data.credit as { amountCents: number } | null;
  };
  expect((await creditNow())!.amountCents).toBe(2400);

  // Correct to 12 received → the live credit becomes 1200; the reversed
  // original stays for the audit trail but no longer reads as active.
  const cc = await page.request.post('/api/trpc/restock.correctCredit', {
    data: { restockId, corrections: [{ lotId, receivedCount: 12 }] },
  });
  expect(cc.ok()).toBe(true);
  const ccData = (await cc.json()).result.data as { previousCents: number; creditCents: number };
  expect(ccData.previousCents).toBe(2400);
  expect(ccData.creditCents).toBe(1200);
  expect((await creditNow())!.amountCents).toBe(1200);

  // Correcting to the same value again is a no-op guarded at 412.
  const again = await page.request.post('/api/trpc/restock.correctCredit', {
    data: { restockId, corrections: [{ lotId, receivedCount: 12 }] },
  });
  expect(again.status()).toBe(412);

  // Correct down to 0 received → the credit is reversed with no replacement
  // (invariant 5: none when the purchaser is owed nothing), netting the pair
  // back to where it started.
  const zero = await page.request.post('/api/trpc/restock.correctCredit', {
    data: { restockId, corrections: [{ lotId, receivedCount: 0 }] },
  });
  expect((await zero.json()).result.data.creditCents).toBe(0);
  expect(await creditNow()).toBeNull();
});
