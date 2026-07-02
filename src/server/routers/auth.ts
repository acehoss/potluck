import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  DUMMY_HASH,
  createSession,
  destroySession,
  hashPassword,
  hashToken,
  setSessionCookie,
  verifyPassword,
} from '../auth';
import { db } from '../db';
import { checkRateLimit, resetRateLimit } from '../rate-limit';
import { publicProcedure, router } from '../trpc';

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(256),
});

export const authRouter = router({
  login: publicProcedure.input(credentialsSchema).mutation(async ({ ctx, input }) => {
    if (
      !checkRateLimit(`login:ip:${ctx.ip}`, 30) ||
      !checkRateLimit(`login:email:${input.email}`, 10)
    ) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many attempts. Try again in a few minutes.',
      });
    }

    const user = await db.user.findUnique({ where: { email: input.email } });
    const valid = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, input.password);
    if (!user || !valid) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password.' });
    }

    resetRateLimit(`login:email:${input.email}`);
    await setSessionCookie(await createSession(user.id));
    return { id: user.id, name: user.name };
  }),

  logout: publicProcedure.mutation(async () => {
    await destroySession();
    return { ok: true };
  }),

  acceptInvite: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(10, 'Password must be at least 10 characters.').max(256),
      }),
    )
    .mutation(async ({ input }) => {
      const invite = await db.invite.findUnique({ where: { tokenHash: hashToken(input.token) } });
      if (!invite || invite.usedAt || invite.expiresAt.getTime() < Date.now()) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite is invalid or expired.' });
      }
      if (await db.user.findUnique({ where: { email: input.email } })) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An account with that email already exists.',
        });
      }

      const passwordHash = await hashPassword(input.password);
      const user = await db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name: input.name,
            email: input.email,
            passwordHash,
            householdId: invite.householdId,
          },
        });
        const claimed = await tx.invite.updateMany({
          where: { id: invite.id, usedAt: null },
          data: { usedAt: new Date(), usedById: created.id },
        });
        if (claimed.count === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite is invalid or expired.' });
        }
        return created;
      });

      await setSessionCookie(await createSession(user.id));
      return { id: user.id, name: user.name };
    }),
});
