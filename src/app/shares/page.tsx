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

  const rawLots = await db.lot.findMany({
    where: {
      excluded: false,
      unitCostCents: { not: null },
      restock: {
        status: 'FINALIZED',
        voidedAt: null,
        pantry: { householdId: user.householdId },
      },
    },
    include: {
      product: { select: { name: true } },
      restock: { select: { dateCode: true, seq: true, purchasedAt: true } },
    },
    orderBy: { restock: { purchasedAt: 'asc' } }, // oldest first, mirrors FIFO gifting
  });

  const lots: ShareableLot[] = rawLots
    .map((l) => ({
      id: l.id,
      productName: l.product?.name ?? 'Untitled',
      code:
        l.restock.dateCode && l.restock.seq !== null
          ? restockCode(l.restock.dateCode, l.restock.seq)
          : '—',
      available: l.remainingCount - l.reservedCount,
    }))
    .filter((l) => l.available > 0);

  return <SharesView lots={lots} />;
}
