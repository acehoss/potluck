import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db';
import {
  CATEGORY_DEFAULTS,
  effectivePrefs,
  NOTIFY_CATEGORIES,
  type NotifyCategory,
} from '../notifications';
import { protectedProcedure, router } from '../trpc';

/**
 * Notification preferences (Phase 3 Round C; docs/REWORK.md N4/N5/N6). The
 * self-serve surface behind the /more preferences screen + first-run consent.
 * Reads/writes are always the ACTING user's OWN prefs — there is no
 * cross-user/household preference (a pref is per-person, spanning every
 * household they act as). No money, no ledger.
 */

const categorySchema = z.enum(
  NOTIFY_CATEGORIES as unknown as [NotifyCategory, ...NotifyCategory[]],
);

/** Reject a timezone string that isn't a real IANA zone (empty/null clears it). */
function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const notificationRouter = router({
  /** The full matrix + digest/showDetails/timezone/onboarded for the current user. */
  get: protectedProcedure.query(async ({ ctx }) => {
    const [categories, user] = await Promise.all([
      effectivePrefs(ctx.user.id),
      db.user.findUniqueOrThrow({
        where: { id: ctx.user.id },
        select: {
          digestOptOut: true,
          showDetails: true,
          timezone: true,
          notifyOnboardedAt: true,
        },
      }),
    ]);
    return {
      categories,
      digestOptOut: user.digestOptOut,
      showDetails: user.showDetails,
      timezone: user.timezone,
      onboarded: user.notifyOnboardedAt !== null,
    };
  }),

  /**
   * Turn one channel of one category on/off. Upserts the (user, category) row —
   * writing a row deliberately "pins" BOTH channels to explicit values (the
   * untouched channel keeps its currently-effective value, default or stored),
   * so a later default change never silently flips a category the user tuned.
   */
  setChannel: protectedProcedure
    .input(
      z.object({
        category: categorySchema,
        channel: z.enum(['push', 'email']),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db.notificationPreference.findUnique({
        where: { userId_category: { userId: ctx.user.id, category: input.category } },
      });
      const base = existing ?? CATEGORY_DEFAULTS[input.category];
      const next = {
        push: input.channel === 'push' ? input.enabled : base.push,
        email: input.channel === 'email' ? input.enabled : base.email,
      };
      await db.notificationPreference.upsert({
        where: { userId_category: { userId: ctx.user.id, category: input.category } },
        create: { userId: ctx.user.id, category: input.category, ...next },
        update: next,
      });
      return { category: input.category, ...next };
    }),

  /**
   * The single-valued prefs: weekly-digest opt-out, show-details-in-notifications
   * (N4 opt-in), and the digest timezone. Any subset — pass only what changed;
   * `timezone: null` clears it back to the instance default.
   */
  setPrefs: protectedProcedure
    .input(
      z.object({
        digestOptOut: z.boolean().optional(),
        showDetails: z.boolean().optional(),
        timezone: z.string().max(64).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data: {
        digestOptOut?: boolean;
        showDetails?: boolean;
        timezone?: string | null;
      } = {};
      if (input.digestOptOut !== undefined) data.digestOptOut = input.digestOptOut;
      if (input.showDetails !== undefined) data.showDetails = input.showDetails;
      if (input.timezone !== undefined) {
        if (input.timezone !== null && !validTimezone(input.timezone)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a recognized time zone.' });
        }
        data.timezone = input.timezone;
      }
      const user = await db.user.update({
        where: { id: ctx.user.id },
        data,
        select: { digestOptOut: true, showDetails: true, timezone: true },
      });
      return user;
    }),

  /**
   * Mark the first-run "how should Potluck reach you?" consent screen seen.
   * Durable per-user (survives across devices), set once — idempotent.
   */
  markOnboarded: protectedProcedure.mutation(async ({ ctx }) => {
    await db.user.updateMany({
      where: { id: ctx.user.id, notifyOnboardedAt: null },
      data: { notifyOnboardedAt: new Date() },
    });
    return { onboarded: true };
  }),
});
