'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

export function InviteMember() {
  const trpc = useTRPC();
  const [invitedName, setInvitedName] = useState('');
  const [copied, setCopied] = useState(false);

  const create = useMutation(trpc.invite.create.mutationOptions());
  const inviteUrl = create.data ? `${window.location.origin}${create.data.path}` : null;

  return (
    <div className="mt-4 border-t border-border pt-3">
      {!inviteUrl ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ invitedName: invitedName || undefined });
          }}
        >
          <input
            type="text"
            name="invitedName"
            placeholder="Name (optional)"
            value={invitedName}
            onChange={(e) => setInvitedName(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Invite a member'}
          </button>
          {create.error && (
            <p role="alert" className="w-full text-sm text-danger">
              {create.error.message}
            </p>
          )}
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text-muted">
            Share this link — it works once and expires in 7 days:
          </p>
          <div className="flex items-center gap-2">
            <code
              data-testid="invite-url"
              className="min-w-0 flex-1 truncate rounded-lg bg-surface-sunken px-3 py-1.5 text-xs"
            >
              {inviteUrl}
            </code>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(inviteUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="shrink-0 rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-sunken"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
