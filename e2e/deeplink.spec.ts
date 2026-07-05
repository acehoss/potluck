import { execFileSync } from 'node:child_process';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { apiLogin, login, PASSWORD } from './helpers';
import { fixtureTotpCode, TESTID } from './auth-fixtures';

/**
 * Phase-3 Round D — navigation-only deep links (docs/REWORK.md N7). A
 * notification's CTA link routes the recipient to the specific screen AND
 * switches to the right acting household, but NEVER authenticates and NEVER
 * performs an action: logged-out hits bounce through a normal login (the target
 * preserved via `?next=`), logged-in hits switch + land. Capture mode
 * (MAIL_MODE=capture, the default fixture stack): the emailed CTA link is read
 * back from the CapturedEmail row through the better-sqlite3 container seam.
 *
 * INTEGRATION NOTE (awaits d-server D1 + d-ui D2): the LANDED surfaces are the
 * `/go` route + `verifyDeepLinkToken`'s redirect contract, notify()'s emailed
 * `/go?t=` CTA (order.submit/markReady → `/orders/<id>`), and the login `?next=`
 * continuation (page validates + form pushes). The token FORMAT is never assumed
 * here — every token is minted by the real app (extracted from a captured email)
 * or is a deliberate tamper of one. Runs on both engines (chromium-light,
 * webkit-dark) on the coordinator's gate stack. Token-crypto edge cases (mint,
 * expiry, the open-redirect guard) are proven in src/server/deeplink.unit.test.ts.
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

// ---- container DB seam (mail.spec / notifications.spec bound-`?` reads) -------

function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}
const DB_PREAMBLE =
  "const Database=require('better-sqlite3');const db=new Database(process.env.DATABASE_URL.replace(/^file:/,''));";

type CapturedRow = { id: string; kind: string; originalTo: string; textBody: string };
const CAP_COLS = 'id, kind, originalTo, textBody';

function maxCapturedRowid(): number {
  const out = execInApp(
    `${DB_PREAMBLE}process.stdout.write(String(db.prepare('SELECT COALESCE(MAX(rowid),0) m FROM CapturedEmail').get().m));`,
  );
  return Number(out.trim() || '0');
}
function capturedSince(startRowid: number, originalTo: string): CapturedRow[] {
  const out = execInApp(
    `${DB_PREAMBLE}const rows=db.prepare('SELECT ${CAP_COLS} FROM CapturedEmail WHERE rowid > ${startRowid} AND originalTo = ? ORDER BY rowid ASC').all(${JSON.stringify(originalTo)});process.stdout.write(JSON.stringify(rows));`,
  );
  return JSON.parse(out.trim() || '[]');
}
function sweepCapturedAbove(startRowid: number) {
  execInApp(`${DB_PREAMBLE}db.prepare('DELETE FROM CapturedEmail WHERE rowid > ${startRowid}').run();`);
}
/** Resolve a seeded household's id by its (unique) name — deterministic seam. */
function householdIdByName(name: string): string {
  return execInApp(
    `${DB_PREAMBLE}const h=db.prepare('SELECT id FROM Household WHERE name = ?').get(${JSON.stringify(name)});process.stdout.write(h?h.id:'');`,
  ).trim();
}
function takeIdForOrder(orderId: string): string {
  return execInApp(
    `${DB_PREAMBLE}const row=db.prepare('SELECT t.id AS id FROM Take t JOIN OrderLine ol ON ol.takeId=t.id WHERE ol.orderId = ?').get(${JSON.stringify(orderId)});process.stdout.write(row?row.id:'');`,
  ).trim();
}

// ---- domain helpers (notifications.spec pattern) ----------------------------

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

/** Pull the navigation-only token out of an emailed `/go?t=` CTA link. */
function goTokenFromEmail(row: CapturedRow): string {
  const m = row.textBody.match(/\/go\?t=([^\s"'<>&)]+)/);
  expect(m, `email textBody carries a /go?t= CTA link (body: ${row.textBody.slice(0, 400)})`).toBeTruthy();
  return m![1];
}

/** Path+query of a redirect Location (absolute or relative), for equality asserts. */
function locationPath(loc: string | undefined): string {
  if (!loc) return '';
  try {
    const u = new URL(loc, BASE);
    return u.pathname + (u.search || '');
  } catch {
    return loc;
  }
}

// ---- browser acting-household helpers (marie is the multi-membership fixture) -

async function actingHouseholdId(page: Page): Promise<string> {
  const res = await page.request.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data.yourHouseholdId as string;
}
async function setActingHousehold(page: Page, householdId: string) {
  const res = await page.request.post('/api/trpc/auth.setActingHousehold', { data: { householdId } });
  expect(res.ok(), `setActingHousehold(${householdId}) → ${res.status()}`).toBe(true);
}

/**
 * A `?next=`-aware login that lands where the continuation says, NOT the shell
 * root — so the shared `login()` helper (which hard-asserts `/`) can't be
 * reused. MFA-aware like `login()`: aaron (instance admin) always boots enrolled.
 */
async function loginLandingOn(page: Page, identifier: string, next: string, landingRe: RegExp) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Username or email').fill(identifier);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const mfaInput = page.getByTestId(TESTID.loginMfaInput);
  // Either the app shell lands (no MFA) or the challenge renders (enrolled).
  await expect(page.getByTestId('tab-bar').or(mfaInput)).toBeVisible();
  if (await mfaInput.isVisible().catch(() => false)) {
    await page.request.post('/api/dev/mfa-reset-step', { data: { identifier } }).catch(() => {});
    for (let attempt = 0; attempt < 2; attempt++) {
      await mfaInput.fill(fixtureTotpCode(identifier));
      await page.getByTestId(TESTID.loginMfaSubmit).click();
      try {
        await expect(page).toHaveURL(landingRe, { timeout: 5_000 });
        break;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
  }
  await expect(page).toHaveURL(landingRe);
}

// =============================================================================

test('emailed /go CTA: logged-out routes through /login?next=, invalid tokens land on /', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // Heise — the requester (order actor)
  const dana = await apiLogin('dana'); // In-Laws — pantry owner + email recipient
  const startRowid = maxCapturedRowid();
  let orderId = '';
  try {
    const lot = await receiveLot(dana, uniq('Deeplink Oats', P));
    orderId = await submitOrder(aaron, lot.pantryId, lot.lotId); // notifies In-Laws (dana)
    await expect
      .poll(() => capturedSince(startRowid, EMAIL.dana).filter((r) => r.kind === 'pickups').length)
      .toBeGreaterThan(0);
    const email = capturedSince(startRowid, EMAIL.dana).find((r) => r.kind === 'pickups')!;
    const token = goTokenFromEmail(email);

    const anon = await playwrightRequest.newContext({ baseURL: BASE });
    try {
      // Logged-out → /go bounces to a normal login that will CONTINUE to /go
      // (household-switch preserved), never authenticating on the link itself.
      const res = await anon.get(`/go?t=${token}`, { maxRedirects: 0 });
      expect(res.status(), 'logged-out /go issues a redirect').toBeGreaterThanOrEqual(300);
      expect(res.status()).toBeLessThan(400);
      const loc = res.headers()['location'] ?? '';
      expect(loc, `Location → /login?next=… (got ${loc})`).toContain('/login?next=');
      // next= carries the URL-encoded /go?t=<token> verbatim so the post-login
      // continuation re-hits /go (now authed) and the switch still applies.
      expect(loc).toContain(encodeURIComponent(`/go?t=${token}`));

      // A TAMPERED token → /go redirects to / (no target, no switch, no crash).
      const bad = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
      const resBad = await anon.get(`/go?t=${bad}`, { maxRedirects: 0 });
      expect(resBad.status()).toBeGreaterThanOrEqual(300);
      expect(resBad.status()).toBeLessThan(400);
      expect(locationPath(resBad.headers()['location'])).toBe('/');

      // A MALFORMED token → / as well.
      const resJunk = await anon.get(`/go?t=not-a-real-token`, { maxRedirects: 0 });
      expect(locationPath(resJunk.headers()['location'])).toBe('/');
    } finally {
      await anon.dispose();
    }
  } finally {
    if (orderId) await rpc(aaron, 'order.cancel', { orderId });
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});

test('a logged-in /go deep link switches the acting household and lands on the target', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron'); // Heise — requester
  const dana = await apiLogin('dana'); // In-Laws — owner/fulfiller (markReady actor)
  const startRowid = maxCapturedRowid();
  const heiseId = householdIdByName('Heise');
  const neighborsId = householdIdByName('Neighbors');
  expect(heiseId && neighborsId, 'seeded Heise + Neighbors resolve').toBeTruthy();
  let orderId = '';
  let pickedUp = false;
  let originalActing = '';
  try {
    // Marie (Heise Owner + Neighbors Adult — the switcher fixture) signs in and
    // switches to Neighbors, so her acting household DIFFERS from the token's
    // (which targets Heise). The chip only renders for multi-membership accounts.
    await login(page, 'marie');
    originalActing = await actingHouseholdId(page);
    await setActingHousehold(page, neighborsId);
    await page.goto('/');
    await expect(page.getByTestId('header-household-chip')).toHaveText(/Neighbors/);

    // markReady notifies the REQUESTER household (Heise); marie, a Heise member,
    // gets a pickups email whose /go token targets Heise + /orders/<orderId>.
    const lot = await receiveLot(dana, uniq('Switch Rice', P));
    orderId = await submitOrder(aaron, lot.pantryId, lot.lotId);
    await ok(dana, 'order.startPicking', { orderId });
    await ok(dana, 'order.markReady', { orderId });
    await expect
      .poll(() => capturedSince(startRowid, EMAIL.marie).filter((r) => r.kind === 'pickups').length)
      .toBeGreaterThan(0);
    const email = capturedSince(startRowid, EMAIL.marie).find((r) => r.kind === 'pickups')!;
    const token = goTokenFromEmail(email);

    // Tap the deep link: /go switches marie Neighbors→Heise and lands on the
    // order detail — which /orders/[id] only shows to the involved household, so
    // the SWITCH is what makes the page reachable at all (not a notFound()).
    await page.goto(`/go?t=${token}`);
    await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
    await expect(page.getByTestId('header-household-chip')).toHaveText(/Heise/);

    // Honest money cleanup: pick up (money posts) then undo the take (net zero).
    await ok(aaron, 'order.pickup', { orderId, clientKey: `dl-${orderId}`.slice(0, 40) });
    pickedUp = true;
    const takeId = takeIdForOrder(orderId);
    expect(takeId, 'pickup created a take to undo').not.toBe('');
    await ok(aaron, 'take.undo', { takeId });
  } finally {
    if (orderId && !pickedUp) await rpc(aaron, 'order.cancel', { orderId });
    if (originalActing) await setActingHousehold(page, originalActing).catch(() => {});
    sweepCapturedAbove(startRowid);
    await aaron.dispose();
    await dana.dispose();
  }
});

test('login ?next= continues to the target after sign-in', async ({ page }) => {
  // A logged-out /login?next=/orders → sign in (MFA-aware) → lands on /orders,
  // NOT the shell root. This is the continuation the emailed /go link relies on.
  await loginLandingOn(page, 'aaron', '/orders', /\/orders$/);
});

test('login ?next= ignores an off-origin target (open-redirect guard)', async ({ page }) => {
  // An UNSAFE next (absolute external URL) must never navigate off-origin: the
  // page validates same-origin-relative only and falls back to /.
  await loginLandingOn(page, 'aaron', 'https://evil.example.com', /\/$/);
  const host = new URL(page.url()).host;
  expect(host, 'stayed on-origin, never the external host').toBe(new URL(BASE).host);
  expect(page.url()).not.toContain('evil.example.com');
});
