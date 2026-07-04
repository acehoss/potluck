import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatCents } from '@/lib/money';
import { getSessionUser } from '@/server/auth';
import { activeConnectionsOf } from '@/server/authz';
import { db } from '@/server/db';
import { netByCounterparty } from '@/server/ledger';
import { AddPantry } from './add-pantry';
import { BrandMark } from './brand-mark';

/**
 * Pantries tab: the acting household's pantries plus — for ACTIVE
 * connections that grant us pantry access (REWORK B2/B4, replacing the
 * everyone-sees-everything premise) — their SHARED pantries. Yours first.
 */
export default async function PantriesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const connections = await activeConnectionsOf(db, user.householdId);
  const pantryGranters = new Set(
    connections.filter((c) => c.theyGrant.pantry).map((c) => c.counterpartyId),
  );
  // Net strips also cover SEVERED pairs with a nonzero balance (B6: the net
  // survives forever and settlement still works — the strip is its only
  // navigation entry point).
  const net = await netByCounterparty(user.householdId);
  const severedWithBalance = (
    await db.connection.findMany({
      where: {
        status: 'SEVERED',
        OR: [{ householdAId: user.householdId }, { householdBId: user.householdId }],
      },
      select: { householdAId: true, householdBId: true },
    })
  )
    .map((e) => (e.householdAId === user.householdId ? e.householdBId : e.householdAId))
    .filter((id) => (net.get(id) ?? 0) !== 0);
  // All strip-worthy counterparties are fetched (a balance is pair data,
  // grants or not); pantry GROUPS render only where the pantry grant reaches
  // us.
  const counterpartyIds = [...connections.map((c) => c.counterpartyId), ...severedWithBalance];
  const households = (
    await db.household.findMany({
      where: { id: { in: [user.householdId, ...counterpartyIds] } },
      orderBy: { createdAt: 'asc' },
      include: { pantries: { orderBy: { createdAt: 'asc' } } },
    })
  ).map((h) => ({
    ...h,
    // Others' private pantries are invisible (B3); your own are always shown.
    pantries: h.id === user.householdId ? h.pantries : h.pantries.filter((p) => p.shared),
  }));
  households.sort((a, b) => (a.id === user.householdId ? -1 : b.id === user.householdId ? 1 : 0));

  // Live counts: sum of lot remainders over finalized restocks, per pantry.
  const remainders = await db.lot.groupBy({
    by: ['restockId'],
    where: { restock: { status: 'FINALIZED' } },
    _sum: { remainingCount: true },
  });
  const restocks = await db.restock.findMany({
    where: { id: { in: remainders.map((r) => r.restockId) } },
    select: { id: true, pantryId: true },
  });
  const pantryOf = new Map(restocks.map((r) => [r.id, r.pantryId]));
  const unitsByPantry = new Map<string, number>();
  for (const r of remainders) {
    const pantryId = pantryOf.get(r.restockId)!;
    unitsByPantry.set(pantryId, (unitsByPantry.get(pantryId) ?? 0) + (r._sum.remainingCount ?? 0));
  }

  // The net number is the product (SPEC §2): one strip per counterparty.
  const others = households.filter((h) => h.id !== user.householdId);
  const pantryGroups = households.filter(
    (h) => h.id === user.householdId || pantryGranters.has(h.id),
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6 sm:pb-24 lg:max-w-4xl">
      <header className="flex items-center justify-between gap-4">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <BrandMark className="size-6 text-accent" />
          Private Coop
        </h1>
        <p className="text-sm text-text-muted">{user.name}</p>
      </header>

      <main className="flex flex-col gap-6">
        {others.length > 0 && (
          <div className="flex flex-col gap-2">
            {others.map((h) => {
              const n = net.get(h.id) ?? 0;
              return (
                <Link
                  key={h.id}
                  data-testid="net-strip"
                  href={`/ledger?with=${h.id}`}
                  className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm font-medium shadow-sm"
                >
                  {n > 0 && (
                    <span className="text-success">
                      You&apos;re up {formatCents(n)} with {h.name}
                    </span>
                  )}
                  {n < 0 && (
                    <span className="text-danger">
                      You&apos;re down {formatCents(-n)} with {h.name}
                    </span>
                  )}
                  {n === 0 && (
                    <span className="text-text-muted">You&apos;re even with {h.name}</span>
                  )}
                  <span className="float-right text-text-muted">→</span>
                </Link>
              );
            })}
          </div>
        )}
        {/* Desktop: the centered mobile column is fine (blueprint 02), but the
            two household groups sit side-by-side where that's free. */}
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:items-start">
        {pantryGroups.map((household) => {
          const isYours = household.id === user.householdId;
          return (
            <section key={household.id} data-testid="pantry-group" className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {household.name}
                </h2>
                {isYours && (
                  <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                    your household
                  </span>
                )}
              </div>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
                {household.pantries.map((pantry) => {
                  const units = unitsByPantry.get(pantry.id) ?? 0;
                  return (
                    <li key={pantry.id}>
                      <Link
                        data-testid="pantry-row"
                        href={`/pantries/${pantry.id}`}
                        className="flex min-h-14 items-center justify-between gap-3 py-3"
                      >
                        <p className="truncate text-base text-text">{pantry.name}</p>
                        <span className="shrink-0 font-mono text-sm tabular-nums text-text-muted">
                          {units === 0
                            ? isYours
                              ? 'empty — tap to stock'
                              : 'empty'
                            : `${units} units`}
                        </span>
                      </Link>
                    </li>
                  );
                })}
                {household.pantries.length === 0 && (
                  <li className="py-3 text-sm text-text-muted">No pantries yet</li>
                )}
              </ul>
              {isYours && user.activeMembership.manageHousehold && <AddPantry />}
            </section>
          );
        })}
        </div>
      </main>
    </div>
  );
}
