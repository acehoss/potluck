import type { Prisma } from '@/generated/prisma/client';
import { getConnection, grantsFrom } from './authz';
import type { db } from './db';

/**
 * The share-visibility primitive, in its own trpc-free module so background jobs
 * (the digest + its in-process scheduler) can ask "can this household still see
 * that household's posts?" WITHOUT importing `routers/share` — which pulls in
 * the tRPC/auth layer and its native argon2 dependency. `routers/share.ts`
 * re-uses this same function for the live feed.
 */

/** Either the base client or a transaction client — share checks run under both. */
export type Dbc = Prisma.TransactionClient | typeof db;

export function prismaForShareReach(dbc: Dbc): Prisma.TransactionClient {
  return dbc as unknown as Prisma.TransactionClient;
}

type CircleGrants = {
  grantsPantry: boolean;
  grantsLending: boolean;
  grantsRecipes: boolean;
  grantsShareTo: boolean;
  grantsShareFrom: boolean;
  grantsReshare: boolean;
};

export type ShareConnection = {
  householdAId: string;
  householdBId: string;
  status: string;
  aCircleId: string | null;
  bCircleId: string | null;
  aCircle: CircleGrants | null;
  bCircle: CircleGrants | null;
};

export type ShareScopedPost = {
  visibility: string;
  scopeCircleIds: readonly string[];
};

export type SharePosterReach = {
  connection: ShareConnection;
  posterSideCircleId: string | null;
};

/** The circle the poster placed the viewer into on this connection. */
export function posterSideCircleId(
  connection: Pick<ShareConnection, 'householdAId' | 'householdBId' | 'aCircleId' | 'bCircleId'>,
  posterHouseholdId: string,
): string | null {
  if (connection.householdAId === posterHouseholdId) return connection.aCircleId;
  if (connection.householdBId === posterHouseholdId) return connection.bCircleId;
  return null;
}

/** The shareVisible rule applied to an already-loaded connection row. */
export function shareVisibleOnConnection(
  connection: ShareConnection,
  posterHouseholdId: string,
  viewerHouseholdId: string,
): boolean {
  if (connection.status !== 'ACTIVE') return false;
  const samePair =
    (connection.householdAId === posterHouseholdId && connection.householdBId === viewerHouseholdId) ||
    (connection.householdAId === viewerHouseholdId && connection.householdBId === posterHouseholdId);
  if (!samePair) return false;
  return (
    grantsFrom(connection, posterHouseholdId).shareTo &&
    grantsFrom(connection, viewerHouseholdId).shareFrom
  );
}

/** Circle-scoped share visibility once the connection and scope rows are known. */
export function postVisibleToConnection(
  post: ShareScopedPost,
  posterSideCircleIdValue: string | null | undefined,
): boolean {
  if (post.visibility === 'ALL') return true;
  if (post.visibility !== 'SELECT') return false;
  return !!posterSideCircleIdValue && post.scopeCircleIds.includes(posterSideCircleIdValue);
}

/** For one viewer, index active/share-visible poster households from loaded connections. */
export function sharePosterReachByHousehold(
  connections: readonly ShareConnection[],
  viewerHouseholdId: string,
): Map<string, SharePosterReach> {
  const reach = new Map<string, SharePosterReach>();
  for (const connection of connections) {
    const posterHouseholdId =
      connection.householdAId === viewerHouseholdId ? connection.householdBId : connection.householdAId;
    if (!shareVisibleOnConnection(connection, posterHouseholdId, viewerHouseholdId)) continue;
    reach.set(posterHouseholdId, {
      connection,
      posterSideCircleId: posterSideCircleId(connection, posterHouseholdId),
    });
  }
  return reach;
}

/**
 * Share-visibility primitive (F2/B2): over an ACTIVE connection, does the
 * poster grant the viewer `shareTo` (my posts reach you) AND does the viewer
 * grant the poster `shareFrom` (show me their posts)? Both must be on.
 * Own-household is a separate branch the callers handle first.
 */
export async function shareVisible(dbc: Dbc, posterHouseholdId: string, viewerHouseholdId: string) {
  const conn = await getConnection(dbc, posterHouseholdId, viewerHouseholdId);
  return !!conn && shareVisibleOnConnection(conn, posterHouseholdId, viewerHouseholdId);
}

/** Hard reshare depth cap (F4). */
export const HOP_MAX = 3;

export function scopeCircleIdsByPost(rows: { sharePostId: string; circleId: string }[]) {
  const byPost = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byPost.get(row.sharePostId);
    if (ids) ids.push(row.circleId);
    else byPost.set(row.sharePostId, [row.circleId]);
  }
  return byPost;
}

export async function loadScopeCircleIds(dbc: Dbc, postIds: string[]) {
  if (postIds.length === 0) return new Map<string, string[]>();
  return scopeCircleIdsByPost(
    await prismaForShareReach(dbc).sharePostCircle.findMany({
      where: { sharePostId: { in: postIds } },
      select: { sharePostId: true, circleId: true },
    }),
  );
}

/** Full scoped-visibility test for one post/viewer pair (own → connection → circle scope). */
export async function postVisibleToHousehold(
  dbc: Dbc,
  post: { id: string; householdId: string; visibility: string },
  viewerHouseholdId: string,
) {
  if (post.householdId === viewerHouseholdId) return true;
  const conn = await getConnection(dbc, post.householdId, viewerHouseholdId);
  if (!conn || !shareVisibleOnConnection(conn, post.householdId, viewerHouseholdId)) return false;
  const scopeIds =
    post.visibility === 'SELECT' ? (await loadScopeCircleIds(dbc, [post.id])).get(post.id) ?? [] : [];
  return postVisibleToConnection(
    { visibility: post.visibility, scopeCircleIds: scopeIds },
    posterSideCircleId(conn, post.householdId),
  );
}

/**
 * A reshare copy stays live only while every hop up to the origin still holds:
 * at each hop the broker (that copy's household) must still share-see its
 * PARENT post's household — including the parent's circle scope. Severing any
 * upstream edge (or re-assigning the broker out of a scoped parent's circles)
 * kills the chain downstream (B6/F4). Capped at the hard reshare depth. Lives
 * here (not routers/share) so the digest can prune dead chains too.
 */
export async function chainEdgesAlive(
  dbc: Dbc,
  copy: { parentPostId: string | null; householdId: string },
): Promise<boolean> {
  let current = copy;
  for (let hop = 0; hop <= HOP_MAX && current.parentPostId; hop++) {
    const parent = await prismaForShareReach(dbc).sharePost.findUnique({
      where: { id: current.parentPostId },
    });
    if (!parent) return false;
    if (!(await postVisibleToHousehold(dbc, parent, current.householdId))) return false;
    current = parent;
  }
  return true;
}
