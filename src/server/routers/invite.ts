import { z } from 'zod';
import { generateToken, hashToken } from '../auth';
import { db } from '../db';
import { protectedProcedure, publicProcedure, router } from '../trpc';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const inviteRouter = router({
  /** Members can invite people into their own household only. */
  create: protectedProcedure
    .input(z.object({ invitedName: z.string().trim().max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      const token = generateToken();
      const invite = await db.invite.create({
        data: {
          tokenHash: hashToken(token),
          householdId: ctx.user.householdId,
          createdById: ctx.user.id,
          invitedName: input.invitedName || null,
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
      householdName: invite.household.name,
      invitedName: invite.invitedName,
    };
  }),
});
