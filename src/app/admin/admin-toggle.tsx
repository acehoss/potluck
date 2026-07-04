'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/** The A1 growth toggle: who may mint new-household invites. */
export function AdminToggle({ allow }: { allow: boolean }) {
  const trpc = useTRPC();
  const router = useRouter();
  // Optimistic local state: the checkbox reflects the click immediately (the
  // server value only lands after router.refresh()); a failure reverts it.
  const [checked, setChecked] = useState(allow);
  const set = useMutation(
    trpc.admin.setAllowMemberHouseholdInvites.mutationOptions({
      onSuccess: () => router.refresh(),
      onError: () => setChecked(allow),
    }),
  );

  return (
    <label className="flex min-h-11 items-center gap-3 text-sm text-text">
      <input
        type="checkbox"
        data-testid="admin-allow-household-invites"
        checked={checked}
        disabled={set.isPending}
        onChange={(e) => {
          setChecked(e.target.checked);
          set.mutate({ allow: e.target.checked });
        }}
        className="size-5 accent-[var(--color-accent)]"
      />
      <span>
        Any member may invite a new household
        <span className="block text-xs font-normal text-text-muted">
          Off = only you can grow the instance. Members always invite people into their OWN
          household either way.
        </span>
      </span>
    </label>
  );
}
