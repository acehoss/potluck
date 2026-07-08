import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { AddPantry } from '../add-pantry';
import { InviteMember } from '../invite-member';
import { ReceiveAction } from '../receive-action';

/**
 * Home — the acting household's own surface (Phase-2 P1, the IA flip). Pantries
 * (with the Receive shortcut), and the doors to Items, Recipes, and the shopping
 * list, plus the members/management card that used to live in More. The network
 * (connections, balances, other households' pantries) lives on Neighbors; this
 * tab is deliberately "your household."
 */

const linkCard =
  'flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3 shadow-sm transition-colors hover:bg-surface-sunken';

export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const me = user.householdId;

  const pantries = await db.pantry.findMany({
    where: { householdId: me },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  // Live unit counts: sum of available stock per own pantry.
  const stockCounts = await db.stock.groupBy({
    by: ['pantryId'],
    where: { pantry: { householdId: me }, lot: { restock: { status: 'FINALIZED' } } },
    _sum: { count: true, reservedCount: true },
  });
  const unitsByPantry = new Map<string, number>();
  for (const r of stockCounts) {
    unitsByPantry.set(r.pantryId, (r._sum.count ?? 0) - (r._sum.reservedCount ?? 0));
  }

  const members = (
    await db.membership.findMany({
      where: { householdId: me },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { user: { select: { id: true, name: true } } },
    })
  ).map((m) => m.user);

  const canReceive = user.activeMembership.receiveStock;
  const canManage = user.activeMembership.manageHousehold;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{user.household.name}</h1>
        <p className="text-sm text-text-muted">your household</p>
      </header>

      {/* Pantries */}
      <section data-testid="home-pantries" className="flex flex-col gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Pantries</h2>
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
          {pantries.map((pantry) => {
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
                    {units === 0 ? 'empty — tap to stock' : `${units} units`}
                  </span>
                </Link>
              </li>
            );
          })}
          {pantries.length === 0 && (
            <li className="py-3 text-sm text-text-muted">No pantries yet</li>
          )}
        </ul>
        {canManage && <AddPantry />}
      </section>

      {/* Doors to the household's other surfaces */}
      <section className="flex flex-col gap-2">
        <Link href="/items" data-testid="home-items" className={linkCard}>
          <span className="font-medium text-text">🔧 Items to lend &amp; borrow</span>
          <span className="text-text-muted">→</span>
        </Link>
        <Link href="/recipes" data-testid="home-recipes" className={linkCard}>
          <span className="font-medium text-text">📖 Recipes</span>
          <span className="text-text-muted">→</span>
        </Link>
        <Link href="/shopping" data-testid="home-shopping" className={linkCard}>
          <span className="font-medium text-text">🛒 Shopping list</span>
          <span className="text-text-muted">→</span>
        </Link>
      </section>

      {/* Members + management */}
      <section
        data-testid="home-members"
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-text">People</h2>
          <Link
            href={`/households/${me}`}
            data-testid="people-contact-link"
            className="text-sm font-medium text-accent-strong"
          >
            Contact &amp; cards →
          </Link>
        </div>
        <p className="text-xs text-text-muted">
          handle: <span className="font-mono">@{user.household.slug}</span> — share it so other
          households can connect
        </p>
        <ul className="flex flex-col gap-1 text-sm text-text">
          {members.map((m) => (
            <li key={m.id}>{m.name}</li>
          ))}
        </ul>
        {canManage && <InviteMember />}
      </section>

      {/* Receive FAB — hidden without receiveStock or any pantry (can/hide). */}
      {canReceive && pantries.length > 0 && (
        <ReceiveAction
          pantries={pantries}
          testId="home-receive-fab"
          className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-10 flex min-h-12 items-center rounded-full bg-accent px-5 py-3 font-medium text-accent-contrast shadow-sm transition-colors hover:bg-accent-strong"
        >
          + Receive
        </ReceiveAction>
      )}
    </div>
  );
}
