'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * Bottom tab bar (Phase-2 P1, the IA flip): Neighbors (home) · Plan · Home ·
 * More. "Neighbors" leads with the network — attention items and per-household
 * sections; "Home" is the acting household's own surface (pantries, items,
 * recipes, members); "Plan" is the calendar + shopping + outgoing orders + my
 * posts; "More" is a curated menu. The retired Ledger/Orders tabs keep their
 * routes (/ledger, /orders) — deep links survive; they're just re-parented onto
 * Neighbors/Plan. Hidden on auth screens and inside the full-screen receive
 * wizard.
 *
 * The counterparty-ledger nudge (a settlement/adjustment/credit the OTHER
 * household posted since you last viewed the ledger) rides the NEIGHBORS tab now
 * that Ledger has no tab of its own — the bell/Activity deliberately doesn't
 * cover money events, so this stays their only signal. Same ledger.hasNew query
 * + markSeen clearing as before; only the host tab moved.
 */

const TABS = [
  { href: '/', label: 'Neighbors', icon: '🤝' },
  { href: '/plan', label: 'Plan', icon: '🗓️' },
  { href: '/home', label: 'Home', icon: '🏠' },
  { href: '/more', label: 'More', icon: '☰' },
] as const;

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
  // navigation, so re-check per route change; viewing the ledger invalidates
  // the query (markSeen).
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
        const showDot = tab.href === '/' && hasNew.data?.hasNew === true;
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
