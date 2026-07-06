import type { Prisma } from '@/generated/prisma/client';
import { getConnection, grantsFrom } from './authz';
import { db } from './db';

/**
 * The share-visibility primitive, in its own trpc-free module so background jobs
 * (the digest + its in-process scheduler) can ask "can this household still see
 * that household's posts?" WITHOUT importing `routers/share` — which pulls in
 * the tRPC/auth layer and its native argon2 dependency. `routers/share.ts`
 * re-uses this same function for the live feed.
 */

/** Either the base client or a transaction client — share checks run under both. */
export type Dbc = Prisma.TransactionClient | typeof db;

/**
 * Share-visibility primitive (F2/B2): over an ACTIVE connection, does the
 * poster grant the viewer `shareTo` (my posts reach you) AND does the viewer
 * grant the poster `shareFrom` (show me their posts)? Both must be on.
 * Own-household is a separate branch the callers handle first.
 */
export async function shareVisible(dbc: Dbc, posterHouseholdId: string, viewerHouseholdId: string) {
  const conn = await getConnection(dbc, posterHouseholdId, viewerHouseholdId);
  if (!conn || conn.status !== 'ACTIVE') return false;
  return (
    grantsFrom(conn, posterHouseholdId).shareTo && grantsFrom(conn, viewerHouseholdId).shareFrom
  );
}
