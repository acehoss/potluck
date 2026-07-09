import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { looksLikeUpcQuery, normalizeScannedCode } from '@/lib/barcode';
import type { Prisma } from '@/generated/prisma/client';
import type { SessionUser } from '../auth';
import { reachesResource, requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { deleteImageFile, imageFileExists, isStoredImagePath } from '../images';
import { moveMediaToMain } from '../media-positions';
import { protectedProcedure, router } from '../trpc';


type ProductLotForPhoto = {
  receivedCount: number;
  unitPhotoPath: string | null;
  stocks: { count: number }[];
  restock: {
    status: string;
    purchasedAt: Date;
    pantry: { id: string; householdId: string; visibility: string };
  };
};

/**
 * "This lot became inventory": received per the receipt, OR units physically
 * placed right now — a credit correction to zero must not hide a lot whose
 * stock is still on a shelf (Phase 4 Round 4, same rule as the pantry page).
 */
function everInventory(lot: ProductLotForPhoto): boolean {
  return lot.receivedCount > 0 || lot.stocks.some((s) => s.count > 0);
}

function newestUnitPhoto(lots: readonly ProductLotForPhoto[]) {
  return (
    lots
      .filter((lot) => lot.restock.status === 'FINALIZED' && everInventory(lot) && lot.unitPhotoPath)
      .sort((a, b) => b.restock.purchasedAt.getTime() - a.restock.purchasedAt.getTime())[0]
      ?.unitPhotoPath ?? null
  );
}

async function visibleProductLots(user: SessionUser, lots: readonly ProductLotForPhoto[]) {
  const visible: ProductLotForPhoto[] = [];
  for (const lot of lots) {
    if (lot.restock.status !== 'FINALIZED' || !everInventory(lot)) continue;
    const { pantry } = lot.restock;
    const canSee = await reachesResource(
      db,
      pantry.householdId,
      user.householdId,
      'pantry',
      pantry,
      (circleId) =>
        db.pantryCircle
          .findUnique({ where: { pantryId_circleId: { pantryId: pantry.id, circleId } } })
          .then(Boolean),
    );
    if (canSee) visible.push(lot);
  }
  return visible;
}

async function assertFreshProductImage(tx: Prisma.TransactionClient, path: string) {
  if (!isStoredImagePath('products', path)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an uploaded image path.' });
  }
  if (!(await imageFileExists(path))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Image not found — upload it first.' });
  }
  const [asProduct, asItem] = await Promise.all([
    tx.productImage.findFirst({ where: { path } }),
    tx.itemImage.findFirst({ where: { path } }),
  ]);
  if (asProduct || asItem) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That image is already attached.' });
  }
}

async function unlinkProductOrItemImageIfUnreferenced(path: string) {
  const [asProduct, asItem] = await Promise.all([
    db.productImage.findFirst({ where: { path } }),
    db.itemImage.findFirst({ where: { path } }),
  ]);
  if (!asProduct && !asItem) await deleteImageFile(path);
}

export const productRouter = router({
  /**
   * Search-as-you-type for the line sheet's product picker. Case-insensitive
   * substring match on name; a digits-only query of retail-code length ALSO
   * matches Product.upc exactly (blueprint 04 §2: typed UPC digits work
   * everywhere a scan button appears — and the scan button feeds the scanned
   * code through this same query). UPC queries are normalized server-side to
   * the same canonical form saveLine stores (leading-zero EAN-13 → 12-digit
   * UPC-A), so the 13-digit code printed on a box finds the product a scan
   * created, and vice versa. Empty query returns the most recent products.
   */
  search: protectedProcedure
    .input(z.object({ query: z.string().trim().max(200) }))
    .query(async ({ ctx, input }) => {
      const q = input.query;
      const upcQ = looksLikeUpcQuery(q) ? normalizeScannedCode(q) : null;
      // Scoped to the ACTING household's catalog (REWORK D1): search feeds
      // the receiving picker, and receiving runs as the pantry owner — other
      // households' same-named products are separate rows by design.
      const products = await db.product.findMany({
        where: {
          householdId: ctx.user.householdId,
          ...(q
            ? upcQ
              ? { OR: [{ upc: upcQ }, { name: { contains: q } }] }
              : { name: { contains: q } }
            : undefined),
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, name: true, upc: true },
      });
      return products;
    }),

  get: protectedProcedure
    .input(z.object({ productId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const product = await db.product.findUnique({
        where: { id: input.productId },
        include: {
          images: { orderBy: { position: 'asc' } },
          lots: {
            include: {
              stocks: { select: { count: true } },
              restock: {
                select: {
                  status: true,
                  purchasedAt: true,
                  pantry: { select: { id: true, householdId: true, visibility: true } },
                },
              },
            },
          },
        },
      });
      if (!product) throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });

      const mine = product.householdId === ctx.user.householdId;
      const photoLots = mine ? product.lots : await visibleProductLots(ctx.user, product.lots);
      if (!mine && photoLots.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
      }

      return {
        id: product.id,
        name: product.name,
        upc: product.upc,
        householdId: product.householdId,
        mine,
        images: product.images.map((image) => ({
          id: image.id,
          path: image.path,
          position: image.position,
        })),
        derivedPhotoPath: newestUnitPhoto(photoLots),
      };
    }),

  addImage: protectedProcedure
    .input(
      z.object({
        productId: z.string().min(1),
        path: z.string().min(1).max(300),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const image = await dbTransaction(async (tx) => {
        const product = await tx.product.findUnique({ where: { id: input.productId } });
        if (!product || product.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
        }
        requireCapability(ctx.user, 'receiveStock');
        await assertFreshProductImage(tx, input.path);

        const count = await tx.productImage.count({ where: { productId: product.id } });
        if (count >= 8) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'A product can have at most 8 images.' });
        }
        const last = await tx.productImage.findFirst({
          where: { productId: product.id },
          orderBy: { position: 'desc' },
        });
        return tx.productImage.create({
          data: {
            productId: product.id,
            path: input.path,
            position: last ? last.position + 1 : 0,
          },
        });
      });
      return { id: image.id };
    }),

  removeImage: protectedProcedure
    .input(z.object({ imageId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const path = await dbTransaction(async (tx) => {
        const image = await tx.productImage.findUnique({
          where: { id: input.imageId },
          include: { product: { select: { householdId: true } } },
        });
        if (!image || image.product.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found.' });
        }
        requireCapability(ctx.user, 'receiveStock');
        await tx.productImage.delete({ where: { id: image.id } });
        return image.path;
      });
      await unlinkProductOrItemImageIfUnreferenced(path);
      return { ok: true };
    }),

  setMain: protectedProcedure
    .input(z.object({ imageId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await dbTransaction(async (tx) => {
        const image = await tx.productImage.findUnique({
          where: { id: input.imageId },
          include: { product: { select: { householdId: true } } },
        });
        if (!image || image.product.householdId !== ctx.user.householdId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found.' });
        }
        requireCapability(ctx.user, 'receiveStock');
        const images = await tx.productImage.findMany({
          where: { productId: image.productId },
          orderBy: { position: 'asc' },
          select: { id: true, position: true },
        });
        const updates = moveMediaToMain(images, image.id);
        for (let i = 0; i < images.length; i++) {
          await tx.productImage.update({ where: { id: images[i].id }, data: { position: -1 - i } });
        }
        for (const update of updates) {
          await tx.productImage.update({ where: { id: update.id }, data: { position: update.position } });
        }
      });
      return { ok: true };
    }),

});
