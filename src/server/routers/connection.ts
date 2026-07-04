import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { GRANTS, type GrantSet, getConnection, grantsFrom, requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

/**
 * Connection management (REWORK B1/B2/B6): request/accept/sever by household
 * handle, plus unilateral grant editing. One row per pair (canonical order);
 * each side owns exactly its own grant set — "the resource owner is
 * authoritative" — and may tighten or revoke at any time without the other's
 * consent. All mutations need the manageConnections capability on the ACTING
 * membership.
 */

const grantSetSchema = z.object(
  Object.fromEntries(GRANTS.map((g) => [g, z.boolean()])) as Record<
    (typeof GRANTS)[number],
    z.ZodBoolean
  >,
);

/** Column prefix for the side of `connection` that `householdId` occupies. */
function sideOf(connection: { householdAId: string }, householdId: string): 'a' | 'b' {
  return connection.householdAId === householdId ? 'a' : 'b';
}

/** The 6 write-ready columns for one side's grant set. */
function grantColumns(side: 'a' | 'b', grants: GrantSet) {
  const cap = (g: string) => g.charAt(0).toUpperCase() + g.slice(1);
  return Object.fromEntries(GRANTS.map((g) => [`${side}Grants${cap(g)}`, grants[g]]));
}

/**
 * Release everything an edge held open (REWORK B6, applied at sever): open
 * orders across the pair auto-cancel and their reservations release. DRAFT
 * carts are left alone (nothing reserved; submit will fail on the dead
 * grant). Loans deliberately survive until returned; ledger history and the
 * net balance survive forever.
 */
async function cancelOpenOrdersAcross(
  tx: Prisma.TransactionClient,
  householdId1: string,
  householdId2: string,
) {
  const open = await tx.order.findMany({
    where: {
      status: { in: ['REQUESTED', 'PICKING', 'READY'] },
      OR: [
        { householdId: householdId1, pantry: { householdId: householdId2 } },
        { householdId: householdId2, pantry: { householdId: householdId1 } },
      ],
    },
    include: { lines: true },
  });
  for (const order of open) {
    const moved = await tx.order.updateMany({
      where: { id: order.id, status: { in: ['REQUESTED', 'PICKING', 'READY'] } },
      data: { status: 'CANCELED', canceledAt: new Date() },
    });
    if (moved.count === 0) continue;
    for (const line of order.lines) {
      await tx.lot.updateMany({
        where: { id: line.lotId, reservedCount: { gte: line.quantity } },
        data: { reservedCount: { decrement: line.quantity } },
      });
    }
  }
  return open.length;
}

export const connectionRouter = router({
  /**
   * Every connection of the acting household, any status, normalized to the
   * counterparty's perspective. Feeds the /more Connections card.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.user.householdId;
    const rows = await db.connection.findMany({
      where: { OR: [{ householdAId: me }, { householdBId: me }] },
      include: {
        householdA: { select: { id: true, name: true, slug: true } },
        householdB: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      yourHouseholdId: me,
      canManage: ctx.user.activeMembership.manageConnections,
      connections: rows.map((row) => {
        const counterparty = row.householdAId === me ? row.householdB : row.householdA;
        return {
          id: row.id,
          counterparty: { id: counterparty.id, name: counterparty.name, slug: counterparty.slug },
          status: row.status,
          /** Whether the ACTING household initiated the (pending) request. */
          requestedByUs: row.requestedByHouseholdId === me,
          weGrant: grantsFrom(row, me),
          theyGrant: grantsFrom(row, counterparty.id),
          activatedAt: row.activatedAt?.toISOString() ?? null,
          severedAt: row.severedAt?.toISOString() ?? null,
        };
      }),
    };
  }),

  /**
   * Request a connection to a household by its handle (B5: exact handle you
   * got out-of-band — no browsing, no discovery). Creates a PENDING edge
   * carrying OUR grant set; the counterparty's set stays empty until they
   * accept. A SEVERED pair may be re-requested (people make up) — the edge
   * returns to PENDING with both grant sets reset.
   */
  request: protectedProcedure
    .input(z.object({ slug: z.string().trim().toLowerCase().min(1).max(64), grants: grantSetSchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const target = await tx.household.findUnique({ where: { slug: input.slug } });
        if (!target) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No household with that handle.' });
        }
        if (target.id === me) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: "That's your own household." });
        }
        const existing = await getConnection(tx, me, target.id);
        if (existing && existing.status !== 'SEVERED') {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              existing.status === 'ACTIVE'
                ? "You're already connected."
                : 'A request between your households is already pending.',
          });
        }
        const [householdAId, householdBId] = [me, target.id].sort();
        const mySide = householdAId === me ? 'a' : 'b';
        const otherSide = mySide === 'a' ? 'b' : 'a';
        const data = {
          status: 'PENDING',
          requestedByHouseholdId: me,
          activatedAt: null,
          severedAt: null,
          ...grantColumns(mySide, input.grants),
          ...grantColumns(otherSide, Object.fromEntries(GRANTS.map((g) => [g, false])) as GrantSet),
        };
        const connection = existing
          ? await tx.connection.update({ where: { id: existing.id }, data })
          : await tx.connection.create({ data: { householdAId, householdBId, ...data } });
        return { id: connection.id, counterpartyName: target.name };
      });
    }),

  /**
   * Accept or decline a PENDING request aimed at the acting household.
   * Accepting sets OUR grant set and activates the edge; declining deletes
   * the row (nothing happened yet — the pair can be re-requested cleanly).
   */
  respond: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
        accept: z.boolean(),
        // Required when accepting; ignored on decline.
        grants: grantSetSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const connection = await tx.connection.findUnique({ where: { id: input.connectionId } });
        if (!connection || (connection.householdAId !== me && connection.householdBId !== me)) {
          throw new TRPCError({ code: 'NOT_FOUND' });
        }
        if (connection.status !== 'PENDING') {
          throw new TRPCError({ code: 'CONFLICT', message: 'This request is no longer pending.' });
        }
        if (connection.requestedByHouseholdId === me) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'The other household has to answer this one.',
          });
        }
        if (!input.accept) {
          await tx.connection.delete({ where: { id: connection.id } });
          return { status: 'DECLINED' as const };
        }
        if (!input.grants) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick what you grant them.' });
        }
        await tx.connection.update({
          where: { id: connection.id },
          data: {
            status: 'ACTIVE',
            activatedAt: new Date(),
            ...grantColumns(sideOf(connection, me), input.grants),
          },
        });
        return { status: 'ACTIVE' as const };
      });
    }),

  /**
   * Edit OUR side's grant set — unilateral, any time, no consent (B2). Works
   * on PENDING (the requester adjusting their offer) and ACTIVE edges.
   */
  setGrants: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1), grants: grantSetSchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const connection = await tx.connection.findUnique({ where: { id: input.connectionId } });
        if (!connection || (connection.householdAId !== me && connection.householdBId !== me)) {
          throw new TRPCError({ code: 'NOT_FOUND' });
        }
        if (connection.status === 'SEVERED') {
          throw new TRPCError({ code: 'CONFLICT', message: 'This connection is severed.' });
        }
        await tx.connection.update({
          where: { id: connection.id },
          data: grantColumns(sideOf(connection, me), input.grants),
        });
        return { ok: true };
      });
    }),

  /**
   * Sever an ACTIVE edge (unilateral, B6): new activity stops immediately —
   * open orders across the pair auto-cancel and release their reservations —
   * while loans run to return and the ledger/net survive forever (settlement
   * still works, per assertPairWithMe's any-status rule). On a PENDING edge
   * this is the requester withdrawing (row deleted, like a decline).
   */
  sever: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const connection = await tx.connection.findUnique({ where: { id: input.connectionId } });
        if (!connection || (connection.householdAId !== me && connection.householdBId !== me)) {
          throw new TRPCError({ code: 'NOT_FOUND' });
        }
        if (connection.status === 'SEVERED') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Already severed.' });
        }
        if (connection.status === 'PENDING') {
          await tx.connection.delete({ where: { id: connection.id } });
          return { status: 'WITHDRAWN' as const, canceledOrders: 0 };
        }
        const canceledOrders = await cancelOpenOrdersAcross(
          tx,
          connection.householdAId,
          connection.householdBId,
        );
        await tx.connection.update({
          where: { id: connection.id },
          data: { status: 'SEVERED', severedAt: new Date() },
        });
        return { status: 'SEVERED' as const, canceledOrders };
      });
    }),
});
