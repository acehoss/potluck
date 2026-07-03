import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db';
import { pushPublicKey } from '../push';
import { isAllowedPushEndpoint } from '../push-endpoint';
import { protectedProcedure, router } from '../trpc';

/**
 * Push subscription CRUD (blueprint 04 §4). tRPC mutations rather than the
 * Next guide's Server Actions, matching the slice-1 convention. The endpoint
 * is globally unique: a browser belongs to whoever subscribed in it last
 * (re-subscribing after a user switch reassigns the row).
 */
export const pushRouter = router({
  /**
   * The VAPID public key, read from the environment at RUNTIME — deliberately
   * not a NEXT_PUBLIC_ var, which would be inlined at build time and force an
   * image rebuild to rotate keys (blueprint 04 §4). Null = push not
   * configured on this server; the UI says so instead of offering the toggle.
   */
  publicKey: protectedProcedure.query(() => ({ publicKey: pushPublicKey() })),

  subscribe: protectedProcedure
    .input(
      z.object({
        endpoint: z.string().url().max(1000),
        p256dh: z.string().min(1).max(512),
        auth: z.string().min(1).max(512),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // SSRF guard: the server will POST notifications to this URL, so only
      // plausible public push-service endpoints may be stored (src/server/
      // push.ts has the full rationale). Browsers only ever hand the client
      // real push-service URLs — anything else is a crafted request.
      if (!isAllowedPushEndpoint(input.endpoint)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That does not look like a push service endpoint.',
        });
      }
      await db.pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        update: { userId: ctx.user.id, p256dh: input.p256dh, auth: input.auth },
        create: { ...input, userId: ctx.user.id },
      });
      return { ok: true };
    }),

  /** Remove this browser's subscription. Scoped to the caller's own rows. */
  unsubscribe: protectedProcedure
    .input(z.object({ endpoint: z.string().max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const { count } = await db.pushSubscription.deleteMany({
        where: { endpoint: input.endpoint, userId: ctx.user.id },
      });
      return { removed: count > 0 };
    }),

  /** Whether the caller owns a subscription for this endpoint (e2e + UI sync). */
  status: protectedProcedure
    .input(z.object({ endpoint: z.string().max(1000) }))
    .query(async ({ ctx, input }) => {
      const sub = await db.pushSubscription.findFirst({
        where: { endpoint: input.endpoint, userId: ctx.user.id },
        select: { id: true },
      });
      return { subscribed: sub !== null };
    }),
});
