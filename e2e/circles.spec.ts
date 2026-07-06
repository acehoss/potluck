import { execFileSync } from 'node:child_process';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';
import { apiLogin, login, PASSWORD } from './helpers';

/**
 * Phase-2 Round B acceptance — CIRCLES (REWORK P4). A circle IS a household's
 * named grant bundle (the six directional grants that used to live per
 * connection); each side of a connection assigns the OTHER household into one
 * of ITS OWN circles, and resource visibility (pantry/item) is scoped to
 * circles via ALL / SELECT(circles) / PRIVATE. This file proves the reach rule
 * end to end: a cross-household resource is reachable iff an ACTIVE edge's
 * circle GRANTS the capability AND the resource is VISIBLE to that circle —
 * both independently necessary — and that moving a connection or editing a
 * circle's grants flips reach LIVE with no session/cache staleness.
 *
 * Seeded topology (prisma/seed.ts, post-circles — all load-bearing):
 *   every household has the three preset circles
 *     Neighbors (shareTo+shareFrom) / Friends (+pantry,lending,recipes) /
 *     Family (all six).
 *   Heise placed In-Laws in Family and Neighbors-household in Neighbors;
 *   In-Laws placed Heise in Family; Neighbors placed Heise in Neighbors.
 *   In-Laws ↔ Neighbors are NOT connected.
 *
 * RESTORE-INVARIANT: later suite files (network/shares/orders/slice*) assert
 * this exact topology, and workers:1 runs every file in one worker — so every
 * mutation here is reverted in a finally (move connections back, restore
 * pantry/item visibility, delete created circles/recipes, SQL-drop per-run
 * pantries/items which have no delete endpoint, and DELETE any In-Laws↔
 * Neighbors edge so the pair is a NON-ROW "unconnected", never a SEVERED row).
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

type GrantSet = {
  pantry: boolean;
  lending: boolean;
  recipes: boolean;
  shareTo: boolean;
  shareFrom: boolean;
  reshare: boolean;
};

/** The three preset grant tuples (mirror authz.ts GRANT_PRESETS). */
const NEIGHBOR: GrantSet = { pantry: false, lending: false, recipes: false, shareTo: true, shareFrom: true, reshare: false };
const FRIEND: GrantSet = { pantry: true, lending: true, recipes: true, shareTo: true, shareFrom: true, reshare: false };
const FAMILY: GrantSet = { pantry: true, lending: true, recipes: true, shareTo: true, shareFrom: true, reshare: true };
const NONE: GrantSet = { pantry: false, lending: false, recipes: false, shareTo: false, shareFrom: false, reshare: false };
const RECIPES_ONLY: GrantSet = { pantry: false, lending: false, recipes: true, shareTo: false, shareFrom: false, reshare: false };

/** Either a Page's request context or a headless apiLogin context. */
type Api = Pick<APIRequestContext, 'get' | 'post'>;

type Circle = {
  id: string;
  name: string;
  position: number;
  grants: GrantSet;
  connectionCount: number;
  scopeCount: number;
};

type Conn = {
  id: string;
  counterparty: { id: string; name: string; slug: string };
  status: 'PENDING' | 'ACTIVE' | 'SEVERED';
  requestedByUs: boolean;
  myCircle: { id: string; name: string; grants: GrantSet } | null;
  theyGrant: GrantSet;
};

type FeedPost = { id: string; status: string; mine: boolean };
type SharedRecipe = { id: string; title: string };

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

async function overview(api: Api) {
  const res = await api.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string; pantries: { id: string; name: string }[] }[];
  };
}

/** The acting household's circles (manageConnections-gated). */
async function circleList(api: Api): Promise<Circle[]> {
  const res = await api.get('/api/trpc/circle.list');
  expect(res.ok(), 'circle.list should be reachable to a manager').toBe(true);
  return (await res.json()).result.data.circles as Circle[];
}

/** The acting household's circle named `name` (throws if absent). */
async function circle(api: Api, name: string): Promise<Circle> {
  const found = (await circleList(api)).find((c) => c.name === name);
  if (!found) throw new Error(`no circle named ${name}`);
  return found;
}

/** The acting household's connections, counterparty-normalized. */
async function connList(api: Api): Promise<Conn[]> {
  const res = await api.get('/api/trpc/connection.list');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data.connections as Conn[];
}

/** The connection whose counterparty household is named `name`. */
async function connWith(api: Api, name: string): Promise<Conn> {
  const found = (await connList(api)).find((c) => c.counterparty.name === name);
  if (!found) throw new Error(`no connection with ${name}`);
  return found;
}

async function feed(api: Api): Promise<FeedPost[]> {
  const res = await api.get('/api/trpc/share.feed');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data.posts as FeedPost[];
}
async function inFeed(api: Api, postId: string): Promise<FeedPost | undefined> {
  return (await feed(api)).find((p) => p.id === postId);
}

/** The `shared` half of the acting household's recipe book. */
async function sharedRecipes(api: Api): Promise<SharedRecipe[]> {
  const res = await api.get('/api/trpc/recipe.list');
  expect(res.ok()).toBe(true);
  return (await res.json()).result.data.shared as SharedRecipe[];
}

async function withdrawQuietly(api: Api | undefined, postId: string | undefined) {
  if (api && postId) await rpc(api, 'share.withdraw', { postId });
}

/**
 * The ids of `householdName`'s pantries the api's user may BROWSE — read from
 * household.overview, which applies the full P4 reach rule (pantry grant AND
 * visibility/SELECT-scope). A deterministic tRPC probe, unlike an SSR page GET.
 */
async function browsablePantryIds(api: Api, householdName: string): Promise<string[]> {
  const h = (await overview(api)).households.find((x) => x.name === householdName);
  return h ? h.pantries.map((p) => p.id) : [];
}

// ---------------------------------------------------------------------------

test('seeded equivalence: preset circles carry the pre-circles tuples and the same reach matrix', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana');
  const nia = await apiLogin('nia');

  // Heise's three preset circles are present with the exact grant tuples
  // authz.ts defines (a household may have added its own circles besides).
  const heiseCircles = await circleList(aaron);
  expect(heiseCircles.map((c) => c.name)).toEqual(
    expect.arrayContaining(['Neighbors', 'Friends', 'Family']),
  );
  expect((await circle(aaron, 'Neighbors')).grants).toEqual(NEIGHBOR);
  expect((await circle(aaron, 'Friends')).grants).toEqual(FRIEND);
  expect((await circle(aaron, 'Family')).grants).toEqual(FAMILY);

  // Aaron placed In-Laws in Family and Neighbors-household in Neighbors (our side).
  expect((await connWith(aaron, 'In-Laws')).myCircle?.name).toBe('Family');
  expect((await connWith(aaron, 'Neighbors')).myCircle?.name).toBe('Neighbors');

  // The pre-circles behavior matrix holds exactly, now expressed through circles.
  const heisePantry = (await overview(aaron)).households
    .find((h) => h.name === 'Heise')!
    .pantries.find((p) => p.name === 'Basement Pantry')!;
  const heisePantryId = heisePantry.id;
  // Dana (Family → pantry grant) reaches the Heise pantry; Nia (Neighbors → no
  // pantry grant) sees the household but none of its pantries — the household's
  // existence is fine, its pantries stay hidden without the grant.
  expect((await browsablePantryIds(dana, 'Heise')).includes(heisePantryId), 'Family reaches it').toBe(true);
  expect((await browsablePantryIds(nia, 'Heise')).includes(heisePantryId), 'Neighbors cannot').toBe(false);

  // Nia sees a Heise share post over the share-only edge; she cannot reshare it
  // (Neighbors circle lacks reshare → 403), but Dana can (Family grants reshare).
  let postId: string | undefined;
  try {
    postId = (await ok(aaron, 'share.create', { type: 'SURPLUS', title: uniq('Equiv Surplus', P) })).id;
    expect(await inFeed(nia, postId!), 'Neighbors sees the Heise surplus').toBeTruthy();
    expect((await rpc(nia, 'share.reshare', { postId })).status, 'no reshare grant → 403').toBe(403);
    expect((await rpc(dana, 'share.reshare', { postId })).status, 'Family grants reshare → 200').toBe(200);
  } finally {
    // Withdrawing the origin cascades Dana's reshare copy.
    await withdrawQuietly(aaron, postId);
  }
});

test('circle CRUD and its capability + integrity gates', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana');
  const theo = await apiLogin('theo'); // Teen: no manageConnections

  const name = uniq('Book Club', P);
  let createdId: string | undefined;
  try {
    // Teen lacks manageConnections → 403 (capability, not visibility).
    expect((await rpc(theo, 'circle.create', { name, grants: FRIEND })).status).toBe(403);

    // A manager creates it; the same name again collides (409), including a
    // collision against a seeded preset name.
    createdId = (await ok(aaron, 'circle.create', { name, grants: NEIGHBOR })).id;
    expect((await rpc(aaron, 'circle.create', { name, grants: NEIGHBOR })).status, 'duplicate name → 409').toBe(409);
    expect((await rpc(aaron, 'circle.create', { name: 'Family', grants: FAMILY })).status, 'preset-name clash → 409').toBe(409);

    // A foreign household's manager cannot touch our circle (own-circle-only → 404).
    expect((await rpc(dana, 'circle.update', { circleId: createdId, name: `${name} X` })).status).toBe(404);
    expect((await rpc(dana, 'circle.delete', { circleId: createdId })).status).toBe(404);

    // Editing grants + rename take effect in the list.
    await ok(aaron, 'circle.update', { circleId: createdId, grants: FAMILY });
    await ok(aaron, 'circle.update', { circleId: createdId, name: `${name} 2` });
    const edited = (await circleList(aaron)).find((c) => c.id === createdId)!;
    expect(edited.name).toBe(`${name} 2`);
    expect(edited.grants).toEqual(FAMILY);

    // Delete-in-use → 409 (Family still holds the In-Laws edge); delete-empty → 200.
    const familyId = (await circle(aaron, 'Family')).id;
    expect((await rpc(aaron, 'circle.delete', { circleId: familyId })).status, 'circle in use → 409').toBe(409);
    expect((await rpc(aaron, 'circle.delete', { circleId: createdId })).status, 'empty circle → 200').toBe(200);
    createdId = undefined;
  } finally {
    if (createdId) await rpc(aaron, 'circle.delete', { circleId: createdId });
  }
});

test('moving a connection into another circle flips reach LIVE in both directions', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const nia = await apiLogin('nia');

  const seededNeighborsCircle = (await circle(aaron, 'Neighbors')).id;
  const edge = await connWith(aaron, 'Neighbors');
  let recipesCircleId: string | undefined;
  let postId: string | undefined;
  let recipeId: string | undefined;
  try {
    // A per-run recipes-only circle, plus a share post (currently reaches Nia via
    // Neighbors' shareTo) and a non-private recipe (currently NOT reaching her —
    // Neighbors grants no recipes).
    recipesCircleId = (await ok(aaron, 'circle.create', { name: uniq('Recipe Buddies', P), grants: RECIPES_ONLY })).id;
    postId = (await ok(aaron, 'share.create', { type: 'SURPLUS', title: uniq('Move Surplus', P) })).id;
    recipeId = (await ok(aaron, 'recipe.create', { title: uniq('Move Recipe', P), ingredients: [] })).id;
    expect(await inFeed(nia, postId!), 'share reaches Nia before the move').toBeTruthy();
    expect((await sharedRecipes(nia)).some((r) => r.id === recipeId), 'recipe NOT visible before the move').toBe(false);

    // Move Neighbors-household into the recipes-only circle.
    await ok(aaron, 'connection.assign', { connectionId: edge.id, circleId: recipesCircleId });

    // Reach flips immediately with a fresh read (no session/cache staleness):
    // the share drops (shareTo gone) and the recipe appears (recipes granted).
    expect(await inFeed(nia, postId!), 'share gone after move (shareTo removed)').toBeUndefined();
    expect((await sharedRecipes(nia)).some((r) => r.id === recipeId), 'recipe visible after move (recipes granted)').toBe(true);
  } finally {
    // Restore: return the edge to the seeded Neighbors circle FIRST (frees the
    // per-run circle from connection use), then drop the per-run artifacts.
    await rpc(aaron, 'connection.assign', { connectionId: edge.id, circleId: seededNeighborsCircle });
    if (recipeId) await rpc(aaron, 'recipe.delete', { recipeId });
    await withdrawQuietly(aaron, postId);
    if (recipesCircleId) await rpc(aaron, 'circle.delete', { circleId: recipesCircleId });
  }
});

test("editing a circle's grants changes reach live for every connection in it", async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana'); // In-Laws, sits in Heise's Family circle

  const heiseId = (await overview(aaron)).yourHouseholdId;
  const familyId = (await circle(aaron, 'Family')).id;
  let itemId: string | undefined;
  try {
    itemId = (await ok(aaron, 'item.create', { householdId: heiseId, name: uniq('Family Drill', P), feeCents: 0 })).id;
    // Dana reaches it via Family's lending grant — checkout then return to reset.
    const co = await ok(dana, 'loan.checkout', { itemId });
    await ok(dana, 'loan.return', { loanId: co.loanId });

    // Toggle Family's lending OFF — this IS the new setGrants: everyone in Family
    // loses lending reach at once. The item now reads as not-found to Dana
    // (a lost grant is a visibility miss → 404, never a 403).
    await ok(aaron, 'circle.update', { circleId: familyId, grants: { ...FAMILY, lending: false } });
    expect((await rpc(dana, 'loan.checkout', { itemId })).status, 'lending revoked → 404').toBe(404);
  } finally {
    await rpc(aaron, 'circle.update', { circleId: familyId, grants: FAMILY }); // restore the preset
    if (itemId) {
      execInApp(
        `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace(/^file:/,''));` +
          `db.prepare("DELETE FROM ItemCircle WHERE itemId='${itemId}'").run();` +
          `db.prepare("DELETE FROM Loan WHERE itemId='${itemId}'").run();` +
          `db.prepare("DELETE FROM Item WHERE id='${itemId}'").run();`,
      );
    }
  }
});

test('SELECT visibility needs BOTH the circle grant and the circle scope', async ({}, testInfo) => {
  const P = testInfo.project.name;
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana'); // In-Laws → Heise Family (pantry+lending grants)
  const nia = await apiLogin('nia'); // Neighbors → Heise Neighbors (no pantry/lending)

  const heiseId = (await overview(aaron)).yourHouseholdId;
  const familyId = (await circle(aaron, 'Family')).id;
  const neighborsId = (await circle(aaron, 'Neighbors')).id;
  let pantryId: string | undefined;
  let itemId: string | undefined;
  try {
    pantryId = (await ok(aaron, 'pantry.create', { name: uniq('Select Pantry', P) })).id;

    // SELECT [Family]: Dana (Family circle, pantry grant, scoped) reaches it; Nia
    // (no pantry grant) does not.
    await ok(aaron, 'pantry.setVisibility', { pantryId, visibility: 'SELECT', circleIds: [familyId] });
    expect((await browsablePantryIds(dana, 'Heise')).includes(pantryId!), 'Family-scoped: Dana reaches it').toBe(true);
    expect((await browsablePantryIds(nia, 'Heise')).includes(pantryId!), 'Nia lacks pantry grant').toBe(false);

    // SELECT [Neighbors]: now Dana loses it (she HAS the pantry grant via Family,
    // but the pantry is not scoped to Family), and Nia still cannot reach it (she
    // IS in a scoped circle, but Neighbors lacks the pantry grant). Grant and
    // visibility are each independently necessary.
    await ok(aaron, 'pantry.setVisibility', { pantryId, visibility: 'SELECT', circleIds: [neighborsId] });
    expect((await browsablePantryIds(dana, 'Heise')).includes(pantryId!), 'granted but not scoped → hidden').toBe(false);
    expect((await browsablePantryIds(nia, 'Heise')).includes(pantryId!), 'scoped but not granted → hidden').toBe(false);

    // The same shape for a lendable item via item.setVisibility + loan.checkout.
    itemId = (await ok(aaron, 'item.create', { householdId: heiseId, name: uniq('Select Drill', P), feeCents: 0 })).id;
    await ok(aaron, 'item.setVisibility', { itemId, visibility: 'SELECT', circleIds: [familyId] });
    const co = await ok(dana, 'loan.checkout', { itemId }); // Family: lending + scoped
    await ok(dana, 'loan.return', { loanId: co.loanId });
    await ok(aaron, 'item.setVisibility', { itemId, visibility: 'SELECT', circleIds: [neighborsId] });
    // Dana keeps the lending grant but the item is no longer scoped to Family → 404.
    expect((await rpc(dana, 'loan.checkout', { itemId })).status, 'granted but not scoped → 404').toBe(404);
  } finally {
    const parts: string[] = [];
    if (pantryId) {
      parts.push(`db.prepare("DELETE FROM PantryCircle WHERE pantryId='${pantryId}'").run();`);
      parts.push(`db.prepare("DELETE FROM Pantry WHERE id='${pantryId}'").run();`);
    }
    if (itemId) {
      parts.push(`db.prepare("DELETE FROM ItemCircle WHERE itemId='${itemId}'").run();`);
      parts.push(`db.prepare("DELETE FROM Loan WHERE itemId='${itemId}'").run();`);
      parts.push(`db.prepare("DELETE FROM Item WHERE id='${itemId}'").run();`);
    }
    if (parts.length) {
      execInApp(
        `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace(/^file:/,''));` +
          parts.join(''),
      );
    }
  }
});

test('an accepted household invite seeds preset circles and assigns both sides per the invite grants', async ({}, testInfo) => {
  const P = testInfo.project.name.slice(0, 4);
  const casa = `Ccirc-${P}-${RUN}`;
  // Distinct namespace from onboarding.spec's casa-* so the two files never
  // sweep each other's rows. FK-safe, circle-aware teardown.
  const SWEEP = `
    const D = require('better-sqlite3');
    const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
    const users = db.prepare("SELECT id FROM User WHERE email LIKE '%@ccirc.test'").all().map(r => r.id);
    const hhs = db.prepare("SELECT id FROM Household WHERE slug LIKE 'ccirc%'").all().map(r => r.id);
    for (const uid of users) db.prepare("DELETE FROM Invite WHERE createdById = ? OR usedById = ?").run(uid, uid);
    for (const id of hhs) {
      db.prepare("DELETE FROM Connection WHERE householdAId = ? OR householdBId = ?").run(id, id);
      db.prepare("DELETE FROM PantryCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
      db.prepare("DELETE FROM ItemCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
      db.prepare("DELETE FROM MembershipCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
      db.prepare("DELETE FROM Circle WHERE householdId = ?").run(id);
      db.prepare("DELETE FROM Pantry WHERE householdId = ?").run(id);
      db.prepare("DELETE FROM Membership WHERE householdId = ?").run(id);
      db.prepare("DELETE FROM Household WHERE id = ?").run(id);
    }
    for (const uid of users) {
      db.prepare("DELETE FROM Session WHERE userId = ?").run(uid);
      db.prepare("DELETE FROM Membership WHERE userId = ?").run(uid);
      db.prepare("DELETE FROM User WHERE id = ?").run(uid);
    }
  `;
  execInApp(SWEEP);
  const aaron = await apiLogin('aaron'); // instance admin → may mint household invites
  const guest = await playwrightRequest.newContext({ baseURL: BASE });
  try {
    // Aaron mints a household invite carrying the FRIEND grant tuple; a stranger
    // accepts, founding their household with the first edge to Heise.
    const minted = await ok(aaron, 'invite.createHousehold', { grants: FRIEND });
    const token = (minted.path as string).split('/invite/')[1];
    const accepted = await rpc(guest, 'auth.acceptInvite', {
      token,
      name: 'Cee',
      username: `cee-${P}-${RUN}`,
      email: `cee-${P}-${RUN}@ccirc.test`,
      password: PASSWORD,
      householdName: casa,
    });
    expect(accepted.status).toBe(200);

    // The new household starts with the three preset circles.
    expect((await circleList(guest)).map((c) => c.name).sort()).toEqual(['Family', 'Friends', 'Neighbors']);

    // The first edge is ACTIVE with BOTH sides assigned per the invite grants: a
    // FRIEND tuple maps to each household's 'Friends' preset circle.
    const guestEdge = await connWith(guest, 'Heise');
    expect(guestEdge.status).toBe('ACTIVE');
    expect(guestEdge.myCircle?.name).toBe('Friends');
    expect(guestEdge.myCircle?.grants).toEqual(FRIEND);
    expect(guestEdge.theyGrant).toEqual(FRIEND);

    // And Heise's side placed the newcomer in its own 'Friends' circle.
    expect((await connWith(aaron, casa)).myCircle?.name).toBe('Friends');
  } finally {
    await guest.dispose();
    execInApp(SWEEP);
  }
});

test('a circleId household invite snapshots the picked circle; the accepter lands in its tuple', async ({}, testInfo) => {
  const P = testInfo.project.name.slice(0, 4);
  const casa = `Ccirc2-${P}-${RUN}`;
  // Round T2: the invite UI picks one of the inviter's CIRCLES (not per-grant
  // checkboxes); the server resolves that circle's CURRENT grants tuple at mint
  // time into grantsJson (no schema change — same storage as the legacy {grants}
  // path above). This proves the circleId mint end to end. Own ccirc2 namespace
  // so it never sweeps the {grants} test's ccirc rows; FK-safe, circle-aware.
  const SWEEP = `
    const D = require('better-sqlite3');
    const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
    const users = db.prepare("SELECT id FROM User WHERE email LIKE '%@ccirc2.test'").all().map(r => r.id);
    const hhs = db.prepare("SELECT id FROM Household WHERE slug LIKE 'ccirc2%'").all().map(r => r.id);
    for (const uid of users) db.prepare("DELETE FROM Invite WHERE createdById = ? OR usedById = ?").run(uid, uid);
    for (const id of hhs) {
      db.prepare("DELETE FROM Connection WHERE householdAId = ? OR householdBId = ?").run(id, id);
      db.prepare("DELETE FROM PantryCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
      db.prepare("DELETE FROM ItemCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
      db.prepare("DELETE FROM MembershipCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
      db.prepare("DELETE FROM Circle WHERE householdId = ?").run(id);
      db.prepare("DELETE FROM Pantry WHERE householdId = ?").run(id);
      db.prepare("DELETE FROM Membership WHERE householdId = ?").run(id);
      db.prepare("DELETE FROM Household WHERE id = ?").run(id);
    }
    for (const uid of users) {
      db.prepare("DELETE FROM Session WHERE userId = ?").run(uid);
      db.prepare("DELETE FROM Membership WHERE userId = ?").run(uid);
      db.prepare("DELETE FROM User WHERE id = ?").run(uid);
    }
  `;
  execInApp(SWEEP);
  const aaron = await apiLogin('aaron'); // instance admin → may mint household invites
  const guest = await playwrightRequest.newContext({ baseURL: BASE });
  try {
    // Aaron mints picking his NON-DEFAULT Family circle (the one-click UI mint
    // defaults to Friends — this proves a picked circle other than the default
    // flows through). The server snapshots Family's CURRENT grants (FAMILY) into
    // the invite, exactly as the legacy {grants: FAMILY} path would have stored.
    const familyId = (await circle(aaron, 'Family')).id;
    const minted = await ok(aaron, 'invite.createHousehold', { circleId: familyId });
    const token = (minted.path as string).split('/invite/')[1];
    const accepted = await rpc(guest, 'auth.acceptInvite', {
      token,
      name: 'Dee',
      username: `dee-${P}-${RUN}`,
      email: `dee-${P}-${RUN}@ccirc2.test`,
      password: PASSWORD,
      householdName: casa,
    });
    expect(accepted.status).toBe(200);

    // The picked Family tuple (NOT the Friends default) lands on BOTH sides: the
    // accepter's edge to Heise carries FAMILY and maps to their own 'Family'
    // preset (same grants→circle remap the {grants} path uses)...
    const guestEdge = await connWith(guest, 'Heise');
    expect(guestEdge.status).toBe('ACTIVE');
    expect(guestEdge.myCircle?.name).toBe('Family');
    expect(guestEdge.myCircle?.grants).toEqual(FAMILY);
    expect(guestEdge.theyGrant).toEqual(FAMILY);

    // ...and Heise placed the newcomer in Heise's own 'Family' circle (the picked
    // circle), not the Friends the legacy default would have produced.
    expect((await connWith(aaron, casa)).myCircle?.name).toBe('Family');
  } finally {
    await guest.dispose();
    execInApp(SWEEP);
  }
});

test('PENDING semantics: request sets only the requester side; accept sets the addressee side', async () => {
  // In-Laws ↔ Neighbors are seeded UNCONNECTED. Drive one PENDING→ACTIVE edge
  // between them, then SQL-delete the row so the pair returns to no-row
  // "unconnected" (a SEVERED row would leak a pair to the money-reach checks).
  const PAIR_DELETE = `
    const D = require('better-sqlite3');
    const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
    const ids = db.prepare("SELECT id FROM Household WHERE slug IN ('in-laws','neighbors')").all().map(r => r.id);
    if (ids.length === 2) {
      db.prepare("DELETE FROM Connection WHERE householdAId IN (?, ?) AND householdBId IN (?, ?)")
        .run(ids[0], ids[1], ids[0], ids[1]);
    }
  `;
  execInApp(PAIR_DELETE); // clear any leak from an interrupted run
  const dana = await apiLogin('dana');
  const nia = await apiLogin('nia');
  try {
    const inlawsFamily = (await circle(dana, 'Family')).id;
    const neighborsNeighbors = (await circle(nia, 'Neighbors')).id;

    // Dana requests Neighbors, placing them in In-Laws' Family circle.
    const req = await ok(dana, 'connection.request', { slug: 'neighbors', circleId: inlawsFamily });
    const connId = req.id as string;

    // Requester side is set to Family; the addressee side is still empty, so from
    // the requester's view the counterparty grants NOTHING back yet.
    const danaPending = await connWith(dana, 'Neighbors');
    expect(danaPending.status).toBe('PENDING');
    expect(danaPending.requestedByUs).toBe(true);
    expect(danaPending.myCircle?.name).toBe('Family');
    expect(danaPending.theyGrant, 'addressee side unset → all-false').toEqual(NONE);

    // The addressee sees an incoming request with no circle of their own yet, but
    // reads what the requester extends to them (Family) from the requester's side.
    const niaPending = await connWith(nia, 'In-Laws');
    expect(niaPending.status).toBe('PENDING');
    expect(niaPending.requestedByUs).toBe(false);
    expect(niaPending.myCircle, 'addressee has assigned no circle yet').toBeNull();
    expect(niaPending.theyGrant, 'requester extends Family').toEqual(FAMILY);

    // Nia accepts into Neighbors' Neighbors circle → ACTIVE, addressee side set.
    await ok(nia, 'connection.respond', { connectionId: connId, accept: true, circleId: neighborsNeighbors });

    const niaActive = await connWith(nia, 'In-Laws');
    expect(niaActive.status).toBe('ACTIVE');
    expect(niaActive.myCircle?.name).toBe('Neighbors');
    // Dana now reads the neighbor tuple coming back from Neighbors.
    expect((await connWith(dana, 'Neighbors')).theyGrant).toEqual(NEIGHBOR);
  } finally {
    execInApp(PAIR_DELETE); // restore the seeded "unconnected" pair (no row)
  }
});

test('UI smoke: circle CRUD, connection move, and the visibility control on /more', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  const api = page.request; // the browser session's tRPC context (Api-shaped)
  const circleName = uniq('Book Club UI', P);

  /** Guaranteed restore, run whatever fails above: In-Laws back in Family, the
   *  Basement pantry back to ALL, and the per-run circle removed. */
  async function restore() {
    const inlaws = await connWith(api, 'In-Laws').catch(() => null);
    const fam = await circle(api, 'Family').catch(() => null);
    if (inlaws && fam && inlaws.myCircle?.id !== fam.id) {
      await rpc(api, 'connection.assign', { connectionId: inlaws.id, circleId: fam.id });
    }
    const basement = (await overview(api)).households
      .find((h) => h.name === 'Heise')
      ?.pantries.find((p) => p.name === 'Basement Pantry');
    if (basement) await rpc(api, 'pantry.setVisibility', { pantryId: basement.id, visibility: 'ALL' });
    const leftover = (await circleList(api)).find((c) => c.name === circleName);
    if (leftover) await rpc(api, 'circle.delete', { circleId: leftover.id });
  }

  await login(page, 'aaron');
  try {
    const familyId = (await circle(api, 'Family')).id;

    await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
    await expect(page.getByTestId('circles-card')).toBeVisible();

    // Create a circle (name + two grant checkboxes) via the sheet.
    await page.getByTestId('circle-create').click();
    await expect(page.getByTestId('circle-sheet')).toBeVisible();
    await page.getByTestId('circle-name').fill(circleName);
    await page.getByTestId('circle-grant-pantry').check();
    await page.getByTestId('circle-grant-recipes').check();
    await page.getByTestId('circle-save').click();
    await expect(page.getByTestId('circle-sheet')).toBeHidden();
    const newRow = page.getByTestId('circle-row').filter({ hasText: circleName });
    await expect(newRow).toBeVisible();
    const createdId = (await circle(api, circleName)).id;

    // Edit it: add lending, and confirm the grant persisted.
    await newRow.getByTestId('circle-edit').click();
    await page.getByTestId('circle-grant-lending').check();
    await page.getByTestId('circle-save').click();
    await expect(page.getByTestId('circle-sheet')).toBeHidden();
    expect((await circle(api, circleName)).grants.lending).toBe(true);

    // Move In-Laws into the new circle (the connection-move picker), then back to
    // Family — the "In: <circle>" line reflects each move.
    const inlawsRow = page.getByTestId('connection-row').filter({ hasText: 'In-Laws' });
    await inlawsRow.getByTestId('connection-move').click();
    await inlawsRow.getByTestId(`connection-circle-option-${createdId}`).check();
    await inlawsRow.getByTestId('connection-move-save').click();
    await expect(inlawsRow.getByTestId('connection-circle')).toHaveText(circleName);
    await inlawsRow.getByTestId('connection-move').click();
    await inlawsRow.getByTestId(`connection-circle-option-${familyId}`).check();
    await inlawsRow.getByTestId('connection-move-save').click();
    await expect(inlawsRow.getByTestId('connection-circle')).toHaveText('Family');

    // Delete the now-unused circle (window.confirm) — the row leaves the card.
    page.once('dialog', (d) => d.accept());
    await newRow.getByTestId('circle-delete').click();
    await expect(page.getByTestId('circle-row').filter({ hasText: circleName })).toHaveCount(0);

    // The pantry visibility control: flip Basement to PRIVATE (chip → "private"),
    // then back to ALL (chip → "shared").
    const basementId = (await overview(api)).households
      .find((h) => h.name === 'Heise')!
      .pantries.find((p) => p.name === 'Basement Pantry')!.id;
    await page.goto(`/pantries/${basementId}`);
    await page.getByTestId('pantry-visibility').click();
    await expect(page.getByTestId('pantry-visibility-sheet')).toBeVisible();
    await page.getByTestId('pantry-visibility-private').check();
    await page.getByTestId('pantry-visibility-save').click();
    await expect(page.getByTestId('pantry-visibility')).toHaveText('private');
    await page.getByTestId('pantry-visibility').click();
    await page.getByTestId('pantry-visibility-all').check();
    await page.getByTestId('pantry-visibility-save').click();
    await expect(page.getByTestId('pantry-visibility')).toHaveText('shared');
  } finally {
    await restore();
  }
});
