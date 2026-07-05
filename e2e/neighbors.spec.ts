import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { autoDismissFirstRun, login, openNeighbors, PASSWORD } from './helpers';

/**
 * Phase-2 Round E — the IA flip. The root became the NEIGHBORS dashboard
 * (docs/REWORK.md P1/P2/P3): an attention strip (same source as Activity)
 * ABOVE a shares section and one section per connected household, each carrying
 * that pair's balance (the /ledger entry point — the Ledger tab retired), a
 * lending line, and member cards into /households/[id]. Ledger/Orders/Items
 * kept their routes; their tabs are gone. Duplicated surfaces may differ in
 * density but never in available actions, and the attention rows honour the
 * density rule: they DEEP-LINK, they never render an inline action button.
 *
 * (a)/(b)/(c) run against the seeded three-household topology (aaron sees
 * In-Laws + Neighbors; nia sees only Heise). (d) and (e) reach around the
 * product's guards through the container seam (connections.spec / onboarding.spec
 * patterns) to prove the two states the seed can't hold — a SEVERED pair that
 * still owes money, and a freshly founded household's first dashboard — and
 * sweep every trace in finally so the seeded topology stays byte-identical.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const TODAY = () => new Date().toISOString().slice(0, 10);

/** Run a Node one-liner inside the app container (see connections.spec.ts). */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

async function rpc(page: Page, path: string, data: Record<string, unknown>) {
  const res = await page.request.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

async function ok(page: Page, path: string, data: Record<string, unknown>) {
  const r = await rpc(page, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)} → ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result.data;
}

async function overview(page: Page) {
  const res = await page.request.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string; pantries: { id: string; name: string }[] }[];
  };
}

// ---- (d) SEVERED-with-balance seam ------------------------------------------
// A fourth household severed from Heise but still owed money. Fixed ids are safe:
// the suite runs single-worker (playwright.config workers=1), so the engines
// never touch the DB at once — pre-clean guards an interrupted run's leak.
const HH = 'e2e-nbr-hh';
const CONN = 'e2e-nbr-conn';
const LE = 'e2e-nbr-le';

const severedCleanup = `
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
  db.prepare("DELETE FROM LedgerEntry WHERE creditorHouseholdId = '${HH}' OR debtorHouseholdId = '${HH}'").run();
  db.prepare("DELETE FROM Connection WHERE householdAId = '${HH}' OR householdBId = '${HH}'").run();
  db.prepare("DELETE FROM LedgerSeen WHERE counterpartyHouseholdId = '${HH}' OR ownHouseholdId = '${HH}'").run();
  db.prepare("DELETE FROM Household WHERE id = '${HH}'").run();
`;

function createSeveredWithBalance() {
  execInApp(`
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
    const heise = db.prepare("SELECT id FROM Household WHERE name = 'Heise'").get().id;
    const aaron = db.prepare("SELECT id FROM User WHERE username = 'aaron'").get().id;
    db.prepare("INSERT OR IGNORE INTO Household (id, name, slug) VALUES ('${HH}', 'Ferris (nbr e2e)', 'e2e-nbr-ferris')").run();
    // System-created severed edge (no circles — the connection is gone; only the
    // net survives, which is exactly what keeps the section on the dashboard).
    db.prepare("INSERT OR IGNORE INTO Connection (id, householdAId, householdBId, status, severedAt) VALUES ('${CONN}', ?, '${HH}', 'SEVERED', datetime('now'))").run(heise);
    // Heise is owed 137¢ by the severed household (B6: settlement still posts).
    db.prepare("INSERT OR IGNORE INTO LedgerEntry (id, type, creditorHouseholdId, debtorHouseholdId, amountCents, note, createdById) VALUES ('${LE}', 'ADJUSTMENT', ?, '${HH}', 137, 'nbr severed probe', ?)").run(heise, aaron);
  `);
}

// ---- (e) newly-founded-household sweep (onboarding.spec's casa pattern) ------
const casaSweep = `
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
  const users = db.prepare("SELECT id FROM User WHERE email LIKE '%@casa-nbr.test'").all().map(r => r.id);
  const hhs = db.prepare("SELECT id FROM Household WHERE slug LIKE 'casa-nbr%'").all().map(r => r.id);
  for (const uid of users) db.prepare("DELETE FROM Invite WHERE createdById = ?").run(uid);
  for (const id of hhs) {
    db.prepare("DELETE FROM Invite WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Membership WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM LedgerSeen WHERE counterpartyHouseholdId = ? OR ownHouseholdId = ?").run(id, id);
    db.prepare("DELETE FROM LedgerEntry WHERE creditorHouseholdId = ? OR debtorHouseholdId = ?").run(id, id);
    db.prepare("DELETE FROM Connection WHERE householdAId = ? OR householdBId = ?").run(id, id);
    db.prepare("DELETE FROM PantryCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM ItemCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM MembershipCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM Circle WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Household WHERE id = ?").run(id);
  }
  for (const id of users) {
    db.prepare("DELETE FROM Session WHERE userId = ?").run(id);
    db.prepare("DELETE FROM Membership WHERE userId = ?").run(id);
    db.prepare("DELETE FROM User WHERE id = ?").run(id);
  }
`;

test('aaron: the Neighbors dashboard leads with attention, shares, and per-household sections', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const data = await overview(page);
  const heise = data.households.find((h) => h.id === data.yourHouseholdId)!;
  const inLaws = data.households.find((h) => h.name === 'In-Laws')!;

  // One deterministic actionable item: a draft restock surfaces in Activity, and
  // the attention strip shares that source. Full-load the dashboard after so the
  // server component re-renders with it; delete it in finally.
  const draft = await ok(page, 'restock.create', {
    pantryId: heise.pantries[0].id,
    retailer: `Nbr Draft ${P}-${RUN}`,
    purchasedAt: TODAY(),
    purchaserHouseholdId: heise.id,
    receiptTotalCents: null,
  });
  try {
    await page.goto('/');

    // Attention strip leads: the seeded draft surfaces as a dense deep-link row
    // (activity.list source) and — the density rule — the strip carries NO inline
    // action buttons (actions live on the destination surface, never a preview).
    const attention = page.getByTestId('neighbors-attention');
    await expect(attention).toBeVisible();
    await expect(attention.getByTestId('neighbors-attention-item').first()).toBeVisible();
    await expect(attention.getByRole('button')).toHaveCount(0);

    // Shares section: present, and links into /shares (browsing needs no cap).
    const shares = page.getByTestId('neighbors-shares');
    await expect(shares).toBeVisible();
    await expect(shares.locator('a[href*="/shares"]').first()).toBeVisible();

    // One section per connected counterparty — In-Laws (full grant) and
    // Neighbors (share-only) — each with a balance link and a member/contact
    // card into /households/[id]. (The lending line only renders while a loan is
    // open, which the seed has none of, so it isn't asserted here.)
    const sections = page.getByTestId('neighbors-household-section');
    await expect(sections).toHaveCount(2);
    await expect(sections.filter({ hasText: 'Neighbors' })).toBeVisible();
    const inLawsSection = sections.filter({ hasText: 'In-Laws' });
    await expect(inLawsSection.getByTestId('neighbors-balance')).toBeVisible();
    await expect(inLawsSection.locator(`a[href*="/households/${inLaws.id}"]`).first()).toBeVisible();
    // In-Laws grants pantry access, so its section lists a "Shared pantries" row
    // that deep-links to the pantry page — the UI path to browse/order a
    // neighbor's pantry (restored in Round E).
    const inLawsPantryRow = inLawsSection.getByTestId('neighbors-pantry-row').first();
    await expect(inLawsPantryRow).toBeVisible();
    expect(await inLawsPantryRow.getAttribute('href')).toMatch(/^\/pantries\//);
  } finally {
    await ok(page, 'restock.deleteDraft', { restockId: draft.id });
  }
});

test('the balance link taps through to the pair ledger, where settle still lives', async ({
  page,
}) => {
  await login(page, 'aaron');
  const inLaws = (await overview(page)).households.find((h) => h.name === 'In-Laws')!;

  await openNeighbors(page);
  const balance = page
    .getByTestId('neighbors-household-section')
    .filter({ hasText: 'In-Laws' })
    .getByTestId('neighbors-balance');
  expect(await balance.getAttribute('href')).toContain(`/ledger?with=${inLaws.id}`);

  await balance.click();
  await expect(page).toHaveURL(new RegExp(`/ledger\\?with=${inLaws.id}`));
  await expect(page.getByTestId('net-hero')).toBeVisible();
  // Settle is reachable from the folded-in pair ledger (P3: the money moved off
  // its own tab, not out of reach).
  await expect(page.getByTestId('settle-up')).toBeVisible();
});

test('a sparse neighbor sees only her connected household, no empty money noise', async ({
  page,
}) => {
  // Nia (Neighbors) is share-only-connected to Heise and unconnected to In-Laws
  // — the Walt rule: her dashboard shows one household section, not a wall of
  // even-balance rows for households she has no edge to.
  await login(page, 'nia');
  await openNeighbors(page);

  const sections = page.getByTestId('neighbors-household-section');
  await expect(sections).toHaveCount(1);
  await expect(sections).toContainText('Heise');
  await expect(sections.filter({ hasText: 'In-Laws' })).toHaveCount(0);
  // The shares section shows for everyone; browsing needs no capability.
  await expect(page.getByTestId('neighbors-shares')).toBeVisible();
});

test('a severed pair that still owes money keeps its household section and settle path', async ({
  page,
}) => {
  execInApp(severedCleanup); // clear any leak from an interrupted run
  createSeveredWithBalance();
  try {
    await login(page, 'aaron');
    await page.goto('/');

    // B6: severing never erased the net, so the section survives — with its
    // balance link into the pair ledger, where settlement still posts.
    const section = page
      .getByTestId('neighbors-household-section')
      .filter({ hasText: 'Ferris (nbr e2e)' });
    await expect(section).toBeVisible();
    const balance = section.getByTestId('neighbors-balance');
    await expect(balance).toContainText('owes you $1.37');

    await balance.click();
    await expect(page).toHaveURL(new RegExp(`/ledger\\?with=${HH}`));
    await expect(page.getByTestId('settle-up')).toBeVisible();
  } finally {
    execInApp(severedCleanup);
  }
});

test('a newly founded household lands on a Neighbors dashboard led by its inviter', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name.slice(0, 4);
  const casa = `Casa-nbr-${P}-${RUN}`;
  execInApp(casaSweep);
  const guestContext = await browser.newContext({ baseURL: BASE });
  try {
    // Aaron mints a household invite (Friend preset default).
    await login(page, 'aaron');
    await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
    await page.getByTestId('invite-household-open').click();
    await page.getByTestId('invite-household-submit').click();
    const link = (await page.getByTestId('household-invite-url').textContent())!.trim();
    expect(link).toContain('/invite/');

    // A stranger founds their own household off it and lands signed in — a
    // brand-new un-onboarded account, so arm the first-run-consent auto-dismiss
    // before it drives the dashboard (it doesn't go through `login`).
    const guest = await guestContext.newPage();
    await autoDismissFirstRun(guest);
    await guest.goto(link);
    await guest.getByTestId('invite-household-name').fill(casa);
    await guest.getByLabel('Your name').fill('Nova');
    await guest.getByLabel('Username').fill(`nova-${P}-${RUN}`);
    await guest.getByLabel('Email').fill(`nova-${P}-${RUN}@casa-nbr.test`);
    await guest.getByLabel('Password').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Start my household' }).click();
    await expect(guest).toHaveURL(/\/$/);

    // The founded household's FIRST screen is the Neighbors dashboard, and its
    // one connection — the inviter, Heise — leads it as a household section. The
    // shares section shows too (browsing needs no capability), so a one-edge
    // network is a real dashboard, not a blank slate.
    await expect(
      guest.getByTestId('neighbors-household-section').filter({ hasText: 'Heise' }),
    ).toBeVisible();
    await expect(guest.getByTestId('neighbors-shares')).toBeVisible();
  } finally {
    await guestContext.close();
    execInApp(casaSweep);
  }
});
