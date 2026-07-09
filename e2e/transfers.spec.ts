import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { apiLogin, login } from './helpers';

/**
 * Phase 4 Round 2 (REWORK S3/S4): pantry-to-pantry transfer + per-line receive
 * splits. The demo seed gives every household ONE pantry, so both features are
 * gated off by default — each test that needs them creates an ephemeral second
 * Heise pantry (+ an ephemeral restock) and SQL-drops everything in FK order
 * (Transfer before Stock — TransferLine RESTRICTs placements; Stock before
 * Restock — Stock RESTRICTs lots).
 */

const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

type Api = Pick<APIRequestContext, 'get' | 'post'>;

/** Run a Node one-liner inside the app container (see connections.spec.ts). */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

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

/** The signed-in user's own first pantry id (the seeded one). */
async function ownPantryId(api: Api): Promise<string> {
  const ov = (await (await api.get('/api/trpc/household.overview')).json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; pantries: { id: string }[] }[];
  };
  return ov.households.find((h) => h.id === ov.yourHouseholdId)!.pantries[0].id;
}

/**
 * Receive one finalized N-unit lot into the given pantry via the API; returns
 * lot + its placement in that pantry (restock.get exposes stockId post-R1).
 */
async function receiveLotApi(api: Api, pantryId: string, retailer: string, units: number) {
  const ov = (await (await api.get('/api/trpc/household.overview')).json()).result.data as {
    yourHouseholdId: string;
  };
  const created = await ok(api, 'restock.create', {
    pantryId,
    retailer,
    purchasedAt: new Date().toISOString().slice(0, 10),
    purchaserHouseholdId: ov.yourHouseholdId,
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

/** SQL cleanup in FK order; every id is a cuid/deterministic id we minted. */
function cleanup(opts: { orderIds?: string[]; pantryIds?: string[]; restockIds?: string[] }) {
  const stmts: string[] = [];
  for (const id of opts.orderIds ?? []) {
    stmts.push(`db.prepare("DELETE FROM \\"Order\\" WHERE id='${id}'").run();`);
  }
  for (const id of opts.pantryIds ?? []) {
    stmts.push(
      `db.prepare("DELETE FROM Transfer WHERE fromPantryId='${id}' OR toPantryId='${id}'").run();`,
    );
  }
  for (const id of opts.restockIds ?? []) {
    stmts.push(
      `db.prepare("DELETE FROM Stock WHERE lotId IN (SELECT id FROM Lot WHERE restockId='${id}')").run();`,
      `db.prepare("DELETE FROM Restock WHERE id='${id}'").run();`,
    );
  }
  for (const id of opts.pantryIds ?? []) {
    stmts.push(
      `db.prepare("DELETE FROM Stock WHERE pantryId='${id}'").run();`,
      `db.prepare("DELETE FROM PantryCircle WHERE pantryId='${id}'").run();`,
      `db.prepare("DELETE FROM Pantry WHERE id='${id}'").run();`,
    );
  }
  if (stmts.length) {
    execInApp(
      `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace(/^file:/,''));` +
        stmts.join(''),
    );
  }
}

test.describe('pantry transfers + receive splits', () => {
  test('single-pantry household shows no move entry points', async ({ page }) => {
    // nia's household keeps exactly one pantry — the transfer/reconcile specs
    // add pantries to aaron's and dana's households, so those can't gate this.
    await login(page, 'nia');
    const pantryId = await ownPantryId(page.request);
    await page.goto(`/pantries/${pantryId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('move-items-button')).toHaveCount(0);
  });

  test('move flow: lot menu seeds the cart, confirm moves units A→B', async ({ page }, testInfo) => {
    await login(page, 'aaron');
    const api = page.request;
    const pantryA = await ownPantryId(api);
    let pantryB: string | undefined;
    let restockId: string | undefined;
    try {
      pantryB = (await ok(api, 'pantry.create', { name: uniq('Move Dest', testInfo.project.name) }))
        .id as string;
      const product = uniq('Move Beans', testInfo.project.name);
      const received = await receiveLotApi(api, pantryA, product, 5);
      restockId = received.restockId;

      await page.goto(`/pantries/${pantryA}`);
      const row = page.getByTestId('product-row').filter({ hasText: product });
      if ((await row.getByTestId('lot-menu').count()) === 0) {
        await row.getByTestId('product-expand').click();
      }
      await row.getByTestId('lot-menu').first().click();
      await expect(page.getByTestId('lot-menu-sheet')).toBeVisible();
      await page.getByTestId('move-lot-menu-item').click();

      // The menu item opens the quantity sheet seeded with that lot; staging
      // it lands the line in the cart bar.
      const sheet = page.getByTestId('move-sheet');
      await expect(sheet).toBeVisible();
      await sheet.getByTestId('move-sheet-qty').fill('3');
      await sheet.getByTestId('move-sheet-add').click();

      const bar = page.getByTestId('move-cart-bar');
      await expect(bar).toBeVisible();
      await expect(bar.getByTestId('move-line-qty')).toHaveValue('3');
      await bar.getByTestId('move-destination').selectOption(pantryB);
      await bar.getByTestId('move-confirm').click();
      await expect(bar.getByTestId('move-confirm')).toBeHidden();

      // Source shows 2 left, destination shows 3.
      await expect(
        page.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
      ).toContainText('2');
      await page.goto(`/pantries/${pantryB}`);
      await expect(
        page.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
      ).toContainText('3');

      // The audit row exists with the right unit sum.
      const history = (await queryOk(api, 'transfer.listForHousehold', {})) as {
        unitSum: number;
        toPantry: { id: string };
      }[];
      expect(history.find((t) => t.toPantry.id === pantryB)?.unitSum).toBe(3);
    } finally {
      cleanup({ pantryIds: pantryB ? [pantryB] : [], restockIds: restockId ? [restockId] : [] });
    }
  });

  test('guards: atomic overdraw rollback, clientKey replay, foreign destination 404, reservation cap', async ({}, testInfo) => {
    const aaron = await apiLogin('aaron');
    const dana = await apiLogin('dana');
    const pantryA = await ownPantryId(aaron);
    const danaPantry = await ownPantryId(dana);
    let pantryB: string | undefined;
    let restockId: string | undefined;
    let orderId: string | undefined;
    try {
      pantryB = (
        await ok(aaron, 'pantry.create', { name: uniq('Guard Dest', testInfo.project.name) })
      ).id as string;
      const product = uniq('Guard Rice', testInfo.project.name);
      const { restockId: rid, lotId, stockId } = await receiveLotApi(aaron, pantryA, product, 4);
      restockId = rid;

      // (a) Two-line payload where line 2 overdraws → 409, and line 1 must NOT
      // have applied (atomicity). Same stock twice is rejected up front, so
      // line 2 overdraws via quantity instead.
      const over = await rpc(aaron, 'transfer.create', {
        fromPantryId: pantryA,
        toPantryId: pantryB,
        lines: [{ stockId, quantity: 5 }],
      });
      expect(over.status).toBe(409);
      const afterOver = (await queryOk(aaron, 'transfer.listForHousehold', {})) as {
        toPantry: { id: string };
      }[];
      expect(afterOver.filter((t) => t.toPantry.id === pantryB)).toHaveLength(0);
      const dupe = await rpc(aaron, 'transfer.create', {
        fromPantryId: pantryA,
        toPantryId: pantryB,
        lines: [
          { stockId, quantity: 1 },
          { stockId, quantity: 1 },
        ],
      });
      expect(dupe.status).toBe(400);

      // (b) clientKey replay returns the ORIGINAL id and does not double-move.
      const clientKey = `e2e-tr-${testInfo.project.name}-${RUN}`;
      const first = await ok(aaron, 'transfer.create', {
        fromPantryId: pantryA,
        toPantryId: pantryB,
        clientKey,
        lines: [{ stockId, quantity: 2 }],
      });
      const replay = await ok(aaron, 'transfer.create', {
        fromPantryId: pantryA,
        toPantryId: pantryB,
        clientKey,
        lines: [{ stockId, quantity: 2 }],
      });
      expect(replay.id).toBe(first.id);
      // Same key with DIFFERENT lines is not a replay — it must conflict, not
      // silently return the original.
      const mutated = await rpc(aaron, 'transfer.create', {
        fromPantryId: pantryA,
        toPantryId: pantryB,
        clientKey,
        lines: [{ stockId, quantity: 1 }],
      });
      expect(mutated.status).toBe(409);

      // (c) A foreign household's pantry as destination reads as nonexistent.
      const foreign = await rpc(aaron, 'transfer.create', {
        fromPantryId: pantryA,
        toPantryId: danaPantry,
        lines: [{ stockId, quantity: 1 }],
      });
      expect(foreign.status).toBe(404);

      // (d) Reserved units are immovable: dana reserves 2 of the remaining 2,
      // so ANY move overdraws free stock.
      const cart = await ok(dana, 'order.addToCart', { pantryId: pantryA, lotId, quantity: 2 });
      orderId = cart.orderId as string;
      await ok(dana, 'order.submit', { orderId });
      const blocked = await rpc(aaron, 'transfer.create', {
        fromPantryId: pantryA,
        toPantryId: pantryB,
        lines: [{ stockId, quantity: 1 }],
      });
      expect(blocked.status).toBe(409);
      await ok(dana, 'order.cancel', { orderId });
    } finally {
      // The canceled order ROW still holds OrderLine → Stock references, so
      // it must be SQL-dropped before the placements are.
      cleanup({
        orderIds: orderId ? [orderId] : [],
        pantryIds: pantryB ? [pantryB] : [],
        restockIds: restockId ? [restockId] : [],
      });
    }
  });

  test('credit-corrected lot stays visible while units remain placed', async ({ page }, testInfo) => {
    // Round-4 fix: receivedCount is receipt/money data — correcting it to
    // zero must not hide physical stock from the pantry (placements are the
    // only source of shelf truth).
    await login(page, 'aaron');
    const api = page.request;
    const pantryA = await ownPantryId(api);
    const product = uniq('Corrected Figs', testInfo.project.name);
    // Purchased by the CONNECTED household — correctCredit only exists where
    // a cross-household credit was posted at finalize.
    const ov = (await (await api.get('/api/trpc/household.overview')).json()).result.data as {
      yourHouseholdId: string;
      households: { id: string; name: string }[];
    };
    const inlawsId = ov.households.find((h) => h.name === 'In-Laws')!.id;
    const created = await ok(api, 'restock.create', {
      pantryId: pantryA,
      retailer: product,
      purchasedAt: new Date().toISOString().slice(0, 10),
      purchaserHouseholdId: inlawsId,
      receiptTotalCents: null,
    });
    const restockId = created.id as string;
    await ok(api, 'restock.saveLine', {
      restockId,
      newProductName: product,
      purchasedCount: 3,
      receivedCount: 3,
      lineTotalCents: 300,
      bestBy: null,
    });
    await ok(api, 'restock.finalize', { restockId, acknowledgedVarianceCents: null });
    const lot = ((await queryOk(api, 'restock.get', { id: restockId })).lots as { id: string }[])[0];
    await ok(api, 'restock.correctCredit', {
      restockId,
      corrections: [{ lotId: lot.id, receivedCount: 0 }],
    });
    await page.goto(`/pantries/${pantryA}`);
    await expect(
      page.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
    ).toContainText('3');
  });

  test('receive split: allocation editor splits a line across pantries at finalize', async ({
    page,
  }, testInfo) => {
    await login(page, 'aaron');
    const api = page.request;
    const pantryA = await ownPantryId(api);
    let pantryB: string | undefined;
    let restockId: string | undefined;
    try {
      pantryB = (
        await ok(api, 'pantry.create', { name: uniq('Split Dest', testInfo.project.name) })
      ).id as string;
      const product = uniq('Split Oats', testInfo.project.name);
      const ov = (await (await api.get('/api/trpc/household.overview')).json()).result.data as {
        yourHouseholdId: string;
      };
      const created = await ok(api, 'restock.create', {
        pantryId: pantryA,
        retailer: product,
        purchasedAt: new Date().toISOString().slice(0, 10),
        purchaserHouseholdId: ov.yourHouseholdId,
        receiptTotalCents: null,
      });
      restockId = created.id as string;
      await ok(api, 'restock.saveLine', {
        restockId,
        newProductName: product,
        purchasedCount: 4,
        receivedCount: 4,
        lineTotalCents: 400,
        bestBy: null,
      });

      // Drive the wizard's allocation editor on the Review-lines step (the
      // line itself was API-saved above): 1 stays in A, 3 go to B.
      await page.goto(`/pantries/${pantryA}/receive/${restockId}?step=3`);
      const chip = page.getByTestId('line-destination-chip').first();
      await expect(chip).toBeVisible();
      await chip.click();
      const editor = page.getByTestId('alloc-editor');
      await expect(editor).toBeVisible();
      await editor.getByTestId('alloc-row-count').first().fill('1');
      await editor.getByTestId('alloc-add-pantry').click();
      const rows = editor.getByTestId('alloc-row-pantry');
      await rows.nth(1).selectOption(pantryB);
      await editor.getByTestId('alloc-row-count').nth(1).fill('3');
      await expect(editor.getByTestId('alloc-sum')).toContainText('4');
      await editor.getByTestId('alloc-save').click();
      await expect(editor).toBeHidden();

      await ok(api, 'restock.finalize', { restockId, acknowledgedVarianceCents: null });

      await page.goto(`/pantries/${pantryA}`);
      await expect(
        page.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
      ).toContainText('1');
      await page.goto(`/pantries/${pantryB}`);
      await expect(
        page.getByTestId('product-row').filter({ hasText: product }).getByTestId('product-total'),
      ).toContainText('3');
    } finally {
      cleanup({ pantryIds: pantryB ? [pantryB] : [], restockIds: restockId ? [restockId] : [] });
    }
  });
});
