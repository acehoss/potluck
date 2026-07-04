import { db } from '../db';
import { protectedProcedure, router } from '../trpc';

export const householdRouter = router({
  /**
   * Everything every member is allowed to see — which, per SPEC §2
   * (full transparency), is all households, members, and pantries.
   */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const households = await db.household.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        memberships: {
          select: { user: { select: { id: true, name: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        pantries: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    return {
      yourHouseholdId: ctx.user.householdId,
      households: households.map((h) => ({
        id: h.id,
        name: h.name,
        members: h.memberships.map((m) => m.user),
        pantries: h.pantries,
      })),
    };
  }),
});
