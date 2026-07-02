import { z } from 'zod';
import { db } from '../db';
import { protectedProcedure, router } from '../trpc';

export const productRouter = router({
  /**
   * Search-as-you-type for the line sheet's product picker. Case-insensitive
   * substring match; empty query returns the most recent products.
   */
  search: protectedProcedure
    .input(z.object({ query: z.string().trim().max(200) }))
    .query(async ({ input }) => {
      const products = await db.product.findMany({
        where: input.query ? { name: { contains: input.query } } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, name: true, upc: true },
      });
      return products;
    }),
});
