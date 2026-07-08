import { notFound, redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { activeConnectionsOf, reachesResource } from '@/server/authz';
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
  // View gate (REWORK P4): your own pantry, or a pantry of another household
  // whose circle for you grants pantry AND that is visible to that circle (ALL,
  // or SELECT scoped to it). Anything else reads as not-found — scoping never
  // leaks existence.
  if (pantry.householdId !== user.householdId) {
    const visible = await reachesResource(
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
    if (!visible) notFound();
  }

  const rawStocks = await db.stock.findMany({
    where: {
      pantryId: pantry.id,
      lot: {
        restock: { status: 'FINALIZED', voidedAt: null },
        excluded: false,
        receivedCount: { gt: 0 },
        productId: { not: null },
        unitCostCents: { not: null },
      },
    },
    include: {
      lot: {
        include: {
          product: { select: { id: true, name: true, upc: true } },
          restock: { select: { dateCode: true, seq: true, purchasedAt: true } },
        },
      },
    },
  });

  // D8: product display photo = newest lot of the product with a unit photo.
  const productIds = [
    ...new Set(
      rawStocks.flatMap((s) => (s.lot.productId && s.lot.product ? [s.lot.productId] : [])),
    ),
  ];
  const [photoLots, productImages] = await Promise.all([
    db.lot.findMany({
      where: { productId: { in: productIds }, unitPhotoPath: { not: null } },
      orderBy: { restock: { purchasedAt: 'desc' } },
      select: { productId: true, unitPhotoPath: true },
    }),
    db.productImage.findMany({
      where: { productId: { in: productIds }, position: 0 },
      select: { productId: true, path: true },
    }),
  ]);
  const mainPhotoByProduct = new Map(productImages.map((image) => [image.productId, image.path]));
  const photoByProduct = new Map<string, string>();
  for (const l of photoLots) {
    if (l.productId && !photoByProduct.has(l.productId)) {
      photoByProduct.set(l.productId, l.unitPhotoPath!);
    }
  }

  const groups = new Map<string, ProductGroup>();
  for (const stock of rawStocks) {
    const lot = stock.lot;
    if (!lot.productId || !lot.product) continue;
    let group = groups.get(lot.productId);
    if (!group) {
      group = {
        productId: lot.productId,
        name: lot.product.name,
        upc: lot.product.upc,
        photoPath: mainPhotoByProduct.get(lot.productId) ?? photoByProduct.get(lot.productId) ?? null,
        total: 0,
        lots: [],
      };
      groups.set(lot.productId, group);
    }
    // Availability = physical stock − units held by open orders (PLAN
    // "Orders & requests"). Everything downstream (the "N left" label, the
    // group total, the > 0 filters, the take/order stepper caps) reads this,
    // so reservations propagate everywhere. max(0, …) is defensive; correct
    // accounting keeps reserved ≤ count.
    const available = Math.max(0, stock.count - stock.reservedCount);
    group.total += available;
    group.lots.push({
      id: lot.id,
      stockId: stock.id,
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
  // SELECT-scope prefill for the owner's visibility control (own pantry only).
  const scopeCircleIds = isOwn
    ? (
        await db.pantryCircle.findMany({
          where: { pantryId: pantry.id },
          select: { circleId: true },
        })
      ).map((r) => r.circleId)
    : [];
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

  // Move-items destinations (Phase 4 S3): the household's OTHER pantries, but
  // only for an owner with adjustInventory. Empty ⇒ the view shows no Move
  // entry points (including the household-with-one-pantry case).
  const movePantries =
    isOwn && user.activeMembership.adjustInventory
      ? await db.pantry.findMany({
          where: { householdId: user.householdId, id: { not: pantry.id } },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        })
      : [];
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
      visibility={pantry.visibility as 'ALL' | 'SELECT' | 'PRIVATE'}
      scopeCircleIds={scopeCircleIds}
      canManageVisibility={isOwn && user.activeMembership.manageHousehold}
      canEditProductPhotos={isOwn && user.activeMembership.receiveStock}
      movePantries={movePantries}
    />
  );
}
