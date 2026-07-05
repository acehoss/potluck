import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiLogin, login } from './helpers';

/**
 * Round 4 acceptance — the meal planner + shopping list (REWORK H). Neither
 * touches money or the ledger, so (unlike orders/shares) there are no net
 * before/after assertions; the load-bearing invariants are instead:
 *   H1 the week grid: three plannable kinds, positioned within a (date, meal)
 *      column, moved/rescaled/removed, with a recipe-delete TOMBSTONE that never
 *      silently drops a planned slot;
 *   H2 generation SCALES each recipe amount by its serving override, MERGES
 *      conservatively (same normalizedName+unit only — cross-unit never combines)
 *      and never silently removes a row (natural-key upsert; only removeItem /
 *      clearChecked delete); category learning pre-fills a re-generated row;
 *   H3 availability resolves ONLY for LINKED items — own pantries match by
 *      productId, granted counterparty SHARED pantries by normalized product
 *      NAME, and the pantry-grantless (share-only) edge is never counted; the
 *      suggested lot bridges to order.addToCart.
 *
 * Seed topology (prisma/seed.ts), all load-bearing here:
 *   Heise    — aaron, marie, theo (every preset carries editRecipes, so there
 *              is NO capability-negative to assert on planner writes)
 *   In-Laws  — dana (Owner)
 *   Neighbors— nia (Owner)
 *   Edges: Heise↔In-Laws ACTIVE FULL grants (incl. `pantry`); Heise↔Neighbors
 *          ACTIVE SHARE-ONLY (NO pantry grant); In-Laws↔Neighbors NOT connected.
 *
 * Rerun-safety: the file runs twice per invocation (chromium then webkit)
 * against ONE accumulating DB and must stay green re-run against a live stack.
 * So: per-run-unique recipe titles AND ingredient names (shopping keys are
 * (normalizedName, unit) — a stale row from a dead run carries a name no later
 * run references and is inert); every plan entry we add is removed in a finally;
 * every shopping row we create (generated ones included) is swept by our per-run
 * title token; created recipes are deleted; carts/orders are canceled; the
 * learned ingredient link is unlinked.
 */

const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

/** The normalized ingredient key the routers use (recipe-parse.normalizeIngredientName). */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Either a Page's request context or a headless apiLogin context. */
type Api = Pick<APIRequestContext, 'get' | 'post'>;

type AvailabilityRow = {
  pantryId: string;
  pantryName: string;
  householdName: string;
  own: boolean;
  available: number;
  suggestedLotId: string | null;
};
type ShoppingItem = {
  id: string;
  title: string;
  normalizedName: string;
  unit: string;
  amounts: string | null;
  category: string | null;
  checked: boolean;
  manual: boolean;
  sourceNote: string | null;
  link: { productId: string; productName: string } | null;
  availability: AvailabilityRow[];
};
type PlanEntry = {
  id: string;
  meal: string;
  position: number;
  kind: string;
  recipeId: string | null;
  recipeTitle: string | null;
  servings: number | null;
  servingsOverride: number | null;
  text: string | null;
};
type PlanWeek = {
  start: string;
  days: { date: string; meals: Record<string, PlanEntry[]> }[];
  recipes: { id: string; title: string; servings: number | null }[];
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

/** tRPC GET query; raw envelope (status + body). */
async function getRpc(api: Api, path: string, input?: Record<string, unknown>) {
  const qs = input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
  const res = await api.get(`/api/trpc/${path}${qs}`);
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** GET and assert 200, returning result.data. */
async function okGet(api: Api, path: string, input?: Record<string, unknown>) {
  const r = await getRpc(api, path, input);
  expect(r.status, `${path} ${JSON.stringify(input ?? {})}`).toBe(200);
  return r.body.result.data;
}

const listShopping = (api: Api) => okGet(api, 'shopping.list') as Promise<ShoppingItem[]>;
const planWeek = (api: Api, start: string) =>
  okGet(api, 'plan.week', { start }) as Promise<PlanWeek>;

/** Find one plan entry inside a week response by (date, meal, id). */
function findEntry(week: PlanWeek, date: string, meal: string, id: string): PlanEntry | undefined {
  return week.days.find((d) => d.date === date)?.meals[meal]?.find((e) => e.id === id);
}

/**
 * Receive one finalized `units`-count lot into the api's own pantry ($1.00/u,
 * no receipt total ⇒ auto-finalize; unitCostCents lands non-null so the lot is
 * orderable AND availability-eligible). `retailer` doubles as the product name,
 * so the created per-household Product is named exactly that. Mirrors
 * shares.spec's receiveLotApi.
 */
async function receiveLotApi(api: Api, retailer: string, units: number) {
  const res = await api.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  const data = (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; pantries: { id: string }[] }[];
  };
  const own = data.households.find((h) => h.id === data.yourHouseholdId)!;
  const pantryId = own.pantries[0].id;
  const created = await ok(api, 'restock.create', {
    pantryId,
    retailer,
    purchasedAt: new Date().toISOString().slice(0, 10),
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
 * Drop any leftover DRAFT cart this household holds against the pantry (one
 * cart per household+pantry, shared across runs — a run that died mid-flow
 * leaves stale lines that 409 later submits). addToCart find-or-creates and
 * hands us the id to cancel. Mirrors orders.spec's freshCart, API-only.
 */
async function freshCartApi(api: Api, pantryId: string, lotId: string) {
  const probe = await rpc(api, 'order.addToCart', { pantryId, lotId, quantity: 1 });
  if (probe.status === 200) {
    await rpc(api, 'order.cancel', { orderId: probe.body.result.data.orderId });
  }
}

/** Best-effort hard delete of a recipe (404 on a gone id). */
async function deleteRecipeQuietly(api: Api | undefined, recipeId: string | undefined) {
  if (api && recipeId) await rpc(api, 'recipe.delete', { recipeId });
}

/** Best-effort remove of every tracked plan entry. */
async function removeEntriesQuietly(api: Api, ids: (string | undefined)[]) {
  for (const id of ids) if (id) await rpc(api, 'plan.removeEntry', { entryId: id });
}

/** Sweep every shopping row whose title carries this run's token. */
async function cleanShopping(api: Api, token: string) {
  for (const item of await listShopping(api)) {
    if (item.title.includes(token)) await rpc(api, 'shopping.removeItem', { itemId: item.id });
  }
}

// ---------------------------------------------------------------------------

test('week CRUD (H1): three kinds grouped/ordered, move + servingsOverride, remove, bad date 400, foreign recipe 404', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana');
  const D0 = '2026-08-03';
  const D1 = '2026-08-04';

  let recipeId: string | undefined;
  let danaRecipeId: string | undefined;
  const entries: (string | undefined)[] = [];
  try {
    recipeId = (await ok(aaron, 'recipe.create', { title: uniq('Plan Me', P), servings: 4, ingredients: [] })).id;

    // All three kinds; two land in the SAME (date, meal) column to prove ordering.
    const r1 = (await ok(aaron, 'plan.addEntry', { date: D0, meal: 'breakfast', kind: 'recipe', recipeId })).id;
    entries.push(r1);
    const i1 = (await ok(aaron, 'plan.addEntry', { date: D0, meal: 'breakfast', kind: 'item', text: uniq('Bananas', P) })).id;
    entries.push(i1);
    const n1 = (await ok(aaron, 'plan.addEntry', { date: D1, meal: 'dinner', kind: 'note', text: uniq('Leftovers night', P) })).id;
    entries.push(n1);

    // week groups by day→meal and orders by append position within the column.
    let week = await planWeek(aaron, D0);
    const eR1 = findEntry(week, D0, 'breakfast', r1);
    const eI1 = findEntry(week, D0, 'breakfast', i1);
    const eN1 = findEntry(week, D1, 'dinner', n1);
    expect(eR1?.kind).toBe('recipe');
    expect(eR1?.recipeId).toBe(recipeId);
    expect(eR1?.recipeTitle).toBe(uniq('Plan Me', P));
    expect(eR1?.servings, 'recipe entry carries base servings').toBe(4);
    expect(eI1?.kind).toBe('item');
    expect(eN1?.kind).toBe('note');
    expect(eR1!.position, 'first-added sits before second in the column').toBeLessThan(eI1!.position);

    // Move r1 → D1 lunch (re-appended in the target column) and set an override.
    await ok(aaron, 'plan.updateEntry', { entryId: r1, date: D1, meal: 'lunch', servingsOverride: 3 });
    week = await planWeek(aaron, D0);
    expect(findEntry(week, D0, 'breakfast', r1), 'left the source column').toBeUndefined();
    const moved = findEntry(week, D1, 'lunch', r1);
    expect(moved?.servingsOverride).toBe(3);
    expect(moved?.servings, 'override wins over base servings').toBe(3);

    // Clearing the override (null) restores base servings.
    await ok(aaron, 'plan.updateEntry', { entryId: r1, servingsOverride: null });
    week = await planWeek(aaron, D0);
    const cleared = findEntry(week, D1, 'lunch', r1);
    expect(cleared?.servingsOverride).toBeNull();
    expect(cleared?.servings).toBe(4);

    // Remove the item entry → gone from the grid.
    await ok(aaron, 'plan.removeEntry', { entryId: i1 });
    week = await planWeek(aaron, D0);
    expect(findEntry(week, D0, 'breakfast', i1)).toBeUndefined();

    // A shape-valid but non-real date is rejected by the dateSchema refine (400).
    expect(
      (await rpc(aaron, 'plan.addEntry', { date: '2026-02-30', meal: 'lunch', kind: 'note', text: 'x' })).status,
      'not-a-real-date → 400',
    ).toBe(400);

    // Planning a recipe the acting household does not own is a 404 (a foreign
    // recipe must be forked first; existence never leaks).
    danaRecipeId = (await ok(dana, 'recipe.create', { title: uniq('Dana Only', P), ingredients: [] })).id;
    expect(
      (await rpc(aaron, 'plan.addEntry', { date: D0, meal: 'lunch', kind: 'recipe', recipeId: danaRecipeId })).status,
      "another household's recipe → 404",
    ).toBe(404);
  } finally {
    await removeEntriesQuietly(aaron, entries);
    await deleteRecipeQuietly(aaron, recipeId);
    await deleteRecipeQuietly(dana, danaRecipeId);
  }
});

test('generation (H2): serving-scaled conservative merge, category learning, never silently removed', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const token = `${P}-${RUN}`;
  const aaron = await apiLogin('aaron');
  const D = '2026-08-10';

  const titleA = uniq('Recipe A', P);
  const titleB = uniq('Recipe B', P);
  const flour = uniq('MergeFlour', P);
  const oil = uniq('MergeOil', P);
  const bread = uniq('MergeBread', P);
  const manual = uniq('MergeManual', P);

  let recipeAId: string | undefined;
  let recipeBId: string | undefined;
  const entries: (string | undefined)[] = [];
  try {
    // A (servings 4): 2 cups flour, 1 tbsp oil.  B (servings 2): 1 cup flour,
    // 1 tsp oil.  Flour shares the unit `cups` so it merges; oil uses tbsp vs
    // tsp so it never does.
    recipeAId = (
      await ok(aaron, 'recipe.create', {
        title: titleA,
        servings: 4,
        ingredients: [
          { kind: 'item', amount: '2', unit: 'cups', text: flour },
          { kind: 'item', amount: '1', unit: 'tbsp', text: oil },
        ],
      })
    ).id;
    recipeBId = (
      await ok(aaron, 'recipe.create', {
        title: titleB,
        servings: 2,
        ingredients: [
          { kind: 'item', amount: '1', unit: 'cups', text: flour },
          { kind: 'item', amount: '1', unit: 'tsp', text: oil },
        ],
      })
    ).id;

    // Plan A plain (factor 1) and B at servingsOverride 4 (factor 2), plus a bare
    // kind=item bread line — all on the same day so one generate covers them.
    const eA = (await ok(aaron, 'plan.addEntry', { date: D, meal: 'breakfast', kind: 'recipe', recipeId: recipeAId })).id;
    entries.push(eA);
    const eB = (await ok(aaron, 'plan.addEntry', { date: D, meal: 'lunch', kind: 'recipe', recipeId: recipeBId, servingsOverride: 4 })).id;
    entries.push(eB);
    const eBread = (await ok(aaron, 'plan.addEntry', { date: D, meal: 'dinner', kind: 'item', text: bread })).id;
    entries.push(eBread);

    // Generate → merged/scaled rows.
    await ok(aaron, 'shopping.generate', { from: D, to: D });
    let items = await listShopping(aaron);

    // Flour: 2 (A) + 1×2 (B scaled) = 4, one row under unit `cups`.
    const flourRow = items.find((i) => i.normalizedName === norm(flour) && i.unit === 'cups');
    expect(flourRow, 'flour merged into one cups row').toBeTruthy();
    expect(flourRow!.amounts, 'summed 2 + scaled 2 = 4').toBe('4');
    // sourceNote names both recipes, ×2 on the serving-scaled one.
    expect(flourRow!.sourceNote).toContain(titleA);
    expect(flourRow!.sourceNote).toContain(`${titleB} ×2`);

    // Oil never merges across units → two rows (tbsp from A, tsp from B×2).
    const oilRows = items.filter((i) => i.normalizedName === norm(oil));
    expect(oilRows.map((r) => r.unit).sort(), 'cross-unit stays split').toEqual(['tbsp', 'tsp']);

    // The bare item flows to the list.
    expect(items.find((i) => i.normalizedName === norm(bread)), 'plan item present').toBeTruthy();

    // --- Category learning (H4): setCategory learns it, a re-generated row
    // carrying the same normalized name comes back pre-categorized. ---
    await ok(aaron, 'shopping.setCategory', { itemId: flourRow!.id, category: 'Baking' });
    items = await listShopping(aaron);
    expect(items.find((i) => i.id === flourRow!.id)?.category).toBe('Baking');

    await ok(aaron, 'shopping.removeItem', { itemId: flourRow!.id });
    await ok(aaron, 'shopping.generate', { from: D, to: D });
    items = await listShopping(aaron);
    const flourAgain = items.find((i) => i.normalizedName === norm(flour) && i.unit === 'cups');
    expect(flourAgain, 'flour regenerated').toBeTruthy();
    expect(flourAgain!.id, 'a genuinely new row').not.toBe(flourRow!.id);
    expect(flourAgain!.category, 'learned category pre-fills the fresh row').toBe('Baking');

    // --- Never silently removed (H2): checks/manual survive, a de-planned row
    // persists, regenerate is idempotent, only removeItem/clearChecked delete. ---
    const breadRow = items.find((i) => i.normalizedName === norm(bread))!;
    await ok(aaron, 'shopping.setChecked', { itemId: breadRow.id, checked: true });
    const manualRow = await ok(aaron, 'shopping.addManual', { title: manual });

    // Drop B from the plan; the oil-tsp row (sourced only from B) loses its source.
    await ok(aaron, 'plan.removeEntry', { entryId: eB });
    entries.splice(entries.indexOf(eB), 1);
    await ok(aaron, 'shopping.generate', { from: D, to: D });
    items = await listShopping(aaron);

    expect(items.find((i) => i.id === breadRow.id)?.checked, 'check survives regenerate').toBe(true);
    const manualAfter = items.find((i) => i.id === manualRow.id);
    expect(manualAfter?.manual, 'manual row untouched').toBe(true);
    expect(
      items.find((i) => i.normalizedName === norm(oil) && i.unit === 'tsp'),
      'a row whose plan source vanished is never auto-removed',
    ).toBeTruthy();

    // An unchanged regenerate adds nothing (natural-key upsert = replay guard).
    const again = await ok(aaron, 'shopping.generate', { from: D, to: D });
    expect(again.added, 'idempotent regenerate adds 0').toBe(0);

    // clearChecked removes the checked row (bread) and leaves unchecked rows.
    const cleared = await ok(aaron, 'shopping.clearChecked', {});
    expect(cleared.removed, 'at least the one checked row').toBeGreaterThanOrEqual(1);
    items = await listShopping(aaron);
    expect(items.find((i) => i.id === breadRow.id), 'checked row cleared').toBeUndefined();
    expect(items.find((i) => i.id === flourAgain!.id), 'unchecked rows survive clearChecked').toBeTruthy();
    expect(items.find((i) => i.id === manualRow.id), 'unchecked manual survives').toBeTruthy();
  } finally {
    await removeEntriesQuietly(aaron, entries);
    await deleteRecipeQuietly(aaron, recipeAId);
    await deleteRecipeQuietly(aaron, recipeBId);
    await cleanShopping(aaron, token);
  }
});

test('availability matrix (H3): own productId + counterparty name-bridge, share-only edge excluded, reserve + add-to-order', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const token = `${P}-${RUN}`;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana');
  const nia = await apiLogin('nia');

  const flour = uniq('AvailFlour', P);
  const prod = uniq('AvailProd', P);

  let ownOrderId: string | undefined;
  let inLawsCartId: string | undefined;
  try {
    // A list row for the ingredient (manual is enough — availability keys on the
    // normalized name, not on how the row got there).
    await ok(aaron, 'shopping.addManual', { title: flour });

    // Aaron stocks a 6-unit lot of `prod` and LEARNS flour → that product (G2).
    const aLot = await receiveLotApi(aaron, prod, 6);
    const suggestions = (await okGet(aaron, 'recipe.suggestions', { text: prod })) as {
      id: string;
      name: string;
    }[];
    const product = suggestions.find((s) => s.name === prod);
    expect(product, 'the received product is suggestible for the link').toBeTruthy();
    await ok(aaron, 'recipe.linkIngredient', { text: flour, productId: product!.id });

    // Own pantry availability: 6, FIFO-oldest lot suggested (matched by productId).
    let row = (await listShopping(aaron)).find((i) => i.normalizedName === norm(flour));
    let own = row?.availability.find((a) => a.own);
    expect(own?.available, 'own pantry sums to 6').toBe(6);
    expect(own?.suggestedLotId, 'own suggestion is the received lot').toBe(aLot.lotId);

    // Counterparty name-bridge: In-Laws (full edge, pantry granted) stocks an
    // identically-NAMED product → aaron's availability gains that pantry row.
    const dLot = await receiveLotApi(dana, prod, 4);
    row = (await listShopping(aaron)).find((i) => i.normalizedName === norm(flour));
    const inLaws = row?.availability.find((a) => !a.own && a.householdName === 'In-Laws');
    expect(inLaws?.available, 'In-Laws pantry bridged by product name').toBe(4);
    expect(inLaws?.suggestedLotId).toBe(dLot.lotId);
    expect(row?.availability.some((a) => a.own), 'own row still present').toBe(true);

    // Share-only edge excluded: Neighbors stocks the same-named product, but the
    // Heise↔Neighbors edge lacks the pantry grant → never counted.
    await receiveLotApi(nia, prod, 5);
    row = (await listShopping(aaron)).find((i) => i.normalizedName === norm(flour));
    expect(
      row?.availability.some((a) => a.householdName === 'Neighbors'),
      'pantry-grantless edge never surfaces',
    ).toBe(false);

    // Reservation interplay: reserve 4 of the own 6 via an order → available 2.
    await freshCartApi(aaron, aLot.pantryId, aLot.lotId);
    const ownCart = await ok(aaron, 'order.addToCart', { pantryId: aLot.pantryId, lotId: aLot.lotId, quantity: 4 });
    ownOrderId = ownCart.orderId;
    await ok(aaron, 'order.submit', { orderId: ownOrderId });
    row = (await listShopping(aaron)).find((i) => i.normalizedName === norm(flour));
    own = row?.availability.find((a) => a.own);
    expect(own?.available, 'remaining 6 − reserved 4 = 2').toBe(2);

    // Add-to-order integration: the In-Laws suggestion feeds order.addToCart for
    // that pantry — the row lands in a DRAFT cart. No pickup (no money here).
    await freshCartApi(aaron, dLot.pantryId, dLot.lotId);
    const inLawsCart = await ok(aaron, 'order.addToCart', {
      pantryId: dLot.pantryId,
      lotId: inLaws!.suggestedLotId,
      quantity: 1,
    });
    inLawsCartId = inLawsCart.orderId;
    expect(inLawsCart.lineCount, 'the suggested lot becomes a cart line').toBe(1);
  } finally {
    if (ownOrderId) await rpc(aaron, 'order.cancel', { orderId: ownOrderId });
    if (inLawsCartId) await rpc(aaron, 'order.cancel', { orderId: inLawsCartId });
    await rpc(aaron, 'recipe.unlinkIngredient', { text: flour });
    await cleanShopping(aaron, token);
  }
});

test('recipe-delete tombstone (H1): a planned slot degrades, never vanishes', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const TD = '2026-08-17';

  let recipeId: string | undefined;
  let entryId: string | undefined;
  try {
    recipeId = (
      await ok(aaron, 'recipe.create', {
        title: uniq('Doomed', P),
        servings: 2,
        ingredients: [{ kind: 'item', amount: '1', unit: 'cup', text: uniq('DoomIng', P) }],
      })
    ).id;
    entryId = (await ok(aaron, 'plan.addEntry', { date: TD, meal: 'dinner', kind: 'recipe', recipeId })).id;

    // Delete the recipe → PlanEntry.recipeId nulls (SetNull), the slot stays.
    await ok(aaron, 'recipe.delete', { recipeId });
    recipeId = undefined;

    const entry = findEntry(await planWeek(aaron, TD), TD, 'dinner', entryId!);
    expect(entry, 'the planned slot survives the delete').toBeTruthy();
    expect(entry?.kind).toBe('recipe');
    expect(entry?.recipeId, 'recipe reference nulled').toBeNull();
    expect(entry?.recipeTitle, 'rendered as the tombstone').toBe('(deleted recipe)');
  } finally {
    await removeEntriesQuietly(aaron, [entryId]);
    await deleteRecipeQuietly(aaron, recipeId);
  }
});

// UI smoke — LAST. Needs the rebuilt stack serving /plan + /shopping. Drives the
// per-day plan-add sheet (recipe picker is a filterable button list, default
// kind=recipe / meal=dinner) and the shopping generator through the testid
// contract. Cleanup runs through the API, so the window.confirm behind
// shopping-remove/clear-checked is never triggered here.
test('UI smoke: plan a recipe, then generate and edit the shopping list', async ({ page }, testInfo) => {
  const P = testInfo.project.name;
  const token = `${P}-${RUN}`;
  const recipeTitle = uniq('UI Plan Recipe', P);
  const ingName = uniq('UI Ingredient', P);
  const manualName = uniq('UI Manual', P);
  // LOCAL calendar day, matching the plan UI's client-side "Today" (ymd of
  // new Date()). toISOString() is UTC and lands on TOMORROW during evening
  // hours west of Greenwich — the entry would be planned on local-today via
  // the Today card while the generate range asked for UTC-today. Bit us at
  // 20:19 EDT.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  await login(page, 'aaron');
  // A known recipe (one ingredient) so the picker has a deterministic target and
  // the generated list has a row to find.
  const recipeId = (
    await ok(page.request, 'recipe.create', {
      title: recipeTitle,
      servings: 4,
      ingredients: [{ kind: 'item', amount: '2', unit: 'cups', text: ingName }],
    })
  ).id;

  try {
    // Home strip → /plan.
    await page.getByTestId('plan-strip').click();
    await expect(page).toHaveURL(/\/plan$/);

    // plan-add is per-day → open the sheet on TODAY's card so the entry lands on
    // today (the range we generate over). Default kind=recipe, meal=dinner.
    const todayCard = page.getByTestId('plan-day').filter({ hasText: 'Today' });
    await todayCard.getByTestId('plan-add').click();
    await expect(page.getByTestId('plan-add-sheet')).toBeVisible();

    // Filter the recipe button list down to ours, pick it, submit → chip renders.
    await page.getByLabel('Search recipes').fill(recipeTitle);
    await page.getByTestId('plan-entry-recipe-picker').getByRole('button', { name: recipeTitle }).click();
    await page.getByTestId('plan-add-submit').click();
    await expect(page.getByTestId('plan-add-sheet')).toBeHidden();
    await expect(page.getByTestId('plan-entry').filter({ hasText: recipeTitle }).first()).toBeVisible();

    // /shopping → range today..today → generate → the ingredient row appears.
    await page.getByTestId('shopping-link').click();
    await expect(page).toHaveURL(/\/shopping$/);
    await page.getByTestId('shopping-generate-from').fill(today);
    await page.getByTestId('shopping-generate-to').fill(today);
    await page.getByTestId('shopping-generate').click();
    const genRow = page.getByTestId('shopping-item').filter({ hasText: ingName });
    await expect(genRow.first()).toBeVisible();

    // Check that row (nested checkbox is controlled by a server round-trip, so
    // click then wait for the refetched checked state rather than .check()).
    const check = genRow.first().getByTestId('shopping-check');
    await check.click();
    await expect(check).toBeChecked();
    await page.getByTestId('shopping-manual-input').fill(manualName);
    await page.getByTestId('shopping-manual-add').click();
    await expect(page.getByTestId('shopping-item').filter({ hasText: manualName }).first()).toBeVisible();
  } finally {
    // Remove the planned entry BEFORE deleting the recipe (so it's found by
    // recipeId, not left as a tombstone), then sweep list rows + the recipe.
    const week = await planWeek(page.request, today);
    for (const day of week.days) {
      for (const meal of Object.keys(day.meals)) {
        for (const e of day.meals[meal]) {
          if (e.recipeId === recipeId) await rpc(page.request, 'plan.removeEntry', { entryId: e.id });
        }
      }
    }
    await cleanShopping(page.request, token);
    await deleteRecipeQuietly(page.request, recipeId);
  }
});
