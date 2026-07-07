import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { activeConnectionsOf, visibleUnderCircle } from '@/server/authz';
import { db } from '@/server/db';
import { ItemsView, type ItemGroup } from './items-view';

/**
 * Items tab (blueprint 02 lending): every household's durable items —
 * transparency principle — grouped by household, yours first. Server
 * component reading Prisma directly (slice-1 convention); mutations go
 * through tRPC in the client view.
 */
export default async function ItemsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  // Scope (REWORK P4): the acting household's items plus — where an ACTIVE
  // connection places us in a circle that grants lending — the counterparty's
  // items VISIBLE to that circle (ALL, or SELECT scoped to it; never PRIVATE).
  const connections = await activeConnectionsOf(db, user.householdId);
  const lendingConns = connections.filter((c) => c.theyGrant.lending);
  const lendingGranters = lendingConns.map((c) => c.counterpartyId);
  // The circle each granter placed US into — the yardstick for their SELECT items.
  const circleByGranter = new Map(lendingConns.map((c) => [c.counterpartyId, c.theirCircleId]));
  const households = await db.household.findMany({
    where: { id: { in: [user.householdId, ...lendingGranters] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  households.sort((a, b) => (a.id === user.householdId ? -1 : b.id === user.householdId ? 1 : 0));

  // Which of the granters' SELECT items are scoped to the circle we sit in.
  const granterCircleIds = [...circleByGranter.values()].filter((id): id is string => id !== null);
  const scopedItemKeys = new Set(
    granterCircleIds.length
      ? (
          await db.itemCircle.findMany({
            where: { circleId: { in: granterCircleIds } },
            select: { itemId: true, circleId: true },
          })
        ).map((r) => `${r.itemId}:${r.circleId}`)
      : [],
  );

  const allItems = await db.item.findMany({
    where: { householdId: { in: [user.householdId, ...lendingGranters] } },
    orderBy: { name: 'asc' },
    include: {
      images: { orderBy: { position: 'asc' } },
      loans: {
        where: { returnedAt: null },
        include: { borrower: { select: { name: true } } },
      },
    },
  });
  const items = allItems.filter((i) => {
    if (i.householdId === user.householdId) return true;
    const circleId = circleByGranter.get(i.householdId);
    if (!circleId) return false;
    return visibleUnderCircle(i.visibility, scopedItemKeys.has(`${i.id}:${circleId}`));
  });

  // Borrower household = the checkout-time snapshot on the loan (REWORK A3),
  // resolved to a name via the household list already in hand.
  const householdNames = new Map(households.map((h) => [h.id, h.name]));

  const groups: ItemGroup[] = households.map((h) => ({
    householdId: h.id,
    householdName: h.name,
    isYours: h.id === user.householdId,
    items: items
      .filter((i) => i.householdId === h.id)
      .map((i) => {
        const loan = i.loans[0] ?? null; // ≤1 active loan per item (partial unique index)
        return {
          id: i.id,
          name: i.name,
          // Ordered by position asc in the query — index 0 is the main photo.
          images: i.images.map((image) => ({ path: image.path })),
          feeCents: i.feeCents,
          activeLoan: loan
            ? {
                borrowerName: loan.borrower.name,
                borrowerHouseholdName: householdNames.get(loan.borrowerHouseholdId) ?? 'Unknown',
                borrowerIsYourHousehold: loan.borrowerHouseholdId === user.householdId,
                outAt: loan.outAt.toISOString(),
                dueAt: loan.dueAt?.toISOString() ?? null,
              }
            : null,
        };
      }),
  }));

  return <ItemsView groups={groups} yourHouseholdId={user.householdId} yourName={user.name} />;
}
