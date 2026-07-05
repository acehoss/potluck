'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTRPC } from '@/lib/trpc';
import { GROUP_LABEL, itemHref, itemLabel } from './app-header';

/**
 * The Neighbors home attention strip (Phase-2 P2): the SAME activity.list the
 * bell reads, rendered as dense deep-link rows at the top of the home page so
 * work surfaces first-scroll. Deep-links ONLY — actions live on /activity and
 * the origin surfaces (the duplication rule: a preview differs in density, never
 * in available actions). Always rendered (stable surface); collapses to a calm
 * line when nothing needs attention.
 */
export function NeighborsAttention() {
  const trpc = useTRPC();
  const q = useQuery(
    trpc.activity.list.queryOptions(undefined, { staleTime: 0, refetchOnWindowFocus: true }),
  );
  const items = (q.data?.items ?? []).slice(0, 6);
  const count = q.data?.actionableCount ?? 0;

  return (
    <section data-testid="neighbors-attention" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          Needs your attention{count > 0 ? ` · ${count}` : ''}
        </h2>
        <Link href="/activity" className="text-sm font-medium text-accent-strong">
          All activity →
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm text-text-muted shadow-sm">
          You&apos;re all caught up.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={itemHref(item)}
                data-testid="neighbors-attention-item"
                className="flex min-h-14 flex-col justify-center gap-0.5 py-2.5"
              >
                <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-text-muted">
                  {GROUP_LABEL[item.type]}
                </span>
                <span className="truncate text-sm text-text">{itemLabel(item)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
