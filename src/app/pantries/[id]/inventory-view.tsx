'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { parseDollarsToCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';

export type ProductGroup = {
  productId: string;
  name: string;
  photoPath: string | null;
  total: number;
  lots: {
    id: string;
    code: string;
    remaining: number;
    purchasedAt: string; // ISO
    bestBy: string | null; // ISO
  }[];
};

type Household = { id: string; name: string };

function ageLabel(purchasedAt: string) {
  const days = Math.floor((Date.now() - new Date(purchasedAt).getTime()) / 86_400_000);
  if (days < 31) return `${days}d old`;
  return `${Math.floor(days / 30)}mo old`;
}

function bestByBadge(bestBy: string | null) {
  if (!bestBy) return null;
  const date = new Date(bestBy);
  const label = `BB ${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(
    date.getUTCFullYear() % 100,
  ).padStart(2, '0')}`;
  const days = (date.getTime() - Date.now()) / 86_400_000;
  if (days < 0) {
    return <span className="font-medium text-danger">{label} · expired</span>;
  }
  if (days <= 30) return <span className="font-medium text-warn">{label}</span>;
  return <span>{label}</span>;
}

export function InventoryView({
  pantry,
  isOwn,
  groups,
  draft,
  households,
  yourHouseholdId,
}: {
  pantry: { id: string; name: string; householdName: string };
  isOwn: boolean;
  groups: ProductGroup[];
  draft: { id: string; retailer: string } | null;
  households: Household[];
  yourHouseholdId: string;
}) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [startOpen, setStartOpen] = useState(false);

  const visible = groups.filter((g) => g.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center gap-3">
        <Link href="/" aria-label="Back to pantries" className="text-lg text-text-muted">
          ←
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {pantry.name} <span className="font-normal text-text-muted">({pantry.householdName})</span>
        </h1>
      </header>

      {draft && (
        <Link
          data-testid="resume-draft"
          href={`/pantries/${pantry.id}/receive/${draft.id}?step=2`}
          className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm font-medium text-warn"
        >
          Draft restock in progress ({draft.retailer}) — tap to resume
        </Link>
      )}

      {groups.length > 0 && (
        <input
          type="search"
          placeholder="search products…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      )}

      <main className="flex flex-col gap-3">
        {groups.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
            <p className="text-sm font-medium text-text">Nothing here yet.</p>
            {isOwn ? (
              <button
                type="button"
                onClick={() => setStartOpen(true)}
                className="min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
              >
                Receive a restock
              </button>
            ) : (
              <p className="text-sm text-text-muted">
                The {pantry.householdName} haven&apos;t stocked this pantry yet.
              </p>
            )}
          </div>
        )}

        {visible.map((group) => {
          const isExpanded = expanded.has(group.productId);
          return (
            <section
              key={group.productId}
              data-testid="product-row"
              className="rounded-xl border border-border bg-surface-raised shadow-sm"
            >
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.productId)) next.delete(group.productId);
                    else next.add(group.productId);
                    return next;
                  })
                }
                className="flex min-h-14 w-full items-center gap-3 p-3 text-left"
              >
                {group.photoPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/images/${group.photoPath}`}
                    alt=""
                    className="size-10 shrink-0 rounded-lg border border-border object-cover"
                  />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-muted">
                    🖼
                  </span>
                )}
                <p className="min-w-0 flex-1 truncate text-base text-text">{group.name}</p>
                <span className="shrink-0 font-mono text-sm tabular-nums text-text-muted">
                  {group.total}
                </span>
                <span className="shrink-0 text-xs text-text-muted">{isExpanded ? '▾' : '▸'}</span>
              </button>
              {isExpanded && (
                <ul className="divide-y divide-border border-t border-border px-3">
                  {group.lots.map((lot) => (
                    <li
                      key={lot.id}
                      data-testid="lot-row"
                      className="flex min-h-11 items-center justify-between gap-3 py-2"
                    >
                      <p className="text-sm text-text">
                        <span className="font-mono">{lot.code}</span> · {lot.remaining} left
                      </p>
                      <p className="text-sm text-text-muted">
                        {ageLabel(lot.purchasedAt)}
                        {lot.bestBy && <> · {bestByBadge(lot.bestBy)}</>}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </main>

      {isOwn && (
        <button
          type="button"
          data-testid="receive-fab"
          onClick={() => setStartOpen(true)}
          className="fixed bottom-20 right-4 z-10 min-h-12 rounded-full bg-accent px-5 py-3 font-medium text-accent-contrast shadow-sm transition-colors hover:bg-accent-strong"
        >
          + Receive
        </button>
      )}

      {startOpen && (
        <StartRestockSheet
          pantryId={pantry.id}
          households={households}
          yourHouseholdId={yourHouseholdId}
          onClose={() => setStartOpen(false)}
        />
      )}
    </div>
  );
}

/** Wizard step 1 (blueprint 02): a sheet over the pantry; creates the draft. */
function StartRestockSheet({
  pantryId,
  households,
  yourHouseholdId,
  onClose,
}: {
  pantryId: string;
  households: Household[];
  yourHouseholdId: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [retailer, setRetailer] = useState('');
  // Local calendar date, not toISOString() (the UTC date): an 8pm CDT session
  // must default to today, not tomorrow — the date drives the permanent
  // restock code (blueprint 01 D6, coop-local TZ).
  const [purchasedAt, setPurchasedAt] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
  });
  const [purchaserHouseholdId, setPurchaserHouseholdId] = useState(yourHouseholdId);
  const [receiptTotal, setReceiptTotal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(
    trpc.restock.create.mutationOptions({
      onSuccess: ({ id }) => router.push(`/pantries/${pantryId}/receive/${id}?step=2`),
      onError: (e) => setError(e.message),
    }),
  );

  const inputClass =
    'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-text/40 sm:items-center">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl">
        <h2 className="text-lg font-semibold">New restock</h2>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const cents = receiptTotal.trim() ? parseDollarsToCents(receiptTotal) : null;
            if (receiptTotal.trim() && cents === null) {
              setError('Receipt total must look like 86.02');
              return;
            }
            create.mutate({
              pantryId,
              retailer,
              purchasedAt,
              purchaserHouseholdId,
              receiptTotalCents: cents,
            });
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Retailer
            <input
              type="text"
              required
              value={retailer}
              onChange={(e) => setRetailer(e.target.value)}
              placeholder="Costco"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Receipt date
            <input
              type="date"
              required
              value={purchasedAt}
              onChange={(e) => setPurchasedAt(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Purchaser household
            <select
              value={purchaserHouseholdId}
              onChange={(e) => setPurchaserHouseholdId(e.target.value)}
              className={inputClass}
            >
              {households.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.id === yourHouseholdId ? ' (yours)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Receipt total (optional)
            <input
              type="text"
              inputMode="decimal"
              value={receiptTotal}
              onChange={(e) => setReceiptTotal(e.target.value)}
              placeholder="86.02"
              className={inputClass}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
            >
              {create.isPending ? 'Starting…' : 'Start'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
