import { z } from 'zod';
import { looksLikeUpcQuery, normalizeScannedCode } from '@/lib/barcode';
import { db } from '../db';
import { protectedProcedure, router } from '../trpc';

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
});
