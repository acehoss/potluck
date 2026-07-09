import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { apiLogin, login } from './helpers';

/**
 * Phase 4 Round 3 (REWORK S5/S6 + A1–A8): reconcile draft sessions. Sessions
 * are one-per-household, so the two Playwright projects use DIFFERENT
 * households (chromium: aaron/Heise · webkit: dana/In-Laws — fully connected
 * both ways) and the file runs serially within a project. Ephemeral pantries/
 * restocks use unique names and are left behind (orders.spec convention);
 * sessions are always closed in finally blocks — an open DRAFT freezes stock.
 */

test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

type Api = Pick<APIRequestContext, 'get' | 'post'>;

/** tRPC POST as the api's signed-in user; raw envelope (status + body). */
async function rpc(api: Api, path: string, data: Record<string, unknown>) {
  const res = await api.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** POST and assert 200, returning result.data. */
async function ok(api: Api, path: string, data: Record<string, unknown>) {
  const r = await rpc(api, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)} → ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result.data;
}

/** GET and assert 200, returning result.data. */
async function queryOk(api: Api, path: string, input: Record<string, unknown>) {
  const res = await api.get(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  expect(res.ok(), `${path} ${JSON.stringify(input)}`).toBe(true);
  return (await res.json()).result.data;
}

/** Run a Node one-liner inside the app container (see connections.spec.ts). */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

/** The reconciling household's user per project (distinct households so the
 *  one-DRAFT-per-household rule never collides across parallel projects). */
const reconcilerOf = (project: string) => (project.includes('webkit') ? 'dana' : 'aaron');
const ordererOf = (project: string) => (project.includes('webkit') ? 'aaron' : 'dana');

async function ownHousehold(api: Api) {
  const ov = (await (await api.get('/api/trpc/household.overview')).json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; pantries: { id: string }[] }[];
  };
  return ov.households.find((h) => h.id === ov.yourHouseholdId)!;
}

/** Receive one finalized N-unit lot into the given pantry via the API. */
async function receiveLotApi(api: Api, pantryId: string, retailer: string, units: number) {
  const own = await ownHousehold(api);
  const created = await ok(api, 'restock.create', {
    pantryId,
    retailer,
    purchasedAt: new Date().toISOString().slice(0, 10),
    purchaserHouseholdId: own.id,
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
  const got = await queryOk(api, 'restock.get', { id: created.id });
  const lot = (got.lots as { id: string; stockId: string | null }[])[0];
  return { restockId: created.id as string, lotId: lot.id, stockId: lot.stockId! };
}

/** Abandon the household's open session if one exists (finally-block safety). */
async function abandonOpenSession(api: Api) {
  const open = await queryOk(api, 'reconcile.open', {});
  if (open?.sessionId) await rpc(api, 'reconcile.abandon', { sessionId: open.sessionId });
}

type SessionLine = {
  lineId: string;
  stockId: string;
  pantryId: string;
  lotId: string;
  countedCount: number | null;
  expectedCount: number;
  expectedReserved: number;
};

test('freeze cutoff: pickups ride through, free-stock mutations 412, abandon releases', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const owner = await apiLogin(reconcilerOf(P));
  const requester = await apiLogin(ordererOf(P));
  let sessionId: string | undefined;
  try {
    const pantry = (await ok(owner, 'pantry.create', { name: uniq('Freeze', P) })).id as string;
    const { lotId, stockId } = await receiveLotApi(owner, pantry, uniq('Freeze Beans', P), 5);

    // A counterparty order goes READY before the count starts.
    const cart = await ok(requester, 'order.addToCart', { pantryId: pantry, lotId, quantity: 2 });
    const orderId = cart.orderId as string;
    await ok(requester, 'order.submit', { orderId });
    await ok(owner, 'order.startPicking', { orderId });
    await ok(owner, 'order.markReady', { orderId });

    const session = await ok(owner, 'reconcile.create', { pantryIds: [pantry] });
    sessionId = session.sessionId as string;
    const line = (session.lines as SessionLine[]).find((l) => l.stockId === stockId)!;
    expect(line.expectedReserved).toBe(2);

    // One DRAFT per household.
    const dupe = await rpc(owner, 'reconcile.create', { pantryIds: [pantry] });
    expect(dupe.status).toBe(409);

    // Free-stock mutations are refused on frozen placements…
    const recount = await rpc(owner, 'adjustment.recount', { stockId, countAfter: 4 });
    expect(recount.status).toBe(412);
    // …but the promised pickup completes (cutoff model: count+reserved move
    // together, free stock — the count baseline — is untouched).
    await ok(requester, 'order.pickup', { orderId, clientKey: `e2e-rc-pick-${P}-${RUN}` });

    await ok(owner, 'reconcile.abandon', { sessionId });
    sessionId = undefined;
    await ok(owner, 'adjustment.recount', { stockId, countAfter: 3, clientKey: `e2e-rc-rec-${P}-${RUN}` });
  } finally {
    if (sessionId) await rpc(owner, 'reconcile.abandon', { sessionId });
    await abandonOpenSession(owner);
  }
});

test('commit: count-where-found derives a move; residual variance needs an ack', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const owner = await apiLogin(reconcilerOf(P));
  let sessionId: string | undefined;
  try {
    const pantryC = (await ok(owner, 'pantry.create', { name: uniq('Math C', P) })).id as string;
    const pantryD = (await ok(owner, 'pantry.create', { name: uniq('Math D', P) })).id as string;
    const { lotId, stockId } = await receiveLotApi(owner, pantryC, uniq('Math Rice', P), 5);

    // Session 1: 2 units physically live in D — count where found.
    let session = await ok(owner, 'reconcile.create', { pantryIds: [pantryC, pantryD] });
    sessionId = session.sessionId as string;
    session = await ok(owner, 'reconcile.addLine', { sessionId, lotId, pantryId: pantryD });
    const lines = session.lines as SessionLine[];
    const lineC = lines.find((l) => l.pantryId === pantryC && l.lotId === lotId)!;
    const lineD = lines.find((l) => l.pantryId === pantryD && l.lotId === lotId)!;
    await ok(owner, 'reconcile.count', { sessionId, lineId: lineC.lineId, counted: 3 });
    await ok(owner, 'reconcile.count', { sessionId, lineId: lineD.lineId, counted: 2 });
    const summary = await ok(owner, 'reconcile.commit', {
      sessionId,
      commitClientKey: `e2e-rc-c1-${P}-${RUN}`,
      acknowledgedVariances: [],
      rejectedMoveLots: [],
      shortageResolutions: [],
    });
    sessionId = undefined;
    expect(summary.moves).toBe(1);
    expect(summary.variances).toBe(0);

    // The derived transfer is marked as reconcile-inferred, counts applied.
    const history = (await queryOk(owner, 'transfer.listForHousehold', {})) as {
      toPantry: { id: string };
      unitSum: number;
    }[];
    expect(history.find((t) => t.toPantry.id === pantryD)?.unitSum).toBe(2);

    // Session 2: one unit genuinely missing — the variance must be acked.
    session = await ok(owner, 'reconcile.create', { pantryIds: [pantryC, pantryD] });
    sessionId = session.sessionId as string;
    const session2Id = sessionId;
    const lines2 = session.lines as SessionLine[];
    const lineC2 = lines2.find((l) => l.pantryId === pantryC && l.lotId === lotId)!;
    const lineD2 = lines2.find((l) => l.pantryId === pantryD && l.lotId === lotId)!;
    await ok(owner, 'reconcile.count', { sessionId, lineId: lineC2.lineId, counted: 2 });
    await ok(owner, 'reconcile.count', { sessionId, lineId: lineD2.lineId, counted: 2 });
    const unacked = await rpc(owner, 'reconcile.commit', {
      sessionId,
      commitClientKey: `e2e-rc-c2-${P}-${RUN}`,
      acknowledgedVariances: [],
      rejectedMoveLots: [],
      shortageResolutions: [],
    });
    expect(unacked.status).toBe(412);
    const acked = await ok(owner, 'reconcile.commit', {
      sessionId,
      commitClientKey: `e2e-rc-c3-${P}-${RUN}`,
      acknowledgedVariances: [{ lineId: lineC2.lineId, delta: -1 }],
      rejectedMoveLots: [],
      shortageResolutions: [],
    });
    sessionId = undefined;
    expect(acked.variances).toBe(1);

    // Commit replay returns the original summary, applies nothing twice.
    const replay = await ok(owner, 'reconcile.commit', {
      sessionId: session2Id,
      commitClientKey: `e2e-rc-c3-${P}-${RUN}`,
      acknowledgedVariances: [],
      rejectedMoveLots: [],
      shortageResolutions: [],
    });
    expect(replay.committed).toBe(true);
  } finally {
    if (sessionId) await rpc(owner, 'reconcile.abandon', { sessionId });
    await abandonOpenSession(owner);
  }
});

test('stale count: a pickup after counting forces a recount before commit', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const owner = await apiLogin(reconcilerOf(P));
  const requester = await apiLogin(ordererOf(P));
  let sessionId: string | undefined;
  try {
    const pantry = (await ok(owner, 'pantry.create', { name: uniq('Stale Pick', P) })).id as string;
    const { lotId } = await receiveLotApi(owner, pantry, uniq('Stale Beans', P), 5);
    const cart = await ok(requester, 'order.addToCart', { pantryId: pantry, lotId, quantity: 2 });
    const orderId = cart.orderId as string;
    await ok(requester, 'order.submit', { orderId });
    await ok(owner, 'order.startPicking', { orderId });
    await ok(owner, 'order.markReady', { orderId });

    const session = await ok(owner, 'reconcile.create', { pantryIds: [pantry] });
    sessionId = session.sessionId as string;
    const line = (session.lines as SessionLine[]).find((l) => l.lotId === lotId)!;

    // Counted with the reserved units still on the shelf…
    await ok(owner, 'reconcile.count', { sessionId, lineId: line.lineId, counted: 5 });
    // …then the pickup completes (the cutoff lets it through).
    await ok(requester, 'order.pickup', { orderId, clientKey: `e2e-rc-sp-${P}-${RUN}` });

    // Committing the stale 5 would restore the 2 picked-up units as a
    // phantom "found" variance — the server refuses instead.
    const staleCommit = await rpc(owner, 'reconcile.commit', {
      sessionId,
      commitClientKey: `e2e-rc-sc1-${P}-${RUN}`,
      acknowledgedVariances: [{ lineId: line.lineId, delta: 2 }],
      rejectedMoveLots: [],
      shortageResolutions: [],
    });
    expect(staleCommit.status).toBe(412);
    expect(JSON.stringify(staleCommit.body)).toContain('picked from after');

    // The payload flags the line for the UI.
    const refreshed = await queryOk(owner, 'reconcile.get', { sessionId });
    const flagged = (refreshed.lines as (SessionLine & { takenSinceCount: number })[]).find(
      (l) => l.lineId === line.lineId,
    )!;
    expect(flagged.takenSinceCount).toBeGreaterThan(0);

    // A recount clears it and the commit lands with no variance.
    await ok(owner, 'reconcile.count', { sessionId, lineId: line.lineId, counted: 3 });
    const committed = await ok(owner, 'reconcile.commit', {
      sessionId,
      commitClientKey: `e2e-rc-sc2-${P}-${RUN}`,
      acknowledgedVariances: [],
      rejectedMoveLots: [],
      shortageResolutions: [],
    });
    sessionId = undefined;
    expect(committed.variances).toBe(0);
  } finally {
    if (sessionId) await rpc(owner, 'reconcile.abandon', { sessionId });
    await abandonOpenSession(owner);
  }
});

test('pantry freeze: finalize-into and transfer-into a counted pantry are refused', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const owner = await apiLogin(reconcilerOf(P));
  let sessionId: string | undefined;
  try {
    const pantryF = (await ok(owner, 'pantry.create', { name: uniq('Frozen F', P) })).id as string;
    const pantryG = (await ok(owner, 'pantry.create', { name: uniq('Free G', P) })).id as string;
    await receiveLotApi(owner, pantryF, uniq('Frozen Peas', P), 2);
    const outside = await receiveLotApi(owner, pantryG, uniq('Free Corn', P), 3);

    const session = await ok(owner, 'reconcile.create', { pantryIds: [pantryF] });
    sessionId = session.sessionId as string;

    // A draft restock cannot finalize INTO the counted pantry (a brand-new
    // placement would land under the count, uncounted and unfrozen).
    const own = await ownHousehold(owner);
    const draft = await ok(owner, 'restock.create', {
      pantryId: pantryF,
      retailer: uniq('Frozen Draft', P),
      purchasedAt: new Date().toISOString().slice(0, 10),
      purchaserHouseholdId: own.id,
      receiptTotalCents: null,
    });
    await ok(owner, 'restock.saveLine', {
      restockId: draft.id,
      newProductName: uniq('Frozen Draft', P),
      purchasedCount: 1,
      receivedCount: 1,
      lineTotalCents: 100,
      bestBy: null,
    });
    const finalize = await rpc(owner, 'restock.finalize', {
      restockId: draft.id,
      acknowledgedVarianceCents: null,
    });
    expect(finalize.status).toBe(412);

    // A transfer whose DESTINATION is counted is refused the same way.
    const move = await rpc(owner, 'transfer.create', {
      fromPantryId: pantryG,
      toPantryId: pantryF,
      lines: [{ stockId: outside.stockId, quantity: 1 }],
    });
    expect(move.status).toBe(412);

    // Abandon lifts both.
    await ok(owner, 'reconcile.abandon', { sessionId });
    sessionId = undefined;
    await ok(owner, 'restock.finalize', { restockId: draft.id, acknowledgedVarianceCents: null });
    await ok(owner, 'transfer.create', {
      fromPantryId: pantryG,
      toPantryId: pantryF,
      lines: [{ stockId: outside.stockId, quantity: 1 }],
    });
  } finally {
    if (sessionId) await rpc(owner, 'reconcile.abandon', { sessionId });
    await abandonOpenSession(owner);
  }
});

test('lazy expiry: a 24h-idle draft self-abandons at the freeze and unblocks create', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const owner = await apiLogin(reconcilerOf(P));
  let sessionId: string | undefined;
  try {
    const pantry = (await ok(owner, 'pantry.create', { name: uniq('Stale', P) })).id as string;
    const { stockId } = await receiveLotApi(owner, pantry, uniq('Stale Salt', P), 2);
    const session = await ok(owner, 'reconcile.create', { pantryIds: [pantry] });
    sessionId = session.sessionId as string;

    // Frozen while fresh…
    const frozen = await rpc(owner, 'adjustment.recount', { stockId, countAfter: 1 });
    expect(frozen.status).toBe(412);

    // …age it 25h; the freeze check flips it ABANDONED and lets the write in.
    execInApp(
      `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace(/^file:/,''));` +
        `db.prepare("UPDATE ReconcileSession SET lastActivityAt = strftime('%Y-%m-%dT%H:%M:%S+00:00','now','-25 hours') WHERE id='${sessionId}'").run();`,
    );
    await ok(owner, 'adjustment.recount', {
      stockId,
      countAfter: 1,
      clientKey: `e2e-rc-stale-${P}-${RUN}`,
    });
    const open = await queryOk(owner, 'reconcile.open', {});
    expect(open).toBeNull();
    // A new count can start — the household is no longer locked.
    const next = await ok(owner, 'reconcile.create', { pantryIds: [pantry] });
    sessionId = next.sessionId as string;
  } finally {
    if (sessionId) await rpc(owner, 'reconcile.abandon', { sessionId });
    await abandonOpenSession(owner);
  }
});

test('UI walk: scope → banner → blind count → review → ack → commit summary', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const who = reconcilerOf(P);
  await login(page, who);
  const api = page.request;
  let sessionOpen = false;
  try {
    const pantry = (await ok(api, 'pantry.create', { name: uniq('Walk', P) })).id as string;
    const product = uniq('Walk Oats', P);
    await receiveLotApi(api, pantry, product, 4);

    await page.goto(`/pantries/${pantry}`);
    await page.getByTestId('reconcile-start').click();
    const sheet = page.getByTestId('scope-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByTestId('scope-begin').click();
    await expect(page.getByTestId('session-screen')).toBeVisible();
    sessionOpen = true;

    // The household banner points back at the session.
    await page.goto('/home');
    await expect(page.getByTestId('reconcile-banner')).toBeVisible();
    await page.getByTestId('banner-open').click();
    await expect(page.getByTestId('session-screen')).toBeVisible();

    // Blind count walk: blank field, count 3 of 4.
    const pantryCard = page.getByTestId('session-pantry');
    await expect(pantryCard).toBeVisible();
    await pantryCard.click();
    const lineRow = page.getByTestId('count-line').filter({ hasText: product });
    await expect(lineRow).toBeVisible();
    const input = lineRow.getByTestId('count-input');
    await expect(input).toHaveValue('');
    await input.fill('3');
    await input.press('Enter');
    await expect(input).toHaveValue('3');
    await expect(lineRow).toContainText('✓');

    await page.getByTestId('review-button').click();
    await expect(page.getByTestId('review-screen')).toBeVisible();
    const variance = page.getByTestId('variance-row').filter({ hasText: product });
    await expect(variance).toBeVisible();
    await expect(page.getByTestId('commit-button')).toBeDisabled();
    await variance.getByTestId('variance-ack').click();
    await page.getByTestId('commit-button').click();
    await expect(page.getByTestId('commit-summary')).toBeVisible();
    sessionOpen = false;

    // Banner gone, pantry shows the corrected count.
    await page.goto('/home');
    await expect(page.getByTestId('reconcile-banner')).toHaveCount(0);
    await page.goto(`/pantries/${pantry}`);
    await expect(
      page.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
    ).toContainText('3');
  } finally {
    if (sessionOpen) await abandonOpenSession(api);
  }
});
