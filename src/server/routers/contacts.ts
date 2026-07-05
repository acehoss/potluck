import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { circleToGrantSet, memberVisibleUnderCircle } from '../authz';
import { loadContactHousehold } from '../contacts';
import { db } from '../db';
import { protectedProcedure, router } from '../trpc';

/**
 * Contact-layer read surface (REWORK P5, Round C). The connection IS the gate
 * (no capability): an ACTIVE-connected household's card and its visible members
 * come from the shared `loadContactHousehold` resolver (same one the vCard route
 * uses). A PENDING incoming request gets a NAME-ONLY preview so the addressee
 * can "see who before I say yes" — never phone/email/address pre-accept.
 */
export const contactsRouter = router({
  /**
   * The acting household's view of a connected (or own) household: pickup
   * logistics + members visible to us. 404 for anything not own or ACTIVE-edged.
   */
  household: protectedProcedure
    .input(z.object({ householdId: z.string().min(1) }))
    .query(({ ctx, input }) => loadContactHousehold(db, ctx.user.householdId, input.householdId)),

  /**
   * Name-only preview of the household behind a PENDING request aimed at us.
   * Members are filtered by their visibility against the circle the REQUESTER
   * placed us into (resolved from the pending edge — no ACTIVE status yet, so
   * this can't ride `reachesMember`). No contact details before accept.
   */
  requestPreview: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const me = ctx.user.householdId;
      const conn = await db.connection.findUnique({
        where: { id: input.connectionId },
        include: { aCircle: true, bCircle: true },
      });
      if (!conn || (conn.householdAId !== me && conn.householdBId !== me)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found.' });
      }
      // Only the addressee of a still-pending incoming request gets a preview.
      if (conn.status !== 'PENDING' || conn.requestedByHouseholdId === me) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found.' });
      }
      const requesterHouseholdId = conn.householdAId === me ? conn.householdBId : conn.householdAId;
      const requesterIsA = conn.householdAId === requesterHouseholdId;
      const circleId = requesterIsA ? conn.aCircleId : conn.bCircleId;
      const circle = requesterIsA ? conn.aCircle : conn.bCircle;
      // The circle the requester placed US into — its grants back their card's
      // member visibility (a PENDING edge always has the requester's side set).
      const reach = circleId && circle ? { circleId, grants: circleToGrantSet(circle) } : null;

      const household = await db.household.findUnique({
        where: { id: requesterHouseholdId },
        include: {
          memberships: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            include: { user: { select: { name: true, photoPath: true, bio: true } } },
          },
        },
      });
      if (!household) throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found.' });

      const members: Array<{ name: string; photoPath: string | null; bio: string | null }> = [];
      for (const m of household.memberships) {
        if (!(await memberVisibleUnderCircle(db, reach, m))) continue;
        members.push({ name: m.user.name, photoPath: m.user.photoPath, bio: m.user.bio });
      }
      return { householdName: household.name, slug: household.slug, members };
    }),
});
