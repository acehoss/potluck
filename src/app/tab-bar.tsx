'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useTRPC } from '@/lib/trpc';

const TABS = [
  { href: '/', label: 'Pantries', icon: '▣' },
  { href: '/ledger', label: 'Ledger', icon: '◫' },
  { href: '/items', label: 'Items', icon: '⛏' },
  { href: '/more', label: 'More', icon: '☰' },
] as const;

/**
 * Bottom tab bar (blueprint 02). Hidden on auth screens and inside the
 * full-screen receive wizard. All four tabs are live as of slice 6.
 * The Ledger tab carries a "new" dot when the other household posted ledger
 * entries since this user last viewed the ledger (blueprint 01 slice 4 —
 * the v1 counterparty notification; push arrives in slice 7).
 */
export function TabBar() {
  const pathname = usePathname();
  const trpc = useTRPC();
  const hidden =
    pathname.startsWith('/login') ||
    pathname.startsWith('/invite') ||
    pathname.includes('/receive/');

  const hasNew = useQuery(
    trpc.ledger.hasNew.queryOptions(undefined, {
      enabled: !hidden,
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: true,
    }),
  );

  // The tab bar lives in the layout and never remounts on client-side
  // navigation, so re-check explicitly per route change; viewing the ledger
  // additionally invalidates the query (markSeen).
  const { refetch } = hasNew;
  useEffect(() => {
    if (!hidden) void refetch();
  }, [pathname, hidden, refetch]);

  if (hidden) return null;

  return (
    <nav
      data-testid="tab-bar"
      className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map((tab) => {
        const active = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
        const showDot = tab.href === '/ledger' && hasNew.data?.hasNew === true;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
              active ? 'text-accent' : 'text-text-muted'
            }`}
          >
            <span aria-hidden className="relative">
              {tab.icon}
              {showDot && (
                <span
                  data-testid="ledger-new-dot"
                  className="absolute -right-1.5 -top-0.5 size-2 rounded-full bg-accent"
                />
              )}
            </span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
