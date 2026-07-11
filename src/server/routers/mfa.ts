import { TRPCError } from '@trpc/server';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { SessionUser } from '../auth';
import { db } from '../db';
import { decryptSecret, encryptSecret, mfaConfigured } from '../mfa/crypto';
import { generateTotpSecret, totpUri, verifyTotpStep } from '../mfa/totp';
import {
  backupCodesRemaining,
  issueEmailMfaCode,
  regenerateBackupCodes,
  verifyEmailMfaCode,
  verifyLoginMfa,
} from '../mfa/service';
import { checkRateLimit } from '../rate-limit';
import { protectedProcedure, router } from '../trpc';

/**
 * MFA management (Phase 3 Round B; docs/archive/mutual-aid-rework-2026-07.md N8). Mounted at `auth.mfa`.
 *
 * Canonical surface (coordinator lock) is ONE begin/confirm/disable triplet
 * parameterized by `method` ('totp' | 'email') — not a procedure per factor:
 *   begin({method:'totp'})  → secret + otpauth + QR (stored encrypted, not enabled)
 *   begin({method:'email'}) → emails a 6-digit setup code (kind:'mfa')
 *   confirm({method, code}) → verifies a live code, enables that factor; TOTP
 *                             confirm also mints + returns the one-time backup codes
 *   disable({method, code}) → verifies a current code, turns that factor off
 * The per-factor procedures (beginTotp/confirmTotp/beginEmail/confirmEmail/
 * disableEmail) are thin aliases over the same helpers — a bridge so a client
 * written to either shape compiles; both call identical logic.
 *
 * Every mutation is a security-setting change on the CALLER's own account, so
 * all are protected; each removal/relax re-verifies a live code first. TOTP
 * secrets are stored encrypted and only enabled after a live code confirms.
 */

const methodSchema = z.enum(['totp', 'email']);
const codeInput = z.object({ code: z.string().trim().min(1).max(64) });

/** MFA is inoperable without an encryption key; fail loudly, never silently. */
function requireConfigured() {
  if (!mfaConfigured()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'MFA is not configured on this instance.',
    });
  }
}

// --- shared factor logic (both surfaces call these) --------------------------

async function beginTotp(user: SessionUser) {
  requireConfigured();
  if (user.totpEnabledAt) {
    throw new TRPCError({ code: 'CONFLICT', message: 'TOTP is already enabled.' });
  }
  const secret = generateTotpSecret();
  await db.user.update({ where: { id: user.id }, data: { totpSecret: encryptSecret(secret) } });
  const uri = totpUri(user.email, secret);
  return { method: 'totp' as const, secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri) };
}

async function beginEmail(user: SessionUser) {
  requireConfigured();
  // Rate-limit the request direction (~3 / 15 min).
  if (!checkRateLimit(`mfa:email:req:${user.id}`, 3)) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many code requests. Try again in a few minutes.',
    });
  }
  await issueEmailMfaCode(user);
  return { method: 'email' as const, ok: true };
}

async function confirmTotp(user: SessionUser, code: string) {
  requireConfigured();
  const fresh = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (fresh.totpEnabledAt) {
    throw new TRPCError({ code: 'CONFLICT', message: 'TOTP is already enabled.' });
  }
  if (!fresh.totpSecret) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Start enrollment first.' });
  }
  const step = verifyTotpStep(code, decryptSecret(fresh.totpSecret));
  if (step === null) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not valid.' });
  }
  await db.user.update({
    where: { id: user.id },
    data: { totpEnabledAt: new Date(), totpLastStep: step },
  });
  const backupCodes = await regenerateBackupCodes(user.id);
  return { method: 'totp' as const, backupCodes };
}

async function confirmEmail(user: SessionUser, code: string) {
  requireConfigured();
  if (!checkRateLimit(`mfa:email:att:${user.id}`, 10)) {
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts.' });
  }
  if (!(await verifyEmailMfaCode(user.id, code))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not valid.' });
  }
  await db.user.update({ where: { id: user.id }, data: { mfaEmailEnabled: true } });
  return { method: 'email' as const, ok: true };
}

async function disableTotp(user: SessionUser, code: string) {
  if (user.isInstanceAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The instance-admin account must keep TOTP enabled.',
    });
  }
  const fresh = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!fresh.totpEnabledAt) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'TOTP is not enabled.' });
  }
  if (!(await verifyLoginMfa(fresh, code))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not valid.' });
  }
  await db.user.update({
    where: { id: user.id },
    data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
  });
  await db.mfaBackupCode.deleteMany({ where: { userId: user.id } });
  return { method: 'totp' as const, ok: true };
}

async function disableEmail(user: SessionUser, code: string) {
  const fresh = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!fresh.mfaEmailEnabled) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Emailed codes are not on.' });
  }
  if (!(await verifyLoginMfa(fresh, code))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not valid.' });
  }
  await db.user.update({ where: { id: user.id }, data: { mfaEmailEnabled: false } });
  return { method: 'email' as const, ok: true };
}

export const mfaRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    return {
      configured: mfaConfigured(),
      totpEnabled: ctx.user.totpEnabledAt !== null,
      emailEnabled: ctx.user.mfaEmailEnabled,
      backupCodesRemaining: ctx.user.totpEnabledAt ? await backupCodesRemaining(ctx.user.id) : 0,
      // Admin-required TOTP (N8): the UI turns this into an enrollment nudge.
      adminMustEnroll: ctx.user.isInstanceAdmin && ctx.user.totpEnabledAt === null,
    };
  }),

  // --- canonical method-arg surface ------------------------------------------
  begin: protectedProcedure
    .input(z.object({ method: methodSchema }))
    .mutation(async ({ ctx, input }) =>
      input.method === 'totp' ? await beginTotp(ctx.user) : await beginEmail(ctx.user),
    ),
  confirm: protectedProcedure
    .input(z.object({ method: methodSchema, code: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) =>
      input.method === 'totp'
        ? await confirmTotp(ctx.user, input.code)
        : await confirmEmail(ctx.user, input.code),
    ),
  disable: protectedProcedure
    // method optional (defaults 'totp') so a client that only passes `{code}`
    // for the TOTP-disable path still resolves.
    .input(z.object({ method: methodSchema.default('totp'), code: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) =>
      input.method === 'totp'
        ? await disableTotp(ctx.user, input.code)
        : await disableEmail(ctx.user, input.code),
    ),

  // --- per-factor aliases (bridge; identical logic) --------------------------
  beginTotp: protectedProcedure.mutation(({ ctx }) => beginTotp(ctx.user)),
  confirmTotp: protectedProcedure.input(codeInput).mutation(({ ctx, input }) => confirmTotp(ctx.user, input.code)),
  beginEmail: protectedProcedure.mutation(({ ctx }) => beginEmail(ctx.user)),
  confirmEmail: protectedProcedure.input(codeInput).mutation(({ ctx, input }) => confirmEmail(ctx.user, input.code)),
  disableEmail: protectedProcedure.input(codeInput).mutation(({ ctx, input }) => disableEmail(ctx.user, input.code)),

  /**
   * Instance-admin recovery (N8): clear another member's MFA — the small-
   * community "I lost my phone" path. Requires the admin's OWN current MFA and
   * is audited (logged, never printing secrets). Cannot target the admin's own
   * account (that would be the disable path, which admins may not do for TOTP).
   */
  adminReset: protectedProcedure
    .input(z.object({ userId: z.string().min(1), code: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.isInstanceAdmin) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Instance admin only.' });
      }
      if (input.userId === ctx.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Use disable for your own account.' });
      }
      const admin = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
      if (!(await verifyLoginMfa(admin, input.code))) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Your MFA code is not valid.' });
      }
      const target = await db.user.findUnique({ where: { id: input.userId } });
      if (!target) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such member.' });
      }
      await db.user.update({
        where: { id: target.id },
        data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null, mfaEmailEnabled: false },
      });
      await db.mfaBackupCode.deleteMany({ where: { userId: target.id } });
      await db.emailMfaCode.deleteMany({ where: { userId: target.id } });
      // Audit trail (N8) — actor + subject, never any secret/code value.
      console.warn(
        `[audit] admin MFA reset: adminUserId=${ctx.user.id} targetUserId=${target.id} at=${new Date().toISOString()}`,
      );
      return { ok: true };
    }),
});
