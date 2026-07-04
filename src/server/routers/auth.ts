import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  DUMMY_HASH,
  createSession,
  destroySession,
  hashPassword,
  hashToken,
  setSessionCookie,
  verifyPasswordLimited,
} from '../auth';
import { OWNER_PRESET } from '../capabilities';
import { db, dbTransaction } from '../db';
import { firstAvailableHandle, usernameBaseFromEmail } from '../identity';
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
    // Bounded-concurrency verify (argon2 is memory-hungry). Still runs against
    // DUMMY_HASH for a missing user so timing never reveals which emails exist.
    const valid = await verifyPasswordLimited(user?.passwordHash ?? DUMMY_HASH, input.password);
    if (valid === 'busy') {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Server is busy — try again in a moment.',
      });
    }
    if (!user || !valid) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password.' });
    }

    // A successful login clears both budgets: only FAILED attempts should
    // accumulate toward the password-spraying limits. Legit users behind one
    // NAT IP (or the e2e suite re-run against a live stack) must not lock the
    // whole household out; an attacker can't reset without valid credentials.
    resetRateLimit(`login:email:${input.email}`);
    resetRateLimit(`login:ip:${ctx.ip}`);
    await setSessionCookie(await createSession(user.id), ctx.secure);
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
    .mutation(async ({ ctx, input }) => {
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
      const user = await dbTransaction(async (tx) => {
        // Username derived from the email local-part until signup collects it
        // directly (R1S2); race-free under the app-wide DB lock.
        const username = await firstAvailableHandle(
          usernameBaseFromEmail(input.email),
          async (candidate) =>
            (await tx.user.findUnique({ where: { username: candidate } })) !== null,
        );
        const created = await tx.user.create({
          data: {
            username,
            name: input.name,
            email: input.email,
            passwordHash,
          },
        });
        // A joining member gets the full-capability (Owner) preset — the
        // pre-rework trust model. Invite-carried capability presets are R1S4.
        await tx.membership.create({
          data: {
            userId: created.id,
            householdId: invite.householdId,
            ...OWNER_PRESET,
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

      await setSessionCookie(await createSession(user.id), ctx.secure);
      return { id: user.id, name: user.name };
    }),
});
