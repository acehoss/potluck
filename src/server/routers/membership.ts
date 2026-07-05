import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireCapability } from '../authz';
import { dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

/**
 * Contact-layer member visibility (REWORK P5, Round C). A membership's card is
 * shown to a connected household per this setting against the circle that
 * household was placed into: ALL (every circle) / SELECT (only the listed OWN
 * circles, via MembershipCircle) / PRIVATE (hidden). The enum matches the
 * schema + authz `reachesMember` exactly — 'PRIVATE', not 'HIDDEN'.
 *
 * Who may set it: the member THEMSELVES (their own card), or a manageHousehold
 * holder acting as that household. Circle ids must belong to the membership's
 * OWN household — a household scopes its members to its own circles.
 */
export const membershipRouter = router({
  setVisibility: protectedProcedure
    .input(
      z.object({
        membershipId: z.string().min(1),
        visibility: z.enum(['ALL', 'SELECT', 'PRIVATE']),
        circleIds: z.array(z.string().min(1)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const membership = await tx.membership.findUnique({ where: { id: input.membershipId } });
        if (!membership) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });

        // Self may always edit their own card. Otherwise the caller must be
        // acting as that household (else 404 — no leak) and hold manageHousehold.
        if (membership.userId !== ctx.user.id) {
          if (ctx.user.householdId !== membership.householdId) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
          }
          requireCapability(ctx.user, 'manageHousehold');
        }

        const circleIds = input.visibility === 'SELECT' ? [...new Set(input.circleIds ?? [])] : [];
        if (input.visibility === 'SELECT' && circleIds.length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick at least one circle.' });
        }
        if (circleIds.length) {
          const owned = await tx.circle.count({
            where: { id: { in: circleIds }, householdId: membership.householdId },
          });
          if (owned !== circleIds.length) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'No such circle.' });
          }
        }

        await tx.membership.update({
          where: { id: membership.id },
          data: { visibility: input.visibility },
        });
        await tx.membershipCircle.deleteMany({ where: { membershipId: membership.id } });
        if (circleIds.length) {
          await tx.membershipCircle.createMany({
            data: circleIds.map((circleId) => ({ membershipId: membership.id, circleId })),
          });
        }
        return { visibility: input.visibility };
      });
    }),
});
