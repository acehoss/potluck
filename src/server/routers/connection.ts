import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { circleToGrantSet, getConnection, grantsFrom, requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { notify } from '../push';
import { protectedProcedure, router } from '../trpc';

/**
 * Connection management (REWORK B1/B6, Phase-2 P4 circles): request/accept/
 * sever by household handle. Grants are no longer edited per-connection — each
 * side assigns the OTHER household into one of ITS OWN circles (a named grant
 * bundle) and re-assigns unilaterally, without the other's consent ("resource
 * owner is authoritative"). All mutations need the manageConnections capability
 * on the ACTING membership.
 */

/** Which side of `connection` the acting household occupies. */
function sideOf(connection: { householdAId: string }, householdId: string): 'a' | 'b' {
  return connection.householdAId === householdId ? 'a' : 'b';
}

/** Load an OWN circle by id, else 404 (a foreign/absent circle never resolves). */
async function requireOwnCircle(
  tx: Prisma.TransactionClient,
  householdId: string,
  circleId: string,
) {
  const circle = await tx.circle.findUnique({ where: { id: circleId } });
  if (!circle || circle.householdId !== householdId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No such circle.' });
  }
  return circle;
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
        aCircle: true,
        bCircle: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      yourHouseholdId: me,
      canManage: ctx.user.activeMembership.manageConnections,
      connections: rows.map((row) => {
        const iAmA = row.householdAId === me;
        const counterparty = iAmA ? row.householdB : row.householdA;
        const myCircle = iAmA ? row.aCircle : row.bCircle;
        return {
          id: row.id,
          counterparty: { id: counterparty.id, name: counterparty.name, slug: counterparty.slug },
          status: row.status,
          /** Whether the ACTING household initiated the (pending) request. */
          requestedByUs: row.requestedByHouseholdId === me,
          /** The circle WE placed them into — id/name/grants, ours to show. */
          myCircle: myCircle
            ? { id: myCircle.id, name: myCircle.name, grants: circleToGrantSet(myCircle) }
            : null,
          /** What they extend to US — effective grants only; their circle NAME
           *  is their private organization and never leaks here. */
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
    .input(
      z.object({
        slug: z.string().trim().toLowerCase().min(1).max(64),
        circleId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      const result = await dbTransaction(async (tx) => {
        await requireOwnCircle(tx, me, input.circleId);
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
        // Requester's side = their chosen circle; the addressee's stays null
        // until they accept (PENDING carries exactly one assigned side).
        const data = {
          status: 'PENDING',
          requestedByHouseholdId: me,
          activatedAt: null,
          severedAt: null,
          aCircleId: mySide === 'a' ? input.circleId : null,
          bCircleId: mySide === 'b' ? input.circleId : null,
        };
        const connection = existing
          ? await tx.connection.update({ where: { id: existing.id }, data })
          : await tx.connection.create({ data: { householdAId, householdBId, ...data } });
        return { id: connection.id, counterpartyName: target.name, targetHouseholdId: target.id };
      });
      // Post-commit: notify the ADDRESSEE household that a connection request is
      // waiting on them to accept/decline. category pickups (needs your hands);
      // generic content (N4). url /more (the Connections card lives there).
      void notify({
        recipientHouseholdIds: [result.targetHouseholdId],
        excludeUserId: ctx.user.id,
        category: 'pickups',
        url: '/more',
        title: 'New connection request for {household}',
        body: 'A household asked to connect with you.',
        detail: `From ${ctx.user.household.name}.`,
      });
      return { id: result.id, counterpartyName: result.counterpartyName };
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
        // The OWN circle to place them into. Required when accepting; ignored
        // on decline.
        circleId: z.string().min(1).optional(),
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
        if (!input.circleId) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick a circle for them.' });
        }
        await requireOwnCircle(tx, me, input.circleId);
        const mySide = sideOf(connection, me);
        // ACTIVE ⇒ both sides non-null: the requester's side was set at request,
        // this sets the addressee's. Guard the requester's side just in case a
        // migrated/edge-case row left it null.
        const requesterCircleId = mySide === 'a' ? connection.bCircleId : connection.aCircleId;
        if (!requesterCircleId) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This request is missing the other side — it may have been withdrawn.',
          });
        }
        await tx.connection.update({
          where: { id: connection.id },
          data: {
            status: 'ACTIVE',
            activatedAt: new Date(),
            ...(mySide === 'a'
              ? { aCircleId: input.circleId }
              : { bCircleId: input.circleId }),
          },
        });
        return { status: 'ACTIVE' as const };
      });
    }),

  /**
   * Move the counterparty into another of MY circles — unilateral, any time, no
   * consent (P4 replaces setGrants: editing which circle they're in IS how I
   * change what I grant them). Works on PENDING (the requester adjusting) and
   * ACTIVE edges; my side only.
   */
  assign: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1), circleId: z.string().min(1) }))
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
        await requireOwnCircle(tx, me, input.circleId);
        const mySide = sideOf(connection, me);
        await tx.connection.update({
          where: { id: connection.id },
          data: mySide === 'a' ? { aCircleId: input.circleId } : { bCircleId: input.circleId },
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
