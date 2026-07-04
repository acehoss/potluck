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

type ConnectionRow = {
  householdAId: string;
  householdBId: string;
  status: string;
  aGrantsPantry: boolean;
  aGrantsLending: boolean;
  aGrantsRecipes: boolean;
  aGrantsShareTo: boolean;
  aGrantsShareFrom: boolean;
  aGrantsReshare: boolean;
  bGrantsPantry: boolean;
  bGrantsLending: boolean;
  bGrantsRecipes: boolean;
  bGrantsShareTo: boolean;
  bGrantsShareFrom: boolean;
  bGrantsReshare: boolean;
};

/** The 6 write-ready Connection columns for one side's grant set. */
export function grantColumns(side: 'a' | 'b', grants: GrantSet) {
  const cap = (g: string) => g.charAt(0).toUpperCase() + g.slice(1);
  return Object.fromEntries(GRANTS.map((g) => [`${side}Grants${cap(g)}`, grants[g]]));
}

/** The grant set `granter` extends to the other side of `connection`. */
export function grantsFrom(connection: ConnectionRow, granterHouseholdId: string): GrantSet {
  const side = connection.householdAId === granterHouseholdId ? 'a' : 'b';
  return side === 'a'
    ? {
        pantry: connection.aGrantsPantry,
        lending: connection.aGrantsLending,
        recipes: connection.aGrantsRecipes,
        shareTo: connection.aGrantsShareTo,
        shareFrom: connection.aGrantsShareFrom,
        reshare: connection.aGrantsReshare,
      }
    : {
        pantry: connection.bGrantsPantry,
        lending: connection.bGrantsLending,
        recipes: connection.bGrantsRecipes,
        shareTo: connection.bGrantsShareTo,
        shareFrom: connection.bGrantsShareFrom,
        reshare: connection.bGrantsReshare,
      };
}

/** The connection row for a pair (canonical order), any status, or null. */
export function getConnection(dbc: Dbc, householdId1: string, householdId2: string) {
  const [householdAId, householdBId] = [householdId1, householdId2].sort();
  return dbc.connection.findUnique({
    where: { householdAId_householdBId: { householdAId, householdBId } },
  });
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
  });
  return rows.map((row) => {
    const counterpartyId = row.householdAId === householdId ? row.householdBId : row.householdAId;
    return {
      connectionId: row.id,
      counterpartyId,
      /** What the counterparty lets US do with their resources. */
      theyGrant: grantsFrom(row, counterpartyId),
      /** What we let the counterparty do with ours. */
      weGrant: grantsFrom(row, householdId),
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
    const visible =
      pantry.shared && (await hasActiveGrant(dbc, pantry.householdId, user.householdId, 'pantry'));
    if (!visible) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
  }
  return { pantry, isOwn };
}
