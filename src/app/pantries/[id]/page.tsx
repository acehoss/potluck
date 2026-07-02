import { notFound, redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { restockCode } from '@/lib/domain';
import { InventoryView, type ProductGroup } from './inventory-view';

/** Pantry inventory (blueprint 02): grouped by product, lots oldest-first. */
export default async function PantryPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const pantry = await db.pantry.findUnique({
    where: { id },
    include: { household: { select: { id: true, name: true } } },
  });
  if (!pantry) notFound();

  const lots = await db.lot.findMany({
    where: {
      restock: { pantryId: pantry.id, status: 'FINALIZED' },
      receivedCount: { gt: 0 },
    },
    include: {
      product: { select: { id: true, name: true } },
      restock: { select: { dateCode: true, seq: true, purchasedAt: true } },
    },
  });

  // D8: product display photo = newest lot of the product with a unit photo.
  const productIds = [...new Set(lots.map((l) => l.productId))];
  const photoLots = await db.lot.findMany({
    where: { productId: { in: productIds }, unitPhotoPath: { not: null } },
    orderBy: { restock: { purchasedAt: 'desc' } },
    select: { productId: true, unitPhotoPath: true },
  });
  const photoByProduct = new Map<string, string>();
  for (const l of photoLots) {
    if (!photoByProduct.has(l.productId)) photoByProduct.set(l.productId, l.unitPhotoPath!);
  }

  const groups = new Map<string, ProductGroup>();
  for (const lot of lots) {
    let group = groups.get(lot.productId);
    if (!group) {
      group = {
        productId: lot.productId,
        name: lot.product.name,
        photoPath: photoByProduct.get(lot.productId) ?? null,
        total: 0,
        lots: [],
      };
      groups.set(lot.productId, group);
    }
    group.total += lot.remainingCount;
    group.lots.push({
      id: lot.id,
      restockId: lot.restockId,
      code: restockCode(lot.restock.dateCode!, lot.restock.seq!),
      remaining: lot.remainingCount,
      // FINALIZED lots always have a frozen unit cost (blueprint 01 D1).
      unitCostCents: lot.unitCostCents!,
      purchasedAt: lot.restock.purchasedAt.toISOString(),
      bestBy: lot.bestBy?.toISOString() ?? null,
      unitPhotoPath: lot.unitPhotoPath,
    });
  }
  const productGroups = [...groups.values()]
    .filter((g) => g.total > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const g of productGroups) {
    g.lots = g.lots
      .filter((l) => l.remaining > 0)
      .sort((a, b) => a.purchasedAt.localeCompare(b.purchasedAt)); // FIFO order visible
  }

  const isOwn = pantry.householdId === user.householdId;
  // Resume banner only for drafts this user can actually finalize/abandon
  // (creator or purchaser household — the restock router's gate); otherwise
  // it walks them into a wizard whose Finalize is FORBIDDEN.
  const draft = isOwn
    ? await db.restock.findFirst({
        where: {
          pantryId: pantry.id,
          status: 'DRAFT',
          OR: [{ createdById: user.id }, { purchaserHouseholdId: user.householdId }],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, retailer: true },
      })
    : null;

  const households = await db.household.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  return (
    <InventoryView
      pantry={{ id: pantry.id, name: pantry.name, householdName: pantry.household.name }}
      isOwn={isOwn}
      groups={productGroups}
      draft={draft}
      households={households}
      yourHouseholdId={user.householdId}
    />
  );
}
