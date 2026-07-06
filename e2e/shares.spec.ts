import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiLogin, login } from './helpers';

/**
 * Round 2 acceptance — needs & surpluses (REWORK F). Shares are GIFTS: the one
 * money-shaped side effect (a confirmed SURPLUS backed by lots) records $0
 * Takes and NEVER a LedgerEntry, so every test here that touches money asserts
 * the net between the two households is IDENTICAL before and after.
 *
 * Seed topology (prisma/seed.ts), all load-bearing:
 *   Heise    — aaron (Owner+admin), marie (Owner; also Adult in Neighbors),
 *              theo (Teen: postShares yes, fulfill NO)
 *   In-Laws  — dana (Owner)
 *   Neighbors— nia (Owner)
 *   Edges: Heise↔In-Laws ACTIVE full grants (incl. reshare); Heise↔Neighbors
 *          ACTIVE share-only (shareTo/shareFrom both ways, NO reshare);
 *          In-Laws↔Neighbors NOT connected.
 *
 * Rerun-safety: the suite runs twice per invocation (chromium then webkit)
 * against ONE accumulating DB, and must stay green re-run against a live
 * stack. So: per-run unique titles; every post created is driven WITHDRAWN in
 * a finally (feeds must not accumulate live posts) EXCEPT posts already driven
 * to FULFILLED (terminal, pruned from every foreign feed); money assertions
 * are before/after deltas that must come out ZERO.
 */

const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;
const TODAY = () => new Date().toISOString().slice(0, 10);

/** Either a Page's request context or a headless apiLogin context. */
type Api = Pick<APIRequestContext, 'get' | 'post'>;

type FeedPost = {
  id: string;
  type: 'NEED' | 'SURPLUS';
  title: string;
  quantity: number | null;
  unit: string | null;
  remaining: number | null;
  expiresAt: string; // ISO, origin-resolved
  status: 'OPEN' | 'CLAIMED' | 'FULFILLED' | 'EXPIRED';
  mine: boolean;
  isReshare: boolean;
  poster: { householdId: string; householdName: string };
  canReshare: boolean;
  hopsRemaining: number;
  myClaim: { id: string; status: string; quantity: number | null } | null;
  claims?: { id: string; householdName: string; quantity: number | null; status: string }[];
};

/** tRPC POST as the api's signed-in user; raw envelope (status + body). */
async function rpc(api: Api, path: string, data: Record<string, unknown>) {
  const res = await api.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** POST and assert 200, returning result.data. */
async function ok(api: Api, path: string, data: Record<string, unknown>) {
  const r = await rpc(api, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)}`).toBe(200);
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

/** The signed-in household's share board. */
async function feed(api: Api): Promise<FeedPost[]> {
  const res = await api.get('/api/trpc/share.feed');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data.posts as FeedPost[];
}

/** Find a post by id in the api's feed (undefined ⇒ not visible / pruned). */
async function inFeed(api: Api, postId: string): Promise<FeedPost | undefined> {
  return (await feed(api)).find((p) => p.id === postId);
}

/**
 * Receive one finalized `units`-count lot into the api's own pantry ($1.00/u,
 * no receipt total ⇒ no variance ⇒ auto-finalize; unitCostCents lands non-null
 * so the lot is shareable). Mirrors network.spec's receiveLotApi, parameterised
 * on unit count. `product` == retailer, so the pantry page product-total reads
 * this lot alone (per-run unique name).
 */
async function receiveLotApi(api: Api, retailer: string, units: number) {
  const data = await overview(api);
  const own = data.households.find((h) => h.id === data.yourHouseholdId)!;
  const pantryId = own.pantries[0].id;
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
    purchasedCount: units,
    receivedCount: units,
    lineTotalCents: units * 100,
    bestBy: null,
  });
  await ok(api, 'restock.finalize', { restockId: created.id, acknowledgedVarianceCents: null });
  const got = await api.get(
    `/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: created.id }))}`,
  );
  const lots = (await got.json()).result.data.lots as { id: string }[];
  return { pantryId, restockId: created.id, lotId: lots[0].id, product: retailer };
}

/**
 * Signed net (cents) with a SPECIFIC counterparty, read from /ledger?with=<id>
 * (Heise has two counterparties, so the pair must be named). Matches the
 * orders.spec net-hero parse.
 */
async function netWith(page: Page, counterpartyId: string): Promise<number> {
  await page.goto(`/ledger?with=${counterpartyId}`);
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

/** Availability (remaining − reserved) shown for a product on a pantry page. */
async function availability(page: Page, pantryId: string, product: string): Promise<number> {
  await page.goto(`/pantries/${pantryId}`);
  await expect(page.getByTestId('back-link')).toBeVisible(); // pantry detail rendered (Q6 BackLink)
  const row = page.getByTestId('product-row').filter({ hasText: product });
  // Zero-availability products are filtered off the pantry page entirely.
  if ((await row.count()) === 0) return 0;
  return Number(((await row.getByTestId('product-total').textContent()) ?? '0').trim());
}

/** Best-effort withdraw (idempotent server-side; already-terminal posts no-op). */
async function withdrawQuietly(api: Api | undefined, postId: string | undefined) {
  if (api && postId) await rpc(api, 'share.withdraw', { postId });
}

test('grant-scoped visibility: surplus reaches every share-connected household, never an unconnected one', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const aaron = page.request;
  const dana = await apiLogin('dana');
  const nia = await apiLogin('nia');
  const theo = await apiLogin('theo');

  let aId: string | undefined;
  let bId: string | undefined;
  let cId: string | undefined;
  try {
    // Aaron (Heise) posts an uncounted surplus.
    aId = (await ok(aaron, 'share.create', { type: 'SURPLUS', title: uniq('Aaron Surplus', P) })).id;

    // Dana sees it over the FULL edge; Nia sees it over the SHARE-ONLY edge —
    // the share-only edge's first positive exercise (shareTo+shareFrom suffice,
    // no pantry/reshare grant needed).
    const danaSaw = await inFeed(dana, aId!);
    expect(danaSaw, "In-Laws (full edge) sees Aaron's surplus").toBeTruthy();
    expect(danaSaw!.mine).toBe(false);
    expect(danaSaw!.poster.householdName).toBe('Heise');
    const niaSaw = await inFeed(nia, aId!);
    expect(niaSaw, "Neighbors (share-only edge) sees Aaron's surplus").toBeTruthy();
    expect(niaSaw!.mine).toBe(false);

    // Theo is a Heise member: visibility is HOUSEHOLD-level, so Aaron's post is
    // his household's — mine:true even though a different user authored it.
    const theoSaw = await inFeed(theo, aId!);
    expect(theoSaw, 'Theo (Heise member) sees the household post').toBeTruthy();
    expect(theoSaw!.mine).toBe(true);

    // Nia posts (Neighbors) and Dana posts (In-Laws) — an unconnected pair.
    bId = (await ok(nia, 'share.create', { type: 'SURPLUS', title: uniq('Nia Surplus', P) })).id;
    cId = (await ok(dana, 'share.create', { type: 'NEED', title: uniq('Dana Need', P) })).id;

    // In-Laws↔Neighbors have NO connection, so neither sees the other — both
    // directions of the unconnected pair.
    expect(await inFeed(dana, bId!), "In-Laws must not see Neighbors' post").toBeUndefined();
    expect(await inFeed(nia, cId!), "Neighbors must not see In-Laws' post").toBeUndefined();
  } finally {
    await withdrawQuietly(aaron, aId);
    await withdrawQuietly(nia, bId);
    await withdrawQuietly(dana, cId);
  }
});

test('uncounted lifecycle: single-claimant lock, release, and confirm→fulfilled prunes foreign feeds', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const aaron = page.request;
  const dana = await apiLogin('dana');
  const nia = await apiLogin('nia');

  let postId: string | undefined;
  try {
    postId = (await ok(aaron, 'share.create', { type: 'SURPLUS', title: uniq('Loaf', P) })).id;

    // Dana claims: an uncounted post flips OPEN→CLAIMED for everyone.
    const danaClaim = await ok(dana, 'share.claim', { postId });
    expect(danaClaim.status).toBe('PENDING');
    expect((await inFeed(dana, postId!))!.status).toBe('CLAIMED');
    expect((await inFeed(aaron, postId!))!.status).toBe('CLAIMED');

    // Nia loses the single-claimant race (guarded OPEN→CLAIMED already fired).
    const niaLost = await rpc(nia, 'share.claim', { postId });
    expect(niaLost.status, 'uncounted post is single-claimant — 409').toBe(409);
    // Dana claiming twice is rejected by the one-pending-per-household guard.
    const danaDup = await rpc(dana, 'share.claim', { postId });
    expect(danaDup.status, 'duplicate pending claim — 409').toBe(409);

    // Aaron releases Dana's claim → back to OPEN; Nia can now take it.
    const released = await ok(aaron, 'share.respond', { claimId: danaClaim.id, action: 'release' });
    expect(released.status).toBe('RELEASED');
    expect((await inFeed(aaron, postId!))!.status).toBe('OPEN');
    const niaClaim = await ok(nia, 'share.claim', { postId });
    expect(niaClaim.status).toBe('PENDING');

    // Aaron confirms Nia → FULFILLED (terminal). It is pruned from Dana's feed
    // (a foreign viewer only sees OPEN/CLAIMED), but Aaron still sees his own.
    const confirmed = await ok(aaron, 'share.respond', { claimId: niaClaim.id, action: 'confirm' });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(await inFeed(dana, postId!), 'fulfilled post leaves foreign feeds').toBeUndefined();
    const mineNow = await inFeed(aaron, postId!);
    expect(mineNow, 'poster still sees their fulfilled post').toBeTruthy();
    expect(mineNow!.status).toBe('FULFILLED');
    // Terminal → no withdraw needed (and withdraw would no-op anyway).
    postId = undefined;
  } finally {
    await withdrawQuietly(aaron, postId);
  }
});

test('counted multi-claim: several households claim concurrently, confirms draw down remaining', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const aaron = page.request;
  const dana = await apiLogin('dana');
  const nia = await apiLogin('nia');

  let postId: string | undefined;
  try {
    postId = (
      await ok(aaron, 'share.create', {
        type: 'SURPLUS',
        title: uniq('Jam', P),
        quantity: 10,
        unit: 'jars',
      })
    ).id;

    // Over-ask is rejected against the origin's remaining (BAD_REQUEST → 400,
    // per share.claim's "That's more than is left.").
    const overAsk = await rpc(dana, 'share.claim', { postId, quantity: 99 });
    expect(overAsk.status, 'over-ask a counted post — 400').toBe(400);

    // Two households claim concurrently; a counted post stays OPEN.
    const danaClaim = await ok(dana, 'share.claim', { postId, quantity: 4 });
    const niaClaim = await ok(nia, 'share.claim', { postId, quantity: 3 });
    const mine = await inFeed(aaron, postId!);
    expect(mine!.status).toBe('OPEN');
    expect(mine!.claims?.filter((c) => c.status === 'PENDING').length).toBe(2);

    // Confirms decrement the ORIGIN's remaining only; the post stays OPEN.
    await ok(aaron, 'share.respond', { claimId: danaClaim.id, action: 'confirm' });
    expect((await inFeed(aaron, postId!))!.remaining).toBe(6);
    await ok(aaron, 'share.respond', { claimId: niaClaim.id, action: 'confirm' });
    const after = await inFeed(aaron, postId!);
    expect(after!.remaining).toBe(3);
    expect(after!.status, 'still open with 3 left').toBe('OPEN');
  } finally {
    await withdrawQuietly(aaron, postId);
  }
});

test('$0 gift transfer: confirming a lot-backed surplus moves stock, never money, and honors reservations', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  // Aaron is the browser user (reads availability of Dana's granted pantry, and
  // the Heise↔In-Laws ledger net). Dana + Marie drive via headless API.
  await login(page, 'aaron');
  const aaron = page.request;
  const dana = await apiLogin('dana');
  const marie = await apiLogin('marie'); // defaults to Heise (same household as Aaron)

  const inLawsId = overview(aaron).then(
    (d) => d.households.find((h) => h.name === 'In-Laws')!.id,
  );

  let postId: string | undefined;
  let orderId: string | undefined;
  try {
    // Dana stocks a 5-unit lot and posts it as a counted surplus.
    const lot = await receiveLotApi(dana, uniq('Gift Pears', P), 5);
    postId = (
      await ok(dana, 'share.create', {
        type: 'SURPLUS',
        title: uniq('Pears', P),
        quantity: 5,
        unit: 'each',
        lotIds: [lot.lotId],
      })
    ).id;

    const netBefore = await netWith(page, await inLawsId);
    expect(await availability(page, lot.pantryId, lot.product)).toBe(5);

    // Aaron claims 2; Dana (Owner → has fulfill) confirms → $0 gift of 2 units.
    const aaronClaim = await ok(aaron, 'share.claim', { postId, quantity: 2 });
    const conf1 = await ok(dana, 'share.respond', { claimId: aaronClaim.id, action: 'confirm' });
    expect(conf1.gifted).toBe(2);
    // Physical stock drops 5→3; money did NOT move (gifts never post a ledger).
    expect(await availability(page, lot.pantryId, lot.product)).toBe(3);
    expect(await netWith(page, await inLawsId), 'a gift moves no money').toBe(netBefore);

    // Reservation interplay: Aaron reserves the remaining 3 units via an ORDER,
    // then Marie (Heise) claims the post's remaining 3. Confirming her claim
    // must NOT cannibalize the reservation → 409.
    const probe = await rpc(aaron, 'order.addToCart', {
      pantryId: lot.pantryId,
      lotId: lot.lotId,
      quantity: 1,
    });
    if (probe.status === 200) {
      await rpc(aaron, 'order.cancel', { orderId: probe.body.result.data.orderId });
    }
    const cart = await ok(aaron, 'order.addToCart', {
      pantryId: lot.pantryId,
      lotId: lot.lotId,
      quantity: 3,
    });
    orderId = cart.orderId;
    await ok(aaron, 'order.submit', { orderId });
    expect(await availability(page, lot.pantryId, lot.product), 'reserved → 0 available').toBe(0);

    const marieClaim = await ok(marie, 'share.claim', { postId, quantity: 3 });
    const blocked = await rpc(dana, 'share.respond', { claimId: marieClaim.id, action: 'confirm' });
    expect(blocked.status, 'gift cannot draw down reserved stock — 409').toBe(409);

    // Release the reservation; the same confirm now succeeds and empties the lot.
    await ok(aaron, 'order.cancel', { orderId });
    orderId = undefined;
    const conf2 = await ok(dana, 'share.respond', { claimId: marieClaim.id, action: 'confirm' });
    expect(conf2.gifted).toBe(3);
    expect(await availability(page, lot.pantryId, lot.product)).toBe(0);

    // The whole exchange moved goods twice and money zero times.
    expect(await netWith(page, await inLawsId), 'still even after two gifts').toBe(netBefore);
    postId = undefined; // FULFILLED (remaining hit 0) — terminal
  } finally {
    if (orderId) await rpc(aaron, 'order.cancel', { orderId });
    await withdrawQuietly(dana, postId);
  }
});

test('reshare chain: anonymized copy, hard hop-stop, grant-gated resharing, subtree withdrawal', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const aaron = page.request;
  const dana = await apiLogin('dana');
  const nia = await apiLogin('nia');

  let originId: string | undefined;
  try {
    const inLawsId = (await overview(dana)).yourHouseholdId;

    // Aaron posts a 1-hop surplus; Dana (full edge, reshare granted) reshares.
    originId = (
      await ok(aaron, 'share.create', {
        type: 'SURPLUS',
        title: uniq('Reshare Rye', P),
        hopsAllowance: 1,
      })
    ).id;
    const copyId = (await ok(dana, 'share.reshare', { postId: originId })).id;

    // (a) The copy shows in Dana's own feed as hers, marked a reshare.
    const danaCopy = await inFeed(dana, copyId);
    expect(danaCopy, 'resharer sees their copy').toBeTruthy();
    expect(danaCopy!.mine).toBe(true);
    expect(danaCopy!.isReshare).toBe(true);

    // Anonymization holds even facing the ORIGIN household: Aaron sees the copy
    // attributed to In-Laws (the resharer), isReshare true — never back to Heise.
    const aaronSeesCopy = await inFeed(aaron, copyId);
    expect(aaronSeesCopy, 'origin household sees the copy too').toBeTruthy();
    expect(aaronSeesCopy!.isReshare).toBe(true);
    expect(aaronSeesCopy!.poster.householdId).toBe(inLawsId);
    expect(aaronSeesCopy!.poster.householdName).toBe('In-Laws');

    // (b) Hard hop-stop: the copy has 0 hops left and is not reshareable anywhere.
    expect(aaronSeesCopy!.hopsRemaining).toBe(0);
    expect(aaronSeesCopy!.canReshare).toBe(false);
    expect(danaCopy!.canReshare).toBe(false);

    // (c) Nia CAN see the origin (share-only edge) but the edge lacks reshare →
    // 403 (grant gate, not a hop/existence issue).
    const niaReshare = await rpc(nia, 'share.reshare', { postId: originId });
    expect(niaReshare.status, 'share-only edge cannot reshare — 403').toBe(403);

    // (d) Resharing the exhausted copy fails on the hop cap. In-Laws grants Heise
    // reshare (full edge), so the grant check passes and the hopsRemaining<=0
    // guard is what fires → 409 (not 403).
    const aaronReshareCopy = await rpc(aaron, 'share.reshare', { postId: copyId });
    expect(aaronReshareCopy.status, 'hops exhausted — 409').toBe(409);

    // (e) Withdrawing the ORIGIN takes the whole reshare subtree with it: Dana's
    // copy leaves her feed.
    await ok(aaron, 'share.withdraw', { postId: originId });
    expect(await inFeed(dana, copyId!), 'subtree withdrawn with the origin').toBeUndefined();
    originId = undefined;
  } finally {
    await withdrawQuietly(aaron, originId);
  }
});

test('capability gate: postShares can claim, but confirming a claim needs fulfill', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const aaron = page.request;
  const dana = await apiLogin('dana');
  const theo = await apiLogin('theo'); // Teen: postShares yes, fulfill NO

  let danaPost: string | undefined;
  let aaronPost: string | undefined;
  try {
    // Theo has postShares → he can CLAIM a visible post (Dana's).
    danaPost = (await ok(dana, 'share.create', { type: 'SURPLUS', title: uniq('Dana Eggs', P) })).id;
    const theoClaim = await rpc(theo, 'share.claim', { postId: danaPost });
    expect(theoClaim.status, 'postShares may claim').toBe(200);

    // But confirming a claim on his OWN household's post needs fulfill, which
    // the Teen preset withholds → 403 (an Owner on the same post → 200).
    aaronPost = (await ok(aaron, 'share.create', { type: 'SURPLUS', title: uniq('Heise Kale', P) })).id;
    const danaClaim = await ok(dana, 'share.claim', { postId: aaronPost });
    const theoConfirm = await rpc(theo, 'share.respond', {
      claimId: danaClaim.id,
      action: 'confirm',
    });
    expect(theoConfirm.status, 'no fulfill capability — 403').toBe(403);
    const aaronConfirm = await rpc(aaron, 'share.respond', {
      claimId: danaClaim.id,
      action: 'confirm',
    });
    expect(aaronConfirm.status, 'Owner has fulfill — 200').toBe(200);
    aaronPost = undefined; // FULFILLED (uncounted origin confirmed) — terminal
  } finally {
    await withdrawQuietly(dana, danaPost);
    await withdrawQuietly(aaron, aaronPost);
  }
});

test('expiry defaults: SURPLUS +3d, NEED +14d, and the 60-day ceiling is enforced', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  await login(page, 'aaron');
  const aaron = page.request;

  let surplusId: string | undefined;
  let needId: string | undefined;
  try {
    // No explicit expiry → the router applies the F1 defaults.
    const now = Date.now();
    surplusId = (await ok(aaron, 'share.create', { type: 'SURPLUS', title: uniq('Def Surplus', P) })).id;
    needId = (await ok(aaron, 'share.create', { type: 'NEED', title: uniq('Def Need', P) })).id;

    const DAY = 24 * 60 * 60 * 1000;
    const surplus = await inFeed(aaron, surplusId!);
    const need = await inFeed(aaron, needId!);
    // Wide tolerance (1h) absorbs test-execution drift; the point is 3d vs 14d.
    const surplusDays = (Date.parse(surplus!.expiresAt) - now) / DAY;
    const needDays = (Date.parse(need!.expiresAt) - now) / DAY;
    expect(surplusDays).toBeGreaterThan(3 - 1 / 24);
    expect(surplusDays).toBeLessThan(3 + 1 / 24);
    expect(needDays).toBeGreaterThan(14 - 1 / 24);
    expect(needDays).toBeLessThan(14 + 1 / 24);

    // The ceiling: an expiry beyond 60 days is rejected (F1 hygiene → 400).
    const tooFar = new Date(now + 61 * DAY).toISOString();
    const rejected = await rpc(aaron, 'share.create', {
      type: 'SURPLUS',
      title: uniq('Too Far', P),
      expiresAt: tooFar,
    });
    expect(rejected.status, 'expiry past the 60-day cap — 400').toBe(400);
  } finally {
    await withdrawQuietly(aaron, surplusId);
    await withdrawQuietly(aaron, needId);
  }
});

test('reshare gift semantics: a broker confirm moves nothing; goods flow only when the broker claims upstream', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  // F4: confirming a claim on a downstream COPY decrements/gifts NOTHING from
  // the origin — a broker sources goods by claiming the origin themselves.
  await login(page, 'aaron');
  const aaron = page.request;
  const dana = await apiLogin('dana');
  const marie = await apiLogin('marie'); // Heise — the only household that can see In-Laws' copy

  const inLawsId = overview(aaron).then((d) => d.households.find((h) => h.name === 'In-Laws')!.id);

  let originId: string | undefined;
  try {
    // Aaron owns a 5-unit lot and offers it as a counted surplus (the origin).
    const lot = await receiveLotApi(aaron, uniq('Broker Beans', P), 5);
    originId = (
      await ok(aaron, 'share.create', {
        type: 'SURPLUS',
        title: uniq('Broker Surplus', P),
        quantity: 5,
        unit: 'each',
        lotIds: [lot.lotId],
      })
    ).id;
    const netBefore = await netWith(page, await inLawsId);
    expect(await availability(page, lot.pantryId, lot.product)).toBe(5);

    // Dana reshares; Marie (Heise) claims 2 of the anonymized COPY.
    const copyId = (await ok(dana, 'share.reshare', { postId: originId })).id;
    const marieClaim = await ok(marie, 'share.claim', { postId: copyId, quantity: 2 });

    // The broker (Dana) confirms the copy-claim: gifts 0, and the ORIGIN's
    // remaining and physical stock are untouched — nothing flows from Aaron.
    const brokerConfirm = await ok(dana, 'share.respond', {
      claimId: marieClaim.id,
      action: 'confirm',
    });
    expect(brokerConfirm.gifted, 'a copy confirm gifts nothing (F4)').toBe(0);
    expect((await inFeed(aaron, originId!))!.remaining, 'origin remaining untouched').toBe(5);
    expect(await availability(page, lot.pantryId, lot.product), 'origin stock untouched').toBe(5);

    // Goods move only when the broker sources UPSTREAM: Dana claims the origin,
    // Aaron confirms → $0 gift of 3 to In-Laws, origin draws down 5→2.
    const danaUpstream = await ok(dana, 'share.claim', { postId: originId, quantity: 3 });
    const originConfirm = await ok(aaron, 'share.respond', {
      claimId: danaUpstream.id,
      action: 'confirm',
    });
    expect(originConfirm.gifted).toBe(3);
    expect((await inFeed(aaron, originId!))!.remaining).toBe(2);
    expect(await availability(page, lot.pantryId, lot.product)).toBe(2);
    // Two confirms, one of them a real transfer — and still no money moved.
    expect(await netWith(page, await inLawsId), 'gifts never post a ledger').toBe(netBefore);
  } finally {
    await withdrawQuietly(aaron, originId); // cascades the reshare subtree
  }
});

test('UI smoke: compose a surplus, claim it, confirm it, watch it reach FULFILLED', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const title = uniq('UI Cukes', P);

  // Aaron composes a counted surplus (quantity 1). The Neighbors dashboard's
  // shares section links into /shares, where the composer lives (Round-E IA
  // flip — the old home strip retired).
  await login(page, 'aaron');
  await page.getByTestId('neighbors-shares-all').click();
  await expect(page).toHaveURL(/\/shares$/);
  await page.getByTestId('share-compose-open').click();
  await expect(page.getByTestId('share-compose-sheet')).toBeVisible();
  await page.getByTestId('share-type-surplus').click();
  await page.getByTestId('share-title').fill(title);
  await page.getByTestId('share-qty').fill('1'); // enables the unit field
  await page.getByTestId('share-unit').fill('each');
  await page.getByTestId('share-compose-submit').click();
  await expect(page.getByTestId('share-compose-sheet')).toBeHidden();
  // A fresh post is OPEN — the row renders but shows no status chip (the chip
  // only appears once status leaves OPEN).
  const aaronRow = page.getByTestId('share-row').filter({ hasText: title });
  await expect(aaronRow).toBeVisible();

  // Dana (full edge) claims the single unit through the UI.
  const danaCtx = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  });
  try {
    const dana = await danaCtx.newPage();
    await login(dana, 'dana');
    await dana.goto('/shares');
    const danaRow = dana.getByTestId('share-row').filter({ hasText: title });
    await danaRow.getByTestId('share-claim-open').click();
    await expect(dana.getByTestId('share-claim-sheet')).toBeVisible();
    await dana.getByTestId('share-claim-qty').fill('1');
    await dana.getByTestId('share-claim-submit').click();
    // A counted post stays OPEN under a claim; the registered claim shows as the
    // cancel affordance rather than a status chip.
    await expect(danaRow.getByTestId('share-claim-cancel')).toBeVisible();

    // Aaron confirms Dana's claim → remaining 1→0 → FULFILLED.
    await page.reload();
    await aaronRow.getByTestId('share-confirm').first().click();
    await expect(aaronRow.getByTestId('share-status')).toHaveText(/fulfilled/i);
  } finally {
    await danaCtx.close();
    // Belt for a partial-failure run: sweep any still-live post by this run's
    // unique title so it can't accumulate in Aaron's feed across reruns.
    for (const p of await feed(page.request)) {
      if (p.mine && p.title === title && p.status !== 'FULFILLED') {
        await rpc(page.request, 'share.withdraw', { postId: p.id });
      }
    }
  }
});
