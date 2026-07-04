import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { requireCapability } from '../authz';
import { dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

/**
 * Inventory adjustments (blueprint 01 D3/D5, invariant 8): recount fixes
 * count drift, write-off records spoilage/damage. Neither touches the ledger
 * in v1 — the owner household eats it — which is enforced by construction:
 * the Adjustment model has no amount column and these mutations never create
 * LedgerEntry rows. Owner-household-only per the authz matrix.
 */

/**
 * Load the lot and gate: finalized restock, viewer belongs to the
 * pantry-owning household.
 */
async function getAdjustableLot(
  tx: Prisma.TransactionClient,
  lotId: string,
  user: { householdId: string },
) {
  const lot = await tx.lot.findUnique({
    where: { id: lotId },
    include: { restock: { include: { pantry: { select: { householdId: true } } } } },
  });
  if (!lot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Lot not found.' });
  if (lot.restock.status !== 'FINALIZED') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Restock is still a draft.' });
  }
  if (lot.restock.pantry.householdId !== user.householdId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the pantry-owning household can adjust its lots.',
    });
  }
  return lot;
}

/**
 * B3 pattern (blueprint 01): the client sends the target only; the server
 * reads remainingCount in-tx as countBefore and writes via a guarded
 * updateMany conditioned on that same countBefore, retrying the read+write on
 * a miss — a take interleaved during user think-time can never make
 * invariant 9 false. (Under dbTransaction's app-wide lock a miss is already
 * impossible; the retry is the belt to that suspender.)
 */
/**
 * Replay of a committed recount/write-off (same clientKey): return the
 * original instead of adjusting again. Write-offs are cumulative — a
 * double-tap or a retry after a lost response would decrement the lot twice
 * and record 2× units written off; recounts would only duplicate the audit
 * row, but the guard is uniform. Safe check-then-act under dbTransaction's
 * app-wide lock (same pattern as Take.clientKey from slice 3).
 */
async function findReplayedAdjustment(
  tx: Prisma.TransactionClient,
  clientKey: string | undefined,
  type: 'RECOUNT' | 'WRITE_OFF',
  input: { lotId: string },
  userId: string,
) {
  if (!clientKey) return null;
  const existing = await tx.adjustment.findUnique({ where: { clientKey } });
  if (!existing) return null;
  if (existing.createdById !== userId || existing.lotId !== input.lotId || existing.type !== type) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
  }
  return existing;
}

async function guardedRecount(
  tx: Prisma.TransactionClient,
  lotId: string,
  nextCount: (countBefore: number) => number,
): Promise<{ countBefore: number; countAfter: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const lot = await tx.lot.findUniqueOrThrow({
      where: { id: lotId },
      select: { remainingCount: true, reservedCount: true },
    });
    const countBefore = lot.remainingCount;
    const countAfter = nextCount(countBefore);
    if (countAfter < 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left.' });
    }
    // A recount/write-off must not drop physical stock below the units already
    // reserved by open orders — that would strand the reservation and wedge the
    // order at pickup (whose guard needs remainingCount ≥ its quantity). The
    // owner has to cancel or complete those orders first.
    if (countAfter < lot.reservedCount) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `${lot.reservedCount} unit(s) are held by open orders — cancel or complete those first.`,
      });
    }
    const hit = await tx.lot.updateMany({
      where: { id: lotId, remainingCount: countBefore, reservedCount: lot.reservedCount },
      data: { remainingCount: countAfter },
    });
    if (hit.count === 1) return { countBefore, countAfter };
  }
  throw new TRPCError({ code: 'CONFLICT', message: 'Lot changed underneath — try again.' });
}

export const adjustmentRouter = router({
  /**
   * Recount: set a lot's remaining count to what was physically counted.
   * For count drift only — spoilage/damage should be a write-off so the
   * Adjustment types stay distinct in history.
   */
  recount: protectedProcedure
    .input(
      z.object({
        lotId: z.string().min(1),
        countAfter: z.number().int().min(0).max(10_000),
        // Idempotency key, generated once per recount sheet.
        clientKey: z.string().min(8).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'adjustInventory');
      return dbTransaction(async (tx) => {
        const replayed = await findReplayedAdjustment(
          tx,
          input.clientKey,
          'RECOUNT',
          input,
          ctx.user.id,
        );
        if (replayed) {
          return {
            id: replayed.id,
            countBefore: replayed.countBefore,
            countAfter: replayed.countAfter,
          };
        }
        await getAdjustableLot(tx, input.lotId, ctx.user);
        const { countBefore, countAfter } = await guardedRecount(
          tx,
          input.lotId,
          () => input.countAfter,
        );
        const adjustment = await tx.adjustment.create({
          data: {
            clientKey: input.clientKey ?? null,
            lotId: input.lotId,
            type: 'RECOUNT',
            countBefore,
            countAfter,
            createdById: ctx.user.id,
          },
        });
        return { id: adjustment.id, countBefore, countAfter };
      });
    }),

  /**
   * Write off N units (expired/damaged) with a required reason. Decrements
   * the lot; the owner household eats the cost (invariant 8 — the WRITE_OFF
   * ledger type stays reserved for the post-v1 shared write-off door).
   */
  writeOff: protectedProcedure
    .input(
      z.object({
        lotId: z.string().min(1),
        count: z.number().int().min(1).max(10_000),
        reason: z.string().trim().min(1).max(200),
        // Idempotency key, generated once per write-off sheet — a replay must
        // NOT decrement the lot a second time.
        clientKey: z.string().min(8).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'adjustInventory');
      return dbTransaction(async (tx) => {
        const replayed = await findReplayedAdjustment(
          tx,
          input.clientKey,
          'WRITE_OFF',
          input,
          ctx.user.id,
        );
        if (replayed) {
          return {
            id: replayed.id,
            countBefore: replayed.countBefore,
            countAfter: replayed.countAfter,
          };
        }
        await getAdjustableLot(tx, input.lotId, ctx.user);
        const { countBefore, countAfter } = await guardedRecount(
          tx,
          input.lotId,
          (before) => before - input.count,
        );
        const adjustment = await tx.adjustment.create({
          data: {
            clientKey: input.clientKey ?? null,
            lotId: input.lotId,
            type: 'WRITE_OFF',
            countBefore,
            countAfter,
            note: input.reason,
            createdById: ctx.user.id,
          },
        });
        return { id: adjustment.id, countBefore, countAfter };
      });
    }),
});
