import { stat } from 'node:fs/promises';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { formatCents } from '@/lib/money';
import {
  activeConnectionsOf,
  reachesResource,
  requireCapability,
  visibleUnderCircle,
} from '../authz';
import { db, dbTransaction } from '../db';
import {
  deleteImageFile,
  imageFileExists,
  isStoredAttachmentPath,
  isStoredImagePath,
  resolveImagePath,
  sanitizeAttachmentName,
} from '../images';
import { moveMediaToMain } from '../media-positions';
import { protectedProcedure, router } from '../trpc';

/** Upper bound for money inputs: keeps values inside Prisma's Int range. */
const MAX_CENTS = 100_000_000; // $1,000,000
const MAX_IMAGES_PER_ITEM = 8;
const MAX_ATTACHMENTS_PER_ITEM = 5;
const itemImageLabel = z.enum(['nutrition', 'ingredients', 'angle']).nullish();
const itemImageInput = z.object({
  path: z.string().min(1).max(300),
  label: itemImageLabel,
});

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
 * server-generated name, present on disk, referenced by no other ItemImage.
 * Same contract as the restock image attach paths — never trust a client
 * string that later drives a file unlink.
 */
async function assertFreshItemImage(tx: Prisma.TransactionClient, path: string) {
  if (!isStoredImagePath('items', path)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an uploaded image path.' });
  }
  if (!(await imageFileExists(path))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Image not found — upload it first.' });
  }
  const inUse = await tx.itemImage.findFirst({ where: { path } });
  if (inUse) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That image is already attached.' });
  }
}

async function assertFreshAttachment(tx: Prisma.TransactionClient, path: string) {
  if (!isStoredAttachmentPath(path)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an uploaded attachment path.' });
  }
  const abs = resolveImagePath(path);
  const file = abs ? await stat(abs).catch(() => null) : null;
  if (!file?.isFile()) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Attachment not found — upload it first.' });
  }
  const inUse = await tx.itemAttachment.findFirst({ where: { path } });
  if (inUse) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That attachment is already attached.' });
  }
  return file.size;
}

async function unlinkItemImageIfUnreferenced(path: string) {
  const [asItem, asProduct] = await Promise.all([
    db.itemImage.findFirst({ where: { path } }),
    db.productImage.findFirst({ where: { path } }),
  ]);
  if (!asItem && !asProduct) await deleteImageFile(path);
}

async function unlinkAttachmentIfUnreferenced(path: string) {
  if (!(await db.itemAttachment.findFirst({ where: { path } }))) await deleteImageFile(path);
}

function mediaRows<
  T extends { id: string; path: string; label: string | null; position: number },
>(rows: readonly T[]) {
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    label: row.label,
    position: row.position,
  }));
}

function attachmentRows<
  T extends { id: string; path: string; name: string; sizeBytes: number; position: number },
>(rows: readonly T[]) {
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    name: row.name,
    sizeBytes: row.sizeBytes,
    position: row.position,
  }));
}

export const itemRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const connections = await activeConnectionsOf(db, ctx.user.householdId);
    const lendingConns = connections.filter((c) => c.theyGrant.lending);
    const lendingGranters = lendingConns.map((c) => c.counterpartyId);
    const circleByGranter = new Map(lendingConns.map((c) => [c.counterpartyId, c.theirCircleId]));

    const granterCircleIds = [...circleByGranter.values()].filter((id): id is string => id !== null);
    const scopedItemKeys = new Set(
      granterCircleIds.length
        ? (
            await db.itemCircle.findMany({
              where: { circleId: { in: granterCircleIds } },
              select: { itemId: true, circleId: true },
            })
          ).map((r) => `${r.itemId}:${r.circleId}`)
        : [],
    );

    const items = await db.item.findMany({
      where: { householdId: { in: [ctx.user.householdId, ...lendingGranters] } },
      orderBy: { name: 'asc' },
      include: {
        household: { select: { id: true, name: true } },
        images: { orderBy: { position: 'asc' } },
        attachments: { orderBy: { position: 'asc' } },
        loans: {
          where: { returnedAt: null },
          include: { borrower: { select: { name: true } } },
        },
      },
    });

    return items
      .filter((item) => {
        if (item.householdId === ctx.user.householdId) return true;
        const circleId = circleByGranter.get(item.householdId);
        if (!circleId) return false;
        return visibleUnderCircle(item.visibility, scopedItemKeys.has(`${item.id}:${circleId}`));
      })
      .map((item) => {
        const loan = item.loans[0] ?? null;
        return {
          id: item.id,
          householdId: item.householdId,
          householdName: item.household.name,
          mine: item.householdId === ctx.user.householdId,
          name: item.name,
          notes: item.notes,
          feeCents: item.feeCents,
          visibility: item.visibility,
          images: mediaRows(item.images),
          attachments: attachmentRows(item.attachments),
          activeLoan: loan
            ? {
                id: loan.id,
                borrowerName: loan.borrower.name,
                borrowerHouseholdId: loan.borrowerHouseholdId,
                outAt: loan.outAt.toISOString(),
                dueAt: loan.dueAt?.toISOString() ?? null,
              }
            : null,
        };
      });
  }),

  get: protectedProcedure
    .input(z.object({ itemId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const item = await db.item.findUnique({
        where: { id: input.itemId },
        include: {
          household: { select: { id: true, name: true } },
          images: { orderBy: { position: 'asc' } },
          attachments: { orderBy: { position: 'asc' } },
          loans: {
            orderBy: { outAt: 'desc' },
            include: { borrower: { select: { name: true } } },
          },
        },
      });
      if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
      if (item.householdId !== ctx.user.householdId) {
        const visible = await reachesResource(
          db,
          item.householdId,
          ctx.user.householdId,
          'lending',
          item,
          (circleId) =>
            db.itemCircle
              .findUnique({ where: { itemId_circleId: { itemId: item.id, circleId } } })
              .then(Boolean),
        );
        if (!visible) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
      }

      return {
        id: item.id,
        householdId: item.householdId,
        householdName: item.household.name,
        mine: item.householdId === ctx.user.householdId,
        name: item.name,
        notes: item.notes,
        feeCents: item.feeCents,
        visibility: item.visibility,
        images: mediaRows(item.images),
        attachments: attachmentRows(item.attachments),
        loans: item.loans.map((loan) => ({
          id: loan.id,
          borrowerName: loan.borrower.name,
          borrowerHouseholdId: loan.borrowerHouseholdId,
          feeCents: loan.feeCents,
          outAt: loan.outAt.toISOString(),
          dueAt: loan.dueAt?.toISOString() ?? null,
          returnedAt: loan.returnedAt?.toISOString() ?? null,
          conditionReturned: loan.conditionReturned,
        })),
      };
    }),

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
        notes: z.string().trim().max(2000).optional(),
        feeCents: z.number().int().min(0).max(MAX_CENTS),
        photos: z.array(itemImageInput).max(MAX_IMAGES_PER_ITEM).optional(),
        // Idempotency key, generated once per add-item sheet: `disabled`
        // flips on the NEXT render, so a fast double-tap fires twice — a
        // media-less create has no other dedupe and would mint twin items.
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
      const photos = input.photos ?? [];
      if (new Set(photos.map((photo) => photo.path)).size !== photos.length) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That image is already attached.' });
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
        for (const photo of photos) await assertFreshItemImage(tx, photo.path);
        const created = await tx.item.create({
          data: {
            clientKey: input.clientKey ?? null,
            householdId: ctx.user.householdId,
            name: input.name,
            notes: input.notes || null,
            feeCents: input.feeCents,
          },
        });
        for (let position = 0; position < photos.length; position++) {
          const photo = photos[position];
          await tx.itemImage.create({
            data: {
              itemId: created.id,
              path: photo.path,
              label: photo.label ?? null,
              position,
            },
          });
        }
        return created;
      });
      return { id: item.id };
    }),

  /**
   * Edit an item (name/notes/fee) — member of the owning household only. Fee
   * edits affect FUTURE loans only: Loan.feeCents is snapshotted at checkout
   * and immutable (blueprint 01). Gallery changes use dedicated mutations.
   */
  update: protectedProcedure
    .input(
      z.object({
        itemId: z.string().min(1),
        name: z.string().trim().min(1).max(120).optional(),
        notes: z.string().trim().max(2000).nullish(),
        feeCents: z.number().int().min(0).max(MAX_CENTS).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      await dbTransaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id: input.itemId } });
        if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
        if (item.householdId !== ctx.user.householdId) {
          // The item may be legitimately visible (borrowable) to this user —
          // editing it is a permission failure, not a visibility one (403,
          // matching pre-gallery behavior; slice6 e2e asserts it).
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the owner household can edit an item.' });
        }
        // Fee changes are money administration (see item.create).
        if (input.feeCents !== undefined && input.feeCents !== item.feeCents) {
          requireCapability(ctx.user, 'settleMoney');
        }
        await tx.item.update({
          where: { id: item.id },
          data: {
            name: input.name,
            feeCents: input.feeCents,
            // undefined = leave untouched; null/'' = clear.
            notes: input.notes === undefined ? undefined : input.notes || null,
          },
        });
      });
      return { ok: true };
    }),

  addImage: protectedProcedure
    .input(
      z.object({
        itemId: z.string().min(1),
        path: z.string().min(1).max(300),
        label: itemImageLabel,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      const image = await dbTransaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id: input.itemId } });
        if (!item || item.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
        }
        await assertFreshItemImage(tx, input.path);
        const count = await tx.itemImage.count({ where: { itemId: item.id } });
        if (count >= MAX_IMAGES_PER_ITEM) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'An item can have at most 8 images.' });
        }
        const last = await tx.itemImage.findFirst({
          where: { itemId: item.id },
          orderBy: { position: 'desc' },
        });
        return tx.itemImage.create({
          data: {
            itemId: item.id,
            path: input.path,
            label: input.label ?? null,
            position: last ? last.position + 1 : 0,
          },
        });
      });
      return { id: image.id };
    }),

  removeImage: protectedProcedure
    .input(z.object({ imageId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      const path = await dbTransaction(async (tx) => {
        const image = await tx.itemImage.findUnique({
          where: { id: input.imageId },
          include: { item: { select: { householdId: true } } },
        });
        if (!image || image.item.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found.' });
        }
        await tx.itemImage.delete({ where: { id: image.id } });
        return image.path;
      });
      await unlinkItemImageIfUnreferenced(path);
      return { ok: true };
    }),

  setMain: protectedProcedure
    .input(z.object({ imageId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      await dbTransaction(async (tx) => {
        const image = await tx.itemImage.findUnique({
          where: { id: input.imageId },
          include: { item: { select: { householdId: true } } },
        });
        if (!image || image.item.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found.' });
        }
        const images = await tx.itemImage.findMany({
          where: { itemId: image.itemId },
          orderBy: { position: 'asc' },
          select: { id: true, position: true },
        });
        const updates = moveMediaToMain(images, image.id);
        for (let i = 0; i < images.length; i++) {
          await tx.itemImage.update({ where: { id: images[i].id }, data: { position: -1 - i } });
        }
        for (const update of updates) {
          await tx.itemImage.update({ where: { id: update.id }, data: { position: update.position } });
        }
      });
      return { ok: true };
    }),

  setLabel: protectedProcedure
    .input(z.object({ imageId: z.string().min(1), label: itemImageLabel }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      await dbTransaction(async (tx) => {
        const image = await tx.itemImage.findUnique({
          where: { id: input.imageId },
          include: { item: { select: { householdId: true } } },
        });
        if (!image || image.item.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found.' });
        }
        await tx.itemImage.update({ where: { id: image.id }, data: { label: input.label ?? null } });
      });
      return { ok: true };
    }),

  addAttachment: protectedProcedure
    .input(
      z.object({
        itemId: z.string().min(1),
        path: z.string().min(1).max(300),
        name: z.string().max(300),
        sizeBytes: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      const attachment = await dbTransaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id: input.itemId } });
        if (!item || item.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
        }
        const sizeBytes = await assertFreshAttachment(tx, input.path);
        const count = await tx.itemAttachment.count({ where: { itemId: item.id } });
        if (count >= MAX_ATTACHMENTS_PER_ITEM) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'An item can have at most 5 attachments.',
          });
        }
        const last = await tx.itemAttachment.findFirst({
          where: { itemId: item.id },
          orderBy: { position: 'desc' },
        });
        return tx.itemAttachment.create({
          data: {
            itemId: item.id,
            path: input.path,
            name: sanitizeAttachmentName(input.name),
            sizeBytes,
            position: last ? last.position + 1 : 0,
          },
        });
      });
      return { id: attachment.id, name: attachment.name, sizeBytes: attachment.sizeBytes };
    }),

  removeAttachment: protectedProcedure
    .input(z.object({ attachmentId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'lendBorrow');
      const path = await dbTransaction(async (tx) => {
        const attachment = await tx.itemAttachment.findUnique({
          where: { id: input.attachmentId },
          include: { item: { select: { householdId: true } } },
        });
        if (!attachment || attachment.item.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Attachment not found.' });
        }
        await tx.itemAttachment.delete({ where: { id: attachment.id } });
        return attachment.path;
      });
      await unlinkAttachmentIfUnreferenced(path);
      return { ok: true };
    }),

  /**
   * Circle-scoped visibility (REWORK P4, mirrors pantry.setVisibility): ALL
   * exposes the item to every lending-granted circle; SELECT restricts it to
   * the given OWN circles (≥1, foreign/absent → 404); PRIVATE hides it. Scope
   * rows are replaced atomically. Household management (A3a — the old shared
   * flag's gate).
   */
  setVisibility: protectedProcedure
    .input(
      z.object({
        itemId: z.string().min(1),
        visibility: z.enum(['ALL', 'SELECT', 'PRIVATE']),
        circleIds: z.array(z.string().min(1)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageHousehold');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id: input.itemId } });
        if (!item || item.householdId !== me) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
        }
        const circleIds = input.visibility === 'SELECT' ? [...new Set(input.circleIds ?? [])] : [];
        if (input.visibility === 'SELECT' && circleIds.length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick at least one circle.' });
        }
        if (circleIds.length) {
          const owned = await tx.circle.count({
            where: { id: { in: circleIds }, householdId: me },
          });
          if (owned !== circleIds.length) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'No such circle.' });
          }
        }
        await tx.item.update({ where: { id: item.id }, data: { visibility: input.visibility } });
        await tx.itemCircle.deleteMany({ where: { itemId: item.id } });
        if (circleIds.length) {
          await tx.itemCircle.createMany({
            data: circleIds.map((circleId) => ({ itemId: item.id, circleId })),
          });
        }
        return { visibility: input.visibility };
      });
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
          // connection, against an item VISIBLE to the circle we're in (REWORK
          // P4) — invisible items read as not-found. A fee-bearing cross-
          // household checkout posts money, so it additionally needs spend (A3a).
          if (item.householdId !== ctx.user.householdId) {
            const visible = await reachesResource(
              tx,
              item.householdId,
              ctx.user.householdId,
              'lending',
              item,
              (circleId) =>
                tx.itemCircle
                  .findUnique({ where: { itemId_circleId: { itemId: item.id, circleId } } })
                  .then(Boolean),
            );
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
