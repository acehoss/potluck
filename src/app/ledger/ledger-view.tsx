'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';

export type LedgerRow = {
  id: string;
  createdAt: string; // ISO
  amountCents: number; // signed from the viewer's side; positive = owed to you
  label: string;
  filterGroup: 'take' | 'credit' | 'payment' | 'other';
  note: string | null;
  createdByName: string;
  restockId: string | null;
  take: { id: string; reversed: boolean; canUndo: boolean } | null;
};

type Household = { id: string; name: string };

const CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'take', label: 'Takes' },
  { key: 'credit', label: 'Credits' },
  { key: 'payment', label: 'Payments' },
] as const;

function heroText(netCents: number) {
  if (netCents > 0) return `You're up ${formatCents(netCents)}`;
  if (netCents < 0) return `You're down ${formatCents(-netCents)}`;
  return "You're even";
}

function signedCents(cents: number) {
  return `${cents > 0 ? '+' : ''}${formatCents(cents)}`.replace('-', '−');
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Local calendar dates, not toISOString()'s UTC ones: an entry created at
 * 8pm CDT on 07/02 must read "07/02", not "07/03" (blueprint 02's ledger
 * sketch shows the date the household experienced).
 */
function localDateParts(iso: string) {
  const d = new Date(iso);
  const short = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  const full = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { short, full };
}

export function LedgerView({
  other,
  others,
  yourName,
  netCents,
  rows,
}: {
  other: Household;
  others: Household[];
  yourName: string;
  netCents: number;
  rows: LedgerRow[];
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [chip, setChip] = useState<(typeof CHIPS)[number]['key']>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const undo = useMutation(
    trpc.take.undo.mutationOptions({
      onSuccess: () => {
        setError(null);
        router.refresh();
      },
      onError: (e) => setError(e.message),
    }),
  );

  const visible = chip === 'all' ? rows : rows.filter((r) => r.filterGroup === chip);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Ledger</h1>
        <p className="text-sm text-text-muted">{yourName}</p>
      </header>

      {/* Pair picker only when there are >2 households (blueprint 02). */}
      {others.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {others.map((h) => (
            <Link
              key={h.id}
              href={`/ledger?with=${h.id}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                h.id === other.id
                  ? 'bg-accent text-accent-contrast'
                  : 'border border-border-strong text-text'
              }`}
            >
              {h.name}
            </Link>
          ))}
        </div>
      )}

      <section
        data-testid="net-hero"
        className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface-raised px-6 py-6 text-center shadow-sm"
      >
        {/* Blueprint 03 §3 hero contract: success up, danger down, text at $0. */}
        <p
          className={`text-3xl font-bold tracking-tight ${
            netCents > 0 ? 'text-success' : netCents < 0 ? 'text-danger' : 'text-text'
          }`}
        >
          {heroText(netCents)}
        </p>
        <p className="text-sm text-text-muted">with {other.name}</p>
        <button
          type="button"
          disabled
          title="arrives in slice 4"
          className="min-h-11 rounded-lg border border-border bg-surface-sunken px-4 py-2.5 font-medium text-text-muted"
        >
          Settle up
        </button>
      </section>

      <div className="flex gap-2" role="tablist" aria-label="Entry type">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={chip === c.key}
            onClick={() => setChip(c.key)}
            className={`min-h-9 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              chip === c.key
                ? 'bg-accent text-accent-contrast'
                : 'border border-border-strong text-text hover:bg-surface-sunken'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <main className="flex flex-col">
        {visible.length === 0 && (
          <p className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center text-sm text-text-muted">
            No entries yet. Takes, credits, and payments land here.
          </p>
        )}
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm empty:hidden">
          {visible.map((row) => {
            const isOpen = expanded === row.id;
            const date = localDateParts(row.createdAt);
            return (
              <li key={row.id} data-testid="ledger-row">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : row.id)}
                  className="flex min-h-12 w-full items-center gap-3 py-2.5 text-left"
                >
                  <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                    {date.short}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    {row.label}
                    {row.take?.reversed && (
                      <span className="ml-2 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
                        undone
                      </span>
                    )}
                  </span>
                  <span
                    className={`shrink-0 font-mono text-sm tabular-nums ${
                      row.amountCents > 0
                        ? 'text-success'
                        : row.amountCents < 0
                          ? 'text-danger'
                          : 'text-text'
                    }`}
                  >
                    {signedCents(row.amountCents)}
                  </span>
                </button>
                {isOpen && (
                  <div className="flex flex-col gap-2 pb-3 pl-11 text-sm text-text-muted">
                    <p>
                      {date.full} · by {row.createdByName}
                      {row.note && <> · {row.note}</>}
                    </p>
                    <div className="flex gap-3">
                      {row.restockId && (
                        <Link
                          href={`/restocks/${row.restockId}`}
                          className="font-medium text-accent"
                        >
                          View restock
                        </Link>
                      )}
                      {row.take?.canUndo && (
                        <button
                          type="button"
                          data-testid="ledger-undo"
                          disabled={undo.isPending}
                          onClick={() => undo.mutate({ takeId: row.take!.id })}
                          className="font-medium text-danger disabled:opacity-50"
                        >
                          {undo.isPending ? 'Undoing…' : 'Undo take'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
