import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

/** ALL (every pantry-granted circle) | SELECT (listed circles) | PRIVATE (own). */
const visibilitySchema = z.enum(['ALL', 'SELECT', 'PRIVATE']);

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
   * Circle-scoped visibility (REWORK P4, replaces setShared): ALL exposes the
   * pantry to every circle that holds the pantry grant; SELECT restricts it to
   * the given OWN circles (≥1 required, foreign/absent ids → 404); PRIVATE hides
   * it from everyone. The circle scope rows are replaced atomically so a switch
   * to ALL/PRIVATE leaves none behind. Household management (A3a).
   */
  setVisibility: protectedProcedure
    .input(
      z.object({
        pantryId: z.string().min(1),
        visibility: visibilitySchema,
        circleIds: z.array(z.string().min(1)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageHousehold');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const pantry = await tx.pantry.findUnique({ where: { id: input.pantryId } });
        if (!pantry || pantry.householdId !== me) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
        }
        const circleIds = input.visibility === 'SELECT' ? [...new Set(input.circleIds ?? [])] : [];
        if (input.visibility === 'SELECT' && circleIds.length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick at least one circle.' });
        }
        if (circleIds.length) {
          const owned = await tx.circle.count({
            where: { id: { in: circleIds }, householdId: me },
          });
          if (owned !== circleIds.length) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'No such circle.' });
          }
        }
        await tx.pantry.update({
          where: { id: pantry.id },
          data: { visibility: input.visibility },
        });
        await tx.pantryCircle.deleteMany({ where: { pantryId: pantry.id } });
        if (circleIds.length) {
          await tx.pantryCircle.createMany({
            data: circleIds.map((circleId) => ({ pantryId: pantry.id, circleId })),
          });
        }
        return { visibility: input.visibility };
      });
    }),
});
