import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { SessionUser } from '../auth';
import { db } from '../db';
import { protectedProcedure, router } from '../trpc';

/**
 * Instance-admin surface (REWORK A4/D2): the operator-level knobs. Deliberately
 * thin — sovereignty applies inside the instance too, so the admin sees
 * OPERATIONAL data (usage, quotas, growth toggle), never other households'
 * content; the usage view itself is a server component on /admin.
 */

function requireInstanceAdmin(user: SessionUser) {
  if (!user.isInstanceAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Instance admin only.' });
  }
}

/**
 * Admin-required TOTP (Phase 3 N8): a meaningful admin action is gated behind
 * TOTP enrollment. This never locks the admin OUT of enrolling — MFA setup
 * (auth.mfa.*) is a plain protected surface — it only blocks admin operations
 * until the required factor exists. The UI reads `auth.mfa.status.adminMustEnroll`
 * to nudge; this is the server-side backstop. The error code lets the client
 * route to the enrollment card.
 */
function requireAdminMfa(user: SessionUser) {
  requireInstanceAdmin(user);
  if (user.totpEnabledAt === null) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Enable TOTP on your admin account before making instance changes.',
    });
  }
}

export const adminRouter = router({
  /** The A1 growth toggle: who may mint new-household invites. */
  setAllowMemberHouseholdInvites: protectedProcedure
    .input(z.object({ allow: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireAdminMfa(ctx.user);
      await db.instanceSettings.update({
        where: { id: 'instance' },
        data: { allowMemberHouseholdInvites: input.allow },
      });
      return { allow: input.allow };
    }),
});
