import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { LogoutButton } from '../logout-button';
import { CirclesCard } from './circles-card';
import { ConnectionsCard } from './connections-card';
import { HouseholdContactCard } from './household-contact-card';
import { HouseholdSwitcher } from './household-switcher';
import { MemberVisibilityCard } from './member-visibility-card';
import { ProfileCard } from './profile-card';
import { InstallCard, NotificationsCard } from './pwa-cards';

/**
 * More — a curated menu (Phase-2 P1), not a sitemap: your profile, your
 * household's contact/pickup card and card-visibility, connections + circles,
 * instance admin, and device settings. The per-household member lists and the
 * pantry/order/ledger destinations moved to Neighbors / Home / Plan in the IA
 * flip.
 */
export default async function MorePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  // The acting membership's own card visibility + the circles it's scoped to
  // when SELECT (REWORK P5) — feeds the self-serve MemberVisibilityCard.
  const myVisibilityCircleIds = (
    await db.membershipCircle.findMany({
      where: { membershipId: user.activeMembership.id },
      select: { circleId: true },
    })
  ).map((r) => r.circleId);

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

        <ProfileCard />

        <HouseholdContactCard
          householdName={user.household.name}
          address={user.household.address}
          pickupNotes={user.household.pickupNotes}
          canManage={user.activeMembership.manageHousehold}
        />
        <MemberVisibilityCard
          membershipId={user.activeMembership.id}
          visibility={user.activeMembership.visibility as 'ALL' | 'SELECT' | 'PRIVATE'}
          circleIds={myVisibilityCircleIds}
        />

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
