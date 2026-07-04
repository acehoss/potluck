import { activeConnectionsOf } from '../authz';
import { db } from '../db';
import { protectedProcedure, router } from '../trpc';

export const householdRouter = router({
  /**
   * The acting household plus its ACTIVE connections (REWORK B4 replaces
   * SPEC §2's "everyone sees everything"): connected households appear with
   * their members and — only where the pantry grant is extended to us —
   * their SHARED pantries. Own pantries are always all visible.
   */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const connections = await activeConnectionsOf(db, ctx.user.householdId);
    const pantryGranters = new Set(
      connections.filter((c) => c.theyGrant.pantry).map((c) => c.counterpartyId),
    );
    const visibleIds = [ctx.user.householdId, ...connections.map((c) => c.counterpartyId)];
    const households = await db.household.findMany({
      where: { id: { in: visibleIds } },
      orderBy: { createdAt: 'asc' },
      include: {
        memberships: {
          select: { user: { select: { id: true, name: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        pantries: { select: { id: true, name: true, shared: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    return {
      yourHouseholdId: ctx.user.householdId,
      households: households.map((h) => ({
        id: h.id,
        name: h.name,
        members: h.memberships.map((m) => m.user),
        pantries: h.pantries
          .filter(
            (p) =>
              h.id === ctx.user.householdId || (p.shared && pantryGranters.has(h.id)),
          )
          .map((p) => ({ id: p.id, name: p.name })),
      })),
    };
  }),
});
