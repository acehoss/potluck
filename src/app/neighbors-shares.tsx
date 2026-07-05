'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTRPC } from '@/lib/trpc';

/**
 * Needs & surpluses preview on the Neighbors home (Phase-2 P2, the Walt rule:
 * shares front-and-center — "helps make the app less about money"). A few live
 * posts from the acting household's board, deep-linking into /shares where the
 * claim/confirm/reshare actions live. Reuses share.feed (same visibility rule
 * as the full board).
 */

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'open',
  CLAIMED: 'claimed',
  FULFILLED: 'fulfilled',
  EXPIRED: 'expired',
};

export function NeighborsShares() {
  const trpc = useTRPC();
  const q = useQuery(trpc.share.feed.queryOptions());
  const posts = (q.data?.posts ?? []).slice(0, 4);

  return (
    <section data-testid="neighbors-shares" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          🫙 Needs &amp; surpluses
        </h2>
        <Link
          href="/shares"
          data-testid="neighbors-shares-all"
          className="text-sm font-medium text-accent-strong"
        >
          See all →
        </Link>
      </div>
      {posts.length === 0 ? (
        <Link
          href="/shares"
          className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm text-text-muted shadow-sm"
        >
          Nothing on the board right now — post a surplus or a need.
        </Link>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
          {posts.map((p) => (
            <li key={p.id}>
              <Link
                href="/shares"
                data-testid="neighbors-share-row"
                className="flex min-h-14 items-center justify-between gap-3 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden>{p.type === 'SURPLUS' ? '🥘' : '🙋'}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text">{p.title}</span>
                    <span className="block truncate text-xs text-text-muted">
                      {p.mine ? 'yours' : p.poster.householdName}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
                  {STATUS_LABEL[p.status] ?? p.status.toLowerCase()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
