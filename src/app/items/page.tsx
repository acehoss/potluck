import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
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

  const households = await db.household.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  households.sort((a, b) => (a.id === user.householdId ? -1 : b.id === user.householdId ? 1 : 0));

  const items = await db.item.findMany({
    orderBy: { name: 'asc' },
    include: {
      loans: {
        where: { returnedAt: null },
        include: { borrower: { select: { name: true } } },
      },
    },
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
          photoPath: i.photoPath,
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
