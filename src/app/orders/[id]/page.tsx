import { notFound, redirect } from 'next/navigation';
import { restockCode } from '@/lib/domain';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { OrderDetail } from './order-detail';

/**
 * Order detail — the shared hub for both households. The requester builds/edits
 * a cart and requests it; the pantry owner picks and readies it; either marks
 * it picked up. Which actions render is driven by (status × role) inside the
 * client component. Authz: only the two involved households can see it.
 */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const order = await db.order.findUnique({
    where: { id },
    include: {
      pantry: {
        select: {
          id: true,
          name: true,
          householdId: true,
          household: { select: { name: true, address: true, pickupNotes: true } },
        },
      },
      household: { select: { name: true } },
      lines: {
        include: {
          lot: {
            select: {
              id: true,
              remainingCount: true,
              reservedCount: true,
              unitCostCents: true,
              product: { select: { name: true } },
              restock: { select: { dateCode: true, seq: true } },
            },
          },
        },
      },
    },
  });
  if (!order) notFound();

  const isRequester = order.householdId === user.householdId;
  const isOwner = order.pantry.householdId === user.householdId;
  if (!isRequester && !isOwner) notFound();

  const cross = order.householdId !== order.pantry.householdId;
  const lines = order.lines
    .filter((l) => l.lot.product) // orderable lots always carry a product
    .map((l) => {
      const available = l.lot.remainingCount - l.lot.reservedCount;
      return {
        id: l.id,
        lotId: l.lotId,
        productName: l.lot.product!.name,
        code: restockCode(l.lot.restock.dateCode!, l.lot.restock.seq!),
        quantity: l.quantity,
        unitCostCents: l.lot.unitCostCents ?? 0,
        // Ceiling when editing: others' availability, plus (on a REQUESTED order)
        // this line's own already-held units.
        maxQty: Math.max(0, available) + (order.status === 'REQUESTED' ? l.quantity : 0),
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName));
  const totalCents = cross ? lines.reduce((s, l) => s + l.quantity * l.unitCostCents, 0) : 0;

  return (
    <OrderDetail
      order={{
        id: order.id,
        status: order.status,
        pantryId: order.pantry.id,
        pantryName: order.pantry.name,
        ownerHouseholdName: order.pantry.household.name,
        // Seller pickup logistics (REWORK P5): shown to the BUYER on a READY
        // cross-household order. Household-level info the connected buyer may see.
        ownerAddress: cross ? order.pantry.household.address : null,
        ownerPickupNotes: cross ? order.pantry.household.pickupNotes : null,
        requesterHouseholdName: order.household.name,
        requestedAt: order.requestedAt?.toISOString() ?? null,
        readyAt: order.readyAt?.toISOString() ?? null,
        pickedUpAt: order.pickedUpAt?.toISOString() ?? null,
      }}
      lines={lines}
      totalCents={totalCents}
      cross={cross}
      role={{ isRequester, isOwner }}
    />
  );
}
