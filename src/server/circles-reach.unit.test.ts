import assert from 'node:assert/strict';
import { before, test } from 'node:test';

// authz.ts pulls in db.ts, which constructs a client at import and requires
// DATABASE_URL. The reach helpers under test take their `dbc` as a parameter
// (mocked below), so the real client is never queried — point it at a throwaway
// file and dynamic-import in a before hook (top-level await isn't available
// under tsx's cjs transform).
process.env.DATABASE_URL ||= 'file:/tmp/circles-reach-test.db';
let reachesResource: typeof import('./authz').reachesResource;
let visibleUnderCircle: typeof import('./authz').visibleUnderCircle;
let circleToGrantSet: typeof import('./authz').circleToGrantSet;

before(async () => {
  ({ reachesResource, visibleUnderCircle, circleToGrantSet } = await import('./authz'));
});

const FAMILY = {
  grantsPantry: true,
  grantsLending: true,
  grantsRecipes: true,
  grantsShareTo: true,
  grantsShareFrom: true,
  grantsReshare: true,
};
const SHARE_ONLY = { ...FAMILY, grantsPantry: false, grantsLending: false, grantsRecipes: false, grantsReshare: false };

/** A fake dbc whose getConnection returns one ACTIVE edge owner→viewer. */
function fakeDbc(ownerCircle: object | null, status = 'ACTIVE') {
  return {
    connection: {
      findUnique: async () => ({
        householdAId: 'owner', // 'owner' < 'viewer' so owner is side A
        householdBId: 'viewer',
        status,
        aCircleId: ownerCircle ? 'circ' : null,
        bCircleId: 'other',
        aCircle: ownerCircle,
        bCircle: SHARE_ONLY,
      }),
    },
  } as never;
}

const hit = () => true;
const miss = () => false;

test('visibleUnderCircle: ALL always, PRIVATE never, SELECT follows scope', () => {
  assert.equal(visibleUnderCircle('ALL', false), true);
  assert.equal(visibleUnderCircle('ALL', true), true);
  assert.equal(visibleUnderCircle('PRIVATE', true), false);
  assert.equal(visibleUnderCircle('PRIVATE', false), false);
  assert.equal(visibleUnderCircle('SELECT', true), true);
  assert.equal(visibleUnderCircle('SELECT', false), false);
});

test('circleToGrantSet: null grants nothing; a circle maps its six flags', () => {
  const none = circleToGrantSet(null);
  assert.deepEqual(none, {
    pantry: false,
    lending: false,
    recipes: false,
    shareTo: false,
    shareFrom: false,
    reshare: false,
  });
  assert.equal(circleToGrantSet(FAMILY).pantry, true);
  assert.equal(circleToGrantSet(SHARE_ONLY).pantry, false);
  assert.equal(circleToGrantSet(SHARE_ONLY).shareTo, true);
});

test('reachesResource: grant ON — reach follows the resource visibility', async () => {
  const dbc = fakeDbc(FAMILY); // pantry grant on
  assert.equal(await reachesResource(dbc, 'owner', 'viewer', 'pantry', { visibility: 'ALL' }, miss), true);
  assert.equal(await reachesResource(dbc, 'owner', 'viewer', 'pantry', { visibility: 'PRIVATE' }, hit), false);
  assert.equal(await reachesResource(dbc, 'owner', 'viewer', 'pantry', { visibility: 'SELECT' }, hit), true);
  assert.equal(await reachesResource(dbc, 'owner', 'viewer', 'pantry', { visibility: 'SELECT' }, miss), false);
});

test('reachesResource: grant OFF — never reaches, even for an ALL/SELECT-hit resource', async () => {
  const dbc = fakeDbc(SHARE_ONLY); // pantry grant off
  assert.equal(await reachesResource(dbc, 'owner', 'viewer', 'pantry', { visibility: 'ALL' }, hit), false);
  assert.equal(await reachesResource(dbc, 'owner', 'viewer', 'pantry', { visibility: 'SELECT' }, hit), false);
  // A grant the circle DOES hold still gates on visibility.
  assert.equal(await reachesResource(dbc, 'owner', 'viewer', 'shareTo', { visibility: 'ALL' }, miss), true);
});

test('reachesResource: no ACTIVE edge / unassigned side never reaches', async () => {
  assert.equal(
    await reachesResource(fakeDbc(FAMILY, 'PENDING'), 'owner', 'viewer', 'pantry', { visibility: 'ALL' }, hit),
    false,
  );
  assert.equal(
    await reachesResource(fakeDbc(null), 'owner', 'viewer', 'pantry', { visibility: 'ALL' }, hit),
    false,
  );
});
