import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';
import type { SessionUser } from './auth';
import type { Capability } from './capabilities';
import { db } from './db';

/**
 * Capability + connection-grant checks (REWORK A3a/B2) — the authz layer
 * every mutation/query goes through from Round 1 slice 2 on.
 *
 * Two axes, checked separately:
 *  - MEMBERSHIP CAPABILITY: may this user, acting as their active household,
 *    perform this kind of action at all? (typed flag on the acting Membership)
 *  - CONNECTION GRANT: may the acting household reach the counterparty's
 *    resource? (directional flag the RESOURCE OWNER controls unilaterally)
 *
 * Error-code convention: lacking a capability on something you can see is
 * FORBIDDEN (403); lacking visibility (no grant / not shared / no connection)
 * is NOT_FOUND (404) so scoping never leaks what exists.
 *
 * Capability checks vs clientKey replays: capability checks run FIRST, before
 * the replay lookup. A retry of an already-committed money op by a user who
 * has since lost the capability reads as 403 while the original post stands —
 * fail-closed and never double-posting (a replay by construction posts no new
 * money, so either ordering is money-safe; this one is simply the convention).
 */

type Dbc = Prisma.TransactionClient | typeof db;

/** The acting membership must carry `capability`, else 403. */
export function requireCapability(user: SessionUser, capability: Capability): void {
  if (!user.activeMembership[capability]) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: "Your role in this household doesn't allow that.",
    });
  }
}

/** The user's membership in `householdId`, or null. Not acting-household-bound. */
export function membershipIn(user: SessionUser, householdId: string) {
  return user.memberships.find((m) => m.householdId === householdId) ?? null;
}

export const GRANTS = ['pantry', 'lending', 'recipes', 'shareTo', 'shareFrom', 'reshare'] as const;
export type Grant = (typeof GRANTS)[number];
export type GrantSet = Record<Grant, boolean>;

function grantPreset(granted: readonly Grant[]): GrantSet {
  return Object.fromEntries(GRANTS.map((g) => [g, granted.includes(g)])) as GrantSet;
}

/**
 * Named "levels" over the grant flags (REWORK B2) — starting points in the
 * connection UI, individually tunable afterwards, never a schema concept.
 */
export const GRANT_PRESETS = {
  /** Neighbor — needs/surpluses flow both ways; nothing else. */
  neighbor: grantPreset(['shareTo', 'shareFrom']),
  /** Friend — plus pantry browsing/ordering, lending, recipes. */
  friend: grantPreset(['pantry', 'lending', 'recipes', 'shareTo', 'shareFrom']),
  /** Family — everything, including onward resharing. */
  family: grantPreset([...GRANTS]),
} as const;

export type GrantPresetName = keyof typeof GRANT_PRESETS;

/** The six circle grant columns — a circle's stored bundle. */
type CircleGrants = {
  grantsPantry: boolean;
  grantsLending: boolean;
  grantsRecipes: boolean;
  grantsShareTo: boolean;
  grantsShareFrom: boolean;
  grantsReshare: boolean;
};

/** A circle's grant columns as a GrantSet; a null circle grants nothing. */
export function circleToGrantSet(circle: CircleGrants | null): GrantSet {
  if (!circle) return grantPreset([]);
  return {
    pantry: circle.grantsPantry,
    lending: circle.grantsLending,
    recipes: circle.grantsRecipes,
    shareTo: circle.grantsShareTo,
    shareFrom: circle.grantsShareFrom,
    reshare: circle.grantsReshare,
  };
}

/** A connection with both sides' assigned circles loaded (grantsFrom's input). */
type ConnectionWithCircles = {
  householdAId: string;
  householdBId: string;
  aCircle: CircleGrants | null;
  bCircle: CircleGrants | null;
};

/** The Prisma include that makes a Connection usable by grantsFrom. */
const CIRCLE_INCLUDE = { aCircle: true, bCircle: true } as const;

/**
 * The grant set `granter` extends to the other side of `connection` (P4): the
 * bundle of the circle the granter placed the counterparty into. API-stable
 * with the pre-circles version — same name, same GrantSet return — so every
 * consumer keeps working once the connection row carries its circles.
 */
export function grantsFrom(
  connection: ConnectionWithCircles,
  granterHouseholdId: string,
): GrantSet {
  const side = connection.householdAId === granterHouseholdId ? 'a' : 'b';
  return circleToGrantSet(side === 'a' ? connection.aCircle : connection.bCircle);
}

/** The connection row for a pair (canonical order), any status, or null. */
export function getConnection(dbc: Dbc, householdId1: string, householdId2: string) {
  const [householdAId, householdBId] = [householdId1, householdId2].sort();
  return dbc.connection.findUnique({
    where: { householdAId_householdBId: { householdAId, householdBId } },
    include: CIRCLE_INCLUDE,
  });
}

export type CircleReach = { circleId: string; grants: GrantSet };

/**
 * The circle `ownerHouseholdId` placed `viewerHouseholdId` into on their ACTIVE
 * edge — the resolution behind every cross-household reach check. Returns the
 * circle id (for SELECT-scope lookups) plus its grants, or null when there is
 * no ACTIVE edge or the owner's side is unassigned. Own-household is never a
 * grant question — callers branch on it first.
 */
export async function resolveGrantingCircle(
  dbc: Dbc,
  ownerHouseholdId: string,
  viewerHouseholdId: string,
): Promise<CircleReach | null> {
  if (ownerHouseholdId === viewerHouseholdId) return null;
  const conn = await getConnection(dbc, ownerHouseholdId, viewerHouseholdId);
  if (!conn || conn.status !== 'ACTIVE') return null;
  const ownerIsA = conn.householdAId === ownerHouseholdId;
  const circleId = ownerIsA ? conn.aCircleId : conn.bCircleId;
  const circle = ownerIsA ? conn.aCircle : conn.bCircle;
  if (!circleId || !circle) return null;
  return { circleId, grants: circleToGrantSet(circle) };
}

/**
 * The circle-visibility half of the reach rule (P4): a resource is visible to a
 * circle when its mode is ALL, never when PRIVATE, and for SELECT only when a
 * scope row ties it to that circle (`scoped`).
 */
export function visibleUnderCircle(visibility: string, scoped: boolean): boolean {
  if (visibility === 'ALL') return true;
  if (visibility === 'PRIVATE') return false;
  return scoped; // SELECT
}

/**
 * Full single-resource reach (P4): the viewer reaches the owner's resource iff
 * an ACTIVE edge's circle grants `grant` AND the resource is visible to that
 * circle. `isScoped` is consulted ONLY for SELECT resources — callers pass a
 * thunk that looks up the resource↔circle join so ALL/PRIVATE cost no query.
 */
export async function reachesResource(
  dbc: Dbc,
  ownerHouseholdId: string,
  viewerHouseholdId: string,
  grant: Grant,
  resource: { visibility: string },
  isScoped: (circleId: string) => Promise<boolean> | boolean,
): Promise<boolean> {
  const circle = await resolveGrantingCircle(dbc, ownerHouseholdId, viewerHouseholdId);
  if (!circle || !circle.grants[grant]) return false;
  if (resource.visibility !== 'SELECT') return visibleUnderCircle(resource.visibility, false);
  return !!(await isScoped(circle.circleId));
}

/**
 * A member's own visibility against an ALREADY-RESOLVED circle (REWORK P4/P5).
 * A member is NOT gated by one of the six grants (members ride the edge itself),
 * only by their visibility mode against the circle the owner placed the viewer
 * into: ALL always, PRIVATE never, SELECT iff a MembershipCircle ties them to
 * that circle. A null circle (no reach) never shows the member. Shared by the
 * ACTIVE-edge `reachesMember` and Round C's PENDING request-preview, which
 * resolves the requester's circle itself.
 */
export async function memberVisibleUnderCircle(
  dbc: Dbc,
  circle: CircleReach | null,
  member: { id: string; visibility: string },
): Promise<boolean> {
  if (!circle) return false;
  if (member.visibility !== 'SELECT') return visibleUnderCircle(member.visibility, false);
  return (
    (await dbc.membershipCircle.findUnique({
      where: { membershipId_circleId: { membershipId: member.id, circleId: circle.circleId } },
    })) !== null
  );
}

/**
 * Contact-layer member reach over an ACTIVE edge (REWORK P4/P5) — exported for
 * Round C. Resolves the circle the owner placed the viewer into, then defers to
 * `memberVisibleUnderCircle`. Own-household is never a grant question — callers
 * branch on it first.
 */
export async function reachesMember(
  dbc: Dbc,
  ownerHouseholdId: string,
  viewerHouseholdId: string,
  member: { id: string; visibility: string },
): Promise<boolean> {
  const circle = await resolveGrantingCircle(dbc, ownerHouseholdId, viewerHouseholdId);
  return memberVisibleUnderCircle(dbc, circle, member);
}

/**
 * True iff an ACTIVE connection exists on which `granter` extends `grant` to
 * `grantee`. Same-household is never a grant question — callers branch on
 * own-household first.
 */
export async function hasActiveGrant(
  dbc: Dbc,
  granterHouseholdId: string,
  granteeHouseholdId: string,
  grant: Grant,
): Promise<boolean> {
  const connection = await getConnection(dbc, granterHouseholdId, granteeHouseholdId);
  if (!connection || connection.status !== 'ACTIVE') return false;
  return grantsFrom(connection, granterHouseholdId)[grant];
}

/**
 * Every ACTIVE connection of `householdId`, normalized to the counterparty
 * with both directions' grants. Feeds page scoping.
 */
export async function activeConnectionsOf(dbc: Dbc, householdId: string) {
  const rows = await dbc.connection.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ householdAId: householdId }, { householdBId: householdId }],
    },
    include: CIRCLE_INCLUDE,
  });
  return rows.map((row) => {
    const iAmA = row.householdAId === householdId;
    const counterpartyId = iAmA ? row.householdBId : row.householdAId;
    return {
      connectionId: row.id,
      counterpartyId,
      /** What the counterparty lets US do with their resources. */
      theyGrant: grantsFrom(row, counterpartyId),
      /** What we let the counterparty do with ours. */
      weGrant: grantsFrom(row, householdId),
      /** The circle the counterparty placed US into — for SELECT-visibility of
       *  THEIR resources (a bulk-scan counterpart to resolveGrantingCircle). */
      theirCircleId: iAmA ? row.bCircleId : row.aCircleId,
      /** The circle WE placed the counterparty into (Round C member scoping). */
      ourCircleId: iAmA ? row.aCircleId : row.bCircleId,
    };
  });
}

/**
 * Load a pantry the acting household may SEE: its own, or a shared pantry of
 * a household that grants it `pantry`. 404 on anything else (existence never
 * leaks). Returns `isOwn` for capability-gated affordances.
 */
export async function loadAccessiblePantry(dbc: Dbc, user: SessionUser, pantryId: string) {
  const pantry = await dbc.pantry.findUnique({
    where: { id: pantryId },
    include: { household: { select: { id: true, name: true } } },
  });
  if (!pantry) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
  const isOwn = pantry.householdId === user.householdId;
  if (!isOwn) {
    const visible = await reachesResource(
      dbc,
      pantry.householdId,
      user.householdId,
      'pantry',
      pantry,
      (circleId) =>
        dbc.pantryCircle
          .findUnique({ where: { pantryId_circleId: { pantryId: pantry.id, circleId } } })
          .then(Boolean),
    );
    if (!visible) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
  }
  return { pantry, isOwn };
}
