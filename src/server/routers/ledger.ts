import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { getConnection, requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { adjustmentPushBody, notifyLedgerEvent, settlementPushBody } from '../push';
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
  // A money pair must ride a connection edge in ANY status — B6 keeps a
  // SEVERED pair settleable forever, but a never-connected household is out
  // of reach (and 404 keeps household ids unprobeable; a bare existence
  // check would be an oracle).
  const other = me === a ? b : a;
  const connection = await getConnection(tx, me, other);
  if (!connection) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Household not found.' });
  }
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
      requireCapability(ctx.user, 'settleMoney');
      const result = await dbTransaction(async (tx) => {
        const replayed = await findReplayedEntry(tx, input.clientKey, 'SETTLEMENT', ctx.user.id);
        if (replayed) return { id: replayed.id, created: false };
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
        return { id: entry.id, created: true };
      });
      // Push AFTER commit (blueprint 04 §4): one of the two v1 push events.
      // Fire-and-forget — never awaited, never fails the mutation — and only
      // for a genuinely new entry (a clientKey replay must not re-notify).
      if (result.created) {
        void notifyLedgerEvent({
          creatorId: ctx.user.id,
          householdIds: [input.payerHouseholdId, input.payeeHouseholdId],
          title: 'Settlement recorded',
          body: settlementPushBody(ctx.user.name, input.amountCents, input.note),
        });
      }
      return { id: result.id };
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
      requireCapability(ctx.user, 'settleMoney');
      const result = await dbTransaction(async (tx) => {
        const replayed = await findReplayedEntry(tx, input.clientKey, 'ADJUSTMENT', ctx.user.id);
        if (replayed) return { id: replayed.id, created: false };
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
        return { id: entry.id, created: true };
      });
      // The second (and last) v1 push event — same post-commit, non-blocking,
      // no-replay rules as settle.
      if (result.created) {
        void notifyLedgerEvent({
          creatorId: ctx.user.id,
          householdIds: [input.creditorHouseholdId, input.debtorHouseholdId],
          title: 'Ledger adjustment posted',
          body: adjustmentPushBody(ctx.user.name, input.amountCents, input.note),
        });
      }
      return { id: result.id };
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
        // The acting household the PAGE rendered under. The acting cookie is
        // browser-global: a stale tab left open across a household switch
        // would otherwise mark entries seen under the wrong membership. A
        // mismatch no-ops (the stale view saw nothing that matters here).
        ownHouseholdId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.ownHouseholdId && input.ownHouseholdId !== ctx.user.householdId) {
        return { ok: true };
      }
      // Clamp to the server clock — a forged future stamp would blind the
      // user to entries that don't exist yet.
      const seenAt = new Date(Math.min(input.renderedAt, Date.now()));
      await dbTransaction(async (tx) => {
        // Same reach rule as settle/adjust: the pair must ride a connection
        // edge (any status); unconnected ids read as not-found.
        const connection = await getConnection(
          tx,
          ctx.user.householdId,
          input.counterpartyHouseholdId,
        );
        if (!connection) throw new TRPCError({ code: 'NOT_FOUND' });
        // Keyed by the viewer's ACTING household too: watching the same
        // counterparty from two memberships keeps two watermarks (REWORK A3).
        const key = {
          userId: ctx.user.id,
          ownHouseholdId: ctx.user.householdId,
          counterpartyHouseholdId: input.counterpartyHouseholdId,
        };
        const existing = await tx.ledgerSeen.findUnique({
          where: { userId_ownHouseholdId_counterpartyHouseholdId: key },
        });
        if (!existing) {
          await tx.ledgerSeen.create({ data: { ...key, seenAt } });
        } else if (seenAt > existing.seenAt) {
          await tx.ledgerSeen.update({
            where: { userId_ownHouseholdId_counterpartyHouseholdId: key },
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
      where: { userId: ctx.user.id, ownHouseholdId: me },
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
