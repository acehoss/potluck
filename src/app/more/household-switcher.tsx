'use client';

import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

/**
 * Sticky acting-household switcher (REWORK A3b). Rendered only for
 * multi-membership users — everyone else never sees it. Switching does a
 * FULL page load: browsing scope, carts, restocks, and ledger attribution
 * are all acting-household-relative, and the module-singleton query cache
 * must not survive the switch.
 */
export function HouseholdSwitcher({
  memberships,
  activeHouseholdId,
}: {
  memberships: { householdId: string; householdName: string }[];
  activeHouseholdId: string;
}) {
  const trpc = useTRPC();
  const switchTo = useMutation(
    trpc.auth.setActingHousehold.mutationOptions({
      onSuccess: () => {
        window.location.assign('/');
      },
    }),
  );

  return (
    <section
      data-testid="household-switcher"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
    >
      <h2 className="text-lg font-semibold">Acting as</h2>
      <p className="text-sm text-text-muted">
        You belong to more than one household. Everything you browse, order, and record
        happens as the active one.
      </p>
      <ul className="flex flex-col gap-1">
        {memberships.map((m) => {
          const isActive = m.householdId === activeHouseholdId;
          return (
            <li
              key={m.householdId}
              className="flex min-h-14 items-center justify-between gap-2 border-b border-border py-3 last:border-b-0"
            >
              <span className="font-medium">{m.householdName}</span>
              {isActive ? (
                <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                  active
                </span>
              ) : (
                <button
                  type="button"
                  disabled={switchTo.isPending}
                  onClick={() => switchTo.mutate({ householdId: m.householdId })}
                  className="min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
                >
                  Switch
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {switchTo.error && (
        <p role="alert" className="text-sm text-danger">
          {switchTo.error.message}
        </p>
      )}
    </section>
  );
}
