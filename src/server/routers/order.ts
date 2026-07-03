import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { dbTransaction } from '../db';
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
 * Load a lot and assert it is orderable from this pantry: finalized, a real
 * inventory line (not excluded), and with its unit cost frozen. Returns the lot
 * plus the pantry-owning ("store") household.
 */
async function loadOrderableLot(tx: Prisma.TransactionClient, lotId: string, pantryId: string) {
  const lot = await tx.lot.findUnique({
    where: { id: lotId },
    include: {
      restock: {
        select: { pantryId: true, status: true, voidedAt: true, pantry: { select: { householdId: true } } },
      },
    },
  });
  if (!lot || lot.restock.pantryId !== pantryId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found in this pantry.' });
  }
  if (
    lot.restock.status !== 'FINALIZED' ||
    lot.restock.voidedAt !== null ||
    lot.excluded ||
    lot.unitCostCents === null
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That item is not available to order.' });
  }
  return { lot, ownerHouseholdId: lot.restock.pantry.householdId };
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
      return dbTransaction(async (tx) => {
        const { lot } = await loadOrderableLot(tx, input.lotId, input.pantryId);
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
      return dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id: input.orderId } });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        if (order.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the requesting household can edit this order.' });
        }
        if (!EDITABLE.has(order.status)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This order can no longer be changed.' });
        }
        const { lot } = await loadOrderableLot(tx, input.lotId, order.pantryId);
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
      return dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id: input.orderId }, include: { lines: true } });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        if (order.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the requesting household can submit this order.' });
        }
        if (order.lines.length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Add something to the order first.' });
        }
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: 'DRAFT' },
          data: { status: 'REQUESTED', requestedAt: new Date() },
        });
        if (moved.count === 0) {
          // Already requested (idempotent replay) — no re-reserve.
          return { orderId: order.id, status: 'REQUESTED' as const };
        }
        for (const line of order.lines) {
          await loadOrderableLot(tx, line.lotId, order.pantryId);
          await reserve(tx, line.lotId, line.quantity);
        }
        return { orderId: order.id, status: 'REQUESTED' as const };
      });
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
      return dbTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { pantry: { select: { householdId: true } } },
        });
        if (!order) throw new TRPCError({ code: 'NOT_FOUND' });
        if (order.pantry.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the pantry household can ready this order.' });
        }
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: 'PICKING' },
          data: { status: 'READY', readyAt: new Date() },
        });
        if (moved.count === 0) throw new TRPCError({ code: 'CONFLICT', message: 'Order is not being picked.' });
        return { ok: true };
      });
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
