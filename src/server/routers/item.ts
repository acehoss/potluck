import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { formatCents } from '@/lib/money';
import { hasActiveGrant, requireCapability } from '../authz';
import { dbTransaction } from '../db';
import { deleteImageFile, imageFileExists, isStoredImagePath } from '../images';
import { protectedProcedure, router } from '../trpc';

/** Upper bound for money inputs: keeps values inside Prisma's Int range. */
const MAX_CENTS = 100_000_000; // $1,000,000

/**
 * A mistaken checkout is undone by returning immediately; the grace window
 * bounds how long the fee REVERSAL stays available (blueprint 01 is silent on
 * loan-fee refunds — v1 has no refund op beyond this, mirroring take.undo).
 */
const UNDO_GRACE_MS = 15 * 60 * 1000;

/**
 * Date-only input (due date), stored as UTC midnight — the same convention as
 * receipt/best-by dates (see restock.ts): the UTC date parts ARE the coop-
 * local calendar date. The refine rejects impossible calendar dates.
 */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a real calendar date.')
  .transform((s) => new Date(`${s}T00:00:00.000Z`));

/**
 * An item photo may only reference a freshly uploaded file of kind "items":
 * server-generated name, present on disk, referenced by no other Item. Same
 * contract as the restock image attach paths — never trust a client string
 * that later drives a file unlink.
 */
async function assertFreshItemPhoto(tx: Prisma.TransactionClient, path: string) {
  if (!isStoredImagePath('items', path)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an uploaded image path.' });
  }
  if (!(await imageFileExists(path))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Image not found — upload it first.' });
  }
  const inUse = await tx.item.findFirst({ where: { photoPath: path } });
  if (inUse) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That image is already attached.' });
  }
}

/** Item photos are referenced only by Item.photoPath; unlink when orphaned. */
async function unlinkItemPhotoIfUnreferenced(tx: Prisma.TransactionClient, path: string) {
  const stillUsed = await tx.item.findFirst({ where: { photoPath: path } });
  if (!stillUsed) await deleteImageFile(path);
}

export const itemRouter = router({
  /**
   * Create a durable item (SPEC §4). Owner-household only (blueprint 01 authz
   * matrix): the client names its own household explicitly so a mismatch
   * fails loudly instead of silently filing the item elsewhere.
   */
  create: protectedProcedure
    .input(
      z.object({
        householdId: z.string().min(1),
        name: z.string().trim().min(1).max(120),
        notes: z.string().trim().max(500).optional(),
        feeCents: z.number().int().min(0).max(MAX_CENTS),
        photoPath: z.string().min(1).max(300).optional(),
        // Idempotency key, generated once per add-item sheet: `disabled`
        // flips on the NEXT render, so a fast double-tap fires twice — a
        // photo-less create has no other dedupe and would mint twin items.
        clientKey: z.string().min(8).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      // A per-loan fee prices future cross-household income for this
      // household — money administration, not day-to-day lending. Zero-fee
      // items stay open to any lendBorrow holder.
      if (input.feeCents > 0) requireCapability(ctx.user, 'settleMoney');
      if (input.householdId !== ctx.user.householdId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Items can only be added to your own household.',
        });
      }
      const item = await dbTransaction(async (tx) => {
        // Replay of a committed create (same key): return the original item.
        // Safe check-then-act — dbTransaction holds the app-wide DB lock.
        if (input.clientKey) {
          const existing = await tx.item.findUnique({ where: { clientKey: input.clientKey } });
          if (existing) {
            if (existing.householdId !== ctx.user.householdId) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
            }
            return existing;
          }
        }
        if (input.photoPath) await assertFreshItemPhoto(tx, input.photoPath);
        return tx.item.create({
          data: {
            clientKey: input.clientKey ?? null,
            householdId: ctx.user.householdId,
            name: input.name,
            notes: input.notes || null,
            feeCents: input.feeCents,
            photoPath: input.photoPath ?? null,
          },
        });
      });
      return { id: item.id };
    }),

  /**
   * Edit an item (name/notes/fee/photo) — member of the owning household only.
   * Fee edits affect FUTURE loans only: Loan.feeCents is snapshotted at
   * checkout and immutable (blueprint 01). photoPath: undefined = keep,
   * null = remove, string = replace with a fresh upload.
   */
  update: protectedProcedure
    .input(
      z.object({
        itemId: z.string().min(1),
        name: z.string().trim().min(1).max(120).optional(),
        notes: z.string().trim().max(500).nullish(),
        feeCents: z.number().int().min(0).max(MAX_CENTS).optional(),
        photoPath: z.string().min(1).max(300).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      const oldPhoto = await dbTransaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id: input.itemId } });
        if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
        if (item.householdId !== ctx.user.householdId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the owning household can edit an item.',
          });
        }
        // Fee changes are money administration (see item.create).
        if (input.feeCents !== undefined && input.feeCents !== item.feeCents) {
          requireCapability(ctx.user, 'settleMoney');
        }
        if (typeof input.photoPath === 'string') {
          await assertFreshItemPhoto(tx, input.photoPath);
        }
        await tx.item.update({
          where: { id: item.id },
          data: {
            name: input.name,
            feeCents: input.feeCents,
            // undefined = leave untouched; null/'' = clear.
            notes: input.notes === undefined ? undefined : input.notes || null,
            photoPath: input.photoPath === undefined ? undefined : input.photoPath,
          },
        });
        // Report the replaced/removed photo for cleanup after commit.
        return input.photoPath !== undefined && item.photoPath !== input.photoPath
          ? item.photoPath
          : null;
      });
      // DB first, then drop the replaced file if truly unreferenced — a crash
      // between the two leaves an orphan file, never a dangling row.
      if (oldPhoto) await dbTransaction((tx) => unlinkItemPhotoIfUnreferenced(tx, oldPhoto));
      return { ok: true };
    }),
});

export const loanRouter = router({
  /**
   * Check out an item. Borrower is ALWAYS the acting user — no picker
   * (blueprint 02 / repair A6); any member may borrow any household's item,
   * including their own household's (for tracking). One transaction:
   * the active-loan guard, the Loan row with the fee snapshot, and — iff
   * fee > 0 AND cross-household (invariant 10) — the LOAN_FEE ledger entry
   * with creditor = item owner. The raw-SQL partial unique index on
   * Loan(itemId) WHERE returnedAt IS NULL backstops the guard mechanically.
   */
  checkout: protectedProcedure
    .input(
      z.object({
        itemId: z.string().min(1),
        dueAt: dateOnly.nullish(),
        // The fee the borrower was SHOWN on the checkout sheet. Checkout
        // posts money read from the item at mutation time; if the owner
        // edited the fee between page load and the tap, the borrower never
        // consented to the new amount — reject instead of charging it.
        expectedFeeCents: z.number().int().min(0).max(MAX_CENTS).optional(),
        // Idempotency key, generated once per checkout sheet: checkout posts
        // money, so a double-tap or a retry after a lost response must replay
        // as the SAME loan instead of double-charging the fee.
        clientKey: z.string().min(8).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      try {
        return await dbTransaction(async (tx) => {
          // Replay of a committed checkout (same key): return the original.
          // Safe check-then-act — dbTransaction holds the app-wide DB lock.
          if (input.clientKey) {
            const existing = await tx.loan.findUnique({ where: { clientKey: input.clientKey } });
            if (existing) {
              if (
                existing.borrowerId !== ctx.user.id ||
                existing.itemId !== input.itemId ||
                existing.borrowerHouseholdId !== ctx.user.householdId
              ) {
                throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
              }
              return { loanId: existing.id, feeCents: existing.feeCents };
            }
          }

          const item = await tx.item.findUnique({ where: { id: input.itemId } });
          if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });

          // Cross-household borrowing rides the LENDING grant over an ACTIVE
          // connection, against a SHARED item (REWORK B2/B3) — invisible
          // items read as not-found. A fee-bearing cross-household checkout
          // posts money, so it additionally needs spend (A3a).
          if (item.householdId !== ctx.user.householdId) {
            const visible =
              item.shared &&
              (await hasActiveGrant(tx, item.householdId, ctx.user.householdId, 'lending'));
            if (!visible) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
            }
            if (item.feeCents > 0) requireCapability(ctx.user, 'spend');
          }

          // TOCTOU guard on posted money: the fee charged must be the fee the
          // borrower saw. Checked whenever the client says what it displayed.
          if (input.expectedFeeCents !== undefined && input.expectedFeeCents !== item.feeCents) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `The fee changed to ${formatCents(item.feeCents)} since you opened this page — reload and try again.`,
            });
          }

          const active = await tx.loan.findFirst({
            where: { itemId: item.id, returnedAt: null },
          });
          if (active) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Already checked out.' });
          }

          const loan = await tx.loan.create({
            data: {
              itemId: item.id,
              borrowerId: ctx.user.id,
              // Snapshot of the ACTING household (REWORK A3): the household
              // that borrowed and owes any fee, never re-derived later.
              borrowerHouseholdId: ctx.user.householdId,
              feeCents: item.feeCents, // snapshot; item fee edits never touch it
              dueAt: input.dueAt ?? null,
              clientKey: input.clientKey ?? null,
            },
          });

          // Invariant 10: LOAN_FEE posts at checkout iff fee > 0 and borrower
          // household ≠ item household (own-household loans are tracking only).
          const cross = ctx.user.householdId !== item.householdId;
          if (cross && item.feeCents > 0) {
            await tx.ledgerEntry.create({
              data: {
                type: 'LOAN_FEE',
                loanId: loan.id,
                creditorHouseholdId: item.householdId,
                debtorHouseholdId: ctx.user.householdId,
                amountCents: item.feeCents,
                createdById: ctx.user.id,
              },
            });
          }
          return { loanId: loan.id, feeCents: item.feeCents };
        });
      } catch (err) {
        // The partial unique index (one active loan per item) is the
        // mechanical backstop for the in-tx guard: map it to the same 409.
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Already checked out.' });
        }
        throw err;
      }
    }),

  /**
   * Record a return, with an optional condition note (SPEC §5). Member of the
   * borrower's OR the owner's household (blueprint 01 authz matrix). The
   * guarded updateMany on returnedAt: null makes double-returns fail closed.
   * No money moves — the fee posted at checkout (SPEC §4).
   */
  return: protectedProcedure
    .input(
      z.object({
        loanId: z.string().min(1),
        conditionNote: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      return dbTransaction(async (tx) => {
        const loan = await tx.loan.findUnique({
          where: { id: input.loanId },
          include: { item: { select: { householdId: true } } },
        });
        if (!loan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Loan not found.' });
        // Borrower side = the household snapshotted at checkout, never the
        // borrower user's current memberships (REWORK A3).
        const mine = ctx.user.householdId;
        if (loan.borrowerHouseholdId !== mine && loan.item.householdId !== mine) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: "Only the borrower's or the owner's household can record a return.",
          });
        }
        const hit = await tx.loan.updateMany({
          where: { id: loan.id, returnedAt: null },
          data: {
            returnedAt: new Date(),
            conditionReturned: input.conditionNote?.trim() || null,
          },
        });
        if (hit.count === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Already returned.' });
        }
        return { ok: true };
      });
    }),

  /**
   * Undo a mistaken checkout within a short grace window: returns the item
   * immediately and — when a LOAN_FEE was posted — posts a swapped-party
   * REVERSAL referencing it (the ledger stays append-only; mirrors
   * take.undo). Gated to the borrower's or owner's household. Blueprint 01 is
   * silent on loan-fee refunds, so this is the whole v1 refund story; outside
   * the window the fee stands (settle up or manual-adjust if it ever matters).
   */
  undoCheckout: protectedProcedure
    .input(z.object({ loanId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      return dbTransaction(async (tx) => {
        const loan = await tx.loan.findUnique({
          where: { id: input.loanId },
          include: { item: { select: { householdId: true } } },
        });
        if (!loan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Loan not found.' });
        // Borrower side = the checkout-time household snapshot (REWORK A3).
        const mine = ctx.user.householdId;
        if (loan.borrowerHouseholdId !== mine && loan.item.householdId !== mine) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: "Only the borrower's or the owner's household can undo a checkout.",
          });
        }
        if (Date.now() - loan.outAt.getTime() > UNDO_GRACE_MS) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'The undo window has passed — record a return instead.',
          });
        }
        // One-way guard: a double undo (or an undo racing a return) fails
        // closed, so the REVERSAL below can never post twice.
        const hit = await tx.loan.updateMany({
          where: { id: loan.id, returnedAt: null },
          data: { returnedAt: new Date() },
        });
        if (hit.count === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Already returned.' });
        }
        const entry = await tx.ledgerEntry.findUnique({ where: { loanId: loan.id } });
        if (entry) {
          // Same amount, swapped parties, linked via reversesId (invariant 6).
          // No loanId on the REVERSAL: that column marks LOAN_FEE entries only.
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
