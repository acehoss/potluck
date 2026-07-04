import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireCapability } from '../authz';
import { db } from '../db';
import { protectedProcedure, router } from '../trpc';

export const pantryRouter = router({
  /**
   * Household-wide shared/private flag (REWORK B3): a private pantry is
   * invisible to every connection, grant or not; shared is the default and
   * exposes it identically to every pantry-granted connection. Shared flags
   * are household management (A3a).
   */
  setShared: protectedProcedure
    .input(z.object({ pantryId: z.string().min(1), shared: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageHousehold');
      const pantry = await db.pantry.findUnique({ where: { id: input.pantryId } });
      if (!pantry || pantry.householdId !== ctx.user.householdId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
      }
      await db.pantry.update({ where: { id: pantry.id }, data: { shared: input.shared } });
      return { shared: input.shared };
    }),
});
