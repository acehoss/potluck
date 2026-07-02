import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { InviteMember } from './invite-member';
import { LogoutButton } from './logout-button';

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const households = await db.household.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      members: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } },
      pantries: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } },
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Private Coop</h1>
          <p className="text-sm text-stone-500">
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
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{household.name}</h2>
                {isYours && (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
                    your household
                  </span>
                )}
              </div>

              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-stone-400">
                    Members
                  </h3>
                  <ul className="mt-1.5 flex flex-col gap-1 text-sm">
                    {household.members.map((member) => (
                      <li key={member.id}>{member.name}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-stone-400">
                    Pantries
                  </h3>
                  <ul className="mt-1.5 flex flex-col gap-1 text-sm">
                    {household.pantries.map((pantry) => (
                      <li key={pantry.id} className="flex items-baseline justify-between gap-2">
                        <span>{pantry.name}</span>
                        <span className="text-xs text-stone-400">
                          empty — stocking arrives in slice 2
                        </span>
                      </li>
                    ))}
                    {household.pantries.length === 0 && (
                      <li className="text-stone-400">No pantries yet</li>
                    )}
                  </ul>
                </div>
              </div>

              {!isYours && (
                <p className="mt-4 border-t border-stone-100 pt-3 text-sm text-stone-400">
                  Net position: — <span className="text-xs">(ledger arrives in slice 3)</span>
                </p>
              )}
              {isYours && <InviteMember />}
            </section>
          );
        })}
      </main>
    </div>
  );
}
