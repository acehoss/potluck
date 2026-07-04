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

export const adminRouter = router({
  /** The A1 growth toggle: who may mint new-household invites. */
  setAllowMemberHouseholdInvites: protectedProcedure
    .input(z.object({ allow: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireInstanceAdmin(ctx.user);
      await db.instanceSettings.update({
        where: { id: 'instance' },
        data: { allowMemberHouseholdInvites: input.allow },
      });
      return { allow: input.allow };
    }),
});
