import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { dateCodeFor, restockCode, unitCostCents, varianceAutoPasses } from '@/lib/domain';
import { db, dbTransaction } from '../db';
import {
  extractReceipt,
  extractionMode,
  parseResolvedIndices,
  parseStoredExtraction,
  type ExtractionImage,
} from '../extraction';
import { deleteImageFile, imageFileExists, isStoredImagePath, readImageFile } from '../images';
import { getActiveRestockCredit } from '../ledger';
import { checkRateLimit } from '../rate-limit';
import { protectedProcedure, router } from '../trpc';

/** Upper bound for money inputs: keeps values inside Prisma's Int range. */
const MAX_CENTS = 100_000_000; // $1,000,000

/**
 * Extractions per user per 15-minute window. A receiving session is one or
 * two extract calls (initial + maybe a retry); this bounds runaway API spend
 * from a stuck client or a stolen session. Fixture/off modes spend nothing
 * (no API call is ever made), so they get a roomy budget that keeps the
 * limiter exercised end-to-end without repeated e2e runs poisoning each
 * other through the shared in-memory window.
 */
function extractsPerWindow() {
  return extractionMode() === 'live' ? 20 : 200;
}

/**
 * Memory caps for the extract endpoint (same threat as the rate limit: a
 * malicious member or stolen session). Without them, every RestockImage of a
 * draft is buffered fully into memory and then base64-expanded (+33%) into
 * one API request — 120 uploads × 8MB would materialize ~2GB and OOM the
 * single self-hosted container. Receipts are 1–3 pages in practice; stored
 * pages are client-downscaled to well under 1MB each.
 */
const MAX_EXTRACT_PAGES = 8;
const MAX_EXTRACT_TOTAL_BYTES = 24 * 1024 * 1024;

/**
 * Date-only input (receipt date, best-by), stored as UTC midnight. The
 * round-trip refine rejects impossible calendar dates ("2026-99-99") that
 * match the digit shape but would otherwise become Invalid Date and crash
 * deep inside Prisma as a 500.
 */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a real calendar date.')
  .transform((s) => new Date(`${s}T00:00:00.000Z`));

const draftHeaderSchema = z.object({
  retailer: z.string().trim().min(1).max(100),
  purchasedAt: dateOnly,
  purchaserHouseholdId: z.string().min(1),
  receiptTotalCents: z.number().int().min(0).max(MAX_CENTS).nullable(),
});

const lineSchema = z.object({
  restockId: z.string().min(1),
  lotId: z.string().min(1).optional(), // absent = new line
  // Exactly one of productId / newProductName.
  productId: z.string().min(1).optional(),
  newProductName: z.string().trim().min(1).max(200).optional(),
  purchasedCount: z.number().int().min(1).max(10_000),
  receivedCount: z.number().int().min(0).max(10_000),
  lineTotalCents: z.number().int().min(0).max(MAX_CENTS),
  bestBy: dateOnly.nullable(),
});

/**
 * Status checks and their dependent writes always run inside the same
 * dbTransaction (which holds the app-wide DB lock), so a concurrent finalize
 * cannot land between the DRAFT check and the write.
 */
async function getDraftOrThrow(tx: Prisma.TransactionClient, restockId: string) {
  const restock = await tx.restock.findUnique({
    where: { id: restockId },
    include: { pantry: true },
  });
  if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
  if (restock.status !== 'DRAFT') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Restock is already finalized.' });
  }
  return restock;
}

/**
 * Finalize/delete gate (blueprint 01 authz matrix): the restock's creator, or
 * a member of the purchaser household. Finalize posts money and delete
 * destroys receipt images — not open to everyone.
 */
function assertMayFinalize(
  restock: { createdById: string; purchaserHouseholdId: string },
  user: { id: string; householdId: string },
) {
  if (restock.createdById !== user.id && restock.purchaserHouseholdId !== user.householdId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the creator or the purchaser household can do this.',
    });
  }
}

/**
 * An attach mutation may only reference a freshly uploaded file: right kind
 * prefix and server-generated name, present on disk, and referenced by no
 * other row. Upload paths are 16 random bytes and are disclosed only to the
 * uploader until attached, so this stops any member from attaching (and later
 * destroying, via the replace/remove paths) another restock's receipt images.
 */
async function assertFreshUpload(
  tx: Prisma.TransactionClient,
  kind: 'receipts' | 'units',
  path: string,
) {
  if (!isStoredImagePath(kind, path)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an uploaded image path.' });
  }
  if (!(await imageFileExists(path))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Image not found — upload it first.' });
  }
  const asReceipt = await tx.restockImage.findFirst({ where: { path } });
  const asUnit = await tx.lot.findFirst({ where: { unitPhotoPath: path } });
  if (asReceipt || asUnit) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That image is already attached.' });
  }
}

/**
 * Unlink a stored file only when no row references it. Attach-time uniqueness
 * makes aliasing impossible going forward, but never trust a path on the
 * delete side either — a file another record points at must survive.
 */
async function unlinkIfUnreferenced(path: string) {
  const [asReceipt, asUnit] = await Promise.all([
    db.restockImage.findFirst({ where: { path } }),
    db.lot.findFirst({ where: { unitPhotoPath: path } }),
  ]);
  if (!asReceipt && !asUnit) await deleteImageFile(path);
}

export const restockRouter = router({
  /** Step 1: create the server-side draft. Any coop member (trust assumed). */
  create: protectedProcedure
    .input(draftHeaderSchema.extend({ pantryId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const pantry = await db.pantry.findUnique({ where: { id: input.pantryId } });
      if (!pantry) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
      const purchaser = await db.household.findUnique({
        where: { id: input.purchaserHouseholdId },
      });
      if (!purchaser) throw new TRPCError({ code: 'NOT_FOUND', message: 'Household not found.' });

      const restock = await db.restock.create({
        data: {
          pantryId: input.pantryId,
          purchaserHouseholdId: input.purchaserHouseholdId,
          createdById: ctx.user.id,
          retailer: input.retailer,
          purchasedAt: input.purchasedAt,
          receiptTotalCents: input.receiptTotalCents,
        },
      });
      return { id: restock.id };
    }),

  /** Header edits while DRAFT (fix a mistyped total/date without abandoning). */
  updateDraft: protectedProcedure
    .input(draftHeaderSchema.partial().extend({ restockId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { restockId, ...data } = input;
      await dbTransaction(async (tx) => {
        await getDraftOrThrow(tx, restockId);
        await tx.restock.update({ where: { id: restockId }, data });
      });
      return { ok: true };
    }),

  /**
   * Wizard data. Everyone sees everything (SPEC §2). Returns a plain-JSON
   * DTO — no transformer on the tRPC link, so Dates go over as ISO strings.
   */
  get: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input }) => {
    const restock = await db.restock.findUnique({
      where: { id: input.id },
      include: {
        pantry: { include: { household: { select: { id: true, name: true } } } },
        purchaserHousehold: { select: { id: true, name: true } },
        images: { orderBy: { position: 'asc' } },
        lots: {
          orderBy: { position: 'asc' },
          include: { product: { select: { id: true, name: true } } },
        },
      },
    });
    if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });

    const credit = await getActiveRestockCredit(restock.id);
    const extraction = parseStoredExtraction(restock.extractionJson);
    return {
      id: restock.id,
      status: restock.status,
      // Drives the "Extract from receipt" affordance; the UI never offers
      // extraction when the mode is off (blueprint 04 §3).
      extractionEnabled: extractionMode() !== 'off',
      extractedAt: restock.extractedAt?.toISOString() ?? null,
      // Proposal state is server-derived (blueprint 02: the wizard survives
      // refresh, tab-kill, and step changes): the stored extraction lines
      // plus the indices the user already confirmed/dismissed. The client
      // renders lines minus resolved minus lines matching existing lots.
      extractionLines: extraction?.lines ?? null,
      extractionResolved: parseResolvedIndices(restock.extractionResolved),
      retailer: restock.retailer,
      purchasedAt: restock.purchasedAt.toISOString().slice(0, 10),
      receiptTotalCents: restock.receiptTotalCents,
      dateCode: restock.dateCode,
      seq: restock.seq,
      varianceCents: restock.varianceCents,
      pantry: {
        id: restock.pantry.id,
        name: restock.pantry.name,
        householdId: restock.pantry.householdId,
        householdName: restock.pantry.household.name,
      },
      purchaserHousehold: restock.purchaserHousehold,
      images: restock.images.map((i) => ({ id: i.id, path: i.path, position: i.position })),
      lots: restock.lots.map((l) => ({
        id: l.id,
        position: l.position,
        purchasedCount: l.purchasedCount,
        receivedCount: l.receivedCount,
        lineTotalCents: l.lineTotalCents,
        unitCostCents: l.unitCostCents,
        bestBy: l.bestBy?.toISOString().slice(0, 10) ?? null,
        unitPhotoPath: l.unitPhotoPath,
        product: l.product,
      })),
      credit: credit ? { amountCents: credit.amountCents } : null,
    };
  }),

  /** Step 2: attach an uploaded receipt photo. Append-only once finalized. */
  addImage: protectedProcedure
    .input(
      z.object({
        restockId: z.string().min(1),
        path: z.string().min(1).max(300),
        // sha256 of the ORIGINAL selected file (pre-downscale), sent with the
        // upload and persisted here so fixture-mode extraction keys on it and
        // drafts survive refresh (blueprint 04 §3). Advisory metadata only.
        originalSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const image = await dbTransaction(async (tx) => {
        await assertFreshUpload(tx, 'receipts', input.path);
        const restock = await tx.restock.findUnique({ where: { id: input.restockId } });
        if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
        // Position is computed inside the locked transaction, so concurrent
        // adds can't both read the same max and trip @@unique([restockId, position]).
        const last = await tx.restockImage.findFirst({
          where: { restockId: input.restockId },
          orderBy: { position: 'desc' },
        });
        return tx.restockImage.create({
          data: {
            restockId: input.restockId,
            path: input.path,
            position: (last?.position ?? 0) + 1,
            originalSha256: input.originalSha256 ?? null,
          },
        });
      });
      return { id: image.id };
    }),

  /**
   * VLM extraction over ALL of the draft's receipt images, in position order
   * (blueprint 04 §3, SPEC §4). ADVISORY: proposed lines are returned to the
   * client and never written to the DB — the user materializes only the
   * lines they confirm, through the normal saveLine flow. Gated like other
   * draft edits (any coop member may edit a draft); rate-limited per user.
   * Failures come back as { status: 'unavailable' } with a friendly,
   * retriable message — extraction never blocks the wizard.
   */
  extract: protectedProcedure
    .input(z.object({ restockId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const restock = await db.restock.findUnique({
        where: { id: input.restockId },
        include: { images: { orderBy: { position: 'asc' } } },
      });
      if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
      if (restock.status !== 'DRAFT') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Restock is already finalized.' });
      }
      if (!checkRateLimit(`extract:${ctx.user.id}`, extractsPerWindow())) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many extractions — wait a few minutes, or enter lines manually.',
        });
      }

      // Cap pages and total bytes BEFORE buffering (mirrors the upload
      // route's pre-buffer length check): first pages win, extras are simply
      // not sent — advisory extraction degrades, it never 500s or OOMs.
      const images: ExtractionImage[] = [];
      let totalBytes = 0;
      for (const image of restock.images.slice(0, MAX_EXTRACT_PAGES)) {
        const jpeg = await readImageFile(image.path);
        if (!jpeg) continue;
        if (totalBytes + jpeg.length > MAX_EXTRACT_TOTAL_BYTES) {
          console.warn(
            `[extraction] restock ${restock.id}: payload cap hit at page ${image.position}; later pages skipped`,
          );
          break;
        }
        totalBytes += jpeg.length;
        images.push({ jpeg, originalSha256: image.originalSha256 });
      }

      // The API call runs OUTSIDE any transaction/lock — it can take tens of
      // seconds and must never stall the app-wide DB lock.
      const result = await extractReceipt(images);
      if (result.status === 'unavailable') return result;

      // Audit metadata + the proposal source of truth (blueprint 01 slice-5
      // columns); status-guarded so a finalize that landed during the API
      // call is left untouched. A fresh extraction resets the resolved set —
      // the client dedupes re-proposed lines against already-confirmed lots.
      await db.restock.updateMany({
        where: { id: restock.id, status: 'DRAFT' },
        data: {
          extractedAt: new Date(),
          extractionModel: result.model,
          extractionJson: JSON.stringify(result.data),
          extractionResolved: '[]',
        },
      });

      return {
        status: 'ok' as const,
        lines: result.data.lines,
        retailer: result.data.retailer,
        purchasedAt: result.data.purchasedAt,
        receiptTotalCents: result.data.receiptTotalCents,
      };
    }),

  /**
   * Mark one extraction line as resolved — confirmed into a lot or dismissed
   * — so it is never re-proposed after a refresh, tab-kill, or step change
   * (blueprint 02's survival contract). Idempotent; gated like other draft
   * edits.
   */
  resolveProposal: protectedProcedure
    .input(z.object({ restockId: z.string().min(1), index: z.number().int().min(0) }))
    .mutation(async ({ input }) => {
      await dbTransaction(async (tx) => {
        const restock = await getDraftOrThrow(tx, input.restockId);
        const lines = parseStoredExtraction(restock.extractionJson)?.lines;
        if (!lines || input.index >= lines.length) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'No such proposed line.' });
        }
        const resolved = parseResolvedIndices(restock.extractionResolved);
        if (!resolved.includes(input.index)) {
          resolved.push(input.index);
          await tx.restock.update({
            where: { id: restock.id },
            data: { extractionResolved: JSON.stringify(resolved) },
          });
        }
      });
      return { ok: true };
    }),

  /**
   * Receipt photos are removable while DRAFT only (retained forever after),
   * and — like deleteDraft — only by the creator or purchaser household:
   * removal unlinks the file from disk, which is exactly what the authz
   * matrix gates delete for.
   */
  removeImage: protectedProcedure
    .input(z.object({ imageId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const path = await dbTransaction(async (tx) => {
        const image = await tx.restockImage.findUnique({
          where: { id: input.imageId },
          include: { restock: true },
        });
        if (!image) throw new TRPCError({ code: 'NOT_FOUND' });
        assertMayFinalize(image.restock, ctx.user);
        if (image.restock.status !== 'DRAFT') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Receipt photos are permanent once finalized.',
          });
        }
        await tx.restockImage.delete({ where: { id: image.id } });
        return image.path;
      });
      await unlinkIfUnreferenced(path);
      return { ok: true };
    }),

  /** Step 3: create or edit a receipt line (a draft Lot — blueprint 01 D4). */
  saveLine: protectedProcedure.input(lineSchema).mutation(async ({ input }) => {
    if (input.receivedCount > input.purchasedCount) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Received count cannot exceed purchased count.',
      });
    }
    if (!input.productId === !input.newProductName) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Pick a product or name a new one.',
      });
    }

    // One transaction: the DRAFT check holds through the write, a new Product
    // can't be orphaned by a failing lot write, and position assignment is
    // race-free.
    const lotId = await dbTransaction(async (tx) => {
      await getDraftOrThrow(tx, input.restockId);

      let productId = input.productId;
      if (input.newProductName) {
        const product = await tx.product.create({ data: { name: input.newProductName } });
        productId = product.id;
      } else {
        const exists = await tx.product.findUnique({ where: { id: productId! } });
        if (!exists) throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
      }

      const data = {
        productId: productId!,
        purchasedCount: input.purchasedCount,
        receivedCount: input.receivedCount,
        lineTotalCents: input.lineTotalCents,
        bestBy: input.bestBy,
      };

      if (input.lotId) {
        const lot = await tx.lot.findUnique({ where: { id: input.lotId } });
        if (!lot || lot.restockId !== input.restockId) throw new TRPCError({ code: 'NOT_FOUND' });
        await tx.lot.update({ where: { id: input.lotId }, data });
        return input.lotId;
      }

      const last = await tx.lot.findFirst({
        where: { restockId: input.restockId },
        orderBy: { position: 'desc' },
      });
      const lot = await tx.lot.create({
        data: { ...data, restockId: input.restockId, position: (last?.position ?? 0) + 1 },
      });
      return lot.id;
    });
    return { lotId };
  }),

  deleteLine: protectedProcedure
    .input(z.object({ lotId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const photoPath = await dbTransaction(async (tx) => {
        const lot = await tx.lot.findUnique({
          where: { id: input.lotId },
          include: { restock: { select: { status: true } } },
        });
        if (!lot) throw new TRPCError({ code: 'NOT_FOUND' });
        if (lot.restock.status !== 'DRAFT') {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Restock is finalized.' });
        }
        await tx.lot.delete({ where: { id: lot.id } });
        return lot.unitPhotoPath;
      });
      // File cleanup only after the row is gone — never before the DB commit.
      if (photoPath) await unlinkIfUnreferenced(photoPath);
      return { ok: true };
    }),

  /** Step 4 (and later re-snaps): unitPhotoPath stays editable after finalize. */
  setUnitPhoto: protectedProcedure
    .input(z.object({ lotId: z.string().min(1), path: z.string().min(1).max(300) }))
    .mutation(async ({ input }) => {
      const previous = await dbTransaction(async (tx) => {
        const lot = await tx.lot.findUnique({ where: { id: input.lotId } });
        if (!lot) throw new TRPCError({ code: 'NOT_FOUND' });
        await assertFreshUpload(tx, 'units', input.path);
        await tx.lot.update({ where: { id: input.lotId }, data: { unitPhotoPath: input.path } });
        return lot.unitPhotoPath;
      });
      // DB first, then drop the replaced file (if truly unreferenced) — a
      // crash between the two leaves an orphan file, never a dangling row.
      if (previous) await unlinkIfUnreferenced(previous);
      return { ok: true };
    }),

  /**
   * Step 5: finalize — one transaction (blueprint 01 D1/D6/D7). Freezes unit
   * costs, sets remaining counts, stores the variance, posts the purchaser
   * credit when cross-household, and assigns the restock code.
   */
  finalize: protectedProcedure
    .input(
      z.object({
        restockId: z.string().min(1),
        /**
         * D7 consent gate: the client echoes the variance it displayed; the
         * server finalizes only when that matches the variance it computes.
         * A stale acknowledgment (a line changed since the user last looked)
         * is rejected instead of silently "acknowledging" a number the user
         * never saw. Null = nothing acknowledged.
         */
        acknowledgedVarianceCents: z.number().int().min(-MAX_CENTS).max(MAX_CENTS).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Code assignment is race-safe via @@unique([dateCode, seq]) + retry.
      for (let attempt = 1; ; attempt++) {
        try {
          return await dbTransaction(async (tx) => {
            const restock = await tx.restock.findUnique({
              where: { id: input.restockId },
              include: { pantry: true, lots: true },
            });
            if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
            if (restock.status !== 'DRAFT') {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Already finalized.' });
            }
            assertMayFinalize(restock, ctx.user);
            if (restock.lots.length === 0) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'Add at least one line before finalizing.',
              });
            }

            let creditCents = 0;
            let lineSumCents = 0;
            for (const lot of restock.lots) {
              const unitCost = unitCostCents(lot.lineTotalCents, lot.purchasedCount);
              lineSumCents += lot.lineTotalCents;
              creditCents += lot.receivedCount * unitCost;
              await tx.lot.update({
                where: { id: lot.id },
                data: { unitCostCents: unitCost, remainingCount: lot.receivedCount },
              });
            }

            const varianceCents =
              restock.receiptTotalCents === null
                ? null
                : restock.receiptTotalCents - lineSumCents;
            if (
              varianceCents !== null &&
              !varianceAutoPasses(varianceCents, restock.lots.length) &&
              input.acknowledgedVarianceCents !== varianceCents
            ) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message:
                  'Receipt total differs from the line sum — review the variance and acknowledge to finalize.',
              });
            }

            // Cross-household: credit the purchaser at cost, received units only.
            if (restock.purchaserHouseholdId !== restock.pantry.householdId && creditCents > 0) {
              await tx.ledgerEntry.create({
                data: {
                  type: 'RESTOCK_CREDIT',
                  restockId: restock.id,
                  creditorHouseholdId: restock.purchaserHouseholdId,
                  debtorHouseholdId: restock.pantry.householdId,
                  amountCents: creditCents,
                  createdById: ctx.user.id,
                },
              });
            }

            const dateCode = dateCodeFor(restock.purchasedAt);
            const maxSeq = await tx.restock.aggregate({
              where: { dateCode },
              _max: { seq: true },
            });
            const seq = (maxSeq._max.seq ?? 0) + 1;

            await tx.restock.update({
              where: { id: restock.id },
              data: {
                status: 'FINALIZED',
                dateCode,
                seq,
                varianceCents,
                finalizedAt: new Date(),
              },
            });

            return { code: restockCode(dateCode, seq), creditCents, varianceCents };
          });
        } catch (err) {
          const isUniqueViolation =
            typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
          if (isUniqueViolation && attempt < 3) continue;
          throw err;
        }
      }
    }),

  /** ✕ abandon: DRAFT only; removes the row, its lots, and all photo files. */
  deleteDraft: protectedProcedure
    .input(z.object({ restockId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const paths = await dbTransaction(async (tx) => {
        const restock = await getDraftOrThrow(tx, input.restockId);
        assertMayFinalize(restock, ctx.user);
        const images = await tx.restockImage.findMany({ where: { restockId: restock.id } });
        const lots = await tx.lot.findMany({ where: { restockId: restock.id } });
        await tx.restock.delete({ where: { id: restock.id } }); // cascades lots/images
        return [
          ...images.map((i) => i.path),
          ...lots.flatMap((l) => (l.unitPhotoPath ? [l.unitPhotoPath] : [])),
        ];
      });
      for (const path of paths) await unlinkIfUnreferenced(path);
      return { ok: true };
    }),
});
