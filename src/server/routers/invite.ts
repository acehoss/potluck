import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { generateToken, hashToken } from '../auth';
import { GRANTS, requireCapability } from '../authz';
import { db } from '../db';
import { protectedProcedure, publicProcedure, router } from '../trpc';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const grantSetSchema = z.object(
  Object.fromEntries(GRANTS.map((g) => [g, z.boolean()])) as Record<
    (typeof GRANTS)[number],
    z.ZodBoolean
  >,
);

export const inviteRouter = router({
  /**
   * Invite someone into the ACTING household. Gated by manageHousehold
   * (REWORK A3a): membership management belongs to household managers.
   */
  create: protectedProcedure
    .input(z.object({ invitedName: z.string().trim().max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageHousehold');
      const token = generateToken();
      const invite = await db.invite.create({
        data: {
          tokenHash: hashToken(token),
          kind: 'member',
          householdId: ctx.user.householdId,
          createdById: ctx.user.id,
          invitedName: input.invitedName || null,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      return { path: `/invite/${token}`, expiresAt: invite.expiresAt.toISOString() };
    }),

  /**
   * Invite a NEW household (REWORK A1): accepting founds the household and
   * creates an ACTIVE connection to the ACTING household — growth along trust
   * edges, the invite IS the first edge. Gated by manageConnections (it mints
   * an edge), and by the instance-admin toggle: when
   * allowMemberHouseholdInvites is off, only the instance admin may grow the
   * instance.
   */
  createHousehold: protectedProcedure
    .input(z.object({ grants: grantSetSchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const settings = await db.instanceSettings.findUnique({ where: { id: 'instance' } });
      if (!settings?.allowMemberHouseholdInvites && !ctx.user.isInstanceAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the instance admin can invite new households right now.',
        });
      }
      const token = generateToken();
      const invite = await db.invite.create({
        data: {
          tokenHash: hashToken(token),
          kind: 'household',
          householdId: ctx.user.householdId,
          createdById: ctx.user.id,
          grantsJson: JSON.stringify(input.grants),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      return { path: `/invite/${token}`, expiresAt: invite.expiresAt.toISOString() };
    }),

  /** Public: lets the accept page show who the invite is for before signup. */
  preview: publicProcedure.input(z.object({ token: z.string().min(1) })).query(async ({ input }) => {
    const invite = await db.invite.findUnique({
      where: { tokenHash: hashToken(input.token) },
      include: { household: { select: { name: true } } },
    });
    if (!invite || invite.usedAt || invite.expiresAt.getTime() < Date.now()) {
      return { valid: false as const };
    }
    return {
      valid: true as const,
      kind: invite.kind as 'member' | 'household',
      householdName: invite.household.name,
      invitedName: invite.invitedName,
    };
  }),
});
