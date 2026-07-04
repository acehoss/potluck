import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { activeConnectionsOf } from '@/server/authz';
import { db } from '@/server/db';
import { InviteMember } from '../invite-member';
import { LogoutButton } from '../logout-button';
import { CirclesCard } from './circles-card';
import { ConnectionsCard } from './connections-card';
import { HouseholdSwitcher } from './household-switcher';
import { InstallCard, NotificationsCard } from './pwa-cards';

/** More tab (blueprint 02): household members, invite link, sign out. */
export default async function MorePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  // The acting household + its ACTIVE connections (REWORK B4 scoping).
  const connections = await activeConnectionsOf(db, user.householdId);
  const households = (
    await db.household.findMany({
      where: { id: { in: [user.householdId, ...connections.map((c) => c.counterpartyId)] } },
      orderBy: { createdAt: 'asc' },
      include: {
        memberships: {
          select: { user: { select: { id: true, name: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    })
  ).map((h) => ({ id: h.id, name: h.name, members: h.memberships.map((m) => m.user) }));
  households.sort((a, b) => (a.id === user.householdId ? -1 : b.id === user.householdId ? 1 : 0));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">More</h1>
          <p className="text-sm text-text-muted">
            {user.name} · {user.household.name}
          </p>
        </div>
        <LogoutButton />
      </header>

      <main className="flex flex-col gap-4">
        {user.memberships.length > 1 && (
          <HouseholdSwitcher
            memberships={user.memberships.map((m) => ({
              householdId: m.householdId,
              householdName: m.household.name,
            }))}
            activeHouseholdId={user.householdId}
          />
        )}
        {households.map((household) => {
          const isYours = household.id === user.householdId;
          return (
            <section
              key={household.id}
              data-testid="household-card"
              className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{household.name}</h2>
                  {isYours && (
                    <p className="text-xs text-text-muted">
                      handle: <span className="font-mono">@{user.household.slug}</span> — share it
                      so other households can connect
                    </p>
                  )}
                </div>
                {isYours && (
                  <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                    your household
                  </span>
                )}
              </div>
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {household.members.map((member) => (
                  <li key={member.id}>{member.name}</li>
                ))}
              </ul>
              {isYours && user.activeMembership.manageHousehold && <InviteMember />}
            </section>
          );
        })}

        <ConnectionsCard />
        <CirclesCard />

        {user.isInstanceAdmin && (
          <Link
            href="/admin"
            data-testid="admin-link"
            className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
          >
            <div>
              <h2 className="text-lg font-semibold">Instance admin</h2>
              <p className="text-sm text-text-muted">
                Usage by household, and who may invite new households.
              </p>
            </div>
            <span className="text-text-muted">→</span>
          </Link>
        )}

        <h2 className="mt-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          This device
        </h2>
        <InstallCard />
        <NotificationsCard />
      </main>
    </div>
  );
}
