import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiLogin, login } from './helpers';

/**
 * Round 3 acceptance — the recipe book (REWORK G). Recipes touch NO money and
 * NO ledger, so unlike shares.spec there are no before/after net assertions;
 * the load-bearing invariants are instead:
 *   G1 title-only-minimal creates; G2 the learned per-household ingredient→product
 *   link resolves at read time across recipes and is per-viewer; G3 browse-live
 *   cross-household visibility rides the `recipes` grant + the per-recipe private
 *   flag, and saving a foreign recipe FORKS a frozen copy; G4 the paste/URL
 *   editor assists (parseText heuristic, SSRF-guarded importUrl).
 *
 * Seed topology (prisma/seed.ts), all load-bearing here:
 *   Heise    — aaron, marie, theo (all Owner/Adult/Teen; every preset carries
 *              editRecipes, so there is NO capability-negative to assert)
 *   In-Laws  — dana (Owner)
 *   Neighbors— nia (Owner)
 *   Edges: Heise↔In-Laws ACTIVE FULL grants (incl. `recipes` both ways);
 *          Heise↔Neighbors ACTIVE SHARE-ONLY (NO `recipes` grant — visible
 *          board, unbrowsable book); In-Laws↔Neighbors NOT connected.
 *
 * NOTE (capability): every seeded preset — Teen included — has editRecipes, so
 * a "denied write" test would be vacuous; there is no negative to exercise.
 *
 * Rerun-safety: the file runs twice per invocation (chromium then webkit)
 * against ONE accumulating DB and must stay green re-run against a live stack.
 * So: per-run unique titles; every recipe created (originals AND forks) is
 * hard-deleted in a finally (recipe.delete is a real delete); ingredient names
 * are per-run unique so any IngredientLink that survives a partial-failure run
 * is keyed on a name no later run references and is therefore inert (we still
 * unlink in the finally).
 */

const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

/** Either a Page's request context or a headless apiLogin context. */
type Api = Pick<APIRequestContext, 'get' | 'post'>;

type Ingredient = {
  id: string;
  position: number;
  kind: 'item' | 'heading';
  amount: string | null;
  unit: string | null;
  text: string;
  note: string | null;
  link: { productId: string; productName: string } | null;
};
type RecipeFull = {
  id: string;
  title: string;
  private: boolean;
  mine: boolean;
  householdName: string;
  forkedFromTitle: string | null;
  forkedFromHouseholdName: string | null;
  ingredients: Ingredient[];
};
type SlimRecipe = {
  id: string;
  title: string;
  private: boolean;
  householdName?: string;
  forkedFromTitle: string | null;
  forkedFromHouseholdName: string | null;
};
type RecipeList = { mine: SlimRecipe[]; shared: SlimRecipe[] };
type ParsedIngredient = {
  kind: 'item' | 'heading';
  amount?: string;
  unit?: string;
  text: string;
  note?: string;
};
type ParsedRecipe = { ingredients: ParsedIngredient[]; directions?: string };

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

const getRecipe = (api: Api, id: string) => okGet(api, 'recipe.get', { id }) as Promise<RecipeFull>;
const listRecipes = (api: Api) => okGet(api, 'recipe.list') as Promise<RecipeList>;

/** Best-effort hard delete (idempotent enough for cleanup; 404 on a gone id). */
async function deleteQuietly(api: Api | undefined, recipeId: string | undefined) {
  if (api && recipeId) await rpc(api, 'recipe.delete', { recipeId });
}

/**
 * Receive one finalized `units`-count lot into the api's own pantry ($1.00/u,
 * no receipt total ⇒ auto-finalize; unitCostCents lands non-null). `retailer`
 * doubles as the product name, so the created Product is named exactly that.
 * Copied from shares.spec's receiveLotApi (drops the lot handles we don't need).
 */
async function receiveProductApi(api: Api, retailer: string, units: number) {
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
  return { pantryId, productName: retailer };
}

// ---------------------------------------------------------------------------

test('CRUD + structure: title-only minimal (G1), ordered heading/item body, replace-on-update, delete→404', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');

  let minimalId: string | undefined;
  let fullId: string | undefined;
  try {
    // G1: title is the only required field — an empty ingredient set is a 200.
    minimalId = (await ok(aaron, 'recipe.create', { title: uniq('Minimal', P), ingredients: [] })).id;
    const minimal = await getRecipe(aaron, minimalId!);
    expect(minimal.ingredients).toHaveLength(0);
    expect(minimal.mine).toBe(true);

    // A full body: headings interleaved with items, in a deliberate order.
    fullId = (
      await ok(aaron, 'recipe.create', {
        title: uniq('Full', P),
        ingredients: [
          { kind: 'heading', text: 'Produce' },
          { kind: 'item', amount: '2', unit: 'cups', text: 'carrots', note: 'diced' },
          { kind: 'item', amount: '1', text: 'onion' },
          { kind: 'heading', text: 'Pantry' },
          { kind: 'item', amount: '1', unit: 'tsp', text: 'salt' },
        ],
      })
    ).id;

    // get returns ingredients in position order with headings interleaved.
    const full = await getRecipe(aaron, fullId!);
    expect(full.ingredients.map((i) => [i.position, i.kind, i.text])).toEqual([
      [0, 'heading', 'Produce'],
      [1, 'item', 'carrots'],
      [2, 'item', 'onion'],
      [3, 'heading', 'Pantry'],
      [4, 'item', 'salt'],
    ]);
    const carrots = full.ingredients[1];
    expect([carrots.amount, carrots.unit, carrots.note]).toEqual(['2', 'cups', 'diced']);

    // update REPLACES the whole ingredient set (value objects): reorder and drop
    // "onion" → the new order/positions hold and the removed line is gone.
    await ok(aaron, 'recipe.update', {
      recipeId: fullId!,
      title: uniq('Full', P),
      ingredients: [
        { kind: 'item', amount: '1', unit: 'tsp', text: 'salt' },
        { kind: 'heading', text: 'Produce' },
        { kind: 'item', amount: '2', unit: 'cups', text: 'carrots', note: 'diced' },
      ],
    });
    const updated = await getRecipe(aaron, fullId!);
    expect(updated.ingredients.map((i) => [i.position, i.kind, i.text])).toEqual([
      [0, 'item', 'salt'],
      [1, 'heading', 'Produce'],
      [2, 'item', 'carrots'],
    ]);

    // delete removes it: a subsequent get is a 404 (existence never leaks).
    await ok(aaron, 'recipe.delete', { recipeId: fullId! });
    expect((await getRpc(aaron, 'recipe.get', { id: fullId! })).status).toBe(404);
    fullId = undefined;
  } finally {
    await deleteQuietly(aaron, minimalId);
    await deleteQuietly(aaron, fullId);
  }
});

test('parseText assist (G4): structured lines, mixed + unicode quantities, heading + trailing directions', async ({}, testInfo) => {
  const aaron = await apiLogin('aaron');

  // A realistic paste: one ingredient block (with a colon heading and a unicode
  // fraction), a blank line, then a prose directions block. parseText is a
  // MUTATION (it gates on editRecipes), so POST it.
  const text = [
    '1 1/2 cups flour, sifted',
    '½ cup sugar',
    '2 eggs',
    'FOR THE SAUCE:',
    '2 tablespoons butter',
    '1 cup maple syrup',
    '',
    'Combine the dry ingredients in a large bowl and whisk thoroughly until evenly blended.' +
      ' Pour in the wet ingredients and stir until just combined, then cook on a hot griddle.',
  ].join('\n');

  const parsed = (await ok(aaron, 'recipe.parseText', { text })) as ParsedRecipe;

  // Mixed number keeps its raw text; the known unit is split off; the trailing
  // comma clause becomes the note.
  const flour = parsed.ingredients.find((i) => i.text === 'flour');
  expect(flour, 'flour line parsed').toBeTruthy();
  expect([flour!.amount, flour!.unit, flour!.note]).toEqual(['1 1/2', 'cups', 'sifted']);

  // A lone unicode fraction is recognised as the amount.
  const sugar = parsed.ingredients.find((i) => i.text === 'sugar');
  expect([sugar!.kind, sugar!.amount, sugar!.unit]).toEqual(['item', '½', 'cup']);

  // The colon line is a heading, interleaved among the items (not an ingredient).
  expect(
    parsed.ingredients.some((i) => i.kind === 'heading' && i.text === 'FOR THE SAUCE'),
    'colon line detected as a heading',
  ).toBe(true);

  // The prose block is peeled off as directions, not shredded into ingredients.
  expect(parsed.directions ?? '').toContain('Combine the dry ingredients');
  expect(parsed.ingredients.some((i) => i.text.startsWith('Combine the dry'))).toBe(false);
});

test('browse-live matrix (G3): grant-scoped visibility, own household sees it, live private-flip hides it', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana'); // In-Laws — FULL edge, recipes granted
  const nia = await apiLogin('nia'); // Neighbors — SHARE-ONLY edge, NO recipes grant
  const theo = await apiLogin('theo'); // Heise member (household-level book)

  let id: string | undefined;
  try {
    const title = uniq('Chili', P);
    id = (await ok(aaron, 'recipe.create', { title, ingredients: [], private: false })).id;

    // In-Laws (full edge grants recipes) sees it in `shared` and can open it.
    const danaList = await listRecipes(dana);
    expect(danaList.shared.some((r) => r.id === id), 'In-Laws sees the shared recipe').toBe(true);
    const danaSaw = danaList.shared.find((r) => r.id === id)!;
    expect(danaSaw.householdName, 'shared card carries the poster household').toBe('Heise');
    expect((await getRpc(dana, 'recipe.get', { id: id! })).status).toBe(200);

    // Neighbors (share-only edge lacks the recipes grant) sees NOTHING: not in
    // the shared list, and a direct get is a 404 (existence never leaks).
    const niaList = await listRecipes(nia);
    expect(niaList.shared.some((r) => r.id === id), 'Neighbors cannot browse the book').toBe(false);
    expect((await getRpc(nia, 'recipe.get', { id: id! })).status).toBe(404);

    // Theo is a Heise member: the book is household-level, so Aaron's recipe is
    // his household's — it appears under MINE for Theo.
    const theoList = await listRecipes(theo);
    expect(theoList.mine.some((r) => r.id === id), 'household member sees it under mine').toBe(true);

    // Live scoping: flipping private hides it from the connected household on the
    // very next read (no re-share/re-index step).
    await ok(aaron, 'recipe.update', { recipeId: id!, title, ingredients: [], private: true });
    expect((await getRpc(dana, 'recipe.get', { id: id! })).status).toBe(404);
    const danaAfter = await listRecipes(dana);
    expect(danaAfter.shared.some((r) => r.id === id), 'private recipe leaves the shared list').toBe(false);
  } finally {
    await deleteQuietly(aaron, id);
  }
});

test('fork-on-save (G3): frozen copy with attribution, private by default, browse-live original, guardrails', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana');
  const nia = await apiLogin('nia');

  let originalId: string | undefined;
  let forkId: string | undefined;
  try {
    const originalTitle = uniq('Stew', P);
    originalId = (
      await ok(aaron, 'recipe.create', {
        title: originalTitle,
        private: false,
        ingredients: [{ kind: 'item', amount: '3', unit: 'cups', text: 'broth' }],
      })
    ).id;

    // Dana forks Aaron's visible recipe → a copy lands in her OWN book, carrying
    // snapshotted attribution (not FKs — the source may vanish later).
    forkId = (await ok(dana, 'recipe.fork', { recipeId: originalId! })).id;
    const fork = await getRecipe(dana, forkId!);
    expect(fork.mine).toBe(true);
    expect(fork.forkedFromTitle).toBe(originalTitle);
    expect(fork.forkedFromHouseholdName).toBe('Heise');
    expect(fork.title).toBe(originalTitle);
    expect(fork.ingredients.map((i) => i.text)).toEqual(['broth']);
    // The fork appears in Dana's mine list too.
    expect((await listRecipes(dana)).mine.some((r) => r.id === forkId)).toBe(true);

    // A fork is private by default → NOT re-shared onward: Aaron cannot see
    // Dana's copy (no transitive sharing), so his get is a 404.
    expect((await getRpc(aaron, 'recipe.get', { id: forkId! })).status).toBe(404);

    // Browse-live vs fork-frozen: Aaron edits the ORIGINAL; Dana's fork is a
    // plain copy and is untouched (title + ingredients stay the snapshot).
    await ok(aaron, 'recipe.update', {
      recipeId: originalId!,
      title: uniq('Stew EDITED', P),
      private: false,
      ingredients: [{ kind: 'item', amount: '9', unit: 'cups', text: 'water' }],
    });
    const forkAfter = await getRecipe(dana, forkId!);
    expect(forkAfter.title, 'fork frozen against author edits').toBe(originalTitle);
    expect(forkAfter.ingredients.map((i) => i.text)).toEqual(['broth']);

    // Forking your OWN recipe is a 400 (BAD_REQUEST — nothing to copy).
    expect((await rpc(aaron, 'recipe.fork', { recipeId: originalId! })).status).toBe(400);

    // Forking an INVISIBLE recipe is a 404: Nia (share-only edge, no recipes
    // grant) cannot even see Aaron's original, so she cannot fork it.
    expect((await rpc(nia, 'recipe.fork', { recipeId: originalId! })).status).toBe(404);
  } finally {
    await deleteQuietly(dana, forkId);
    await deleteQuietly(aaron, originalId);
  }
});

test('ingredient links (G2): learned map resolves across recipes, per-viewer-household, unlink clears it', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana');

  // Per-run ingredient name so any leftover IngredientLink is inert next run.
  const ingName = uniq('Heirloom Tomato', P);
  let aId: string | undefined;
  let bId: string | undefined;
  try {
    // Aaron receives a lot → creates a Product named exactly `ingName`.
    await receiveProductApi(aaron, ingName, 3);

    // suggestions surfaces that product for the matching ingredient text (never
    // auto-links — G2), and gives us the productId to link with.
    const suggestions = (await okGet(aaron, 'recipe.suggestions', { text: ingName })) as {
      id: string;
      name: string;
    }[];
    const product = suggestions.find((s) => s.name === ingName);
    expect(product, 'the received product is suggested for the ingredient').toBeTruthy();

    // Recipe A uses that ingredient text; before linking, get resolves no link.
    aId = (
      await ok(aaron, 'recipe.create', {
        title: uniq('Salad A', P),
        private: false,
        ingredients: [{ kind: 'item', text: ingName }],
      })
    ).id;
    expect((await getRecipe(aaron, aId!)).ingredients[0].link).toBeNull();

    // Learn the mapping → A's item now resolves to the product on read.
    await ok(aaron, 'recipe.linkIngredient', { text: ingName, productId: product!.id });
    const aLinked = (await getRecipe(aaron, aId!)).ingredients[0];
    expect(aLinked.link).toEqual({ productId: product!.id, productName: ingName });

    // The learned map is per-NAME, not per-recipe: a brand-new recipe B with the
    // SAME ingredient text resolves the SAME link with no extra confirmation.
    bId = (
      await ok(aaron, 'recipe.create', {
        title: uniq('Salad B', P),
        private: false,
        ingredients: [{ kind: 'item', text: ingName }],
      })
    ).id;
    expect((await getRecipe(aaron, bId!)).ingredients[0].link).toEqual({
      productId: product!.id,
      productName: ingName,
    });

    // Links are per-VIEWER-household: Dana can see recipe A (full edge) but has
    // no link of her own for that name, so her read resolves null.
    expect((await getRecipe(dana, aId!)).ingredients[0].link, 'links are per-household').toBeNull();

    // Unlink forgets the mapping → A resolves null again.
    await ok(aaron, 'recipe.unlinkIngredient', { text: ingName });
    expect((await getRecipe(aaron, aId!)).ingredients[0].link).toBeNull();
  } finally {
    await rpc(aaron, 'recipe.unlinkIngredient', { text: ingName });
    await deleteQuietly(aaron, aId);
    await deleteQuietly(aaron, bId);
  }
});

test('importUrl SSRF surface (G4): every unsafe URL degrades to { status: "unavailable" }, no fetch', async ({}, testInfo) => {
  const aaron = await apiLogin('aaron');

  // importUrl is advisory: the SSRF guard (safeImportUrl) rejects these BEFORE
  // any network I/O, and the router returns a 200 envelope carrying
  // { status: 'unavailable', reason } — NOT a 4xx and NOT a thrown error. So we
  // assert HTTP 200 + data.status==='unavailable'. None of these reach the
  // network (all fail the guard on the initial URL), so no real site is fetched.
  const unsafe = [
    'http://example.com/recipe', // not https
    'https://127.0.0.1/recipe', // IPv4 literal
    'https://localhost/recipe', // bare/dotless intranet name
    'https://foo.internal/recipe', // .internal suffix
    'https://user:pass@example.com/recipe', // embedded credentials
  ];
  for (const url of unsafe) {
    const r = await rpc(aaron, 'recipe.importUrl', { url });
    expect(r.status, `importUrl(${url}) still returns a 200 envelope`).toBe(200);
    expect(r.body.result.data.status, `importUrl(${url}) is unavailable`).toBe('unavailable');
    expect(typeof r.body.result.data.reason, 'unavailable carries a reason string').toBe('string');
  }
});

// UI smoke — LAST. Needs the rebuilt stack serving /recipes. The row's fields
// have no per-field testids (contract stops at recipe-ingredient-row), but each
// carries a stable aria-label — Amount/Unit/Ingredient/Note on an item row,
// "Section heading" on a heading row — so address them by accessible name
// (robust to the optional 4th Note input and any future field reorder).
test('UI smoke: compose a recipe, save it, then fork it from the connected household', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name;
  const title = uniq('UI Frittata', P);

  await login(page, 'aaron');
  await page.getByTestId('recipes-strip').click();
  await expect(page).toHaveURL(/\/recipes$/);

  await page.getByTestId('recipe-new').click();
  await page.getByTestId('recipe-title').fill(title);

  // One item line: fill amount/unit/text by accessible name.
  await page.getByTestId('recipe-add-line').click();
  const itemRow = page.getByTestId('recipe-ingredient-row').last();
  await itemRow.getByRole('textbox', { name: 'Amount' }).fill('6');
  await itemRow.getByRole('textbox', { name: 'Unit' }).fill('each');
  await itemRow.getByRole('textbox', { name: 'Ingredient' }).fill('eggs');

  // One heading line (the heading row exposes a single "Section heading" input).
  await page.getByTestId('recipe-add-heading').click();
  await page
    .getByTestId('recipe-ingredient-row')
    .last()
    .getByRole('textbox', { name: 'Section heading' })
    .fill('Toppings');

  await page.getByTestId('recipe-save').click();

  // Back in the book, the new recipe row appears.
  const aaronRow = page.getByTestId('recipe-row').filter({ hasText: title });
  await expect(aaronRow).toBeVisible();

  // Dana (full edge) sees it in her shared section, opens it, and forks it into
  // her own book — attribution to Heise is visible on the fork.
  const danaCtx = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  });
  try {
    const dana = await danaCtx.newPage();
    await login(dana, 'dana');
    await dana.goto('/recipes');
    const danaRow = dana.getByTestId('recipe-row').filter({ hasText: title });
    await expect(danaRow).toBeVisible();
    await danaRow.click();
    await dana.getByTestId('recipe-fork').click();
    // The fork lands in Dana's book carrying the source household's name.
    await expect(dana.getByText('Heise')).toBeVisible();
    await expect(dana.getByText(title).first()).toBeVisible();
  } finally {
    await danaCtx.close();
    // Sweep every copy this run created (original + any fork), by title, so a
    // partial-failure run can't accumulate rows across reruns.
    for (const who of [page.request, await apiLogin('dana')]) {
      const list = (await okGet(who, 'recipe.list')) as RecipeList;
      for (const r of list.mine) {
        if (r.title === title || r.forkedFromTitle === title) {
          await rpc(who, 'recipe.delete', { recipeId: r.id });
        }
      }
    }
  }
});
