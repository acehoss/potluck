import { openLoopsFor } from '../open-loops';
import { protectedProcedure, router } from '../trpc';

/**
 * Activity — the acting household's attention feed (Phase-2 Round D). A DERIVED
 * read over existing state; it owns NO schema and adds NO mutations. Every
 * inline action the UI hangs off an item calls the SAME tRPC mutation (with the
 * same guards + clientKeys) its origin surface does — Activity is a denser
 * second door onto orders/restocks/shares/connections, never a new one.
 *
 * Five item types surface, each carrying `actionable` = "THIS user, acting as
 * this household, holds the capability to advance it" (the can/hide rule — an
 * informative row for the whole household, an action only for who can perform
 * it). `actionableCount` (the bell badge) is exactly the count of actionable
 * items. Money never fires from a list row: order-out READY is actionable (the
 * pickup capability) but the UI deep-links to the order detail rather than
 * inlining the money post.
 *
 * The derived read itself (`openLoopsFor`) and the `ActivityItem` type live in
 * the trpc-free `../open-loops` module so background jobs (the digest + its
 * scheduler) can share them without importing the tRPC/auth layer; the type is
 * re-exported here so existing `@/server/routers/activity` imports keep working.
 */

export type { ActivityItem } from '../open-loops';

export const activityRouter = router({
  /**
   * The attention list for the acting household, newest-attention first, capped
   * at 50 (a mutual-aid instance never has a real backlog; pagination is a
   * door). Returns `actionableCount` for the bell badge.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    return openLoopsFor(ctx.user.householdId, ctx.user.activeMembership);
  }),
});
