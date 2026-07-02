import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { InviteMember } from '../invite-member';
import { LogoutButton } from '../logout-button';

/** More tab (blueprint 02): household members, invite link, sign out. */
export default async function MorePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const households = await db.household.findMany({
    orderBy: { createdAt: 'asc' },
    include: { members: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } } },
  });
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
        {households.map((household) => {
          const isYours = household.id === user.householdId;
          return (
            <section
              key={household.id}
              data-testid="household-card"
              className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{household.name}</h2>
                {isYours && (
                  <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                    your household
                  </span>
                )}
              </div>
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {household.members.map((member) => (
                  <li key={member.id}>{member.name}</li>
                ))}
              </ul>
              {isYours && <InviteMember />}
            </section>
          );
        })}
      </main>
    </div>
  );
}
