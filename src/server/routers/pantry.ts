import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireCapability } from '../authz';
import { db } from '../db';
import { protectedProcedure, router } from '../trpc';

export const pantryRouter = router({
  /**
   * Create a pantry in the ACTING household (manageHousehold — A3a puts
   * pantries under household management). Households founded through an
   * invite start with none, so this is the first thing a new household does.
   */
  create: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageHousehold');
      const pantry = await db.pantry.create({
        data: { name: input.name, householdId: ctx.user.householdId },
      });
      return { id: pantry.id };
    }),

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
