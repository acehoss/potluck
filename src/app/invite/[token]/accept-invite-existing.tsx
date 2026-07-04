'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';

/**
 * A signed-in user accepting an invite (REWORK A3 multi-membership): member
 * invites add a membership; household invites found a new household. The
 * server switches the acting household to the new one, so land with a full
 * reload — everything on screen is acting-household-relative.
 */
export function AcceptInviteExisting({
  token,
  userName,
  kind,
  inviterName,
}: {
  token: string;
  userName: string;
  kind: 'member' | 'household';
  inviterName: string;
}) {
  const trpc = useTRPC();
  useRouter(); // keep the router mounted for the pre-nav render
  const [householdName, setHouseholdName] = useState('');

  const accept = useMutation(
    trpc.auth.acceptInviteExisting.mutationOptions({
      onSuccess: () => {
        window.location.assign('/');
      },
    }),
  );

  return (
    <form
      className="flex w-full flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        accept.mutate({ token, householdName: householdName || undefined });
      }}
    >
      <p className="text-sm text-text-muted">
        You&apos;re signed in as <span className="font-medium text-text">{userName}</span>.
        {kind === 'member'
          ? ' Accepting adds this household to your account — switch between your households any time from More.'
          : ` Accepting starts a new household on this server, connected to ${inviterName}.`}
      </p>
      {kind === 'household' && (
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Your household&apos;s name
          <input
            type="text"
            name="householdName"
            required
            data-testid="invite-household-name"
            value={householdName}
            onChange={(e) => setHouseholdName(e.target.value)}
            className={inputClass}
          />
        </label>
      )}
      {accept.error && (
        <p role="alert" className="text-sm text-danger">
          {accept.error.message}
        </p>
      )}
      <button
        type="submit"
        data-testid="invite-accept-existing"
        disabled={accept.isPending}
        className="min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70"
      >
        {accept.isPending
          ? 'Joining…'
          : kind === 'member'
            ? 'Join this household'
            : 'Start my household'}
      </button>
    </form>
  );
}
