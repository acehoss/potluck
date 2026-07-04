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
    const me = ctx.user.householdId;
    const connections = await activeConnectionsOf(db, me);
    // Per counterparty that grants us pantry: the circle THEY placed US into —
    // the key for SELECT-visibility of their pantries (REWORK P4).
    const pantryCircleByHousehold = new Map(
      connections
        .filter((c) => c.theyGrant.pantry)
        .map((c) => [c.counterpartyId, c.theirCircleId]),
    );
    const visibleIds = [me, ...connections.map((c) => c.counterpartyId)];
    const households = await db.household.findMany({
      where: { id: { in: visibleIds } },
      orderBy: { createdAt: 'asc' },
      include: {
        memberships: {
          select: { user: { select: { id: true, name: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        pantries: {
          select: { id: true, name: true, visibility: true, circles: { select: { circleId: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return {
      yourHouseholdId: me,
      households: households.map((h) => {
        const theirCircleId = pantryCircleByHousehold.get(h.id);
        return {
          id: h.id,
          name: h.name,
          members: h.memberships.map((m) => m.user),
          pantries: h.pantries
            .filter((p) => {
              if (h.id === me) return true; // own household: all pantries
              if (theirCircleId === undefined) return false; // no pantry grant to us
              if (p.visibility === 'ALL') return true;
              if (p.visibility === 'PRIVATE') return false;
              return p.circles.some((c) => c.circleId === theirCircleId); // SELECT
            })
            .map((p) => ({ id: p.id, name: p.name })),
        };
      }),
    };
  }),
});
