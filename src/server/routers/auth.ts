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
import type { Prisma } from '@/generated/prisma/client';
import { GRANT_PRESETS, type GrantSet } from '../authz';
import { OWNER_PRESET } from '../capabilities';
import { circleIdForGrants, ensurePresetCircles } from '../circles';
import { db, dbTransaction } from '../db';
import { USERNAME_PATTERN, firstAvailableHandle, slugBaseFromName } from '../identity';
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
        // Household invites (REWORK A1) found a NEW household: its name comes
        // from the person accepting, not the inviter.
        householdName: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const invite = await db.invite.findUnique({ where: { tokenHash: hashToken(input.token) } });
      if (!invite || invite.usedAt || invite.expiresAt.getTime() < Date.now()) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite is invalid or expired.' });
      }
      if (invite.kind === 'household' && !input.householdName?.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Name your household.' });
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
        await joinViaInvite(tx, invite, created.id, input.householdName);
        return created;
      });

      await setSessionCookie(await createSession(user.id), ctx.secure);
      return { id: user.id, name: user.name };
    }),

  /**
   * A SIGNED-IN user accepts an invite (REWORK A3 multi-membership): a member
   * invite adds a membership in that household; a household invite founds a
   * new household with this user as its first member. Either way the acting
   * household switches to the new one so the next screen shows it.
   */
  acceptInviteExisting: protectedProcedure
    .input(
      z.object({
        token: z.string().min(1),
        householdName: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const invite = await db.invite.findUnique({ where: { tokenHash: hashToken(input.token) } });
      if (!invite || invite.usedAt || invite.expiresAt.getTime() < Date.now()) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite is invalid or expired.' });
      }
      if (invite.kind === 'household' && !input.householdName?.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Name your household.' });
      }
      if (
        invite.kind === 'member' &&
        ctx.user.memberships.some((m) => m.householdId === invite.householdId)
      ) {
        throw new TRPCError({ code: 'CONFLICT', message: "You're already a member there." });
      }
      const householdId = await dbTransaction((tx) =>
        joinViaInvite(tx, invite, ctx.user.id, input.householdName),
      );
      await setActingHouseholdCookie(householdId, ctx.secure);
      return { householdId };
    }),
});

/**
 * Apply an invite for `userId` inside an open transaction: member invites add
 * an Owner-preset membership in the invite's household (pre-rework trust
 * parity — per-invite capability presets remain a door); household invites
 * (A1) found the new household, make the user its first Owner, and mint the
 * ACTIVE first-edge connection to the inviter's household with the invite's
 * grant set on BOTH sides (each side tunes unilaterally afterwards). The
 * one-shot claim guard makes concurrent accepts fail closed. Returns the
 * household the user ended up in.
 */
async function joinViaInvite(
  tx: Prisma.TransactionClient,
  invite: { id: string; kind: string; householdId: string; grantsJson: string | null },
  userId: string,
  householdName: string | undefined,
): Promise<string> {
  let householdId = invite.householdId;
  if (invite.kind === 'household') {
    const slug = await firstAvailableHandle(
      slugBaseFromName(householdName!),
      async (c) => (await tx.household.findUnique({ where: { slug: c } })) !== null,
    );
    const household = await tx.household.create({
      data: { name: householdName!.trim(), slug },
    });
    householdId = household.id;
    // Both households start with the three preset circles (P4).
    await ensurePresetCircles(tx, household.id);
    await ensurePresetCircles(tx, invite.householdId);
    const inviterHousehold = await tx.household.findUniqueOrThrow({
      where: { id: invite.householdId },
    });
    const grants = (
      invite.grantsJson ? JSON.parse(invite.grantsJson) : GRANT_PRESETS.friend
    ) as GrantSet;
    // The first edge assigns BOTH sides per the invite's grant tuple, mapping it
    // to each household's matching preset circle (or a fresh custom one).
    const newSideCircleId = await circleIdForGrants(
      tx,
      household.id,
      grants,
      inviterHousehold.name,
    );
    const inviterSideCircleId = await circleIdForGrants(
      tx,
      invite.householdId,
      grants,
      household.name,
    );
    const [householdAId, householdBId] = [household.id, invite.householdId].sort();
    const newIsA = householdAId === household.id;
    await tx.connection.create({
      data: {
        householdAId,
        householdBId,
        status: 'ACTIVE',
        activatedAt: new Date(),
        // requestedByHouseholdId stays null: this edge was born from an
        // invite, not an in-app request.
        aCircleId: newIsA ? newSideCircleId : inviterSideCircleId,
        bCircleId: newIsA ? inviterSideCircleId : newSideCircleId,
      },
    });
  }
  await tx.membership.create({
    data: { userId, householdId, ...OWNER_PRESET },
  });
  const claimed = await tx.invite.updateMany({
    where: { id: invite.id, usedAt: null },
    data: { usedAt: new Date(), usedById: userId },
  });
  if (claimed.count === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite is invalid or expired.' });
  }
  return householdId;
}
