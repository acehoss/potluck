import { redirect } from 'next/navigation';
import { restockCode } from '@/lib/domain';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { SharesView, type ShareableLot } from './shares-view';

/**
 * Needs & surpluses board (REWORK F). Server shell: auth redirect plus the
 * acting household's own shareable lots for the SURPLUS composer (the share
 * router exposes no lot-list query, so it's loaded here directly). Everything
 * else — the feed, claims, reshares — drives through the tRPC feed query in
 * SharesView. Lots mirror loadOwnShareableLot's rule: own, FINALIZED,
 * non-void, non-excluded, unit cost frozen, and something actually available
 * (remaining − reserved > 0).
 */
export default async function SharesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const rawStocks = await db.stock.findMany({
    where: {
      pantry: { householdId: user.householdId },
      lot: {
        excluded: false,
        unitCostCents: { not: null },
        restock: {
          status: 'FINALIZED',
          voidedAt: null,
        },
      },
    },
    include: {
      lot: {
        include: {
          product: { select: { name: true } },
          restock: { select: { dateCode: true, seq: true, purchasedAt: true } },
        },
      },
    },
  });
  rawStocks.sort((a, b) => a.lot.restock.purchasedAt.getTime() - b.lot.restock.purchasedAt.getTime());

  const lots: ShareableLot[] = rawStocks
    .map((s) => ({
      id: s.id,
      productName: s.lot.product?.name ?? 'Untitled',
      code:
        s.lot.restock.dateCode && s.lot.restock.seq !== null
          ? restockCode(s.lot.restock.dateCode, s.lot.restock.seq)
          : '—',
      available: s.count - s.reservedCount,
    }))
    .filter((l) => l.available > 0);

  return <SharesView lots={lots} />;
}
