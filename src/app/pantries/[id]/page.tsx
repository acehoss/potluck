import { notFound, redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { activeConnectionsOf, hasActiveGrant } from '@/server/authz';
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
  // View gate (REWORK B2/B3/B4): your own pantry, or a SHARED pantry of a
  // household extending you the pantry grant over an ACTIVE connection.
  // Anything else reads as not-found — scoping never leaks existence.
  if (pantry.householdId !== user.householdId) {
    const visible =
      pantry.shared && (await hasActiveGrant(db, pantry.householdId, user.householdId, 'pantry'));
    if (!visible) notFound();
  }

  const rawLots = await db.lot.findMany({
    where: {
      restock: { pantryId: pantry.id, status: 'FINALIZED' },
      receivedCount: { gt: 0 },
      productId: { not: null },
    },
    include: {
      product: { select: { id: true, name: true, upc: true } },
      restock: { select: { dateCode: true, seq: true, purchasedAt: true } },
    },
  });
  // receivedCount > 0 already excludes non-inventory lines; the productId guard
  // narrows the type (excluded lines have a null product).
  const lots = rawLots.filter(
    (l): l is typeof l & { productId: string; product: NonNullable<typeof l.product> } =>
      l.product !== null,
  );

  // D8: product display photo = newest lot of the product with a unit photo.
  const productIds = [...new Set(lots.map((l) => l.productId))];
  const photoLots = await db.lot.findMany({
    where: { productId: { in: productIds }, unitPhotoPath: { not: null } },
    orderBy: { restock: { purchasedAt: 'desc' } },
    select: { productId: true, unitPhotoPath: true },
  });
  const photoByProduct = new Map<string, string>();
  for (const l of photoLots) {
    if (l.productId && !photoByProduct.has(l.productId)) {
      photoByProduct.set(l.productId, l.unitPhotoPath!);
    }
  }

  const groups = new Map<string, ProductGroup>();
  for (const lot of lots) {
    let group = groups.get(lot.productId);
    if (!group) {
      group = {
        productId: lot.productId,
        name: lot.product.name,
        upc: lot.product.upc,
        photoPath: photoByProduct.get(lot.productId) ?? null,
        total: 0,
        lots: [],
      };
      groups.set(lot.productId, group);
    }
    // Availability = physical stock − units held by open orders (PLAN
    // "Orders & requests"). Everything downstream (the "N left" label, the
    // group total, the > 0 filters, the take/order stepper caps) reads this,
    // so reservations propagate everywhere. max(0, …) is defensive; correct
    // accounting keeps reserved ≤ remaining.
    const available = Math.max(0, lot.remainingCount - lot.reservedCount);
    group.total += available;
    group.lots.push({
      id: lot.id,
      restockId: lot.restockId,
      code: restockCode(lot.restock.dateCode!, lot.restock.seq!),
      remaining: available,
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
  // Resume banner only for drafts this user can actually edit and finalize —
  // owner-household receiving with the receiveStock capability (the restock
  // router's gate); otherwise it walks them into a FORBIDDEN wizard.
  const draft =
    isOwn && user.activeMembership.receiveStock
      ? await db.restock.findFirst({
          where: { pantryId: pantry.id, status: 'DRAFT' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, retailer: true },
        })
      : null;

  // Purchaser picker options: the acting household plus its ACTIVE
  // connections (the restock router enforces the same set).
  const connections = await activeConnectionsOf(db, user.householdId);
  const households = await db.household.findMany({
    where: { id: { in: [user.householdId, ...connections.map((c) => c.counterpartyId)] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  // The viewer's in-progress cart (DRAFT order) for this pantry: seeds the
  // add-to-order stepper and drives the cart bar.
  const cart = await db.order.findFirst({
    where: { pantryId: pantry.id, householdId: user.householdId, status: 'DRAFT' },
    include: { lines: { select: { lotId: true, quantity: true } } },
  });
  const cartQtyByLot: Record<string, number> = {};
  for (const l of cart?.lines ?? []) cartQtyByLot[l.lotId] = l.quantity;
  const cartInfo =
    cart && cart.lines.length > 0
      ? {
          orderId: cart.id,
          count: cart.lines.length,
          units: cart.lines.reduce((s, l) => s + l.quantity, 0),
        }
      : null;

  return (
    <InventoryView
      pantry={{ id: pantry.id, name: pantry.name, householdName: pantry.household.name }}
      isOwn={isOwn}
      groups={productGroups}
      draft={draft}
      households={households}
      yourHouseholdId={user.householdId}
      cart={cartInfo}
      cartQtyByLot={cartQtyByLot}
      shared={pantry.shared}
      canManageShared={isOwn && user.activeMembership.manageHousehold}
    />
  );
}
