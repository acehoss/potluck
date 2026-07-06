'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTRPC } from '@/lib/trpc';
import type { ActivityItem } from '@/server/routers/activity';
import { HouseholdSwitcher } from './more/household-switcher';
import { ReceiveAction } from './receive-action';

/**
 * Global top toolbar (Phase-2 Round D): acting-household chip (multi-membership
 * only) · Receive quick-action · Activity bell with an actionable-count badge
 * and a preview popover. Lives in the root layout above every screen; hides
 * itself on the auth screens and inside the full-screen receive wizard, exactly
 * like the tab bar. The bell badge is a live client query; the chip/Receive
 * target come from server-resolved props (static per load — switching reloads).
 */

type HeaderData = {
  householdName: string;
  activeHouseholdId: string;
  memberships: { householdId: string; householdName: string }[];
  canReceive: boolean;
  pantries: { id: string; name: string }[];
} | null;

/** Deep-link for a preview row — the item's origin surface. */
export function itemHref(item: ActivityItem): string {
  switch (item.type) {
    case 'draft':
      return `/pantries/${item.pantryId}/receive/${item.restockId}?step=2`;
    case 'order-in':
    case 'order-out':
      return `/orders/${item.orderId}`;
    case 'claim':
      return '/shares';
    case 'connection':
      return '/activity';
  }
}

/** One-line preview label for a bell-popover / attention row. */
export function itemLabel(item: ActivityItem): string {
  switch (item.type) {
    case 'draft':
      return `Receiving at ${item.pantryName}${item.code ? ` · ${item.code}` : ''}`;
    case 'order-in':
      return `${item.counterpartyName} · ${item.lineCount} ${item.lineCount === 1 ? 'item' : 'items'}`;
    case 'order-out':
      return `${item.ownerHouseholdName} · ${item.pantryName}`;
    case 'connection':
      return item.requesterName;
    case 'claim':
      return `${item.claimantName} · ${item.postTitle}`;
  }
}

export const GROUP_LABEL: Record<ActivityItem['type'], string> = {
  draft: 'Receiving',
  'order-in': 'Incoming orders',
  'order-out': 'Your orders',
  connection: 'Connection requests',
  claim: 'Claims on your posts',
};

const iconBtn =
  'flex size-10 items-center justify-center rounded-lg text-xl text-text hover:bg-surface-sunken';

export function AppHeader({ data }: { data: HeaderData }) {
  const pathname = usePathname();
  const trpc = useTRPC();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);

  const hidden =
    !data ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/invite') ||
    pathname.includes('/receive/');

  const activity = useQuery(
    trpc.activity.list.queryOptions(undefined, {
      enabled: !hidden,
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: true,
    }),
  );

  // The header lives in the layout and never remounts on client navigation, so
  // re-check the badge per route change (mirrors the tab bar's ledger dot).
  // Re-check the badge per route change (mirrors the tab bar's ledger dot).
  // Overlays close through their own click-away / link handlers, so nothing to
  // reset here.
  const { refetch } = activity;
  useEffect(() => {
    if (!hidden) void refetch();
  }, [pathname, hidden, refetch]);

  if (hidden || !data) return null;

  const multi = data.memberships.length > 1;
  const count = activity.data?.actionableCount ?? 0;
  const preview = (activity.data?.items ?? []).slice(0, 5);

  return (
    <header
      data-testid="app-header"
      className="sticky top-0 z-20 border-b border-border bg-surface-raised px-3 pt-[env(safe-area-inset-top)]"
    >
      {/* The bar's chrome (border/background) runs edge to edge; its CONTENTS
          align with the pages' mx-auto max-w-2xl column on wide screens. */}
      <div className="mx-auto flex min-h-12 w-full max-w-2xl items-center justify-between gap-2">
      {/* Left: acting-household chip (multi-membership) or the brand mark. */}
      {multi ? (
        <button
          type="button"
          data-testid="header-household-chip"
          onClick={() => setSwitcherOpen(true)}
          className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 font-medium text-text hover:bg-surface-sunken"
        >
          <span aria-hidden>🫙</span>
          <span className="max-w-[9rem] truncate">{data.householdName}</span>
          <span aria-hidden className="text-text-muted">
            ▾
          </span>
        </button>
      ) : (
        <Link
          href="/"
          data-testid="header-brand"
          className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 font-semibold text-text"
        >
          <span aria-hidden>🫙</span>
          <span>Potluck</span>
        </Link>
      )}

      <div className="flex items-center gap-1">
        {data.canReceive && data.pantries.length > 0 && (
          <ReceiveAction pantries={data.pantries} testId="header-receive" className={iconBtn}>
            🧺
          </ReceiveAction>
        )}

        <div className="relative">
          <button
            type="button"
            data-testid="header-bell"
            aria-label={`Activity${count > 0 ? ` — ${count} need your action` : ''}`}
            onClick={() => setBellOpen((v) => !v)}
            className={iconBtn}
          >
            🔔
            {count > 0 && (
              <span
                data-testid="bell-badge"
                className="absolute -right-0.5 -top-0.5 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.625rem] font-semibold leading-none text-accent-contrast"
              >
                {count > 9 ? '9+' : count}
              </span>
            )}
          </button>

          {bellOpen && (
            <>
              {/* Click-away scrim (transparent; the popover floats above it). */}
              <button
                type="button"
                aria-label="Close activity preview"
                onClick={() => setBellOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
              />
              <div
                data-testid="bell-popover"
                className="absolute right-0 top-full z-20 mt-1 flex max-h-[70vh] w-80 max-w-[90vw] flex-col overflow-y-auto rounded-xl border border-border bg-surface-raised p-2 shadow-lg"
              >
                {preview.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-text-muted">All caught up 🎉</p>
                ) : (
                  <ul className="flex flex-col">
                    {preview.map((item) => (
                      <li key={item.id}>
                        <Link
                          href={itemHref(item)}
                          data-testid="bell-item"
                          onClick={() => setBellOpen(false)}
                          className="flex flex-col gap-0.5 rounded-lg px-2 py-2 hover:bg-surface-sunken"
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
                <Link
                  href="/activity"
                  data-testid="bell-see-all"
                  onClick={() => setBellOpen(false)}
                  className="mt-1 min-h-11 rounded-lg border border-border-strong px-3 py-2 text-center text-sm font-medium text-text hover:bg-surface-sunken"
                >
                  See all activity
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
      </div>

      {/* Household switcher sheet (reuses the More card's component). */}
      {switcherOpen && (
        <Sheet onClose={() => setSwitcherOpen(false)} testId="header-switcher-sheet">
          <HouseholdSwitcher
            memberships={data.memberships}
            activeHouseholdId={data.activeHouseholdId}
          />
        </Sheet>
      )}

    </header>
  );
}

/** A simple centered modal sheet over a scrim (tokens only). */
function Sheet({
  children,
  onClose,
  testId,
}: {
  children: React.ReactNode;
  onClose: () => void;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-30 flex items-start justify-center bg-scrim p-4 pt-16"
      onClick={onClose}
    >
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
