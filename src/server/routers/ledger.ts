import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { db, dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

/** Upper bound for money inputs: keeps values inside Prisma's Int range. */
const MAX_CENTS = 100_000_000; // $1,000,000

/**
 * A money entry between two distinct households, one of which must be the
 * acting user's own (blueprint 01 authz matrix — both the SETTLEMENT and
 * ADJUSTMENT rows require it). Returns them in no particular order.
 */
async function assertPairWithMe(
  tx: Prisma.TransactionClient,
  a: string,
  b: string,
  me: string,
): Promise<void> {
  if (a === b) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick two different households.' });
  }
  if (me !== a && me !== b) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your household must be part of this entry.',
    });
  }
  const found = await tx.household.count({ where: { id: { in: [a, b] } } });
  if (found !== 2) throw new TRPCError({ code: 'NOT_FOUND', message: 'Household not found.' });
}

/**
 * Replay of a committed settle/adjust (same clientKey): return the original
 * entry instead of posting a second immutable money row. Same failure mode
 * the slice-3 Take.clientKey closed — disabled={isPending} re-renders
 * asynchronously, so a double-tap (or a retry after a lost response)
 * dispatches two mutates. Safe check-then-act: dbTransaction holds the
 * app-wide DB lock for the whole transaction.
 */
async function findReplayedEntry(
  tx: Prisma.TransactionClient,
  clientKey: string | undefined,
  type: 'SETTLEMENT' | 'ADJUSTMENT',
  userId: string,
) {
  if (!clientKey) return null;
  const existing = await tx.ledgerEntry.findUnique({ where: { clientKey } });
  if (!existing) return null;
  if (existing.createdById !== userId || existing.type !== type) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
  }
  return existing;
}

export const ledgerRouter = router({
  /**
   * Record a settlement (blueprint 01 D5): no table — a SETTLEMENT
   * LedgerEntry with payer = creditor, so recording "$X from A to B" moves
   * net(A, B) up by X (invariant 11). Any member of the payer or payee
   * household may record it; every OTHER user of both households sees it
   * flagged "new" via LedgerSeen (push arrives in slice 7).
   */
  settle: protectedProcedure
    .input(
      z.object({
        payerHouseholdId: z.string().min(1),
        payeeHouseholdId: z.string().min(1),
        amountCents: z.number().int().min(1).max(MAX_CENTS),
        // Method + optional free text ("Venmo", "Cash — birthday").
        note: z.string().trim().min(1).max(200),
        // Idempotency key, generated once per settle sheet.
        clientKey: z.string().min(8).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const replayed = await findReplayedEntry(tx, input.clientKey, 'SETTLEMENT', ctx.user.id);
        if (replayed) return { id: replayed.id };
        await assertPairWithMe(
          tx,
          input.payerHouseholdId,
          input.payeeHouseholdId,
          ctx.user.householdId,
        );
        const entry = await tx.ledgerEntry.create({
          data: {
            type: 'SETTLEMENT',
            clientKey: input.clientKey ?? null,
            creditorHouseholdId: input.payerHouseholdId,
            debtorHouseholdId: input.payeeHouseholdId,
            amountCents: input.amountCents,
            note: input.note,
            createdById: ctx.user.id,
          },
        });
        return { id: entry.id };
      });
    }),

  /**
   * Manual ledger adjustment (blueprint 02's repair sheet): free-form entry
   * with a REQUIRED note explaining it. Any member may create one, but their
   * own household must be creditor or debtor; the counterparty household is
   * notified via the in-app "new" flag (LedgerSeen) — push at slice 7.
   * Wrong restock credits are NOT fixed here (the linked correct-credit op
   * owns that path, per blueprint 01 Immutability).
   */
  adjust: protectedProcedure
    .input(
      z.object({
        creditorHouseholdId: z.string().min(1),
        debtorHouseholdId: z.string().min(1),
        amountCents: z.number().int().min(1).max(MAX_CENTS),
        note: z.string().trim().min(1).max(200),
        // Idempotency key, generated once per adjust sheet.
        clientKey: z.string().min(8).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const replayed = await findReplayedEntry(tx, input.clientKey, 'ADJUSTMENT', ctx.user.id);
        if (replayed) return { id: replayed.id };
        await assertPairWithMe(
          tx,
          input.creditorHouseholdId,
          input.debtorHouseholdId,
          ctx.user.householdId,
        );
        const entry = await tx.ledgerEntry.create({
          data: {
            type: 'ADJUSTMENT',
            clientKey: input.clientKey ?? null,
            creditorHouseholdId: input.creditorHouseholdId,
            debtorHouseholdId: input.debtorHouseholdId,
            amountCents: input.amountCents,
            note: input.note,
            createdById: ctx.user.id,
          },
        });
        return { id: entry.id };
      });
    }),

  /**
   * The viewer has seen one PAIR's ledger up to the page's render moment.
   * Fired from the ledger screen after render with the timestamp the server
   * captured BEFORE snapshotting the entry list — never "now": an entry
   * created between the render and this write was never on the page, so it
   * must stay unseen. Per-pair so that with >2 households, viewing pair A–C
   * can't swallow a never-displayed entry from pair A–B. The watermark only
   * moves forward (a stale tab replaying an old timestamp is a no-op).
   */
  markSeen: protectedProcedure
    .input(
      z.object({
        counterpartyHouseholdId: z.string().min(1),
        // The page's render timestamp, epoch ms (server-generated, echoed back).
        renderedAt: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Clamp to the server clock — a forged future stamp would blind the
      // user to entries that don't exist yet.
      const seenAt = new Date(Math.min(input.renderedAt, Date.now()));
      await dbTransaction(async (tx) => {
        const counterparty = await tx.household.findUnique({
          where: { id: input.counterpartyHouseholdId },
          select: { id: true },
        });
        if (!counterparty) throw new TRPCError({ code: 'NOT_FOUND' });
        const key = {
          userId: ctx.user.id,
          counterpartyHouseholdId: input.counterpartyHouseholdId,
        };
        const existing = await tx.ledgerSeen.findUnique({
          where: { userId_counterpartyHouseholdId: key },
        });
        if (!existing) {
          await tx.ledgerSeen.create({ data: { ...key, seenAt } });
        } else if (seenAt > existing.seenAt) {
          await tx.ledgerSeen.update({
            where: { userId_counterpartyHouseholdId: key },
            data: { seenAt },
          });
        }
      });
      return { ok: true };
    }),

  /**
   * Whether any ledger entry involving the viewer's household was created by
   * SOMEONE ELSE since the viewer last looked at that pair — drives the "new"
   * dot on the Ledger tab. Only the creating USER is excluded (blueprint 02:
   * a settlement is flagged for BOTH households until viewed — the recorder's
   * housemates still need to see it); newness is judged against the per-pair
   * LedgerSeen watermark.
   */
  hasNew: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.user.householdId;
    const seen = await db.ledgerSeen.findMany({
      where: { userId: ctx.user.id },
      select: { counterpartyHouseholdId: true, seenAt: true },
    });
    const seenByPair = new Map(seen.map((s) => [s.counterpartyHouseholdId, s.seenAt]));
    const candidates = await db.ledgerEntry.findMany({
      where: {
        OR: [{ creditorHouseholdId: me }, { debtorHouseholdId: me }],
        createdById: { not: ctx.user.id },
      },
      select: { creditorHouseholdId: true, debtorHouseholdId: true, createdAt: true },
    });
    const hasNew = candidates.some((c) => {
      const other = c.creditorHouseholdId === me ? c.debtorHouseholdId : c.creditorHouseholdId;
      const seenAt = seenByPair.get(other);
      return seenAt === undefined || c.createdAt > seenAt;
    });
    return { hasNew };
  }),
});
