import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { normalizeScannedCode } from '@/lib/barcode';
import {
  allocateReceipt,
  dateCodeFor,
  reconcileVariance,
  restockCode,
  varianceAutoPasses,
} from '@/lib/domain';
import type { SessionUser } from '../auth';
import { getConnection, loadAccessiblePantry, requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import {
  extractReceipt,
  extractionMode,
  parseResolvedIndices,
  parseStoredExtraction,
  type ExtractionImage,
} from '../extraction';
import { deleteImageFile, imageFileExists, isStoredImagePath, readImageFile } from '../images';
import { getActiveRestockCredit, pickActiveRestockCredit } from '../ledger';
import { checkRateLimit } from '../rate-limit';
import { assertPantriesNotUnderCount, ensureStock, guardedRecountStock } from '../stock';
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
  // Non-inventory receipt amounts (blueprint 01 D7). Tax is split across taxable
  // lines; fees across all lines only when feesDistributed. Both fold into the
  // frozen unit cost at finalize, so entering them also removes the false
  // "receipt is short" variance a taxed receipt used to always show.
  taxCents: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
  feesCents: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
  feesDistributed: z.boolean().optional(),
});

const lineSchema = z.object({
  restockId: z.string().min(1),
  lotId: z.string().min(1).optional(), // absent = new line
  // Exactly one of productId / newProductName — unless `excluded` (no product).
  productId: z.string().min(1).optional(),
  newProductName: z.string().trim().min(1).max(200).optional(),
  // A taxable line earns a pro-rata share of the receipt tax at finalize.
  taxable: z.boolean().optional(),
  // An excluded line has no product and no units — it exists only so the
  // receipt reconciles and fee distribution is accurate (a shortcut for whole
  // receipt lines that aren't going into the pantry). Still opt-in taxable.
  excluded: z.boolean().optional(),
  // Raw receipt line text (from extraction), shown beside the product.
  receiptText: z.string().trim().max(300).optional(),
  // Optional retail code (slice 7 scan flow): saved onto the inline-created
  // product, or onto an EXISTING picked product that has no UPC yet — a scan
  // matched by search rather than UPC must still stick, or pre-scan-era
  // products could never gain a code and repeat scans would miss forever.
  // Digits only, UPC-A/EAN length; normalized server-side (leading-zero
  // EAN-13 → 12-digit UPC-A) so scanned and typed codes meet in one form.
  upc: z
    .string()
    .trim()
    .regex(/^\d{8,14}$/)
    .optional(),
  purchasedCount: z.number().int().min(0).max(10_000), // 0 only for excluded lines
  receivedCount: z.number().int().min(0).max(10_000),
  lineTotalCents: z.number().int().min(0).max(MAX_CENTS),
  bestBy: dateOnly.nullable(),
  // Optional unit photo captured in the line sheet (Round A): a freshly
  // uploaded 'units' path, validated exactly like setUnitPhoto and applied to
  // the created/updated lot in the same transaction. Absent = leave the lot's
  // existing photo untouched.
  unitPhotoPath: z.string().min(1).max(300).optional(),
});

const lineAllocationSchema = z.object({
  lotId: z.string().min(1),
  allocations: z
    .array(
      z.object({
        pantryId: z.string().min(1),
        count: z.number().int().min(1).max(10_000),
      }),
    )
    .max(8),
});

/**
 * Status checks and their dependent writes always run inside the same
 * dbTransaction (which holds the app-wide DB lock), so a concurrent finalize
 * cannot land between the DRAFT check and the write.
 *
 * Also the draft-edit authz choke point (REWORK A3a/D1): receiving is a
 * PANTRY-OWNER-household action — drafts are created and edited while acting
 * as the household that owns the pantry (a connected purchaser is credited
 * via purchaserHouseholdId, not by driving the wizard), and the acting
 * membership needs receiveStock.
 */
async function getDraftOrThrow(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  restockId: string,
) {
  const restock = await tx.restock.findUnique({
    where: { id: restockId },
    include: { pantry: true },
  });
  if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
  // Visibility BEFORE status: a household with no standing must read 404 —
  // never the draft-vs-finalized distinction. The purchaser household can SEE
  // the restock (restock.get) but never drive the wizard.
  if (restock.pantry.householdId !== user.householdId) {
    if (restock.purchaserHouseholdId !== user.householdId) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Receiving runs as the household that owns the pantry.',
    });
  }
  requireCapability(user, 'receiveStock');
  if (restock.status !== 'DRAFT') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Restock is already finalized.' });
  }
  return restock;
}

/**
 * Assign the restock's `YYMMDD-NN` code for its purchase date, race-safe via
 * @@unique([dateCode, seq]). Assigned at DRAFT START (not finalize) so the
 * physical label is known up front — the user pulls items from bags in any
 * order and labels each as it hits the shelf (Aaron's flow). Reverses blueprint
 * D6's finalize-time assignment; the tradeoff is that abandoned drafts leave
 * gaps in a day's numbering, which is fine. Re-derives when the receipt date is
 * edited to a different day, and no-ops when already coded for the same day.
 * Must run inside a caller transaction wrapped in `withCodeRetry` (a P2002 on
 * the unique index means a concurrent restock grabbed the seq — retry).
 */
async function assignRestockCode(
  tx: Prisma.TransactionClient,
  restockId: string,
  purchasedAt: Date,
) {
  const dateCode = dateCodeFor(purchasedAt);
  const current = await tx.restock.findUnique({
    where: { id: restockId },
    select: { dateCode: true, seq: true },
  });
  if (current?.dateCode === dateCode && current.seq !== null) return;
  const maxSeq = await tx.restock.aggregate({ where: { dateCode }, _max: { seq: true } });
  const seq = (maxSeq._max.seq ?? 0) + 1;
  await tx.restock.update({ where: { id: restockId }, data: { dateCode, seq } });
}

/** Retry a transaction that assigns a restock seq when it collides (P2002). */
async function withCodeRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isUniqueViolation =
        typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
      if (isUniqueViolation && attempt < 5) continue;
      throw err;
    }
  }
}

/**
 * Finalize/delete/removeImage gate: the ACTING household must own the pantry,
 * with receiveStock. Receiving — including landing or abandoning a draft and
 * destroying receipt images — is an owner-side flow; the pre-rework
 * creator/purchaser standings are gone (adversarial review: bare-creator
 * standing let a user demoted in the owner household finalize on a capability
 * from an UNRELATED household's membership, and purchaser-side finalize let a
 * teen post a credit in their own household's favor). The purchaser reads its
 * credit on the restock detail instead.
 */
function assertOwnerReceiving(
  restock: { purchaserHouseholdId: string; pantry: { householdId: string } },
  user: SessionUser,
) {
  if (restock.pantry.householdId !== user.householdId) {
    if (restock.purchaserHouseholdId !== user.householdId) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Receiving runs as the household that owns the pantry.',
    });
  }
  requireCapability(user, 'receiveStock');
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
  /**
   * Step 1: create the server-side draft. Receiving is a pantry-owner action
   * (the acting household must own the pantry, with receiveStock); the
   * PURCHASER may be the acting household or any ACTIVELY-connected one —
   * that attribution is what posts the cross-household credit at finalize,
   * so it can't be a free-form household id.
   */
  create: protectedProcedure
    .input(draftHeaderSchema.extend({ pantryId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'receiveStock');
      // 404 for pantries the acting household can't SEE at all; 403 for
      // visible-but-foreign ones (a granted counterparty may browse, never
      // receive) — the B4 convention.
      const { isOwn } = await loadAccessiblePantry(db, ctx.user, input.pantryId);
      if (!isOwn) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Receiving runs as the household that owns the pantry.',
        });
      }
      // Purchaser attribution posts money at finalize: the acting household
      // itself, or an ACTIVELY connected one. Anything else — including a
      // household id that doesn't exist — reads uniformly as not-found (a
      // split response would be a household-id existence oracle).
      if (
        input.purchaserHouseholdId !== ctx.user.householdId &&
        !(await getConnection(db, input.purchaserHouseholdId, ctx.user.householdId).then(
          (c) => c?.status === 'ACTIVE',
        ))
      ) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Household not found.' });
      }

      const id = await withCodeRetry(() =>
        dbTransaction(async (tx) => {
          const restock = await tx.restock.create({
            data: {
              pantryId: input.pantryId,
              purchaserHouseholdId: input.purchaserHouseholdId,
              createdById: ctx.user.id,
              retailer: input.retailer,
              purchasedAt: input.purchasedAt,
              receiptTotalCents: input.receiptTotalCents,
              taxCents: input.taxCents ?? null,
              feesCents: input.feesCents ?? null,
              feesDistributed: input.feesDistributed ?? false,
            },
          });
          // Assign the label code up front (see assignRestockCode).
          await assignRestockCode(tx, restock.id, input.purchasedAt);
          return restock.id;
        }),
      );
      return { id };
    }),

  /** Header edits while DRAFT (fix a mistyped total/date without abandoning). */
  updateDraft: protectedProcedure
    .input(draftHeaderSchema.partial().extend({ restockId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { restockId, ...data } = input;
      await withCodeRetry(() =>
        dbTransaction(async (tx) => {
          const draft = await getDraftOrThrow(tx, ctx.user, restockId);
          // Purchaser CHANGES carry the same connected-household constraint
          // as create (the attribution posts money at finalize). Keeping the
          // existing purchaser is always allowed — the edit-details sheet
          // resubmits it alongside unrelated header fixes, which must not
          // start failing if the connection state moves under the draft
          // (finalize re-checks at the money moment).
          if (
            data.purchaserHouseholdId &&
            data.purchaserHouseholdId !== draft.purchaserHouseholdId &&
            data.purchaserHouseholdId !== ctx.user.householdId &&
            !(await getConnection(tx, data.purchaserHouseholdId, ctx.user.householdId).then(
              (c) => c?.status === 'ACTIVE',
            ))
          ) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Household not found.' });
          }
          await tx.restock.update({ where: { id: restockId }, data });
          // A changed receipt date changes the day, so re-derive the label.
          if (data.purchasedAt) await assignRestockCode(tx, restockId, data.purchasedAt);
        }),
      );
      return { ok: true };
    }),

  /**
   * Wizard data. Everyone sees everything (SPEC §2). Returns a plain-JSON
   * DTO — no transformer on the tRPC link, so Dates go over as ISO strings.
   */
  get: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    const restock = await db.restock.findUnique({
      where: { id: input.id },
      include: {
        pantry: { include: { household: { select: { id: true, name: true } } } },
        purchaserHousehold: { select: { id: true, name: true } },
        images: { orderBy: { position: 'asc' } },
        lots: {
          orderBy: { position: 'asc' },
          include: {
            product: { select: { id: true, name: true } },
            stocks: { select: { id: true, pantryId: true, count: true, reservedCount: true } },
            allocations: {
              orderBy: { pantryId: 'asc' },
              include: { pantry: { select: { name: true } } },
            },
          },
        },
      },
    });
    if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
    // Owner-side flow plus the purchaser household (their credit's audit
    // trail); anyone else reads not-found (B4 scoping).
    if (
      restock.pantry.householdId !== ctx.user.householdId &&
      restock.purchaserHouseholdId !== ctx.user.householdId
    ) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }

    const credit = await getActiveRestockCredit(restock.id);
    const extraction = parseStoredExtraction(restock.extractionJson);
    const pantries =
      restock.pantry.householdId === ctx.user.householdId
        ? await db.pantry.findMany({
            where: { householdId: ctx.user.householdId },
            orderBy: { name: 'asc' },
            select: { id: true, name: true },
          })
        : [];
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
      taxCents: restock.taxCents,
      feesCents: restock.feesCents,
      feesDistributed: restock.feesDistributed,
      dateCode: restock.dateCode,
      seq: restock.seq,
      code:
        restock.dateCode && restock.seq !== null
          ? restockCode(restock.dateCode, restock.seq)
          : null,
      varianceCents: restock.varianceCents,
      voidedAt: restock.voidedAt?.toISOString() ?? null,
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
        taxable: l.taxable,
        excluded: l.excluded,
        receiptText: l.receiptText,
        unitCostCents: l.unitCostCents,
        taxCentsAllocated: l.taxCentsAllocated,
        feeCentsAllocated: l.feeCentsAllocated,
        stockId: l.stocks.find((s) => s.pantryId === restock.pantryId)?.id ?? null,
        bestBy: l.bestBy?.toISOString().slice(0, 10) ?? null,
        unitPhotoPath: l.unitPhotoPath,
        allocations: l.allocations.map((a) => ({
          pantryId: a.pantryId,
          pantryName: a.pantry.name,
          count: a.count,
        })),
        // Null for an excluded (non-inventory) line.
        product: l.product,
      })),
      pantries,
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
    .mutation(async ({ ctx, input }) => {
      const image = await dbTransaction(async (tx) => {
        await assertFreshUpload(tx, 'receipts', input.path);
        const restock = await tx.restock.findUnique({
          where: { id: input.restockId },
          include: { pantry: { select: { householdId: true } } },
        });
        if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
        // Receipt pages are append-only even post-finalize (blueprint 01), so
        // this is not draft-gated — but it IS an owner/purchaser receiving
        // action (REWORK A3a).
        if (
          restock.pantry.householdId !== ctx.user.householdId &&
          restock.purchaserHouseholdId !== ctx.user.householdId
        ) {
          throw new TRPCError({ code: 'NOT_FOUND' });
        }
        requireCapability(ctx.user, 'receiveStock');
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
        include: {
          images: { orderBy: { position: 'asc' } },
          pantry: { select: { householdId: true } },
        },
      });
      if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
      if (restock.status !== 'DRAFT') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Restock is already finalized.' });
      }
      // Gated like the other draft edits (owner-household receiving action),
      // checked BEFORE consuming the extraction budget.
      if (restock.pantry.householdId !== ctx.user.householdId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Receiving runs as the household that owns the pantry.',
        });
      }
      requireCapability(ctx.user, 'receiveStock');
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
        taxCents: result.data.taxCents,
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
    .mutation(async ({ ctx, input }) => {
      await dbTransaction(async (tx) => {
        const restock = await getDraftOrThrow(tx, ctx.user, input.restockId);
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
          include: { restock: { include: { pantry: { select: { householdId: true } } } } },
        });
        if (!image) throw new TRPCError({ code: 'NOT_FOUND' });
        assertOwnerReceiving(image.restock, ctx.user);
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
  saveLine: protectedProcedure.input(lineSchema).mutation(async ({ ctx, input }) => {
    const excluded = input.excluded ?? false;
    if (!excluded) {
      if (input.purchasedCount < 1) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'At least one unit.' });
      }
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
    }

    // One transaction: the DRAFT check holds through the write, a new Product
    // can't be orphaned by a failing lot write, and position assignment is
    // race-free.
    const { lotId, previousPhotoPath } = await dbTransaction(async (tx) => {
      const restock = await getDraftOrThrow(tx, ctx.user, input.restockId);

      // Canonical stored form (zod guarantees 8–14 digits, so this never
      // nulls out a value the schema accepted).
      const upc = input.upc ? normalizeScannedCode(input.upc) : null;
      let productId: string | null = null;
      if (!excluded) {
        productId = input.productId ?? null;
        if (input.newProductName) {
          // Products belong to the household whose pantry the lot lands in
          // (REWORK D1: the pantry owner is the catalog owner — the purchaser
          // may be another household entirely).
          const product = await tx.product.create({
            data: {
              name: input.newProductName,
              upc,
              householdId: restock.pantry.householdId,
            },
          });
          productId = product.id;
        } else {
          const exists = await tx.product.findUnique({ where: { id: productId! } });
          // The picked product must belong to the pantry-owner household
          // (REWORK D1): a lot may never reference another household's
          // catalog row — and the UPC write-through below must never stamp a
          // foreign catalog. Foreign products read as not-found.
          if (!exists || exists.householdId !== restock.pantry.householdId) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
          }
          // A scanned code picked onto an existing product fills in a missing
          // UPC (never overwrites one that's already set).
          if (upc && exists.upc === null) {
            await tx.product.update({ where: { id: exists.id }, data: { upc } });
          }
        }
      }

      // Optional unit photo captured in the line sheet (Round A): a fresh
      // 'units' upload, validated exactly like setUnitPhoto (right kind,
      // present on disk, referenced by no other row). Excluded lines carry no
      // photo. Applied to the lot below in this same transaction.
      let unitPhotoPath: string | undefined;
      if (!excluded && input.unitPhotoPath) {
        await assertFreshUpload(tx, 'units', input.unitPhotoPath);
        unitPhotoPath = input.unitPhotoPath;
      }

      // An excluded line carries only its total (weight for tax/fee split) and
      // its taxable flag — no product, no units, no inventory. The photo is set
      // only when a fresh one was captured — an unchanged edit leaves it be.
      const data = {
        productId,
        purchasedCount: excluded ? 0 : input.purchasedCount,
        receivedCount: excluded ? 0 : input.receivedCount,
        lineTotalCents: input.lineTotalCents,
        taxable: input.taxable ?? false,
        excluded,
        receiptText: input.receiptText || null,
        bestBy: excluded ? null : input.bestBy,
        ...(unitPhotoPath ? { unitPhotoPath } : {}),
      };

      if (input.lotId) {
        const lot = await tx.lot.findUnique({ where: { id: input.lotId } });
        if (!lot || lot.restockId !== input.restockId) throw new TRPCError({ code: 'NOT_FOUND' });
        await tx.lot.update({ where: { id: input.lotId }, data });
        // A replaced photo's old file is unlinked after commit (below), never
        // before — same DB-first ordering as setUnitPhoto.
        return { lotId: input.lotId, previousPhotoPath: unitPhotoPath ? lot.unitPhotoPath : null };
      }

      const last = await tx.lot.findFirst({
        where: { restockId: input.restockId },
        orderBy: { position: 'desc' },
      });
      const lot = await tx.lot.create({
        data: { ...data, restockId: input.restockId, position: (last?.position ?? 0) + 1 },
      });
      return { lotId: lot.id, previousPhotoPath: null };
    });
    // Drop the replaced file only after the DB commit, and only if nothing
    // else references it.
    if (previousPhotoPath) await unlinkIfUnreferenced(previousPhotoPath);
    return { lotId };
  }),

  /**
   * Draft-only destination split for one receive line. Empty allocations mean
   * "land the whole line in the restock's default pantry"; non-empty rows are
   * validated against receivedCount only at finalize so line edits can happen
   * in either order without making the draft unusable.
   */
  setLineAllocations: protectedProcedure
    .input(lineAllocationSchema)
    .mutation(async ({ ctx, input }) => {
      const seen = new Set<string>();
      let total = 0;
      for (const allocation of input.allocations) {
        if (seen.has(allocation.pantryId)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Duplicate destination pantry.' });
        }
        seen.add(allocation.pantryId);
        total += allocation.count;
      }
      if (total > 10_000) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Destination split is too large.' });
      }

      await dbTransaction(async (tx) => {
        const lot = await tx.lot.findUnique({
          where: { id: input.lotId },
          select: { id: true, restockId: true, excluded: true },
        });
        if (!lot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Line not found.' });
        const restock = await getDraftOrThrow(tx, ctx.user, lot.restockId);
        if (lot.excluded && input.allocations.length > 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Excluded lines cannot be split.' });
        }
        if (input.allocations.length) {
          const owned = await tx.pantry.count({
            where: { id: { in: [...seen] }, householdId: restock.pantry.householdId },
          });
          if (owned !== seen.size) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
          }
        }
        await tx.lotAllocation.deleteMany({ where: { lotId: lot.id } });
        if (input.allocations.length) {
          await tx.lotAllocation.createMany({
            data: input.allocations.map((allocation) => ({
              lotId: lot.id,
              pantryId: allocation.pantryId,
              count: allocation.count,
            })),
          });
        }
      });
      return { ok: true };
    }),

  deleteLine: protectedProcedure
    .input(z.object({ lotId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const photoPath = await dbTransaction(async (tx) => {
        const lot = await tx.lot.findUnique({
          where: { id: input.lotId },
          include: {
            restock: { select: { status: true, pantry: { select: { householdId: true } } } },
          },
        });
        if (!lot) throw new TRPCError({ code: 'NOT_FOUND' });
        if (lot.restock.status !== 'DRAFT') {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Restock is finalized.' });
        }
        // Same owner-household gate as every other draft edit.
        if (lot.restock.pantry.householdId !== ctx.user.householdId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Receiving runs as the household that owns the pantry.',
          });
        }
        requireCapability(ctx.user, 'receiveStock');
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
    .mutation(async ({ ctx, input }) => {
      const previous = await dbTransaction(async (tx) => {
        const lot = await tx.lot.findUnique({
          where: { id: input.lotId },
          include: {
            restock: {
              select: {
                purchaserHouseholdId: true,
                pantry: { select: { householdId: true } },
              },
            },
          },
        });
        if (!lot) throw new TRPCError({ code: 'NOT_FOUND' });
        // Deliberately assigned (was "any member"): a receiving action of the
        // owner or purchaser household, allowed post-finalize (re-snaps).
        if (
          lot.restock.pantry.householdId !== ctx.user.householdId &&
          lot.restock.purchaserHouseholdId !== ctx.user.householdId
        ) {
          throw new TRPCError({ code: 'NOT_FOUND' });
        }
        requireCapability(ctx.user, 'receiveStock');
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
              include: {
                pantry: true,
                lots: {
                  orderBy: { position: 'asc' },
                  include: {
                    product: { select: { name: true } },
                    allocations: {
                      include: { pantry: { select: { householdId: true } } },
                    },
                  },
                },
              },
            });
            if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
            if (restock.status !== 'DRAFT') {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Already finalized.' });
            }
            assertOwnerReceiving(restock, ctx.user);
            // A reconcile freeze on any destination pantry blocks finalize —
            // new placements would land uncounted under the count (A2).
            await assertPantriesNotUnderCount(tx, [
              ...new Set([
                restock.pantryId,
                ...restock.lots.flatMap((l) => l.allocations.map((a) => a.pantryId)),
              ]),
            ]);
            if (restock.lots.length === 0) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'Add at least one line before finalizing.',
              });
            }

            // Fold receipt tax/fees into each lot's landed cost (D1 freeze, now
            // tax-inclusive), then freeze the unit costs and stock placements.
            const receiptAllocations = allocateReceipt(
              restock.lots.map((l) => ({
                lineTotalCents: l.lineTotalCents,
                purchasedCount: l.purchasedCount,
                taxable: l.taxable,
                excluded: l.excluded,
              })),
              restock.taxCents,
              restock.feesCents,
              restock.feesDistributed,
            );

            let creditCents = 0;
            let lineSumCents = 0;
            for (let i = 0; i < restock.lots.length; i++) {
              const lot = restock.lots[i];
              const a = receiptAllocations[i];
              lineSumCents += lot.lineTotalCents;
              // Excluded lines never become inventory and never earn a credit —
              // their tax/fee share is the purchaser's own cost.
              if (!lot.excluded && a.unitCostCents !== null) {
                creditCents += lot.receivedCount * a.unitCostCents;
              }
              await tx.lot.update({
                where: { id: lot.id },
                data: {
                  unitCostCents: a.unitCostCents,
                  taxCentsAllocated: a.taxCentsAllocated,
                  feeCentsAllocated: a.feeCentsAllocated,
                },
              });
              if (!lot.excluded) {
                if (lot.allocations.some((allocation) => allocation.pantry.householdId !== restock.pantry.householdId)) {
                  throw new TRPCError({
                    code: 'PRECONDITION_FAILED',
                    message: `Line ${lot.position}: destination pantry is no longer available.`,
                  });
                }
                if (lot.allocations.length) {
                  const splitCount = lot.allocations.reduce((sum, allocation) => sum + allocation.count, 0);
                  if (splitCount !== lot.receivedCount) {
                    const name = lot.product?.name ? ` (${lot.product.name})` : '';
                    throw new TRPCError({
                      code: 'PRECONDITION_FAILED',
                      message: `Line ${lot.position}${name}: destination split (${splitCount}) doesn't match received count (${lot.receivedCount}).`,
                    });
                  }
                  for (const allocation of lot.allocations) {
                    const stock = await ensureStock(tx, lot.id, allocation.pantryId);
                    await guardedRecountStock(tx, stock.id, () => allocation.count);
                  }
                } else {
                  const stock = await ensureStock(tx, lot.id, restock.pantryId);
                  await guardedRecountStock(tx, stock.id, () => lot.receivedCount);
                }
              }
            }
            await tx.lotAllocation.deleteMany({
              where: { lotId: { in: restock.lots.map((lot) => lot.id) } },
            });

            const varianceCents = reconcileVariance(
              restock.receiptTotalCents,
              lineSumCents,
              restock.taxCents,
              restock.feesCents,
            );
            if (
              varianceCents !== null &&
              !varianceAutoPasses(varianceCents, restock.lots.length) &&
              input.acknowledgedVarianceCents !== varianceCents
            ) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message:
                  'Receipt total differs from the accounted amount — review the variance and acknowledge to finalize.',
              });
            }

            // Cross-household: credit the purchaser at cost (tax-inclusive),
            // received units only. The connection is re-verified at the MONEY
            // moment — a draft can sit for days, and B6 forbids new money
            // across an edge severed mid-draft (validated at create/edit too,
            // but the credit posts HERE).
            if (restock.purchaserHouseholdId !== restock.pantry.householdId && creditCents > 0) {
              const edge = await getConnection(
                tx,
                restock.purchaserHouseholdId,
                restock.pantry.householdId,
              );
              if (edge?.status !== 'ACTIVE') {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message:
                    'The purchaser household is no longer connected — change the purchaser before finalizing.',
                });
              }
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

            // The code was assigned at draft start; this only fills one in for a
            // legacy draft that predates early assignment (no-op otherwise).
            await assignRestockCode(tx, restock.id, restock.purchasedAt);
            const coded = await tx.restock.findUnique({
              where: { id: restock.id },
              select: { dateCode: true, seq: true },
            });

            await tx.restock.update({
              where: { id: restock.id },
              data: {
                status: 'FINALIZED',
                varianceCents,
                finalizedAt: new Date(),
              },
            });

            return {
              code: restockCode(coded!.dateCode!, coded!.seq!),
              creditCents,
              varianceCents,
            };
          });
        } catch (err) {
          const isUniqueViolation =
            typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
          if (isUniqueViolation && attempt < 3) continue;
          throw err;
        }
      }
    }),

  /**
   * The correct-credit op (blueprint 01 Immutability + invariant 5): the only
   * auditable fix for a RESTOCK_CREDIT posted against a wrong `receivedCount`
   * caught AFTER finalize. FINALIZED is terminal and a free-form manual
   * ADJUSTMENT is explicitly NOT the fix path (it carries no `restockId` and
   * severs restock↔ledger auditability), so this is the escape hatch.
   *
   * One transaction, gated to a member of the purchaser OR pantry-owning
   * household (authz matrix, "Correct a RESTOCK_CREDIT"): the operator supplies
   * the corrected received count per affected lot; the server recomputes the
   * credit as Σ(receivedCount × unitCostCents) — never a client-supplied dollar
   * figure (D1) — then REVERSES the old credit (swapped parties, same amount,
   * `reversesId`, same `restockId`) and posts the corrected RESTOCK_CREDIT
   * (also linked to the restock). Both survive for the audit trail; the
   * reversed-credit dedup in `pickActiveRestockCredit` keeps every display read
   * on the live one.
   *
   * `receivedCount` is the money basis and is persisted here so invariant 5
   * stays literally true — this is the sanctioned exception to its post-finalize
   * immutability (like `Take.reversedAt`). It does NOT touch Stock counts:
   * physical inventory drift is corrected independently by the owner's recount
   * (invariant 9), and double-correcting here would desync the two.
   */
  correctCredit: protectedProcedure
    .input(
      z.object({
        restockId: z.string().min(1),
        // Corrected received count per affected lot; omitted lots keep theirs.
        corrections: z
          .array(
            z.object({
              lotId: z.string().min(1),
              receivedCount: z.number().int().min(0).max(10_000),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const restock = await tx.restock.findUnique({
          where: { id: input.restockId },
          include: { pantry: { select: { householdId: true } }, lots: true },
        });
        if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
        if (restock.status !== 'FINALIZED') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Only a finalized restock has a credit to correct.',
          });
        }
        // Authz: purchaser or pantry-owning household (blueprint 01 matrix),
        // with settleMoney — this rewrites posted money (REWORK A3a).
        if (
          restock.purchaserHouseholdId !== ctx.user.householdId &&
          restock.pantry.householdId !== ctx.user.householdId
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the purchaser or pantry-owning household can correct this credit.',
          });
        }
        requireCapability(ctx.user, 'settleMoney');
        if (restock.purchaserHouseholdId === restock.pantry.householdId) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'An own-pantry restock posts no credit to correct.',
          });
        }

        // Validate every correction targets a lot of THIS restock and stays in
        // range, then fold the corrected counts over the frozen unit costs.
        const byId = new Map(restock.lots.map((l) => [l.id, l]));
        const corrected = new Map<string, number>();
        for (const c of input.corrections) {
          const lot = byId.get(c.lotId);
          if (!lot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Lot not found on this restock.' });
          if (c.receivedCount > lot.purchasedCount) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Received count cannot exceed purchased count.',
            });
          }
          corrected.set(c.lotId, c.receivedCount);
        }
        let newCreditCents = 0;
        for (const lot of restock.lots) {
          const received = corrected.get(lot.id) ?? lot.receivedCount;
          newCreditCents += received * (lot.unitCostCents ?? 0);
        }

        const entries = await tx.ledgerEntry.findMany({ where: { restockId: restock.id } });
        const active = pickActiveRestockCredit(entries);
        const previousCents = active?.amountCents ?? 0;
        if (newCreditCents === previousCents) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'The corrected credit matches the current one — nothing to change.',
          });
        }

        // Persist the corrected money basis (the sanctioned receivedCount edit).
        for (const [lotId, received] of corrected) {
          await tx.lot.update({ where: { id: lotId }, data: { receivedCount: received } });
        }
        // Reverse the old credit (if one is live). The unique `reversesId` is a
        // hard backstop against reversing the same entry twice concurrently.
        if (active) {
          await tx.ledgerEntry.create({
            data: {
              type: 'REVERSAL',
              reversesId: active.id,
              restockId: restock.id,
              creditorHouseholdId: active.debtorHouseholdId,
              debtorHouseholdId: active.creditorHouseholdId,
              amountCents: active.amountCents,
              createdById: ctx.user.id,
            },
          });
        }
        // Post the corrected credit — unless it nets to zero (invariant 5:
        // none when purchaser owes nothing for received units).
        if (newCreditCents > 0) {
          await tx.ledgerEntry.create({
            data: {
              type: 'RESTOCK_CREDIT',
              restockId: restock.id,
              creditorHouseholdId: restock.purchaserHouseholdId,
              debtorHouseholdId: restock.pantry.householdId,
              amountCents: newCreditCents,
              createdById: ctx.user.id,
            },
          });
        }
        return { creditCents: newCreditCents, previousCents };
      });
    }),

  /**
   * Void a finalized restock entered by mistake (auditable "undo"). FINALIZED is
   * terminal and stays so — this reverses the active purchaser credit (swapped
   * parties, `reversesId`, same `restockId`) and zeroes every placement for
   * this restock's lots so the phantom stock leaves inventory, then stamps
   * `voidedAt`. Gated to the purchaser or pantry-owning household (same standing
   * as correctCredit). ALLOWED ONLY WHILE NO TAKE references a lot — once
   * someone has pulled from these lots, the honest fix is to undo those takes or
   * use correctCredit, not to pretend the restock never happened.
   */
  voidInError: protectedProcedure
    .input(z.object({ restockId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const restock = await tx.restock.findUnique({
          where: { id: input.restockId },
          include: { pantry: { select: { householdId: true } } },
        });
        if (!restock) throw new TRPCError({ code: 'NOT_FOUND' });
        if (restock.status !== 'FINALIZED') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Only a finalized restock can be voided.',
          });
        }
        if (restock.voidedAt) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Already voided.' });
        }
        if (
          restock.purchaserHouseholdId !== ctx.user.householdId &&
          restock.pantry.householdId !== ctx.user.householdId
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the purchaser or pantry-owning household can void this restock.',
          });
        }
        // Voiding reverses posted money (REWORK A3a).
        requireCapability(ctx.user, 'settleMoney');
        const takeCount = await tx.take.count({ where: { lot: { restockId: restock.id } } });
        if (takeCount > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'This restock already has takes — undo those first, or use Correct received counts.',
          });
        }
        // Reservations are not takes (a Take is only created at pickup), so the
        // takeCount gate above misses an open order holding these placements.
        // Zeroing count would strand that reservation and wedge the order at
        // pickup. Block until those orders are canceled or completed.
        const stocks = await tx.stock.findMany({
          where: { lot: { restockId: restock.id } },
          select: { id: true, reservedCount: true },
        });
        if (stocks.some((s) => s.reservedCount > 0)) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Open orders have reserved items from this restock — cancel or complete those first.',
          });
        }

        const entries = await tx.ledgerEntry.findMany({ where: { restockId: restock.id } });
        const active = pickActiveRestockCredit(entries);
        if (active) {
          await tx.ledgerEntry.create({
            data: {
              type: 'REVERSAL',
              reversesId: active.id,
              restockId: restock.id,
              creditorHouseholdId: active.debtorHouseholdId,
              debtorHouseholdId: active.creditorHouseholdId,
              amountCents: active.amountCents,
              createdById: ctx.user.id,
            },
          });
        }
        for (const stock of stocks) await guardedRecountStock(tx, stock.id, () => 0);
        await tx.restock.update({
          where: { id: restock.id },
          data: { voidedAt: new Date() },
        });
        return { reversedCents: active?.amountCents ?? 0 };
      });
    }),

  /** ✕ abandon: DRAFT only; removes the row, its lots, and all photo files. */
  deleteDraft: protectedProcedure
    .input(z.object({ restockId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const paths = await dbTransaction(async (tx) => {
        const restock = await getDraftOrThrow(tx, ctx.user, input.restockId);
        assertOwnerReceiving(restock, ctx.user);
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
