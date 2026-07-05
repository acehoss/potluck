import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { SessionUser } from '../auth';
import { hasActiveGrant, reachesResource, requireCapability } from '../authz';
import { dbTransaction } from '../db';
import { notify } from '../push';
import { protectedProcedure, router } from '../trpc';

/**
 * Orders with a request/fulfilment lifecycle + inventory reservation
 * (PLAN "Orders & requests"). Every order runs the same path — there is no
 * instant-take:
 *   DRAFT → REQUESTED (reserve) → PICKING (lock) → READY → PICKED_UP (Takes +
 *   ledger post here) / CANCELED (release; ledger untouched).
 * Availability everywhere is remainingCount − reservedCount. Reservation is a
 * soft hold that never touches the ledger; money posts only at pickup, exactly
 * mirroring take.create (money rule #2, invariants 3/4). The ledger stays
 * append-only — a post-pickup return is take.undo's swapped-party REVERSAL.
 */

// Statuses in which the requester may still change lines.
const EDITABLE = new Set(['DRAFT', 'REQUESTED']);

/**
 * Load a lot and assert it is orderable from this pantry BY this user's
 * acting household: finalized, a real inventory line (not excluded), unit
 * cost frozen — and the pantry reachable (own, or shared + ACTIVE pantry
 * grant from its owner, REWORK B2/B3; unreachable reads as not-found).
 * Returns the lot plus the pantry-owning ("store") household.
 */
async function loadOrderableLot(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  lotId: string,
  pantryId: string,
) {
  const lot = await tx.lot.findUnique({
    where: { id: lotId },
    include: {
      restock: {
        select: {
          pantryId: true,
          status: true,
          voidedAt: true,
          pantry: { select: { householdId: true, visibility: true } },
        },
      },
    },
  });
  if (!lot || lot.restock.pantryId !== pantryId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found in this pantry.' });
  }
  const ownerHouseholdId = lot.restock.pantry.householdId;
  if (ownerHouseholdId !== user.householdId) {
    const visible = await reachesResource(
      tx,
      ownerHouseholdId,
      user.householdId,
      'pantry',
      lot.restock.pantry,
      (circleId) =>
        tx.pantryCircle
          .findUnique({ where: { pantryId_circleId: { pantryId, circleId } } })
          .then(Boolean),
    );
    if (!visible) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found in this pantry.' });
    }
  }
  if (
    lot.restock.status !== 'FINALIZED' ||
    lot.restock.voidedAt !== null ||
    lot.excluded ||
    lot.unitCostCents === null
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That item is not available to order.' });
  }
  return { lot, ownerHouseholdId };
}

/**
 * Reserve `qty` units on a lot: bump reservedCount when availability
 * (remainingCount − reservedCount) covers it. Prisma's WHERE can't compare two
 * columns, so read then guard the updateMany on the read values (the app-wide
 * lock in dbTransaction makes a miss impossible; the retry is belt-and-braces,
 * mirroring adjustment.guardedRecount).
 */
async function reserve(tx: Prisma.TransactionClient, lotId: string, qty: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const lot = await tx.lot.findUniqueOrThrow({
      where: { id: lotId },
      select: { remainingCount: true, reservedCount: true },
    });
    if (lot.remainingCount - lot.reservedCount < qty) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left to reserve.' });
    }
    const hit = await tx.lot.updateMany({
      where: { id: lotId, remainingCount: lot.remainingCount, reservedCount: lot.reservedCount },
      data: { reservedCount: { increment: qty } },
    });
    if (hit.count === 1) return;
  }
  throw new TRPCError({ code: 'CONFLICT', message: 'That item changed underneath you — try again.' });
}

/** Release `qty` reserved units. Guards reservedCount ≥ qty so it never goes negative. */
async function release(tx: Prisma.TransactionClient, lotId: string, qty: number) {
  if (qty <= 0) return;
  await tx.lot.updateMany({
    where: { id: lotId, reservedCount: { gte: qty } },
    data: { reservedCount: { decrement: qty } },
  });
}

export const orderRouter = router({
  /**
   * Add/set a lot line in the household's DRAFT cart for a pantry (find-or-create
   * the cart). Absolute quantity, so a double-tap is idempotent. DRAFT reserves
   * nothing — reservation happens at submit.
   */
  addToCart: protectedProcedure
    .input(
      z.object({
        pantryId: z.string().min(1),
        lotId: z.string().min(1),
        quantity: z.number().int().min(1).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'placeOrders');
      return dbTransaction(async (tx) => {
        const { lot } = await loadOrderableLot(tx, ctx.user, input.lotId, input.pantryId);
        let order = await tx.order.findFirst({
          where: { pantryId: input.pantryId, householdId: ctx.user.householdId, status: 'DRAFT' },
        });
        if (!order) {
          order = await tx.order.create({
            data: {
              pantryId: input.pantryId,
              householdId: ctx.user.householdId,
              createdById: ctx.user.id,
              status: 'DRAFT',
            },
          });
        }
        const existing = await tx.orderLine.findFirst({ where: { orderId: order.id, lotId: lot.id } });
        if (existing) {
          await tx.orderLine.update({ where: { id: existing.id }, data: { quantity: input.quantity } });
        } else {
          await tx.orderLine.create({ data: { orderId: order.id, lotId: lot.id, quantity: input.quantity } });
        }
        const lineCount = await tx.orderLine.count({ where: { orderId: order.id } });
        return { orderId: order.id, lineCount };
      });
    }),

  /**
   * Set a line's absolute quantity on an editable order the household owns
   * (DRAFT cart review, or a still-editable REQUESTED order). quantity 0 removes
   * it. On a REQUESTED order the reservation moves by the delta (reserve up,
   * release down); DRAFT touches no reservation.
   */
  setLine: protectedProcedure
    .input(
      z.object({
        orderId: z.string().min(1),
        lotId: z.string().min(1),
        quantity: z.number().int().min(0).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'placeOrders');
      return dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id: input.orderId } });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        if (order.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the requesting household can edit this order.' });
        }
        if (!EDITABLE.has(order.status)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This order can no longer be changed.' });
        }
        const { lot, ownerHouseholdId } = await loadOrderableLot(
          tx,
          ctx.user,
          input.lotId,
          order.pantryId,
        );
        // Editing an already-SUBMITTED cross-household order changes what
        // money will post at pickup — that consent belongs to a spend-holder,
        // exactly like submit itself (a placeOrders-only member could
        // otherwise inflate a submitted order past what was approved).
        if (order.status === 'REQUESTED' && ownerHouseholdId !== ctx.user.householdId) {
          requireCapability(ctx.user, 'spend');
        }
        const existing = await tx.orderLine.findFirst({ where: { orderId: order.id, lotId: lot.id } });
        const oldQty = existing?.quantity ?? 0;
        const delta = input.quantity - oldQty;
        if (order.status === 'REQUESTED' && delta !== 0) {
          if (delta > 0) await reserve(tx, lot.id, delta);
          else await release(tx, lot.id, -delta);
        }
        if (input.quantity === 0) {
          if (existing) await tx.orderLine.delete({ where: { id: existing.id } });
        } else if (existing) {
          await tx.orderLine.update({ where: { id: existing.id }, data: { quantity: input.quantity } });
        } else {
          await tx.orderLine.create({ data: { orderId: order.id, lotId: lot.id, quantity: input.quantity } });
        }
        const lineCount = await tx.orderLine.count({ where: { orderId: order.id } });
        return { orderId: order.id, lineCount };
      });
    }),

  /**
   * Submit a DRAFT cart → REQUESTED, reserving every line. Any shortfall rolls
   * the whole transaction back (nothing reserved). The DRAFT→REQUESTED status
   * guard makes a double-submit fire once. No ledger movement — reserving is not
   * a money event.
   */
  submit: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'placeOrders');
      const result = await dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { lines: true, pantry: { select: { householdId: true } } },
        });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        if (order.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the requesting household can submit this order.' });
        }
        // A cross-household submission commits the acting household to money
        // at pickup — that's the spend line (A3a: order-holders draft,
        // spend-holders submit).
        if (order.pantry.householdId !== ctx.user.householdId) {
          requireCapability(ctx.user, 'spend');
        }
        if (order.lines.length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Add something to the order first.' });
        }
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: 'DRAFT' },
          data: { status: 'REQUESTED', requestedAt: new Date() },
        });
        if (moved.count === 0) {
          // Already requested (idempotent replay) — no re-reserve, no re-notify.
          return { orderId: order.id, submitted: false, ownerHouseholdId: order.pantry.householdId };
        }
        for (const line of order.lines) {
          await loadOrderableLot(tx, ctx.user, line.lotId, order.pantryId);
          await reserve(tx, line.lotId, line.quantity);
        }
        return { orderId: order.id, submitted: true, ownerHouseholdId: order.pantry.householdId };
      });
      // Post-commit (blueprint 04 §4 shape): notify the pantry-OWNER household a
      // request landed — but not for an own-pantry order (owner == requester).
      // Fired only on a genuine DRAFT→REQUESTED move (idempotent replay stays
      // quiet). category pickups (needs-your-hands); generic content (N4).
      if (result.submitted && result.ownerHouseholdId !== ctx.user.householdId) {
        void notify({
          recipientHouseholdIds: [result.ownerHouseholdId],
          excludeUserId: ctx.user.id,
          category: 'pickups',
          url: '/orders',
          title: 'New request in {household}',
          body: 'A household wants goods from your pantry.',
          detail: `From ${ctx.user.household.name}.`,
        });
      }
      return { orderId: result.orderId, status: 'REQUESTED' as const };
    }),

  /** Owner starts picking a REQUESTED order → PICKING. Locks the requester's edits. */
  startPicking: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { pantry: { select: { householdId: true } } },
        });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        if (order.pantry.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the pantry household can pick this order.' });
        }
        requireCapability(ctx.user, 'fulfill');
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: 'REQUESTED' },
          data: { status: 'PICKING', pickingAt: new Date() },
        });
        if (moved.count === 0) throw new TRPCError({ code: 'CONFLICT', message: 'Order is not awaiting picking.' });
        return { ok: true };
      });
    }),

  /** Owner finishes → READY (set aside for pickup). */
  markReady: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { pantry: { select: { householdId: true } } },
        });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        if (order.pantry.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the pantry household can ready this order.' });
        }
        requireCapability(ctx.user, 'fulfill');
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: 'PICKING' },
          data: { status: 'READY', readyAt: new Date() },
        });
        if (moved.count === 0) throw new TRPCError({ code: 'CONFLICT', message: 'Order is not being picked.' });
        return { requesterHouseholdId: order.householdId, ownerHouseholdId: order.pantry.householdId };
      });
      // Post-commit: tell the REQUESTING household their order is ready to pick
      // up (skip an own-pantry order — requester == owner). pickups; generic.
      if (result.requesterHouseholdId !== result.ownerHouseholdId) {
        void notify({
          recipientHouseholdIds: [result.requesterHouseholdId],
          excludeUserId: ctx.user.id,
          category: 'pickups',
          url: '/orders',
          title: 'Ready to pick up in {household}',
          body: 'An order you placed is ready.',
          detail: `From ${ctx.user.household.name}.`,
        });
      }
      return { ok: true };
    }),

  /**
   * Mark a READY order PICKED_UP — the money event. Either household may do it.
   * Per line: consume the reservation (decrement remainingCount AND reservedCount
   * together), log a Take, and — cross-household only — post the TAKE ledger
   * entry at quantity × frozen unitCost (invariant 3). One dbTransaction: all
   * lines commit or none. The READY→PICKED_UP status guard + clientKey make it
   * fire once.
   */
  pickup: protectedProcedure
    .input(z.object({ orderId: z.string().min(1), clientKey: z.string().min(8).max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { lines: true, pantry: { select: { householdId: true } } },
        });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        const ownerHouseholdId = order.pantry.householdId;
        const debtorHouseholdId = order.householdId; // the requesting household owes
        const isRequester = debtorHouseholdId === ctx.user.householdId;
        const isOwner = ownerHouseholdId === ctx.user.householdId;
        if (!isRequester && !isOwner) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the two households can complete this order.' });
        }
        // Capability per side (A3a): the requester side posts money on a
        // cross-household order (spend; own-pantry moves none — placeOrders);
        // the owner side hands goods over (fulfill). A user in both
        // households qualifies through either.
        const crossOrder = debtorHouseholdId !== ownerHouseholdId;
        const capable =
          (isRequester &&
            (crossOrder ? ctx.user.activeMembership.spend : ctx.user.activeMembership.placeOrders)) ||
          (isOwner && ctx.user.activeMembership.fulfill);
        if (!capable) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: "Your role in this household doesn't allow that.",
          });
        }

        // clientKey replay: return the original result instead of re-posting.
        if (input.clientKey) {
          const prior = await tx.order.findUnique({ where: { clientKey: input.clientKey } });
          if (prior) {
            if (prior.id !== order.id) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
            }
            if (prior.status === 'PICKED_UP') return { orderId: order.id, status: 'PICKED_UP' as const };
          }
        }

        // Reach is re-verified at the MONEY moment, not just at submit: a
        // pantry grant revoked (or a connection severed) while the order sat
        // READY must block the post — B6's sever-auto-cancel arrives with the
        // S3 sever flow; this is the belt under it. Cancel still works (it
        // deliberately checks no grant, so the reservation can always be
        // released across a dead edge).
        if (
          crossOrder &&
          !(await hasActiveGrant(tx, ownerHouseholdId, debtorHouseholdId, 'pantry'))
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'The connection no longer allows this order — cancel it instead.',
          });
        }

        const moved = await tx.order.updateMany({
          where: { id: order.id, status: 'READY' },
          data: { status: 'PICKED_UP', pickedUpAt: new Date(), clientKey: input.clientKey ?? null },
        });
        if (moved.count === 0) throw new TRPCError({ code: 'CONFLICT', message: 'Order is not ready for pickup.' });

        for (const line of order.lines) {
          const lot = await tx.lot.findUnique({
            where: { id: line.lotId },
            include: { restock: { select: { status: true } } },
          });
          if (!lot || lot.restock.status !== 'FINALIZED' || lot.unitCostCents === null) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Lot is not finalized.' });
          }
          const hit = await tx.lot.updateMany({
            where: {
              id: line.lotId,
              remainingCount: { gte: line.quantity },
              reservedCount: { gte: line.quantity },
            },
            data: {
              remainingCount: { decrement: line.quantity },
              reservedCount: { decrement: line.quantity },
            },
          });
          if (hit.count === 0) throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left.' });

          const cross = debtorHouseholdId !== ownerHouseholdId;
          const costCents = cross ? line.quantity * lot.unitCostCents : 0;
          const take = await tx.take.create({
            data: {
              lotId: line.lotId,
              takerId: order.createdById, // requester's user who built the order
              // The household the goods transferred to — the order's
              // requester household, snapshotted so undo authz and history
              // never re-derive it from a user's (mutable) memberships.
              householdId: order.householdId,
              quantity: line.quantity,
              costCents,
              clientKey: input.clientKey ? `${input.clientKey}:${line.id}` : null,
            },
          });
          await tx.orderLine.update({ where: { id: line.id }, data: { takeId: take.id } });
          if (costCents > 0) {
            await tx.ledgerEntry.create({
              data: {
                type: 'TAKE',
                takeId: take.id,
                creditorHouseholdId: ownerHouseholdId,
                debtorHouseholdId,
                amountCents: costCents,
                createdById: ctx.user.id,
              },
            });
          }
        }
        return { orderId: order.id, status: 'PICKED_UP' as const };
      });
    }),

  /**
   * Cancel a DRAFT or REQUESTED order (before picking starts), releasing any
   * reservation. The requester may cancel either; the pantry household may
   * decline a REQUESTED one. Nothing posts to the ledger — money never moved.
   */
  cancel: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { lines: true, pantry: { select: { householdId: true } } },
        });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        const isRequester = order.householdId === ctx.user.householdId;
        const isOwner = order.pantry.householdId === ctx.user.householdId;
        if (!isRequester && !isOwner) throw new TRPCError({ code: 'FORBIDDEN' });
        // A DRAFT is the requester's private cart — the owner can't touch it.
        if (order.status === 'DRAFT' && !isRequester) {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }
        // Requester cancels with placeOrders; the owner's decline is a
        // fulfillment action (A3a).
        const capable =
          (isRequester && ctx.user.activeMembership.placeOrders) ||
          (isOwner && ctx.user.activeMembership.fulfill);
        if (!capable) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: "Your role in this household doesn't allow that.",
          });
        }
        const wasReserved = order.status === 'REQUESTED';
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: { in: ['DRAFT', 'REQUESTED'] } },
          data: { status: 'CANCELED', canceledAt: new Date() },
        });
        if (moved.count === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This order can no longer be canceled.' });
        }
        if (wasReserved) {
          for (const line of order.lines) await release(tx, line.lotId, line.quantity);
        }
        return { ok: true };
      });
    }),
});
