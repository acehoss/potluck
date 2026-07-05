import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';
import { apiLogin, PASSWORD } from './helpers';

/**
 * Phase-3 Round C acceptance — the notification matrix (N4/N5), the five
 * post-commit triggers, the weekly digest, and RFC-8058 one-click unsubscribe.
 * Capture mode (MAIL_MODE=capture, the default fixture stack): every email the
 * app tries to send lands in CapturedEmail and nothing touches SMTP; push is
 * proven with the SEED_DEMO push sink (slice7's pattern — the real web-push
 * encryption + VAPID runs, only FCM/APNs is stood in for).
 *
 * What each channel can assert:
 *   - PUSH: the sink records bytes, not plaintext — so push is asserted only as
 *     "a delivery arrived / didn't" (channel on vs off). All CONTENT rules (N4)
 *     are asserted on the plaintext EMAIL row (subject/textBody).
 *   - EMAIL: read back from CapturedEmail through the better-sqlite3 container
 *     seam (mail.spec.ts's bound-`?` read).
 *
 * Isolation: playwright.config runs workers:1 (chromium then webkit, each its
 * own worker, ONE shared DB), so within a test nothing else writes CapturedEmail
 * or NotificationPreference — a rowid baseline taken at test start lets the
 * finally drop exactly the rows the test created, and every pref row / push
 * subscription / order / share / connection is swept back to the seeded
 * topology. Login as aaron rides the Round-B MFA-aware helper.
 *
 * INTEGRATION NOTE (awaits notify-server C1): the LANDED notify() titles/bodies/
 * details, categories, urls, recipient rules, and the CATEGORY_DEFAULTS matrix
 * are what this asserts (read from src/server/routers/{order,share,connection}.ts
 * + src/server/notifications.ts). The still-unlanded surfaces are centralized in
 * NAMES below (the `notification` tRPC router) and DEV (the /unsub + digest-run
 * routes) — a gate delta there is a one-line edit. Pref rows are set/read
 * directly through the DB seam (not the router) in the trigger tests so those
 * stay coupled only to notify(); the router itself gets its own CRUD test.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;
const TODAY = () => new Date().toISOString().slice(0, 10);

/** Seeded demo mailboxes (fixtures, keyed by upsert — see prisma/seed.ts). */
const EMAIL = {
  aaron: 'aaron@demo.coop',
  marie: 'marie@demo.coop',
  dana: 'dana@demo.coop',
  nia: 'nia@demo.coop',
} as const;

/**
 * Cross-boundary names still in flight on notify-server (proposed via message,
 * ratified at the gate). One edit here if the landed names differ.
 */
const NAMES = {
  prefsGet: 'notification.get', // query → { categories, digestOptOut, showDetails, timezone, onboarded }
  setChannel: 'notification.setChannel', // { category, channel:'push'|'email', enabled }
  setPrefs: 'notification.setPrefs', // { digestOptOut?, showDetails?, timezone? } — any subset
} as const;
const DEV = {
  digestRun: '/api/dev/digest-run', // POST { identifier? } → { ok, capturedId, skipped? }
  unsub: '/unsub', // POST ?token=… body List-Unsubscribe=One-Click (RFC-8058)
  mailTest: '/api/dev/mail-test', // POST { to, pipeline, userId, category } → { ok, capturedId, skipped }
} as const;

type Api = Pick<APIRequestContext, 'get' | 'post'>;

async function rpc(api: Api, path: string, data: Record<string, unknown>) {
  const res = await api.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}
async function ok(api: Api, path: string, data: Record<string, unknown>) {
  const r = await rpc(api, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)} → ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result.data;
}
async function overview(api: Api) {
  const res = await api.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string; pantries: { id: string; name: string }[] }[];
  };
}

// ---- push sink (slice7 pattern) ---------------------------------------------

function makePushKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}
const sinkEndpoint = (id: string) => `http://127.0.0.1:3000/api/dev/push-sink/${id}`;

async function subscribePush(api: Api, endpoint: string) {
  const res = await api.post('/api/trpc/push.subscribe', { data: { endpoint, ...makePushKeys() } });
  expect(res.ok(), `push.subscribe → ${res.status()}`).toBe(true);
}
async function unsubscribePush(api: Api, endpoint: string) {
  await api.post('/api/trpc/push.unsubscribe', { data: { endpoint } }).catch(() => {});
}
async function sinkCount(api: Api, id: string): Promise<number> {
  const res = await api.get(`/api/dev/push-sink/${id}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()).hits as unknown[]).length;
}
/** After a flip-OFF, prove silence: wait past the async post-commit send, then
 * assert the count did not move. */
async function countStaysAt(api: Api, id: string, expected: number) {
  await new Promise((r) => setTimeout(r, 1500));
  expect(await sinkCount(api, id)).toBe(expected);
}

// ---- CapturedEmail + preference DB seam (mail.spec bound-`?` reads) ----------

function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}
const DB_PREAMBLE =
  "const Database=require('better-sqlite3');const db=new Database(process.env.DATABASE_URL.replace(/^file:/,''));";

type CapturedRow = {
  id: string;
  pipeline: string;
  kind: string;
  originalTo: string;
  subject: string;
  textBody: string;
  headersJson: string;
};
const CAP_COLS = 'id, pipeline, kind, originalTo, subject, textBody, headersJson';

/** The highest CapturedEmail rowid right now — the finally deletes everything above it. */
function maxCapturedRowid(): number {
  const out = execInApp(`${DB_PREAMBLE}process.stdout.write(String(db.prepare('SELECT COALESCE(MAX(rowid),0) m FROM CapturedEmail').get().m));`);
  return Number(out.trim() || '0');
}
/** CapturedEmail rows written after `startRowid` for one intended recipient. */
function capturedSince(startRowid: number, originalTo: string): CapturedRow[] {
  const out = execInApp(
    `${DB_PREAMBLE}const rows=db.prepare('SELECT ${CAP_COLS} FROM CapturedEmail WHERE rowid > ${startRowid} AND originalTo = ? ORDER BY rowid ASC').all(${JSON.stringify(originalTo)});process.stdout.write(JSON.stringify(rows));`,
  );
  return JSON.parse(out.trim() || '[]');
}
/** Read one CapturedEmail row by id (digest-run hands us the id directly). */
function readCaptured(id: string): CapturedRow | null {
  const out = execInApp(
    `${DB_PREAMBLE}const row=db.prepare('SELECT ${CAP_COLS} FROM CapturedEmail WHERE id = ?').get(${JSON.stringify(id)});process.stdout.write(JSON.stringify(row ?? null));`,
  );
  return JSON.parse(out.trim() || 'null');
}
/** Drop every CapturedEmail row this test created (workers:1 → nothing else wrote any). */
function sweepCapturedAbove(startRowid: number) {
  execInApp(`${DB_PREAMBLE}db.prepare('DELETE FROM CapturedEmail WHERE rowid > ${startRowid}').run();`);
}

/** Upsert a NotificationPreference row for a seeded user (bypasses the router). */
function setPref(username: string, category: string, push: boolean, email: boolean) {
  execInApp(
    `${DB_PREAMBLE}const u=db.prepare('SELECT id FROM User WHERE username = ?').get(${JSON.stringify(username)});` +
      `db.prepare('INSERT INTO NotificationPreference (userId,category,push,email) VALUES (?,?,?,?) ON CONFLICT(userId,category) DO UPDATE SET push=excluded.push,email=excluded.email').run(u.id, ${JSON.stringify(category)}, ${push ? 1 : 0}, ${email ? 1 : 0});`,
  );
}
/** Read back a user's pref row (null → the category default applies). */
function readPref(username: string, category: string): { push: boolean; email: boolean } | null {
  const out = execInApp(
    `${DB_PREAMBLE}const u=db.prepare('SELECT id FROM User WHERE username = ?').get(${JSON.stringify(username)});` +
      `const r=db.prepare('SELECT push,email FROM NotificationPreference WHERE userId = ? AND category = ?').get(u.id, ${JSON.stringify(category)});` +
      `process.stdout.write(r?JSON.stringify({push:!!r.push,email:!!r.email}):'null');`,
  );
  return JSON.parse(out.trim() || 'null');
}
/** Set one single-valued notify column on User (showDetails/digestOptOut). */
function setUserFlag(username: string, column: 'showDetails' | 'digestOptOut', on: boolean) {
  execInApp(
    `${DB_PREAMBLE}db.prepare('UPDATE User SET ${column} = ? WHERE username = ?').run(${on ? 1 : 0}, ${JSON.stringify(username)});`,
  );
}
/** Full reset of a user's notify state → the seeded default (byte-identical topology). */
function resetUserNotify(username: string) {
  execInApp(
    `${DB_PREAMBLE}const u=db.prepare('SELECT id FROM User WHERE username = ?').get(${JSON.stringify(username)});` +
      `if(u){db.prepare('DELETE FROM NotificationPreference WHERE userId = ?').run(u.id);` +
      `db.prepare('UPDATE User SET digestOptOut=0, showDetails=0, lastDigestAt=NULL, timezone=NULL WHERE id = ?').run(u.id);}`,
  );
}
function userIdOf(username: string): string {
  return execInApp(
    `${DB_PREAMBLE}const u=db.prepare('SELECT id FROM User WHERE username = ?').get(${JSON.stringify(username)});process.stdout.write(u?u.id:'');`,
  ).trim();
}

// ---- domain helpers ---------------------------------------------------------

/** Receive one finalized lot of `count` units ($1/u) into the api's own pantry. */
async function receiveLot(api: Api, retailer: string, count = 9) {
  const data = await overview(api);
  const pantryId = data.households.find((h) => h.id === data.yourHouseholdId)!.pantries[0].id;
  const created = await ok(api, 'restock.create', {
    pantryId,
    retailer,
    purchasedAt: TODAY(),
    purchaserHouseholdId: data.yourHouseholdId,
    receiptTotalCents: null,
  });
  await ok(api, 'restock.saveLine', {
    restockId: created.id,
    newProductName: retailer,
    purchasedCount: count,
    receivedCount: count,
    lineTotalCents: count * 100,
    bestBy: null,
  });
  await ok(api, 'restock.finalize', { restockId: created.id, acknowledgedVarianceCents: null });
  const got = await api.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: created.id }))}`,
  );
  const lots = (await got.json()).result.data.lots as { id: string }[];
  return { pantryId, lotId: lots[0].id };
}

/** Clear any leftover DRAFT cart, then place + submit a fresh order; returns its id. */
async function submitOrder(requester: Api, pantryId: string, lotId: string, qty = 1) {
  const probe = await rpc(requester, 'order.addToCart', { pantryId, lotId, quantity: 1 });
  if (probe.status === 200) {
    await rpc(requester, 'order.cancel', { orderId: probe.body.result.data.orderId });
  }
  const cart = await ok(requester, 'order.addToCart', { pantryId, lotId, quantity: qty });
  await ok(requester, 'order.submit', { orderId: cart.orderId });
  return cart.orderId as string;
}
function takeIdForOrder(orderId: string): string {
  return execInApp(
    `${DB_PREAMBLE}const row=db.prepare('SELECT t.id AS id FROM Take t JOIN OrderLine ol ON ol.takeId=t.id WHERE ol.orderId = ?').get(${JSON.stringify(orderId)});process.stdout.write(row?row.id:'');`,
  ).trim();
}

/** Pull the /unsub token out of a captured subscription email's List-Unsubscribe. */
function unsubTokenFromHeaders(headersJson: string): string {
  const h = JSON.parse(headersJson || '{}') as Record<string, string>;
  const lu = Object.entries(h).find(([k]) => k.toLowerCase() === 'list-unsubscribe')?.[1] ?? '';
  const m = lu.match(/[?&]token=([^>&\s]+)/);
  expect(m, `List-Unsubscribe carries a ?token= URI (got ${JSON.stringify(lu)})`).toBeTruthy();
  return decodeURIComponent(m![1]);
}

// =============================================================================

/** Read the prefs matrix via the notification router (a tRPC query → GET). */
async function getPrefs(api: Api) {
  const res = await api.get(`/api/trpc/${NAMES.prefsGet}`);
  expect(res.ok(), `${NAMES.prefsGet} → ${res.status()}`).toBe(true);
  return (await res.json()).result.data as {
    categories: Record<'pickups' | 'circle' | 'ledger', { push: boolean; email: boolean }>;
    digestOptOut: boolean;
    showDetails: boolean;
    timezone: string | null;
  };
}

test('preference defaults + CRUD through the notification router', async () => {
  const aaron = await apiLogin('aaron');
  try {
    // A fresh account carries ZERO pref rows and still reads the N5 defaults.
    const before = await getPrefs(aaron);
    expect(before.categories.pickups).toEqual({ push: true, email: true });
    expect(before.categories.circle).toEqual({ push: false, email: false });
    expect(before.categories.ledger).toEqual({ push: false, email: false });
    expect(before.digestOptOut).toBe(false);
    expect(before.showDetails).toBe(false);

    // Toggle one channel, the digest, and showDetails; read them all back.
    await ok(aaron, NAMES.setChannel, { category: 'circle', channel: 'push', enabled: true });
    await ok(aaron, NAMES.setChannel, { category: 'pickups', channel: 'email', enabled: false });
    await ok(aaron, NAMES.setPrefs, { digestOptOut: true, showDetails: true });

    const after = await getPrefs(aaron);
    expect(after.categories.circle.push).toBe(true); // opted in
    expect(after.categories.circle.email).toBe(false); // untouched → still default off
    expect(after.categories.pickups.email).toBe(false); // opted out
    expect(after.categories.pickups.push).toBe(true); // untouched → still default on
    expect(after.digestOptOut).toBe(true);
    expect(after.showDetails).toBe(true);
  } finally {
    resetUserNotify('aaron');
    await aaron.dispose();
  }
});

test('order.submit notifies the pantry-owning household on pickups (push + email), N4-generic, showDetails opt-in', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // Heise — the requester
  const dana = await apiLogin('dana'); // In-Laws — pantry owner + notify recipient
  const danaSink = `notif-submit-dana-${P}-${RUN}`;
  const startRowid = maxCapturedRowid();
  const orderIds: string[] = [];
  try {
    await subscribePush(dana, sinkEndpoint(danaSink));
    const lot = await receiveLot(dana, uniq('Submit Oats', P));

    // Order #1 — showDetails OFF (the default). pickups defaults push+email ON.
    orderIds.push(await submitOrder(aaron, lot.pantryId, lot.lotId));
    await expect.poll(() => sinkCount(dana, danaSink)).toBe(1); // push fired
    await expect.poll(() => capturedSince(startRowid, EMAIL.dana).length).toBeGreaterThan(0);

    const email1 = capturedSince(startRowid, EMAIL.dana).find((r) => r.kind === 'pickups')!;
    expect(email1, 'a pickups subscription email was captured for dana').toBeTruthy();
    expect(email1.pipeline).toBe('subscription');
    // N4: subject stamps the recipient's OWN household (In-Laws), NEVER the
    // counterparty (Heise), and carries no money/address.
    expect(email1.subject).toContain('In-Laws');
    expect(email1.subject).not.toContain('Heise');
    // N4 body (showDetails off): generic, no counterparty name, no dollars.
    expect(email1.textBody).not.toContain('Heise');
    for (const s of [email1.subject, email1.textBody]) {
      expect(s).not.toContain('$');
      expect(s, 'no money-shaped figure leaks').not.toMatch(/\d+\.\d{2}/);
    }

    // Turn dana's showDetails ON → the counterparty household NAME may appear in
    // the BODY (still no dollars/addresses); the subject stays generic.
    setUserFlag('dana', 'showDetails', true);
    const mid = maxCapturedRowid();
    orderIds.push(await submitOrder(aaron, lot.pantryId, lot.lotId));
    await expect.poll(() => capturedSince(mid, EMAIL.dana).length).toBeGreaterThan(0);
    const email2 = capturedSince(mid, EMAIL.dana).find((r) => r.kind === 'pickups')!;
    expect(email2.textBody).toContain('Heise'); // detail appended for showDetails
    expect(email2.subject).not.toContain('Heise'); // subject still generic
    expect(email2.subject).toContain('In-Laws');
    await expect.poll(() => sinkCount(dana, danaSink)).toBe(2); // order #2 pushed too

    // Flip dana's pickups PUSH off → the next submit lands NO new push (email
    // still on, so this is a channel-level silence, not a category one).
    setUserFlag('dana', 'showDetails', false);
    setPref('dana', 'pickups', false, true);
    orderIds.push(await submitOrder(aaron, lot.pantryId, lot.lotId));
    await countStaysAt(dana, danaSink, 2); // still the two earlier hits, no third
  } finally {
    for (const id of orderIds) await rpc(aaron, 'order.cancel', { orderId: id });
    await unsubscribePush(dana, sinkEndpoint(danaSink));
    resetUserNotify('dana');
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});

test('order.markReady notifies the requesting household on pickups', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // Heise — requester + notify recipient
  const dana = await apiLogin('dana'); // In-Laws — owner/fulfiller (the actor)
  const aaronSink = `notif-ready-aaron-${P}-${RUN}`;
  const startRowid = maxCapturedRowid();
  let orderId = '';
  let pickedUp = false;
  try {
    await subscribePush(aaron, sinkEndpoint(aaronSink));
    const lot = await receiveLot(dana, uniq('Ready Rice', P));
    orderId = await submitOrder(aaron, lot.pantryId, lot.lotId);

    // dana advances REQUESTED → PICKING → READY. markReady notifies Heise.
    await ok(dana, 'order.startPicking', { orderId });
    await ok(dana, 'order.markReady', { orderId });

    await expect.poll(() => sinkCount(aaron, aaronSink)).toBe(1); // Heise pushed
    await expect.poll(() => capturedSince(startRowid, EMAIL.aaron).length).toBeGreaterThan(0);
    const email = capturedSince(startRowid, EMAIL.aaron).find((r) => r.kind === 'pickups')!;
    expect(email, 'a pickups email reached the requester household').toBeTruthy();
    expect(email.subject).toContain('Heise'); // own-household stamp
    expect(email.subject).not.toContain('In-Laws'); // counterparty stays out of subject

    // Honest cleanup: pick up (money posts) then undo the take (net zero).
    await ok(aaron, 'order.pickup', { orderId, clientKey: `nrdy-${orderId}`.slice(0, 40) });
    pickedUp = true;
    const takeId = takeIdForOrder(orderId);
    expect(takeId, 'pickup created a take to undo').not.toBe('');
    await ok(aaron, 'take.undo', { takeId });
  } finally {
    if (orderId && !pickedUp) await rpc(aaron, 'order.cancel', { orderId });
    await unsubscribePush(aaron, sinkEndpoint(aaronSink));
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});

test('share.claim notifies the posting household on pickups', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // Heise — poster + notify recipient
  const dana = await apiLogin('dana'); // In-Laws — claimer (the actor)
  const aaronSink = `notif-claim-aaron-${P}-${RUN}`;
  const startRowid = maxCapturedRowid();
  let postId = '';
  try {
    await subscribePush(aaron, sinkEndpoint(aaronSink));
    postId = (
      await ok(aaron, 'share.create', {
        type: 'SURPLUS',
        title: uniq('Claim Zucchini', P),
        clientKey: `ncl-${RUN}-${P}`.slice(0, 40),
      })
    ).id;
    await ok(dana, 'share.claim', { postId, clientKey: `nclm-${RUN}-${P}`.slice(0, 40) });

    await expect.poll(() => sinkCount(aaron, aaronSink)).toBe(1); // poster household pushed
    await expect.poll(() => capturedSince(startRowid, EMAIL.aaron).length).toBeGreaterThan(0);
    const email = capturedSince(startRowid, EMAIL.aaron).find((r) => r.kind === 'pickups')!;
    expect(email, 'a pickups email reached the posting household').toBeTruthy();
    expect(email.subject).toContain('Heise');
    expect(email.subject).not.toContain('In-Laws');
    expect(email.textBody).not.toContain('In-Laws'); // no counterparty (showDetails off)
  } finally {
    if (postId) await rpc(aaron, 'share.withdraw', { postId });
    await unsubscribePush(aaron, sinkEndpoint(aaronSink));
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});

test('share.create is silent by default (circle off), and delivers once circle is opted in', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // Heise — poster (the actor)
  const dana = await apiLogin('dana'); // In-Laws — a visible connection
  const danaSink = `notif-share-dana-${P}-${RUN}`;
  const startRowid = maxCapturedRowid();
  const postIds: string[] = [];
  try {
    await subscribePush(dana, sinkEndpoint(danaSink));

    // Post #1 — circle defaults push+email OFF, so a visible connection is NOT
    // interrupted (in-app + digest only per N5).
    postIds.push(
      (await ok(aaron, 'share.create', { type: 'SURPLUS', title: uniq('Silent Share', P) })).id,
    );
    await countStaysAt(dana, danaSink, 0); // no push
    expect(capturedSince(startRowid, EMAIL.dana).filter((r) => r.kind === 'circle')).toHaveLength(0);

    // dana opts IN to circle on both channels → the next post reaches them.
    setPref('dana', 'circle', true, true);
    const mid = maxCapturedRowid();
    postIds.push(
      (await ok(aaron, 'share.create', { type: 'SURPLUS', title: uniq('Loud Share', P) })).id,
    );
    await expect.poll(() => sinkCount(dana, danaSink)).toBe(1); // push fired
    await expect.poll(() => capturedSince(mid, EMAIL.dana).filter((r) => r.kind === 'circle').length).toBe(1);
    const email = capturedSince(mid, EMAIL.dana).find((r) => r.kind === 'circle')!;
    expect(email.pipeline).toBe('subscription');
    expect(email.subject).toContain('In-Laws'); // recipient's own household stamp
    expect(email.subject).not.toContain('Heise'); // no counterparty in subject
  } finally {
    for (const id of postIds) await rpc(aaron, 'share.withdraw', { postId: id });
    await unsubscribePush(dana, sinkEndpoint(danaSink));
    resetUserNotify('dana');
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});

test('connection.request notifies the addressee household on pickups (push)', async ({}, testInfo) => {
  const P = testInfo.project.name;
  // An ephemeral household (activity.spec pattern) requests Heise by handle.
  // Controlled slugs only (no quotes/specials) → raw single-quoted SQL literals,
  // like activity.spec — NEVER JSON.stringify inside a double-quoted node -e SQL
  // string (that injects a `"` and breaks the script). PASSWORD binds via `?`.
  const HH = `e2e-notif-hh-${P}`;
  const UID = `e2e-notif-user-${P}`;
  const EMAIL_ADA = `ada.notif.${P}@demo.coop`;
  const SLUG = `e2e-notif-ada-${P}`;
  const cleanup = `${DB_PREAMBLE}
    db.prepare("DELETE FROM Session WHERE userId='${UID}'").run();
    db.prepare("DELETE FROM Membership WHERE userId='${UID}'").run();
    db.prepare("DELETE FROM Connection WHERE householdAId='${HH}' OR householdBId='${HH}'").run();
    db.prepare("DELETE FROM Circle WHERE householdId='${HH}'").run();
    db.prepare("DELETE FROM User WHERE id='${UID}'").run();
    db.prepare("DELETE FROM Household WHERE id='${HH}'").run();`;
  execInApp(cleanup);
  execInApp(`
    const { hashSync }=require('@node-rs/argon2');${DB_PREAMBLE}
    db.prepare("INSERT OR IGNORE INTO Household (id,name,slug) VALUES ('${HH}','Ada (notif)','${SLUG}')").run();
    const hash=hashSync(${JSON.stringify(PASSWORD)},{memoryCost:19456,timeCost:2,parallelism:1});
    db.prepare("INSERT OR IGNORE INTO User (id,username,name,email,passwordHash) VALUES ('${UID}','${UID}','Ada','${EMAIL_ADA}',?)").run(hash);
    db.prepare("INSERT OR IGNORE INTO Membership (id,userId,householdId,manageHousehold,manageConnections,receiveStock,placeOrders,spend,fulfill,adjustInventory,lendBorrow,postShares,editRecipes,settleMoney) VALUES ('m-${UID}','${UID}','${HH}',1,1,1,1,1,1,1,1,1,1,1)").run();`);

  const aaron = await apiLogin('aaron'); // Heise — addressee + notify recipient
  const ada = await apiLogin(EMAIL_ADA);
  const aaronSink = `notif-conn-aaron-${P}-${RUN}`;
  const startRowid = maxCapturedRowid();
  let connectionId = '';
  try {
    await subscribePush(aaron, sinkEndpoint(aaronSink));
    const circle = (
      await ok(ada, 'circle.create', {
        name: 'Friends',
        grants: { pantry: true, lending: true, recipes: true, shareTo: true, shareFrom: true, reshare: false },
      })
    ).id;
    connectionId = (await ok(ada, 'connection.request', { slug: 'heise', circleId: circle })).id;

    await expect.poll(() => sinkCount(aaron, aaronSink)).toBe(1); // addressee household pushed
    await expect.poll(() => capturedSince(startRowid, EMAIL.aaron).length).toBeGreaterThan(0);
    const email = capturedSince(startRowid, EMAIL.aaron).find((r) => r.kind === 'pickups')!;
    expect(email, 'a pickups email reached the addressee household').toBeTruthy();
    expect(email.subject).toContain('Heise');
  } finally {
    if (connectionId) await rpc(aaron, 'connection.sever', { connectionId });
    await unsubscribePush(aaron, sinkEndpoint(aaronSink));
    sweepCapturedAbove(startRowid);
    execInApp(cleanup);
    await aaron.dispose();
    await ada.dispose();
  }
});

test('ledger settlement is silent by default (N5 push-off), and delivers once ledger is opted in', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // Heise — settles (the actor)
  const dana = await apiLogin('dana'); // In-Laws — counterparty + notify recipient
  const danaSink = `notif-ledger-dana-${P}-${RUN}`;
  const startRowid = maxCapturedRowid();
  const data = await overview(aaron);
  const mine = data.yourHouseholdId;
  const other = data.households.find((h) => h.name === 'In-Laws')!.id;
  // A settlement is an append-only ledger write — reverse each (swapped parties,
  // equal amount) in finally so the net Heise↔In-Laws balance is unchanged.
  const posted: { amountCents: number; key: string }[] = [];
  const settle = async (amountCents: number, tag: string) => {
    const key = `nlg-${tag}-${P}-${RUN}`.slice(0, 40);
    await ok(aaron, 'ledger.settle', {
      payerHouseholdId: mine,
      payeeHouseholdId: other,
      amountCents,
      note: `notif ledger ${tag} ${P}-${RUN}`,
      clientKey: key,
    });
    posted.push({ amountCents, key });
  };
  try {
    await subscribePush(dana, sinkEndpoint(danaSink));

    // DEFAULT ledger prefs are push+email OFF (the deliberate N5 change — money
    // events are in-app + digest only): a settlement interrupts nobody.
    await settle(101, 'default');
    await countStaysAt(dana, danaSink, 0); // no push
    expect(capturedSince(startRowid, EMAIL.dana).filter((r) => r.kind === 'ledger')).toHaveLength(0);

    // dana opts IN to ledger on both channels → the next settlement reaches them.
    setPref('dana', 'ledger', true, true);
    const mid = maxCapturedRowid();
    await settle(102, 'optin');
    await expect.poll(() => sinkCount(dana, danaSink)).toBe(1); // push fired
    await expect.poll(() => capturedSince(mid, EMAIL.dana).filter((r) => r.kind === 'ledger').length).toBe(1);
    const email = capturedSince(mid, EMAIL.dana).find((r) => r.kind === 'ledger')!;
    expect(email.pipeline).toBe('subscription');
    // A ledger event is two-sided → generic, NO counterparty detail even though
    // the recipient can see it (N4): no "Heise", no dollars, no note text.
    for (const s of [email.subject, email.textBody]) {
      expect(s).not.toContain('Heise');
      expect(s).not.toContain('$');
      expect(s).not.toMatch(/\d+\.\d{2}/);
    }
  } finally {
    // Reset dana's ledger pref to the default-off FIRST so the reversal
    // settlements below notify nobody (no orphan rows after the sweep).
    resetUserNotify('dana');
    for (const p of posted) {
      await rpc(aaron, 'ledger.settle', {
        payerHouseholdId: other, // swapped → reverses the balance impact
        payeeHouseholdId: mine,
        amountCents: p.amountCents,
        note: `notif ledger reversal ${P}-${RUN}`,
        clientKey: `rev-${p.key}`.slice(0, 40),
      });
    }
    await unsubscribePush(dana, sinkEndpoint(danaSink));
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});

test('weekly digest assembles balances/loops/new-shares and honors digestOptOut', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // Heise — digest subject
  const dana = await apiLogin('dana'); // In-Laws — posts a share aaron can see
  const startRowid = maxCapturedRowid();
  const shareTitle = uniq('Digest Share', P);
  let postId = '';
  let digestId: string | null = null;
  try {
    // digestOptOut FIRST (before any lastDigestAt is stamped): the run is skipped.
    setUserFlag('aaron', 'digestOptOut', true);
    const optedOut = await aaron.post(DEV.digestRun, { data: { identifier: 'aaron' } });
    expect(optedOut.ok(), `digest-run route enabled (got ${optedOut.status()})`).toBe(true);
    const optedOutBody = await optedOut.json();
    expect(optedOutBody.capturedId, 'digestOptOut suppresses the digest send').toBeFalsy();

    // Opt back in; a fresh, visible share this week bumps the new-shares count.
    setUserFlag('aaron', 'digestOptOut', false);
    resetUserNotify('aaron'); // also clears any lastDigestAt so the forced run sends
    postId = (await ok(dana, 'share.create', { type: 'SURPLUS', title: shareTitle })).id;

    // force:true bypasses the lastDigestAt idempotency guard so both engines send.
    const run = await aaron.post(DEV.digestRun, { data: { identifier: 'aaron', force: true } });
    expect(run.ok()).toBe(true);
    const runBody = await run.json();
    digestId = runBody.capturedId as string | null;
    expect(digestId, 'the digest produced a CapturedEmail row').toBeTruthy();

    const row = readCaptured(digestId!);
    expect(row, 'digest row readable').not.toBeNull();
    expect(row!.pipeline).toBe('subscription');
    expect(row!.kind).toBe('digest');
    // A digest is bulk mail → it MUST carry RFC-8058 unsubscribe headers.
    const headers = JSON.parse(row!.headersJson || '{}') as Record<string, string>;
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'list-unsubscribe')).toBe(true);
    // The three assembled sections are all present: balances (N6 subject),
    // open loops ("Waiting on you"), and new shares this week — a real count,
    // NOT "none", because dana's fresh share is visible to Heise.
    expect(row!.subject).toContain('Your Potluck week:');
    expect(row!.textBody).toContain('Heise'); // aaron's household section header
    expect(row!.textBody).toContain('Balances'); // the balances block
    expect(row!.textBody).toContain('Waiting on you:'); // open-loops block
    expect(row!.textBody, 'the visible share this week is counted, not "none"').toMatch(
      /New shares from neighbors this week: [1-9]/,
    );
  } finally {
    if (postId) await rpc(dana, 'share.withdraw', { postId });
    resetUserNotify('aaron'); // clears digestOptOut + lastDigestAt for the next engine
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});

test('/unsub one-click flips the category email off; a later subscription send is skipped', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // requester driving a pickups email to dana
  const dana = await apiLogin('dana'); // In-Laws — the unsubscriber
  const danaId = userIdOf('dana');
  const startRowid = maxCapturedRowid();
  let orderId = '';
  try {
    // Produce a real pickups email to dana so we can read its List-Unsubscribe.
    const lot = await receiveLot(dana, uniq('Unsub Beans', P));
    orderId = await submitOrder(aaron, lot.pantryId, lot.lotId);
    await expect.poll(() => capturedSince(startRowid, EMAIL.dana).filter((r) => r.kind === 'pickups').length).toBeGreaterThan(0);
    const email = capturedSince(startRowid, EMAIL.dana).find((r) => r.kind === 'pickups')!;
    const token = unsubTokenFromHeaders(email.headersJson);

    // RFC-8058 one-click: an UNAUTHENTICATED POST with the token flips the pref.
    const anon = await playwrightRequest.newContext({ baseURL: BASE });
    try {
      const res = await anon.post(`${DEV.unsub}?token=${encodeURIComponent(token)}`, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        data: 'List-Unsubscribe=One-Click',
      });
      expect(res.ok(), `one-click unsub POST → ${res.status()}`).toBe(true);
    } finally {
      await anon.dispose();
    }

    // The pref row now reads email OFF for pickups…
    expect(readPref('dana', 'pickups')).toEqual({ push: true, email: false });
    // …and a subsequent subscription send for that category is skipped opted-out.
    const resend = await aaron.post(DEV.mailTest, {
      data: { to: EMAIL.dana, pipeline: 'subscription', userId: danaId, category: 'pickups', kind: 'pickups' },
    });
    expect(resend.ok()).toBe(true);
    const resendBody = await resend.json();
    expect(resendBody.skipped).toBe('opted-out');
    expect(resendBody.capturedId).toBeFalsy();
  } finally {
    if (orderId) await rpc(aaron, 'order.cancel', { orderId });
    resetUserNotify('dana');
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});
