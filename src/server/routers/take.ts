import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireCapability } from '../authz';
import { dbTransaction } from '../db';
import { restoreStock } from '../stock';
import { protectedProcedure, router } from '../trpc';

// The take is now the record of an ORDER pickup (a Take + its TAKE ledger entry
// are created inside order.pickup — the only path that hands goods over now that
// "everything is a request"). There is no instant-take mutation: a stand-alone
// take.create guarded only on physical count would oversell units already held
// by an open order's reservation. What survives here
// is undo — the append-only return path for a take, reachable from the restock
// detail (own-household takes) and the ledger detail (cross-household).
export const takeRouter = router({
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
      // Returns ride the ordering capability: undoing a take reverses an
      // order pickup (money flows BACK to the acting household, so no spend).
      requireCapability(ctx.user, 'placeOrders');
      return dbTransaction(async (tx) => {
        const take = await tx.take.findUnique({ where: { id: input.takeId } });
        if (!take) throw new TRPCError({ code: 'NOT_FOUND' });
        // The taking household is the snapshot on the take itself (stamped at
        // pickup from Order.householdId) — never re-derived from the taker
        // user, whose memberships can change (REWORK A3).
        if (take.householdId !== ctx.user.householdId) {
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

        const stock = await tx.stock.findUnique({
          where: { lotId_pantryId: { lotId: take.lotId, pantryId: take.pantryId } },
          select: { id: true },
        });
        if (!stock) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Original stock placement is missing.',
          });
        }
        await restoreStock(tx, stock.id, take.quantity);

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
