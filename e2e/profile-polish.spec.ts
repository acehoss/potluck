import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { apiLogin, autoDismissFirstRun, login, PASSWORD } from './helpers';

/**
 * Profile-polish round acceptance (avatar crop · US phone formatting · quiet TZ
 * auto-detect). Three product asks, each proven end to end against the real
 * compose stack:
 *
 *  1. PHONE — the profile phone input formats as-you-type to `(913) 555-0142`
 *     (the phone keypad can't type `(`/`-`); the util does it), persists the
 *     formatted string, and a connected household's contact page turns it into a
 *     normalized `tel:+1…` / `sms:+1…` href via `phoneHref`.
 *  2. AVATAR — picking a photo opens a circle cropper (pan by pointer-drag, zoom
 *     by slider), and Save crops to a 512² JPEG uploaded as an "avatars" image;
 *     the saved profile then renders that new `/api/images/avatars/…` path.
 *  3. TIMEZONE — a fresh un-onboarded account's first-run consent quietly records
 *     the browser's IANA zone on User.timezone (no new UI); the notification-prefs
 *     "Server default" option surfaces the detected zone when it's still unset.
 *
 * Seeded topology is byte-identical and shared (workers:1), so seeded mutations
 * are read-before-write + restored in a finally; avatar/TZ work runs on EPHEMERAL
 * accounts created and swept through the container seam (connections.spec pattern)
 * so no seeded row is touched.
 */

const RUN = Date.now().toString(36);

/** Run a Node one-liner inside the app container (see connections.spec.ts). */
function execInApp(script: string): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

/** name → id for every household the api user can see (own + connections). */
async function householdIds(
  api: Pick<import('@playwright/test').APIRequestContext, 'get'>,
): Promise<Map<string, string>> {
  const res = await api.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  const data = (await res.json()).result.data as { households: { id: string; name: string }[] };
  return new Map(data.households.map((h) => [h.name, h.id]));
}

// ---------------------------------------------------------------------------
// Ephemeral-account seam. A DB-inserted user + household + full-capability
// membership: boots un-onboarded (notifyOnboardedAt null → first-run modal
// shows), owns a pantry-less household that still renders the app shell + /more.

type Ephemeral = { username: string; hhId: string; userId: string; cleanup: () => void };

function makeEphemeral(tag: string): Ephemeral {
  const suffix = `${tag}-${RUN}`;
  const hhId = `e2e-pp-hh-${suffix}`;
  const userId = `e2e-pp-user-${suffix}`;
  const username = `e2e_pp_${tag}_${RUN}`;
  const email = `${username}@demo.coop`;
  const cleanupScript = `
    const D = require('better-sqlite3');
    const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
    db.prepare("DELETE FROM NotificationPreference WHERE userId = '${userId}'").run();
    db.prepare("DELETE FROM PushSubscription WHERE userId = '${userId}'").run();
    db.prepare("DELETE FROM Session WHERE userId = '${userId}'").run();
    db.prepare("DELETE FROM Membership WHERE userId = '${userId}'").run();
    db.prepare("DELETE FROM User WHERE id = '${userId}'").run();
    db.prepare("DELETE FROM Household WHERE id = '${hhId}'").run();
  `;
  const cleanup = () => execInApp(cleanupScript);
  cleanup(); // clear any leak from an interrupted prior run
  execInApp(`
    const { hashSync } = require('@node-rs/argon2');
    const D = require('better-sqlite3');
    const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
    db.prepare("INSERT OR IGNORE INTO Household (id, name, slug) VALUES ('${hhId}', 'PP ${tag}', '${hhId}')").run();
    const hash = hashSync('${PASSWORD}', { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    db.prepare("INSERT OR IGNORE INTO User (id, username, name, email, passwordHash) VALUES ('${userId}', '${username}', 'PP ${tag}', '${email}', ?)").run(hash);
    db.prepare("INSERT OR IGNORE INTO Membership (id, userId, householdId, manageHousehold, manageConnections, receiveStock, placeOrders, spend, fulfill, adjustInventory, lendBorrow, postShares, editRecipes, settleMoney) VALUES ('m-${userId}', '${userId}', '${hhId}', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)").run();
  `);
  return { username, hhId, userId, cleanup };
}

/** Read one User column back through the container (returns '' when null). */
function readUserColumn(userId: string, column: string): string {
  return execInApp(`
    const D = require('better-sqlite3');
    const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
    const row = db.prepare("SELECT ${column} AS v FROM User WHERE id = '${userId}'").get();
    process.stdout.write(row && row.v != null ? String(row.v) : '');
  `).trim();
}

// ===========================================================================

test('profile phone: as-you-type US formatting persists and drives contact tel:/sms:', async ({
  page,
}) => {
  await login(page, 'aaron');
  const heiseId = (await householdIds(page.request)).get('Heise')!;

  // Restore aaron's seeded phone whatever happens (shared-DB invariant).
  const before = (await (await page.request.get('/api/trpc/profile.get')).json()).result.data as {
    phone: string | null;
  };

  try {
    // (1) Open the edit sheet and type ten bare digits — the phone keypad can't
    //     produce `(` or `-`, so the util must insert them as we go.
    await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
    await page.getByTestId('profile-edit').click();
    await expect(page.getByTestId('profile-sheet')).toBeVisible();
    // fill dispatches one input event → the controlled onChange runs formatUsPhone
    // once over the ten digits (deterministic across engines; per-keystroke caret
    // behavior is exhaustively covered by phone.unit.test.ts instead).
    const phoneInput = page.getByTestId('profile-phone');
    await phoneInput.fill('9135550142');
    await expect(phoneInput).toHaveValue('(913) 555-0142');

    // (2) Save and reopen — the FORMATTED string is what persisted.
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-sheet')).toBeHidden();
    await expect
      .poll(async () => (await (await page.request.get('/api/trpc/profile.get')).json()).result.data.phone)
      .toBe('(913) 555-0142');
    await page.getByTestId('profile-edit').click();
    await expect(page.getByTestId('profile-phone')).toHaveValue('(913) 555-0142');
    await page.getByTestId('profile-sheet').getByRole('button', { name: 'Cancel' }).click();

    // (3) A connected household (In-Laws' dana) reads Heise's contact page: the
    //     formatted string becomes a normalized tel:/sms: href via phoneHref.
    await login(page, 'dana');
    await page.goto(`/households/${heiseId}`);
    await expect(page.getByTestId('contact-page')).toBeVisible();
    await page.getByTestId('member-card').filter({ hasText: 'Aaron' }).click();
    const sheet = page.getByTestId('member-detail-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('member-phone')).toHaveAttribute('href', 'tel:+19135550142');
    await expect(sheet.getByTestId('member-sms')).toHaveAttribute('href', 'sms:+19135550142');
  } finally {
    const restore = await apiLogin('aaron');
    await restore.post('/api/trpc/profile.update', { data: { phone: before.phone } });
    await restore.dispose();
  }
});

// ---------------------------------------------------------------------------

test('avatar crop: pick → drag + zoom → save uploads a fresh /api/images/avatars path', async ({
  page,
}) => {
  const acct = makeEphemeral('avatar');
  try {
    await login(page, acct.username); // arms first-run auto-dismiss

    // Open the profile edit sheet on the ephemeral (photo-less) account.
    await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
    await page.getByTestId('profile-edit').click();
    await expect(page.getByTestId('profile-sheet')).toBeVisible();

    // Pick a real JPEG → the circle cropper opens with it loaded.
    await page.setInputFiles('[data-testid=profile-photo-input]', 'e2e/fixtures/receipt-costco.jpg');
    const cropSheet = page.getByTestId('avatar-crop-sheet');
    await expect(cropSheet).toBeVisible();
    const stage = page.getByTestId('avatar-crop-stage');
    await expect(stage).toBeVisible();

    // Zoom in first (keyboard — a range input ignores fill; NO pinch in e2e). The
    // slider enables only once the bitmap decoded and cover-scale is known.
    const zoom = page.getByTestId('avatar-crop-zoom');
    await expect(zoom).toBeEnabled();
    await zoom.press('Home'); // cover (min)
    await zoom.press('End'); // max zoom — a definite change through apply()

    // Pan by pointer-drag across the stage (mouse actions emit pointer events);
    // zoomed in, there is pan room on both axes.
    const box = await stage.boundingBox();
    if (!box) throw new Error('crop stage has no box');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 25, { steps: 8 });
    await page.mouse.move(cx - 20, cy + 10, { steps: 6 });
    await page.mouse.up();

    // Save the crop → the async upload lands, cropper closes, sheet preview shows
    // an <img> where a photo-less account had only a monogram.
    await page.getByTestId('avatar-crop-save').click();
    await expect(cropSheet).toBeHidden();
    await expect(page.getByTestId('profile-sheet').locator('img')).toBeVisible();

    // Persist the profile → the card avatar renders the NEW avatars path, and the
    // stored photoPath is a fresh 32-hex avatars object.
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-sheet')).toBeHidden();
    await expect
      .poll(async () => (await (await page.request.get('/api/trpc/profile.get')).json()).result.data.photoPath)
      .toMatch(/^avatars\/[0-9a-f]{32}\.jpg$/);
    await expect(page.getByTestId('profile-card').locator('img')).toHaveAttribute(
      'src',
      /\/api\/images\/avatars\/[0-9a-f]{32}\.jpg$/,
    );
  } finally {
    acct.cleanup();
  }
});

// ---------------------------------------------------------------------------

/** Manual login that does NOT arm the first-run auto-dismiss (the TZ test needs
 *  the consent modal to actually appear). Ephemeral accounts never enroll MFA. */
async function loginRaw(page: Page, identifier: string) {
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(identifier);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('timezone auto-detect: first-run Save records an IANA zone; prefs shows the detected zone', async ({
  page,
}) => {
  const acct = makeEphemeral('tz');
  try {
    // Fresh un-onboarded account → the first-run consent modal appears. Do NOT
    // auto-dismiss it; its Save is what quietly writes the detected zone.
    await loginRaw(page, acct.username);
    await expect(page.getByTestId('notif-firstrun')).toBeVisible();
    const detected = await page.evaluate(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(detected, 'the browser reports a zone to detect').toBeTruthy();

    await page.getByTestId('notif-firstrun-save').click();
    await expect(page.getByTestId('notif-firstrun')).toBeHidden();

    // The zone landed on User.timezone (a real IANA string the server accepted).
    const savedTz = readUserColumn(acct.userId, 'timezone');
    expect(savedTz, 'first-run Save wrote a non-null IANA zone').toBe(detected);
    expect(savedTz).toMatch(/^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/);

    // Prefs "Server default" surfaces the detected zone while tz is UNSET. Clear
    // it back to null and reopen prefs (digestCadence default 'daily' keeps the
    // tz section rendered).
    execInApp(`
      const D = require('better-sqlite3');
      const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
      db.prepare("UPDATE User SET timezone = NULL WHERE id = '${acct.userId}'").run();
    `);
    await autoDismissFirstRun(page); // onboarded now, but harmless; keeps the app clickable
    await page.goto('/more/notifications');
    await expect(page.getByTestId('notif-prefs-screen')).toBeVisible();
    const serverDefaultOption = page.getByTestId('notif-timezone').locator('option[value=""]');
    await expect(serverDefaultOption).toContainText(detected);
  } finally {
    acct.cleanup();
  }
});
