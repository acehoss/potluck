import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  DUMMY_HASH,
  createSession,
  destroySession,
  generateToken,
  hashPassword,
  hashToken,
  setActingHouseholdCookie,
  setSessionCookie,
  verifyPasswordLimited,
} from '../auth';
import type { Prisma, User } from '@/generated/prisma/client';
import { appUrl } from '../app-url';
import { GRANT_PRESETS, type GrantSet } from '../authz';
import { OWNER_PRESET } from '../capabilities';
import { circleIdForGrants, ensurePresetCircles } from '../circles';
import { db, dbTransaction } from '../db';
import { USERNAME_PATTERN, firstAvailableHandle, slugBaseFromName } from '../identity';
import { sendTransactional } from '../mail';
import { verifyPendingToken, mintPendingToken } from '../mfa/crypto';
import { hasMfa, issueEmailMfaCode, verifyLoginMfa } from '../mfa/service';
import { mfaRouter } from './mfa';
import { checkRateLimit, resetRateLimit } from '../rate-limit';
import { protectedProcedure, publicProcedure, router } from '../trpc';

// Verification/reset link tokens: short-TTL, single-use, hashed at rest (only
// the raw value rides the emailed link). N8.
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000; // 1h

/** Mint + email an email-verification link for a freshly-created account. */
async function sendVerificationEmail(user: Pick<User, 'id' | 'email'>): Promise<void> {
  const raw = generateToken();
  await db.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    },
  });
  const link = appUrl(`/verify?token=${raw}`);
  await sendTransactional({
    to: user.email,
    kind: 'verify',
    subject: 'Confirm your Potluck email',
    text: `Welcome to Potluck! Confirm this email address by opening:\n\n${link}\n\nThe link expires in 24 hours. If you didn't create an account, you can ignore this email.`,
  });
}

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

    // A correct password clears both budgets: only FAILED attempts should
    // accumulate toward the password-spraying limits. Legit users behind one
    // NAT IP (or the e2e suite re-run against a live stack) must not lock the
    // whole household out; an attacker can't reset without valid credentials.
    resetRateLimit(`login:id:${input.identifier}`);
    resetRateLimit(`login:user:${user.id}`);
    resetRateLimit(`login:ip:${ctx.ip}`);

    // MFA hook (N8): a correct password is only the FIRST factor. If the account
    // has any MFA factor, do NOT set the session — return a short-lived signed
    // pending token instead; `mfaChallenge` completes sign-in. The pending token
    // is not a session; it only authorizes a second-factor attempt.
    if (hasMfa(user)) {
      return {
        mfaRequired: true as const,
        pendingToken: mintPendingToken(user.id),
        // Backup codes exist iff TOTP is enrolled (they are minted at confirm).
        methods: {
          totp: user.totpEnabledAt !== null,
          email: user.mfaEmailEnabled,
          backup: user.totpEnabledAt !== null,
        },
      };
    }

    await setSessionCookie(await createSession(user.id), ctx.secure);
    return { id: user.id, name: user.name };
  }),

  /**
   * Second step of an MFA login (N8): exchange a valid `pendingToken` + second
   * factor for a session. Tries every factor the account has (TOTP / emailed
   * code / backup code); a used TOTP step is replay-rejected. Throttled per IP
   * and per account — never a permanent lockout.
   */
  mfaChallenge: publicProcedure
    .input(z.object({ pendingToken: z.string().min(1), code: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      if (!checkRateLimit(`mfachallenge:ip:${ctx.ip}`, 30)) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Try again in a few minutes.',
        });
      }
      const userId = verifyPendingToken(input.pendingToken);
      if (!userId) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Your sign-in expired. Please start again.',
        });
      }
      if (!checkRateLimit(`mfachallenge:user:${userId}`, 10)) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Try again in a few minutes.',
        });
      }
      const user = await db.user.findUnique({ where: { id: userId } });
      if (!user || !hasMfa(user)) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Your sign-in expired. Please start again.',
        });
      }
      const factor = await verifyLoginMfa(user, input.code);
      if (!factor) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not valid.' });
      }
      resetRateLimit(`mfachallenge:ip:${ctx.ip}`);
      resetRateLimit(`mfachallenge:user:${userId}`);
      await setSessionCookie(await createSession(user.id), ctx.secure);
      return { id: user.id, name: user.name };
    }),

  /**
   * During an MFA login, send an emailed code to the pending account (only when
   * it has the emailed-code factor). The pending token already proves the
   * password, so this is not an enumeration surface; still rate-limited.
   */
  requestMfaEmailCode: publicProcedure
    .input(z.object({ pendingToken: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const userId = verifyPendingToken(input.pendingToken);
      if (!userId) return { ok: true };
      if (!checkRateLimit(`mfa:email:req:${userId}`, 3)) return { ok: true };
      const user = await db.user.findUnique({ where: { id: userId } });
      if (user?.mfaEmailEnabled) await issueEmailMfaCode(user);
      return { ok: true };
    }),

  /**
   * Consume an email-verification link (public, single-use). Returns a generic
   * `{ status }` — an invalid/expired/used token all read as `'invalid'` without
   * revealing which (or anything about accounts).
   */
  verifyEmail: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const row = await db.emailVerificationToken.findUnique({
        where: { tokenHash: hashToken(input.token) },
      });
      if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
        return { status: 'invalid' as const };
      }
      const claimed = await db.emailVerificationToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) return { status: 'invalid' as const };
      await db.user.update({
        where: { id: row.userId },
        data: { emailVerifiedAt: new Date() },
      });
      return { status: 'verified' as const };
    }),

  /** Whether the signed-in account's email is confirmed (drives the nudge banner). */
  emailStatus: protectedProcedure.query(({ ctx }) => {
    return { verified: ctx.user.emailVerifiedAt !== null };
  }),

  /** Resend the verification link to the signed-in user (rate-limited, no-op if verified). */
  resendVerification: protectedProcedure.mutation(async ({ ctx }) => {
    if (!checkRateLimit(`verify:resend:${ctx.user.id}`, 5)) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Try again in a few minutes.',
      });
    }
    if (ctx.user.emailVerifiedAt) return { ok: true };
    await sendVerificationEmail(ctx.user);
    return { ok: true };
  }),

  /**
   * Start a password reset (public, enumeration-safe). ALWAYS returns the same
   * result whether or not the identifier matches an account; when it does, a
   * single-use reset link is emailed. Rate-limited per IP and per identifier.
   */
  requestPasswordReset: publicProcedure
    .input(z.object({ identifier: z.string().trim().toLowerCase().min(1).max(254) }))
    .mutation(async ({ ctx, input }) => {
      const generic = { ok: true as const };
      if (
        !checkRateLimit(`reset:ip:${ctx.ip}`, 30) ||
        !checkRateLimit(`reset:id:${input.identifier}`, 5)
      ) {
        // Same shape as success — a throttled attacker learns nothing.
        return generic;
      }
      const user = await db.user.findUnique({
        where: input.identifier.includes('@')
          ? { email: input.identifier }
          : { username: input.identifier },
      });
      if (user) {
        const raw = generateToken();
        await db.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hashToken(raw),
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
          },
        });
        const link = appUrl(`/reset?token=${raw}`);
        await sendTransactional({
          to: user.email,
          kind: 'reset',
          subject: 'Reset your Potluck password',
          text: `Someone asked to reset the password for your Potluck account. Open this link to choose a new one:\n\n${link}\n\nThe link expires in 1 hour and can be used once. If this wasn't you, ignore this email — your password hasn't changed.`,
        });
      }
      return generic;
    }),

  /**
   * Whether a reset token is (still) valid and whether completing it will
   * require an MFA code — lets the /reset form decide whether to show the code
   * field. Does NOT consume the token. Token-gated, so revealing the account's
   * TOTP status here is not a new enumeration surface.
   */
  resetPasswordInfo: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .query(async ({ input }) => {
      const row = await db.passwordResetToken.findUnique({
        where: { tokenHash: hashToken(input.token) },
      });
      if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
        return { valid: false, requiresMfa: false };
      }
      const user = await db.user.findUnique({ where: { id: row.userId } });
      return { valid: true, requiresMfa: user?.totpEnabledAt != null };
    }),

  /**
   * Complete a password reset (public). Single-use short-TTL token. If the
   * account has TOTP enrolled the caller MUST also pass a valid TOTP/backup code
   * — a reset is not a TOTP bypass (N8); the token is NOT consumed until the
   * whole thing succeeds, so a bad/missing code can be retried. On success the
   * password changes and every existing session is revoked.
   */
  resetPassword: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        newPassword: z.string().min(10, 'Password must be at least 10 characters.').max(256),
        // The TOTP/backup code for a TOTP-enrolled reset. Canonical field is
        // `mfaCode` (coordinator lock); `code` is tolerated as an alias so an
        // older client shape still works.
        mfaCode: z.string().trim().max(64).optional(),
        code: z.string().trim().max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkRateLimit(`reset:submit:ip:${ctx.ip}`, 30)) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Try again in a few minutes.',
        });
      }
      const row = await db.passwordResetToken.findUnique({
        where: { tokenHash: hashToken(input.token) },
      });
      if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This reset link is invalid or has expired. Request a new one.',
        });
      }
      const user = await db.user.findUnique({ where: { id: row.userId } });
      if (!user) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This reset link is invalid.' });
      }
      // TOTP-enrolled accounts must clear the second factor in the same call —
      // a reset must never be a TOTP bypass (N8). The token is untouched here,
      // so a wrong/absent code just re-prompts.
      const mfaCode = input.mfaCode ?? input.code;
      if (user.totpEnabledAt) {
        if (!mfaCode) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Enter a code from your authenticator app (or a backup code) to reset.',
          });
        }
        const factor = await verifyLoginMfa(user, mfaCode);
        if (!factor) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not valid.' });
        }
      }
      const passwordHash = await hashPassword(input.newPassword);
      await dbTransaction(async (tx) => {
        // Claim the token first (fail-closed against a concurrent double-use).
        const claimed = await tx.passwordResetToken.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'This reset link is invalid.' });
        }
        await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
        // Revoke every session + any other outstanding reset token for the user.
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.passwordResetToken.deleteMany({
          where: { userId: user.id, id: { not: row.id } },
        });
      });
      return { ok: true as const };
    }),

  mfa: mfaRouter,

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
      // Email verification (N8): a new account is usable immediately but
      // unverified until it consumes this link (the UI banners it). Best-effort
      // — a mail hiccup never fails account creation.
      await sendVerificationEmail(user).catch((e) =>
        console.error('[auth] verification send failed:', e instanceof Error ? e.message : e),
      );
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
