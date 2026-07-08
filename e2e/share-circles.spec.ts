import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { apiLogin, login } from './helpers';

/**
 * Share circle scoping acceptance. These tests deliberately target the public
 * testid/API contract from /tmp/share-circles/e2e-spec.md; setup stays local to
 * per-run share posts and never mutates the shared circle/connection fixtures.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

type Api = Pick<APIRequestContext, 'get' | 'post'>;

type GrantSet = {
  pantry: boolean;
  lending: boolean;
  recipes: boolean;
  shareTo: boolean;
  shareFrom: boolean;
  reshare: boolean;
};

type FeedPost = {
  id: string;
  type: 'NEED' | 'SURPLUS';
  title: string;
  quantity: number | null;
  unit: string | null;
  remaining: number | null;
  expiresAt: string;
  status: 'OPEN' | 'CLAIMED' | 'FULFILLED' | 'EXPIRED';
  visibility: 'ALL' | 'SELECT';
  mine: boolean;
  isReshare: boolean;
  poster: { householdId: string; householdName: string };
  canReshare: boolean;
  hopsRemaining: number;
  myClaim: { id: string; status: string; quantity: number | null } | null;
  claims?: { id: string; householdName: string; quantity: number | null; status: string }[];
};

type Connection = {
  id: string;
  counterparty: { id: string; name: string; slug: string };
  status: 'PENDING' | 'ACTIVE' | 'SEVERED';
  requestedByUs: boolean;
  myCircle: { id: string; name: string; grants: GrantSet } | null;
  theyGrant: GrantSet;
};

type CircleName = { id: string; name: string; shareTo: boolean };
type RpcEnvelope<T> = {
  result?: { data?: T };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};
type RpcResult = { status: number; body: RpcEnvelope<unknown> | null };

async function rpc(api: Api, path: string, data: Record<string, unknown>): Promise<RpcResult> {
  const res = await api.post(`/api/trpc/${path}`, { data });
  const body = (await res.json().catch(() => null)) as RpcEnvelope<unknown> | null;
  return { status: res.status(), body };
}

async function ok<T>(api: Api, path: string, data: Record<string, unknown>): Promise<T> {
  const r = await rpc(api, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)} -> ${JSON.stringify(r.body)}`).toBe(200);
  const out = r.body?.result?.data;
  if (out === undefined) throw new Error(`missing tRPC result for ${path}`);
  return out as T;
}

function expectRpcError(r: RpcResult, status: number, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body?.error?.data?.httpStatus ?? r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body?.error?.data?.code, JSON.stringify(r.body)).toBe(code);
}

async function feed(api: Api): Promise<FeedPost[]> {
  const res = await api.get('/api/trpc/share.feed');
  expect(res.ok(), `share.feed -> ${res.status()}`).toBe(true);
  const body = (await res.json()) as RpcEnvelope<{ posts: FeedPost[] }>;
  return body.result!.data!.posts;
}

async function inFeed(api: Api, postId: string): Promise<FeedPost | undefined> {
  return (await feed(api)).find((p) => p.id === postId);
}

async function postByTitle(api: Api, title: string): Promise<FeedPost> {
  await expect
    .poll(async () => (await feed(api)).find((p) => p.title === title)?.id ?? null, {
      message: `post ${title} should appear in the actor's feed`,
    })
    .not.toBeNull();
  const post = (await feed(api)).find((p) => p.title === title);
  if (!post) throw new Error(`could not find post titled ${title}`);
  return post;
}

async function circleNames(api: Api): Promise<CircleName[]> {
  const res = await api.get('/api/trpc/circle.names');
  expect(res.ok(), `circle.names -> ${res.status()}`).toBe(true);
  const body = (await res.json()) as RpcEnvelope<{ circles: CircleName[] }>;
  return body.result!.data!.circles;
}

async function connectionList(api: Api): Promise<Connection[]> {
  const res = await api.get('/api/trpc/connection.list');
  expect(res.ok(), `connection.list -> ${res.status()}`).toBe(true);
  const body = (await res.json()) as RpcEnvelope<{ connections: Connection[] }>;
  return body.result!.data!.connections;
}

async function myCircleFor(api: Api, counterpartyName: string) {
  const conn = (await connectionList(api)).find(
    (c) => c.counterparty.name === counterpartyName && c.status === 'ACTIVE',
  );
  if (!conn) throw new Error(`no ACTIVE connection with ${counterpartyName}`);
  if (!conn.myCircle) throw new Error(`connection with ${counterpartyName} has no caller-side circle`);
  expect(conn.myCircle.grants.shareTo, `${counterpartyName} circle should be shareable`).toBe(true);
  return conn.myCircle;
}

async function createSurplus(
  api: Api,
  title: string,
  opts: {
    circleIds?: string[];
    quantity?: number;
    unit?: string;
    hopsAllowance?: number;
  } = {},
) {
  return (
    await ok<{ id: string }>(api, 'share.create', {
      type: 'SURPLUS',
      title,
      ...opts,
    })
  ).id;
}

async function withdrawQuietly(api: Api | undefined, postId: string | undefined) {
  if (api && postId) await rpc(api, 'share.withdraw', { postId });
}

async function openShares(page: Page) {
  await page.goto('/shares');
  await expect(page.getByTestId('share-compose-open')).toBeVisible();
}

async function chooseSelectAudience(page: Page) {
  const select = page.getByTestId('share-audience-mode-select');
  await expect(select).toBeVisible();
  if ((await select.getAttribute('type')) === 'radio') await select.check();
  else await select.click();
}

// STRICT contract selector: `share-audience-circle` is the row (a label
// wrapping the checkbox + circle name). No fallbacks — a contract drift
// should fail loudly here, not be papered over.
function audienceCircle(page: Page, circleName: string): Locator {
  return page.getByTestId('share-audience-circle').filter({ hasText: circleName });
}

async function checkAudienceCircle(page: Page, circleName: string) {
  const row = audienceCircle(page, circleName);
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();
}

async function audienceRowTexts(page: Page) {
  const rows = page.getByTestId('share-audience-circle');
  await expect(rows.first()).toBeVisible();
  return (await rows.allTextContents()).map((t) => t.trim()).filter(Boolean);
}

async function composeScopedSurplus(page: Page, title: string, circleName: string) {
  await openShares(page);
  await page.getByTestId('share-compose-open').click();
  await expect(page.getByTestId('share-compose-sheet')).toBeVisible();
  await page.getByTestId('share-type-surplus').click();
  await page.getByTestId('share-title').fill(title);
  await chooseSelectAudience(page);
  await checkAudienceCircle(page, circleName);
  await page.getByTestId('share-compose-submit').click();
  await expect(page.getByTestId('share-compose-sheet')).toBeHidden();
}

test.describe('share circle scoping', () => {
  test('scoped composer post reaches the chosen circle only', async ({ page }, testInfo) => {
    const P = testInfo.project.name;
    await login(page, 'aaron');
    const aaron = page.request;
    const dana = await apiLogin('dana');
    const nia = await apiLogin('nia');
    const inLawsCircle = await myCircleFor(aaron, 'In-Laws');

    const scopedTitle = uniq('Scoped surplus', P);
    const allTitle = uniq('All surplus control', P);
    let scopedId: string | undefined;
    let allId: string | undefined;
    try {
      await composeScopedSurplus(page, scopedTitle, inLawsCircle.name);
      scopedId = (await postByTitle(aaron, scopedTitle)).id;
      allId = await createSurplus(aaron, allTitle);

      expect(await inFeed(dana, scopedId), 'In-Laws should see the scoped post').toBeTruthy();
      expect(await inFeed(nia, scopedId), 'Neighbors should not see the scoped post').toBeUndefined();
      expect(await inFeed(nia, allId), 'Neighbors should see an ALL control post').toBeTruthy();

      const ownRow = page.getByTestId('share-row').filter({ hasText: scopedTitle });
      await expect(ownRow).toBeVisible();
      await expect(ownRow.getByTestId('share-limited-chip')).toBeVisible();
    } finally {
      await withdrawQuietly(aaron, scopedId);
      await withdrawQuietly(aaron, allId);
    }
  });

  test('excluded household gets a 404 on direct claim', async ({}, testInfo) => {
    const P = testInfo.project.name;
    const aaron = await apiLogin('aaron');
    const nia = await apiLogin('nia');
    const inLawsCircle = await myCircleFor(aaron, 'In-Laws');

    let postId: string | undefined;
    try {
      postId = await createSurplus(aaron, uniq('Scoped 404 surplus', P), {
        circleIds: [inLawsCircle.id],
      });
      expectRpcError(await rpc(nia, 'share.claim', { postId }), 404, 'NOT_FOUND');
    } finally {
      await withdrawQuietly(aaron, postId);
    }
  });

  test('in-scope claim and handoff complete like an all-share', async ({
    page,
    browser,
  }, testInfo) => {
    const P = testInfo.project.name;
    await login(page, 'aaron');
    const aaron = page.request;
    const inLawsCircle = await myCircleFor(aaron, 'In-Laws');
    const title = uniq('Scoped claim cukes', P);

    let postId: string | undefined;
    const danaCtx = await browser.newContext({ baseURL: BASE });
    try {
      postId = await createSurplus(aaron, title, {
        circleIds: [inLawsCircle.id],
        quantity: 1,
        unit: 'each',
      });

      await openShares(page);
      const aaronRow = page.getByTestId('share-row').filter({ hasText: title });
      await expect(aaronRow).toBeVisible();
      await expect(aaronRow.getByTestId('share-limited-chip')).toBeVisible();

      const dana = await danaCtx.newPage();
      await login(dana, 'dana');
      await dana.goto('/shares');
      const danaRow = dana.getByTestId('share-row').filter({ hasText: title });
      await expect(danaRow).toBeVisible();
      await danaRow.getByTestId('share-claim-open').click();
      await expect(dana.getByTestId('share-claim-sheet')).toBeVisible();
      await dana.getByTestId('share-claim-qty').fill('1');
      await dana.getByTestId('share-claim-submit').click();
      await expect(danaRow.getByTestId('share-claim-cancel')).toBeVisible();

      await page.reload();
      await aaronRow.getByTestId('share-confirm').first().click();
      await expect(aaronRow.getByTestId('share-status')).toHaveText(/fulfilled/i);
      postId = undefined;
    } finally {
      await danaCtx.close();
      await withdrawQuietly(aaron, postId);
    }
  });

  test('scoped posts are not resharable', async ({ page }, testInfo) => {
    const P = testInfo.project.name;
    const aaron = await apiLogin('aaron');
    await login(page, 'dana');
    const dana = page.request;
    const inLawsCircle = await myCircleFor(aaron, 'In-Laws');

    const allTitle = uniq('Reshare all control', P);
    const scopedTitle = uniq('Reshare scoped surplus', P);
    let allId: string | undefined;
    let scopedId: string | undefined;
    try {
      allId = await createSurplus(aaron, allTitle, { hopsAllowance: 1 });
      scopedId = await createSurplus(aaron, scopedTitle, {
        circleIds: [inLawsCircle.id],
        hopsAllowance: 1,
      });

      const allPost = await inFeed(dana, allId);
      const scopedPost = await inFeed(dana, scopedId);
      expect(allPost?.canReshare, 'full-grant ALL post should be resharable').toBe(true);
      expect(scopedPost?.canReshare, 'SELECT post should suppress canReshare').toBe(false);

      await openShares(page);
      const allRow = page.getByTestId('share-row').filter({ hasText: allTitle });
      const scopedRow = page.getByTestId('share-row').filter({ hasText: scopedTitle });
      await expect(allRow.getByTestId('share-reshare')).toBeVisible();
      await expect(scopedRow.getByTestId('share-reshare')).toHaveCount(0);

      expectRpcError(await rpc(dana, 'share.reshare', { postId: scopedId }), 409, 'CONFLICT');
    } finally {
      await withdrawQuietly(aaron, allId);
      await withdrawQuietly(aaron, scopedId);
    }
  });

  test('composer audience list is shareTo-only', async ({ page }) => {
    await login(page, 'aaron');
    const circles = await circleNames(page.request);
    const shareToNames = circles.filter((c) => c.shareTo).map((c) => c.name);
    const blockedNames = circles.filter((c) => !c.shareTo).map((c) => c.name);

    await openShares(page);
    await page.getByTestId('share-compose-open').click();
    await expect(page.getByTestId('share-compose-sheet')).toBeVisible();
    await chooseSelectAudience(page);

    const rows = await audienceRowTexts(page);
    const rowText = rows.join('\n');
    expect(rows.length, 'share audience rows').toBeGreaterThan(0);
    expect(rowText).toContain('Neighbors');
    expect(rowText).toContain('Friends');
    expect(rowText).toContain('Family');
    for (const row of rows) {
      expect(
        shareToNames.some((name) => row.includes(name)),
        `audience row must name a shareTo circle: ${row}`,
      ).toBe(true);
      for (const blocked of blockedNames) {
        expect(row, `non-shareTo circle should not be offered: ${blocked}`).not.toContain(blocked);
      }
    }
  });
});
