import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

// The take is now the record of an ORDER pickup (a Take + its TAKE ledger entry
// are created inside order.pickup — the only path that hands goods over now that
// "everything is a request"). There is no instant-take mutation: a stand-alone
// take.create guarded only on remainingCount would oversell units already held
// by an open order's reservation (it ignored reservedCount). What survives here
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
