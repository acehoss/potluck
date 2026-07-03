import crypto from 'node:crypto';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

/**
 * Slice 7 acceptance: PWA installability (manifest, icons, iOS meta,
 * install card), the push-only service worker, web push CRUD + a real
 * server-side send round-trip, camera-scan graceful degradation + the manual
 * UPC path, and the safe-area CSS.
 *
 * Push round-trip: headless browsers can't reach FCM/APNs, so the suite
 * subscribes with endpoints pointing at the app's SEED_DEMO-gated push sink
 * (/api/dev/push-sink/<id>) — the REAL web-push encryption + VAPID + HTTP
 * delivery runs, only the push service is stood in for. Browser-side
 * pushManager.subscribe (needs a push-service connection) is a documented
 * real-device task in PLAN.md.
 *
 * Both projects share one database: sink ids, endpoints, products, and notes
 * are unique per project + run.
 */

const PASSWORD = 'demo-password';
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
}

/**
 * A signed-in raw-API session with NO browser page. The push tests drive
 * their second/third users purely through the API, and WebKit intermittently
 * hangs the first navigation of second-and-later browser contexts on long
 * runs (traced: dana's goto('/login') never even issued a request while the
 * server sat idle) — so those users skip the browser entirely.
 */
async function apiLogin(email: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  const res = await ctx.post('/api/trpc/auth.login', {
    data: { email, password: PASSWORD },
  });
  expect(res.ok()).toBe(true);
  return ctx;
}

/** The raw-API side of either a live page or a pure API session. */
const api = (s: Page | APIRequestContext): APIRequestContext =>
  'request' in s ? (s as Page).request : (s as APIRequestContext);

/** Valid-looking browser push keys (real P-256 point + 16-byte auth secret). */
function makePushKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

/** The app-internal sink endpoint web-push will POST the notification to. */
const sinkEndpoint = (id: string, status?: number) =>
  `http://127.0.0.1:3000/api/dev/push-sink/${id}${status ? `?status=${status}` : ''}`;

const sinkHits = async (s: Page | APIRequestContext, id: string) => {
  const res = await api(s).get(`/api/dev/push-sink/${id}`);
  expect(res.ok()).toBe(true);
  return (await res.json()).hits as {
    at: number;
    bodyBytes: number;
    ttl: string | null;
    authorization: string | null;
    contentEncoding: string | null;
  }[];
};

async function subscribe(s: Page | APIRequestContext, endpoint: string) {
  const keys = makePushKeys();
  const res = await api(s).post('/api/trpc/push.subscribe', {
    data: { endpoint, ...keys },
  });
  expect(res.ok()).toBe(true);
}

async function subscriptionStatus(s: Page | APIRequestContext, endpoint: string) {
  const res = await api(s).get(
    `/api/trpc/push.status?input=${encodeURIComponent(JSON.stringify({ endpoint }))}`,
  );
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data.subscribed as boolean;
}

async function householdIds(s: Page | APIRequestContext) {
  const res = await api(s).get('/api/trpc/household.overview');
  const data = (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string }[];
  };
  const mine = data.yourHouseholdId;
  const other = data.households.find((h) => h.id !== mine)!.id;
  return { mine, other };
}

// ---- installability ---------------------------------------------------------

test('manifest is served with the install-critical fields', async ({ page }) => {
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await res.json();
  expect(manifest.name).toBe('Private Coop');
  expect(manifest.short_name).toBe('Coop');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.theme_color).toBe('#1c1917');
  expect(manifest.background_color).toBe('#1c1917');
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(
    manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable'),
  ).toBe(true);

  // Every icon the manifest promises actually resolves as a PNG.
  for (const icon of manifest.icons as { src: string }[]) {
    const img = await page.request.get(icon.src);
    expect(img.status()).toBe(200);
    expect(img.headers()['content-type']).toContain('image/png');
  }
  const apple = await page.request.get('/apple-touch-icon.png');
  expect(apple.status()).toBe(200);
});

test('service worker is push-only, uncached, and correctly typed', async ({ page }) => {
  const res = await page.request.get('/sw.js');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/javascript');
  expect(res.headers()['cache-control']).toContain('no-store');
  const body = await res.text();
  expect(body).toContain("addEventListener('push'");
  expect(body).toContain("addEventListener('notificationclick'");
  // No offline/caching machinery — stale money data must be impossible.
  expect(body).not.toContain("addEventListener('fetch'");
  expect(body).not.toContain('caches.');
});

test('layout carries PWA meta: per-scheme theme-color, viewport-fit, apple tags', async ({
  page,
}) => {
  await page.goto('/login');
  const themeMetas = page.locator('meta[name="theme-color"]');
  await expect(themeMetas).toHaveCount(2);
  await expect(
    page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]'),
  ).toHaveAttribute('content', '#1c1917');
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');
  // Next renders appleWebApp.capable as the modern standalone-capable meta
  // (accepted by iOS 17.4+; the apple-specific title/status-bar tags follow).
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
    'content',
    'yes',
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
    'content',
    'Coop',
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
    'content',
    'black-translucent',
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    /apple-touch-icon/,
  );
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    /manifest\.webmanifest/,
  );
});

test('install card renders on /more, dismisses, and stays dismissed', async ({ page }) => {
  await login(page, 'aaron@demo.coop');
  await page.goto('/more');
  const card = page.getByTestId('install-card');
  await expect(card).toBeVisible();
  // Desktop test browsers fire no beforeinstallprompt and are not iOS — the
  // generic guidance is the correct branch.
  await expect(page.getByTestId('install-generic-hint')).toBeVisible();

  await page.getByTestId('install-dismiss').click();
  await expect(card).not.toBeVisible();
  await page.reload();
  await expect(page.getByTestId('notifications-card')).toBeVisible();
  await expect(page.getByTestId('install-card')).not.toBeVisible();
});

test('iOS user agents get the Share → Add to Home Screen steps', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: BASE,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  await login(page, 'aaron@demo.coop');
  await page.goto('/more');
  await expect(page.getByTestId('install-card')).toBeVisible();
  const steps = page.getByTestId('install-ios-steps');
  await expect(steps).toBeVisible();
  await expect(steps).toContainText('Share');
  await expect(steps).toContainText('Add to Home Screen');
  await context.close();
});

test('iPadOS 13+ (desktop Macintosh UA + touch) is treated as iOS by both cards', async ({
  browser,
}) => {
  // Modern iPad Safari reports a Mac UA; the tell is a multi-touch screen.
  // Real Macs report maxTouchPoints 0, so they must NOT hit this branch.
  const context = await browser.newContext({
    baseURL: BASE,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
  });
  const page = await context.newPage();
  await login(page, 'aaron@demo.coop');
  await page.goto('/more');
  // Install card: the Share → Add to Home Screen steps, not the Chrome-menu
  // hint an iPad Safari user can't follow.
  await expect(page.getByTestId('install-ios-steps')).toBeVisible();
  // Notifications card: in iPad Safari outside the installed PWA there is no
  // PushManager — the copy must say "install first", not "unsupported
  // browser" (blueprint 04 §4: iOS caveats surface in UI copy).
  const hasPushManager = await page.evaluate(() => 'PushManager' in window);
  if (!hasPushManager) {
    await expect(page.getByTestId('push-unsupported')).toContainText('home screen');
  }
  await context.close();
});

test('safe-area CSS is present: tab bar inset padding, body top inset, cover viewport', async ({
  page,
}) => {
  await login(page, 'aaron@demo.coop');
  const tabBarClass = await page.getByTestId('tab-bar').getAttribute('class');
  expect(tabBarClass).toContain('pb-[env(safe-area-inset-bottom)]');
  // The compiled stylesheet actually ships the body's safe-area padding.
  const bodyRuleShipped = await page.evaluate(() =>
    Array.from(document.styleSheets).some((sheet) => {
      try {
        return Array.from(sheet.cssRules).some(
          (rule) =>
            rule.cssText.includes('safe-area-inset-top') && rule.cssText.includes('body'),
        );
      } catch {
        return false;
      }
    }),
  );
  expect(bodyRuleShipped).toBe(true);
});

test('notifications card offers the toggle (or explains itself) — never auto-prompts', async ({
  page,
}) => {
  await login(page, 'aaron@demo.coop');
  await page.goto('/more');
  const card = page.getByTestId('notifications-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('settlement');
  // Supported browsers see the opt-in button; unsupported ones the
  // explanation. Either way nothing subscribes or prompts without a tap.
  await expect(
    page.getByTestId('push-on-btn').or(page.getByTestId('push-unsupported')),
  ).toBeVisible();
  const permission = await page.evaluate(() =>
    'Notification' in window ? Notification.permission : 'unsupported',
  );
  expect(permission).not.toBe('granted'); // nothing asked on load
});

// ---- web push ----------------------------------------------------------------

test('push endpoints require a session (authz negatives)', async () => {
  const anon = await playwrightRequest.newContext({ baseURL: BASE });
  const keys = makePushKeys();
  const sub = await anon.post('/api/trpc/push.subscribe', {
    data: { endpoint: sinkEndpoint(`anon-${RUN}`), ...keys },
  });
  expect(sub.status()).toBe(401);
  const unsub = await anon.post('/api/trpc/push.unsubscribe', {
    data: { endpoint: sinkEndpoint(`anon-${RUN}`) },
  });
  expect(unsub.status()).toBe(401);
  const key = await anon.get('/api/trpc/push.publicKey');
  expect(key.status()).toBe(401);
  await anon.dispose();
});

test('push subscribe rejects SSRF-shaped endpoints (only public https push hosts)', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron@demo.coop');
  // z.url() accepts all of these — the endpoint guard must not. The server
  // POSTs notifications to stored endpoints, so an internal address here is
  // a blind SSRF primitive for any authenticated member.
  for (const endpoint of [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'https://10.0.0.5/admin', // private-range IP literal
    'https://internal-service/probe', // bare intranet hostname
    'https://localhost/api', // loopback by name
    'https://push.example.com:8443/x', // non-443 port
    'http://127.0.0.1:3000/api/health', // demo-stack loopback, but NOT the sink path
  ]) {
    const keys = makePushKeys();
    const res = await page.request.post('/api/trpc/push.subscribe', {
      data: { endpoint, ...keys },
    });
    expect(res.status(), endpoint).toBe(400);
  }
  // Sanity: a real push-service-shaped endpoint is accepted (and cleaned up).
  const ok = `https://updates.push.services.mozilla.com/wpush/v2/ssrf-${P}-${RUN}`;
  await subscribe(page, ok);
  expect(await subscriptionStatus(page, ok)).toBe(true);
  await page.request.post('/api/trpc/push.unsubscribe', { data: { endpoint: ok } });
});

test('push subscribe/unsubscribe CRUD, and endpoints belong to their last subscriber', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron@demo.coop');

  // publicKey is served at runtime (the dev pair on e2e stacks).
  const keyRes = await page.request.get('/api/trpc/push.publicKey');
  expect(keyRes.ok()).toBe(true);
  const { publicKey } = (await keyRes.json()).result.data;
  expect(typeof publicKey).toBe('string');
  expect(publicKey.length).toBeGreaterThan(60);

  const endpoint = sinkEndpoint(`crud-${P}-${RUN}`);
  await subscribe(page, endpoint);
  expect(await subscriptionStatus(page, endpoint)).toBe(true);

  // Same browser endpoint re-subscribed by another user → reassigned.
  const dana = await apiLogin('dana@demo.coop');
  await subscribe(dana, endpoint);
  expect(await subscriptionStatus(dana, endpoint)).toBe(true);
  expect(await subscriptionStatus(page, endpoint)).toBe(false);

  // Aaron can't remove Dana's subscription.
  const foreign = await page.request.post('/api/trpc/push.unsubscribe', {
    data: { endpoint },
  });
  expect(foreign.ok()).toBe(true);
  expect((await foreign.json()).result.data.removed).toBe(false);
  expect(await subscriptionStatus(dana, endpoint)).toBe(true);

  // Dana removes it for real.
  const own = await dana.post('/api/trpc/push.unsubscribe', { data: { endpoint } });
  expect((await own.json()).result.data.removed).toBe(true);
  expect(await subscriptionStatus(dana, endpoint)).toBe(false);

  // Garbage subscription payloads are rejected.
  const bad = await page.request.post('/api/trpc/push.subscribe', {
    data: { endpoint: 'not-a-url', p256dh: 'x', auth: 'y' },
  });
  expect(bad.status()).toBe(400);

  await dana.dispose();
});

test('settlement pushes to both households except the creator; adjustment pushes back', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron@demo.coop'); // creator (Heise)

  const marie = await apiLogin('marie@demo.coop'); // creator's housemate (Heise)
  const dana = await apiLogin('dana@demo.coop'); // counterparty (In-Laws)

  const aaronSink = `aaron-${P}-${RUN}`;
  const marieSink = `marie-${P}-${RUN}`;
  const danaSink = `dana-${P}-${RUN}`;
  await subscribe(page, sinkEndpoint(aaronSink));
  await subscribe(marie, sinkEndpoint(marieSink));
  await subscribe(dana, sinkEndpoint(danaSink));

  const { mine, other } = await householdIds(page);

  // Event 1: Aaron records a settlement.
  const settle = await page.request.post('/api/trpc/ledger.settle', {
    data: {
      payerHouseholdId: mine,
      payeeHouseholdId: other,
      amountCents: 123,
      note: `push-settle-${P}-${RUN}`,
      clientKey: `push-settle-${P}-${RUN}`,
    },
  });
  expect(settle.ok()).toBe(true);

  // The send is post-commit and async — poll the sinks. Marie (housemate)
  // and Dana (counterparty) each get exactly one encrypted delivery.
  await expect.poll(async () => (await sinkHits(marie, marieSink)).length).toBe(1);
  await expect.poll(async () => (await sinkHits(dana, danaSink)).length).toBe(1);
  const [hit] = await sinkHits(dana, danaSink);
  expect(hit.bodyBytes).toBeGreaterThan(0); // an actual payload arrived…
  expect(hit.ttl).toBeTruthy();
  // …and it is a REAL web-push request a production push service would
  // accept: VAPID-signed and aes128gcm-encrypted, not plaintext JSON with a
  // TTL slapped on. These headers are what FCM/APNs 401/400 without.
  expect(hit.authorization).toMatch(/^vapid t=.+k=.+/);
  expect(hit.contentEncoding).toBe('aes128gcm');

  // A clientKey replay must not re-notify.
  const replay = await page.request.post('/api/trpc/ledger.settle', {
    data: {
      payerHouseholdId: mine,
      payeeHouseholdId: other,
      amountCents: 123,
      note: `push-settle-${P}-${RUN}`,
      clientKey: `push-settle-${P}-${RUN}`,
    },
  });
  expect(replay.ok()).toBe(true);

  // Event 2: Dana posts a manual adjustment; Aaron and Marie are notified.
  const adjust = await dana.post('/api/trpc/ledger.adjust', {
    data: {
      creditorHouseholdId: other,
      debtorHouseholdId: mine,
      amountCents: 77,
      note: `push-adjust-${P}-${RUN}`,
      clientKey: `push-adjust-${P}-${RUN}`,
    },
  });
  expect(adjust.ok()).toBe(true);

  await expect.poll(async () => (await sinkHits(page, aaronSink)).length).toBe(1);
  await expect.poll(async () => (await sinkHits(marie, marieSink)).length).toBe(2);

  // Creators were never notified of their own events: Aaron's sink has only
  // Dana's adjustment (1 hit, not 2); Dana's has only Aaron's settlement.
  expect((await sinkHits(page, aaronSink)).length).toBe(1);
  expect((await sinkHits(dana, danaSink)).length).toBe(1);

  await marie.dispose();
  await dana.dispose();
});

test('a 410 from the push service prunes the subscription', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron@demo.coop');
  const dana = await apiLogin('dana@demo.coop');

  const goneSink = `gone-${P}-${RUN}`;
  const goneEndpoint = sinkEndpoint(goneSink, 410);
  await subscribe(dana, goneEndpoint);
  expect(await subscriptionStatus(dana, goneEndpoint)).toBe(true);

  const settle = await page.request.post('/api/trpc/ledger.settle', {
    data: {
      payerHouseholdId: (await householdIds(page)).mine,
      payeeHouseholdId: (await householdIds(page)).other,
      amountCents: 55,
      note: `push-prune-${P}-${RUN}`,
      clientKey: `push-prune-${P}-${RUN}`,
    },
  });
  expect(settle.ok()).toBe(true);

  // The sink answered 410 → the row is gone.
  await expect.poll(async () => (await sinkHits(dana, goneSink)).length).toBe(1);
  await expect.poll(async () => subscriptionStatus(dana, goneEndpoint)).toBe(false);

  await dana.dispose();
});

// ---- camera barcode scanning --------------------------------------------------

/** Start a draft restock in the signed-in user's own pantry, land on step 3. */
async function startDraft(page: Page, retailer: string) {
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Pantries' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page
    .getByTestId('pantry-group')
    .filter({ hasText: 'your household' })
    .getByTestId('pantry-row')
    .first()
    .click();
  await page.getByTestId('receive-fab').click();
  await page.getByLabel('Retailer').fill(retailer);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/receive\/.+step=2/);
  const restockId = page.url().match(/\/receive\/([^/?]+)/)![1];
  await page.getByRole('button', { name: 'Skip photos' }).click();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();
  return restockId;
}

test('scan sheet on a real camera API: webkit holds steady on a fake feed, chromium degrades', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron@demo.coop');
  const restockId = await startDraft(page, `S7scan-${P}-${RUN}`);

  await page.getByTestId('add-line').click();
  await expect(page.getByTestId('product-search')).toBeVisible();

  // localhost is a secure context, so both engines have the camera API and
  // the button must render. (The no-API case is forced in its own test.)
  const scanButton = page.getByTestId('scan-upc');
  await expect(scanButton).toBeVisible();
  await scanButton.click();
  const sheet = page.getByTestId('scan-sheet');
  await expect(sheet).toBeVisible();
  // Two legitimate headless outcomes:
  // - chromium: no camera device → getUserMedia rejects → the sheet
  //   explains itself and points at the manual path (the degradation).
  // - webkit: Playwright ships a mock capture device → the REAL camera +
  //   zxing-wasm detect loop runs against the fake feed (no barcode in it);
  //   the sheet must hold steady, not crash or error.
  // The video container renders while getUserMedia is pending, so "no
  // error within 5s" (camera running) vs "error shown" (no camera) is the
  // discriminator — not element presence.
  const error = page.getByTestId('scan-error');
  const video = sheet.locator('video');
  const errored = await error
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (errored) {
    await expect(error).toContainText('product search');
  } else {
    // Let the detect loop chew on a few fake frames — it must not blow up.
    await page.waitForTimeout(2000);
    await expect(video).toBeVisible();
    await expect(error).not.toBeVisible();
  }
  await page.getByTestId('scan-close').click();
  await expect(sheet).not.toBeVisible();

  // Cleanup: abandon the draft so reruns stay tidy.
  const del = await page.request.post('/api/trpc/restock.deleteDraft', {
    data: { restockId },
  });
  expect(del.ok()).toBe(true);
});

test('scan buttons are hidden when no camera API exists (plain-http LAN degradation)', async ({
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  // Force the http-LAN shape: a context whose pages have no
  // navigator.mediaDevices at all. Without this, localhost (a secure
  // context) always has the API and the hidden-button contract is dead code.
  const context = await browser.newContext({ baseURL: BASE });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      get: () => undefined,
      configurable: true,
    });
  });
  const page = await context.newPage();
  await login(page, 'aaron@demo.coop');
  const restockId = await startDraft(page, `S7nocam-${P}-${RUN}`);

  // Line sheet: manual search stays, the Scan button does not render.
  await page.getByTestId('add-line').click();
  await expect(page.getByTestId('product-search')).toBeVisible();
  await expect(page.getByTestId('scan-upc')).not.toBeVisible();

  const del = await page.request.post('/api/trpc/restock.deleteDraft', {
    data: { restockId },
  });
  expect(del.ok()).toBe(true);

  // Pantry inventory: search input renders without its Scan neighbor.
  // (The wizard screen has no tab bar — go home directly.)
  await page.goto('/');
  await page
    .getByTestId('pantry-group')
    .filter({ hasText: 'your household' })
    .getByTestId('pantry-row')
    .first()
    .click();
  await expect(page.locator('input[type="search"]')).toBeVisible();
  await expect(page.getByTestId('inventory-scan')).not.toBeVisible();
  await context.close();
});

test('denied camera permission explains itself and points at the manual path', async ({
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const context = await browser.newContext({ baseURL: BASE });
  await context.addInitScript(() => {
    // Replace mediaDevices wholesale (WebKit ignores instance-level
    // overrides of getUserMedia on the real object): the camera API exists,
    // but permission is always denied.
    const denied = {
      getUserMedia: () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      get: () => denied,
      configurable: true,
    });
  });
  const page = await context.newPage();
  await login(page, 'aaron@demo.coop');
  const restockId = await startDraft(page, `S7denied-${P}-${RUN}`);
  await page.getByTestId('add-line').click();
  await page.getByTestId('scan-upc').click();
  await expect(page.getByTestId('scan-error')).toContainText('denied');
  await expect(page.getByTestId('scan-error')).toContainText('product search');
  await page.getByTestId('scan-close').click();
  const del = await page.request.post('/api/trpc/restock.deleteDraft', {
    data: { restockId },
  });
  expect(del.ok()).toBe(true);
  await context.close();
});

/**
 * The seam-driven scan tests exercise the detection HANDLER (normalize →
 * lookup → select/keep), not the camera itself — that has its own dedicated
 * test above and the on-device owner task. Stub getUserMedia to reject in
 * their pages: the scan buttons still render (the API exists), the sheet
 * shows its manual-path copy, and — crucially — WebKit's mock-capture
 * pipeline is never touched. Repeated real capture open/close cycles were
 * the strongest correlate of WebKit's wedged-next-navigation flake (see
 * playwright.config.ts).
 */
async function stubCameraUnavailable(page: Page) {
  await page.addInitScript(() => {
    const denied = {
      getUserMedia: () =>
        Promise.reject(new DOMException('No camera in this test', 'NotFoundError')),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      get: () => denied,
      configurable: true,
    });
  });
}

/**
 * Emit a raw scanned value into an ALREADY-OPEN scan sheet via its seam
 * (window.__coopScanEmit feeds the sheet's real normalize→flash→deliver
 * pipeline — everything below the camera frame loop, which needs physical
 * hardware). Emits the 13-digit EAN form so normalization is exercised for
 * real.
 */
async function emitWhenReady(page: Page, rawValue: string) {
  await expect(page.getByTestId('scan-sheet')).toBeVisible();
  await page.waitForFunction(() => typeof window.__coopScanEmit === 'function');
  const accepted = await page.evaluate((raw) => window.__coopScanEmit!(raw), rawValue);
  expect(accepted).toBe(true);
  await expect(page.getByTestId('scan-sheet')).not.toBeVisible();
}

async function emitScan(page: Page, rawValue: string) {
  await page.getByTestId('scan-upc').click();
  await emitWhenReady(page, rawValue);
}

test('take flow: scanning at the pantry opens the take sheet for the matched product', async ({
  page,
}, testInfo) => {
  test.slow(); // API seeding + two scan-sheet opens; give webkit headroom under load
  const P = testInfo.project.name;
  await stubCameraUnavailable(page);
  await login(page, 'aaron@demo.coop');
  const { mine } = await householdIds(page);

  // Land on the own pantry and grab its id from the URL.
  await page
    .getByTestId('pantry-group')
    .filter({ hasText: 'your household' })
    .getByTestId('pantry-row')
    .first()
    .click();
  await expect(page).toHaveURL(/\/pantries\/.+/);
  const pantryId = page.url().match(/\/pantries\/([^/?]+)/)![1];

  // Seed a FINALIZED lot whose product carries a per-run UPC.
  const upc = `4${String(Date.now()).slice(-9)}${P === 'webkit' ? '81' : '41'}`;
  const productName = `Scan Take Beans ${P}-${RUN}`;
  const create = await page.request.post('/api/trpc/restock.create', {
    data: {
      pantryId,
      retailer: `S7take-${P}-${RUN}`,
      purchasedAt: new Date().toISOString().slice(0, 10),
      purchaserHouseholdId: mine,
      receiptTotalCents: null,
    },
  });
  expect(create.ok()).toBe(true);
  const restockId = (await create.json()).result.data.id as string;
  const line = await page.request.post('/api/trpc/restock.saveLine', {
    data: {
      restockId,
      newProductName: productName,
      upc,
      purchasedCount: 3,
      receivedCount: 3,
      lineTotalCents: 600,
      bestBy: null,
    },
  });
  expect(line.ok()).toBe(true);
  const fin = await page.request.post('/api/trpc/restock.finalize', {
    data: { restockId, acknowledgedVarianceCents: null },
  });
  expect(fin.ok()).toBe(true);

  await page.reload();
  const scanButton = page.getByTestId('inventory-scan');
  await expect(scanButton).toBeVisible();

  // Unknown code → a notice, not a dead end.
  await scanButton.click();
  const bogus = `4${String(Date.now()).slice(-9)}${P === 'webkit' ? '82' : '42'}`;
  await emitWhenReady(page, `0${bogus}`);
  await expect(page.getByTestId('inventory-scan-notice')).toContainText('nothing with this UPC');

  // The real code (13-digit form again) jumps straight into the take sheet
  // with the FIFO suggestion — SPEC §5's "find product (search/scan)".
  await scanButton.click();
  await emitWhenReady(page, `0${upc}`);
  const takeSheet = page.getByTestId('take-sheet');
  await expect(takeSheet).toBeVisible();
  await expect(takeSheet).toContainText(productName);
  await expect(takeSheet).toContainText('FIFO');
  await takeSheet.getByRole('button', { name: 'Cancel' }).click();
});

test('manual UPC path: a typed UPC finds the product; a new product keeps its UPC', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron@demo.coop');
  const restockId = await startDraft(page, `S7upc-${P}-${RUN}`);

  // A UPC unique to this project+run (12 digits, numeric only).
  const upc = `4${String(Date.now()).slice(-9)}${P === 'webkit' ? '77' : '33'}`;
  const productName = `Scanned Beans ${P}-${RUN}`;

  // Create the product with a UPC through the same API the line sheet uses.
  const create = await page.request.post('/api/trpc/restock.saveLine', {
    data: {
      restockId,
      newProductName: productName,
      upc,
      purchasedCount: 2,
      receivedCount: 2,
      lineTotalCents: 500,
      bestBy: null,
    },
  });
  expect(create.ok()).toBe(true);

  // Malformed UPCs are rejected.
  const badUpc = await page.request.post('/api/trpc/restock.saveLine', {
    data: {
      restockId,
      newProductName: `Bad UPC ${P}-${RUN}`,
      upc: 'ABC123',
      purchasedCount: 1,
      receivedCount: 1,
      lineTotalCents: 100,
      bestBy: null,
    },
  });
  expect(badUpc.status()).toBe(400);

  // Manual path (blueprint 04 §2): typing the UPC digits into the product
  // search finds the product — the exact flow a scan hit automates.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();
  await page.getByTestId('add-line').click();
  await page.getByTestId('product-search').fill(upc);
  const match = page.getByTestId('product-result').filter({ hasText: productName });
  await expect(match).toBeVisible();
  await expect(match).toContainText(upc);
  await match.click();
  // The picker collapses to the selected product (with a Change affordance).
  await expect(page.getByRole('button', { name: 'Change' })).toBeVisible();

  // Save a line against the UPC-matched product to prove the pick is real.
  await page.getByTestId('line-total').fill('3.50');
  await page.getByTestId('save-line').click();
  await expect(
    page.getByTestId('line-row').filter({ hasText: productName }),
  ).toHaveCount(2);

  const del = await page.request.post('/api/trpc/restock.deleteDraft', {
    data: { restockId },
  });
  expect(del.ok()).toBe(true);
});

// Kept LAST in the file: three camera open/close cycles occasionally wedge
// WebKit's next navigation (see playwright.config.ts) — with nothing after
// this test in the worker, there is nothing to wedge.
test('scan detection end to end: UPC sticks to an existing product, then matches; new products too', async ({
  page,
}, testInfo) => {
  test.slow(); // five sheet-open/scan/save cycles; webkit runs this near 20s under full-suite load
  const P = testInfo.project.name;
  await stubCameraUnavailable(page);
  await login(page, 'aaron@demo.coop');
  const restockId = await startDraft(page, `S7detect-${P}-${RUN}`);

  // Per-run 12-digit codes; the seam always emits the 13-digit EAN form (a
  // leading zero) so the sheet's normalization is proven, not assumed.
  const upcExisting = `4${String(Date.now()).slice(-9)}${P === 'webkit' ? '61' : '21'}`;
  const upcNew = `4${String(Date.now()).slice(-9)}${P === 'webkit' ? '62' : '22'}`;
  const existingName = `Diced Tomatoes ${P}-${RUN}`;
  const newName = `Scan Salsa ${P}-${RUN}`;

  // A pre-scan-era product: exists, has NO UPC (the slice-2 shape).
  const preCreate = await page.request.post('/api/trpc/restock.saveLine', {
    data: {
      restockId,
      newProductName: existingName,
      purchasedCount: 1,
      receivedCount: 1,
      lineTotalCents: 199,
      bestBy: null,
    },
  });
  expect(preCreate.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review lines' })).toBeVisible();

  // Scan 1: no product carries this UPC yet → the code is KEPT and shown.
  await page.getByTestId('add-line').click();
  await emitScan(page, `0${upcExisting}`);
  const notice = page.getByTestId('scan-notice');
  await expect(notice).toContainText('no product with this UPC yet');
  await expect(notice).toContainText(upcExisting); // normalized 12-digit form
  await expect(page.getByTestId('pending-upc')).toContainText(upcExisting);

  // The user recognizes the item and picks the EXISTING product by name.
  // The pending chip must stay visible on the selected product (nothing is
  // attached silently) and saving must write the UPC onto that product.
  await page.getByTestId('product-search').fill('Diced Tomatoes');
  await page.getByTestId('product-result').filter({ hasText: existingName }).click();
  await expect(page.getByTestId('pending-upc')).toBeVisible();
  await expect(page.getByText(`will be saved onto ${existingName}`)).toBeVisible();
  await page.getByTestId('line-total').fill('2.19');
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: existingName })).toHaveCount(2);

  // Scan 2 (same package): the existing product now matches and auto-selects.
  await page.getByTestId('add-line').click();
  await emitScan(page, `0${upcExisting}`);
  await expect(page.getByTestId('scan-notice')).toContainText(`matched ${existingName}`);
  await expect(page.getByRole('button', { name: 'Change' })).toBeVisible();
  await expect(page.getByTestId('pending-upc')).not.toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Scan 3: a different unknown code, resolved by CREATING a product — the
  // code rides along and the next scan of it matches instantly.
  await page.getByTestId('add-line').click();
  await emitScan(page, `0${upcNew}`);
  await expect(page.getByTestId('pending-upc')).toContainText(upcNew);
  await page.getByTestId('product-search').fill(newName);
  await page.getByTestId('create-product').click();
  await expect(page.getByText('will be saved with the new product')).toBeVisible();
  await page.getByTestId('line-total').fill('3.49');
  await page.getByTestId('save-line').click();
  await expect(page.getByTestId('line-row').filter({ hasText: newName })).toBeVisible();

  await page.getByTestId('add-line').click();
  await emitScan(page, `0${upcNew}`);
  await expect(page.getByTestId('scan-notice')).toContainText(`matched ${newName}`);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Server-side canonicalization: the 13-digit code TYPED into the search
  // API also finds the product created from the 12-digit scan.
  const typed = await page.request.get(
    `/api/trpc/product.search?input=${encodeURIComponent(
      JSON.stringify({ query: `0${upcExisting}` }),
    )}`,
  );
  expect(typed.ok()).toBe(true);
  const typedResults = (await typed.json()).result.data as { name: string; upc: string | null }[];
  expect(typedResults.some((p) => p.name === existingName && p.upc === upcExisting)).toBe(true);

  const del = await page.request.post('/api/trpc/restock.deleteDraft', {
    data: { restockId },
  });
  expect(del.ok()).toBe(true);
});
