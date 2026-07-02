import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

export const takeRouter = router({
  /**
   * Take N units from a lot (blueprint 01 D2/D3). Any coop member may take
   * from any lot. One transaction: the conditional decrement is the stock
   * guard (never lets remainingCount go negative and only touches FINALIZED
   * restocks), the Take row is the log, and a cross-household take posts the
   * TAKE ledger entry at exactly quantity × unitCostCents (invariant 3).
   */
  create: protectedProcedure
    .input(
      z.object({
        lotId: z.string().min(1),
        quantity: z.number().int().min(1).max(10_000),
        // Idempotency key, generated once per take sheet. The button's
        // disabled={isPending} re-renders asynchronously, so a fast double-tap
        // can dispatch two mutates; the second must not double-take.
        clientKey: z.string().min(8).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        // Replay of a committed take (same key): return the original instead
        // of decrementing again. Safe check-then-act — dbTransaction holds the
        // app-wide DB lock for the whole transaction.
        if (input.clientKey) {
          const existing = await tx.take.findUnique({
            where: { clientKey: input.clientKey },
            include: { lot: { select: { product: { select: { name: true } } } } },
          });
          if (existing) {
            if (existing.takerId !== ctx.user.id || existing.lotId !== input.lotId) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
            }
            return {
              takeId: existing.id,
              quantity: existing.quantity,
              costCents: existing.costCents,
              productName: existing.lot.product.name,
            };
          }
        }

        const lot = await tx.lot.findUnique({
          where: { id: input.lotId },
          include: {
            restock: { include: { pantry: { select: { householdId: true } } } },
            product: { select: { name: true } },
          },
        });
        if (!lot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Lot not found.' });

        // D3: the guard and the decrement are one conditional write. A miss
        // means "not enough left" or "not finalized" — either way, no take.
        const hit = await tx.lot.updateMany({
          where: {
            id: lot.id,
            remainingCount: { gte: input.quantity },
            restock: { status: 'FINALIZED' },
          },
          data: { remainingCount: { decrement: input.quantity } },
        });
        if (hit.count === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left.' });
        }
        // The guard passed, so the restock is FINALIZED and unitCostCents is
        // frozen (finalize sets both in one transaction).
        if (lot.unitCostCents === null) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Lot has no unit cost.' });
        }

        const ownerHouseholdId = lot.restock.pantry.householdId;
        const cross = ctx.user.householdId !== ownerHouseholdId;
        // Own-pantry takes are inventory decrements only (invariant 4).
        const costCents = cross ? input.quantity * lot.unitCostCents : 0;

        const take = await tx.take.create({
          data: {
            lotId: lot.id,
            takerId: ctx.user.id,
            quantity: input.quantity,
            costCents,
            clientKey: input.clientKey ?? null,
          },
        });
        if (costCents > 0) {
          await tx.ledgerEntry.create({
            data: {
              type: 'TAKE',
              takeId: take.id,
              creditorHouseholdId: ownerHouseholdId,
              debtorHouseholdId: ctx.user.householdId,
              amountCents: costCents,
              createdById: ctx.user.id,
            },
          });
        }
        return {
          takeId: take.id,
          quantity: input.quantity,
          costCents,
          productName: lot.product.name,
        };
      });
    }),

  /**
   * Undo a take (covers returns). Member of the taking household only. The
   * reversedAt guard makes double-submits fail closed even for own-household
   * takes, which have no ledger entry (blueprint 01 D2). Cross-household
   * undos post a swapped-party REVERSAL — the original entry is never
   * touched (append-only ledger).
   */
  undo: protectedProcedure
    .input(z.object({ takeId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const take = await tx.take.findUnique({
          where: { id: input.takeId },
          include: { taker: { select: { householdId: true } } },
        });
        if (!take) throw new TRPCError({ code: 'NOT_FOUND' });
        if (take.taker.householdId !== ctx.user.householdId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the taking household can undo a take.',
          });
        }

        const undone = await tx.take.updateMany({
          where: { id: take.id, reversedAt: null },
          data: { reversedAt: new Date(), reversedById: ctx.user.id },
        });
        if (undone.count === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Already undone.' });
        }

        await tx.lot.update({
          where: { id: take.lotId },
          data: { remainingCount: { increment: take.quantity } },
        });

        const entry = await tx.ledgerEntry.findUnique({ where: { takeId: take.id } });
        if (entry) {
          // Same amount, swapped parties, linked via reversesId (invariant 6).
          // No takeId on the REVERSAL: that column marks TAKE entries only.
          await tx.ledgerEntry.create({
            data: {
              type: 'REVERSAL',
              reversesId: entry.id,
              creditorHouseholdId: entry.debtorHouseholdId,
              debtorHouseholdId: entry.creditorHouseholdId,
              amountCents: entry.amountCents,
              createdById: ctx.user.id,
            },
          });
        }
        return { ok: true };
      });
    }),
});
