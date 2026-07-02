'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Pantries', icon: '▣', enabled: true },
  { href: '/ledger', label: 'Ledger', icon: '◫', enabled: true },
  { href: '/items', label: 'Items', icon: '⛏', enabled: false, slice: 6 },
  { href: '/more', label: 'More', icon: '☰', enabled: true },
] as const;

/**
 * Bottom tab bar (blueprint 02). Hidden on auth screens and inside the
 * full-screen receive wizard. Ledger/Items are greyed until their slice.
 */
export function TabBar() {
  const pathname = usePathname();
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/invite') ||
    pathname.includes('/receive/')
  ) {
    return null;
  }

  return (
    <nav
      data-testid="tab-bar"
      className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map((tab) => {
        const active = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
        if (!tab.enabled) {
          return (
            <span
              key={tab.href}
              title={`arrives in slice ${'slice' in tab ? tab.slice : ''}`}
              aria-disabled="true"
              className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-text-muted opacity-40"
            >
              <span aria-hidden>{tab.icon}</span>
              {tab.label}
            </span>
          );
        }
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
              active ? 'text-accent' : 'text-text-muted'
            }`}
          >
            <span aria-hidden>{tab.icon}</span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
