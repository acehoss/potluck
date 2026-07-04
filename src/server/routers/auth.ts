import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  DUMMY_HASH,
  createSession,
  destroySession,
  hashPassword,
  hashToken,
  setActingHouseholdCookie,
  setSessionCookie,
  verifyPasswordLimited,
} from '../auth';
import { OWNER_PRESET } from '../capabilities';
import { db, dbTransaction } from '../db';
import { USERNAME_PATTERN } from '../identity';
import { checkRateLimit, resetRateLimit } from '../rate-limit';
import { protectedProcedure, publicProcedure, router } from '../trpc';

const credentialsSchema = z.object({
  // Username is the identity (REWORK A2); email still works — both are
  // unique, and '@' disambiguates. Lowercased like both columns' stored form.
  identifier: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(256),
});

export const authRouter = router({
  login: publicProcedure.input(credentialsSchema).mutation(async ({ ctx, input }) => {
    if (
      !checkRateLimit(`login:ip:${ctx.ip}`, 30) ||
      !checkRateLimit(`login:id:${input.identifier}`, 10)
    ) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many attempts. Try again in a few minutes.',
      });
    }

    const user = await db.user.findUnique({
      where: input.identifier.includes('@')
        ? { email: input.identifier }
        : { username: input.identifier },
    });
    // Every account now has TWO identifiers (username + email) and the
    // per-identifier bucket alone would double the guessing budget — charge a
    // per-ACCOUNT bucket too once the identifier resolves.
    if (user && !checkRateLimit(`login:user:${user.id}`, 10)) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many attempts. Try again in a few minutes.',
      });
    }
    // Bounded-concurrency verify (argon2 is memory-hungry). Still runs against
    // DUMMY_HASH for a missing user so timing never reveals which usernames
    // or emails have accounts.
    const valid = await verifyPasswordLimited(user?.passwordHash ?? DUMMY_HASH, input.password);
    if (valid === 'busy') {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Server is busy — try again in a moment.',
      });
    }
    if (!user || !valid) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid username or password.' });
    }

    // A successful login clears both budgets: only FAILED attempts should
    // accumulate toward the password-spraying limits. Legit users behind one
    // NAT IP (or the e2e suite re-run against a live stack) must not lock the
    // whole household out; an attacker can't reset without valid credentials.
    resetRateLimit(`login:id:${input.identifier}`);
    resetRateLimit(`login:user:${user.id}`);
    resetRateLimit(`login:ip:${ctx.ip}`);
    await setSessionCookie(await createSession(user.id), ctx.secure);
    return { id: user.id, name: user.name };
  }),

  /**
   * Sticky acting-household switch (REWORK A3b): validates the target against
   * the caller's live memberships, then persists the choice in its own cookie.
   * The client fully reloads afterwards — every query, page, and cart is
   * acting-household-relative.
   */
  setActingHousehold: protectedProcedure
    .input(z.object({ householdId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const membership = ctx.user.memberships.find((m) => m.householdId === input.householdId);
      if (!membership) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of that household.' });
      }
      await setActingHouseholdCookie(input.householdId, ctx.secure);
      return { householdId: input.householdId };
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
        username: z
          .string()
          .trim()
          .toLowerCase()
          .regex(
            USERNAME_PATTERN,
            'Usernames are 3–30 characters: lowercase letters, digits, - or _.',
          ),
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
      if (await db.user.findUnique({ where: { username: input.username } })) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That username is taken.' });
      }

      const passwordHash = await hashPassword(input.password);
      const user = await dbTransaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            username: input.username,
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
