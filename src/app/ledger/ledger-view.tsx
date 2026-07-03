'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { newClientKey } from '@/lib/client-key';
import { centsToDollarsString, formatCents, parseDollarsToCents } from '@/lib/money';
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
  /** LOAN_FEE rows (and their reversals) link to the item detail. */
  itemId: string | null;
  take: { id: string; reversed: boolean; canUndo: boolean } | null;
  /** Created since this viewer last saw this pair's ledger, by someone else. */
  isNew: boolean;
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

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50';
const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken';

export function LedgerView({
  other,
  others,
  yourName,
  yourHouseholdId,
  netCents,
  rows,
  renderedAt,
}: {
  other: Household;
  others: Household[];
  yourName: string;
  yourHouseholdId: string;
  netCents: number;
  rows: LedgerRow[];
  /** Server render timestamp (epoch ms) — echoed to markSeen, see below. */
  renderedAt: number;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [chip, setChip] = useState<(typeof CHIPS)[number]['key']>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  // Viewing the ledger IS the acknowledgment (blueprint 01 slice 4): mark
  // this pair seen so the tab dot clears. The rows' "new" highlight came from
  // the previous watermark, so it stays visible for this visit. The write is
  // the page's RENDER timestamp, not now(): an entry created between the
  // render and this mutation was never on screen and must stay flagged.
  const { mutate: markSeen } = useMutation(
    trpc.ledger.markSeen.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.ledger.hasNew.queryKey() }),
    }),
  );
  useEffect(() => {
    markSeen({ counterpartyHouseholdId: other.id, renderedAt });
  }, [markSeen, other.id, renderedAt]);

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
        <div className="relative flex items-center gap-2">
          <p className="text-sm text-text-muted">{yourName}</p>
          {/* Blueprint 02: "⋯ in the ledger header → Manual adjustment". */}
          <button
            type="button"
            data-testid="ledger-menu"
            aria-label="Ledger actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex size-11 items-center justify-center rounded-lg text-lg text-text-muted transition-colors hover:bg-surface-sunken"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-max rounded-lg border border-border bg-surface-raised py-1 shadow-sm">
              <button
                type="button"
                data-testid="open-adjust"
                onClick={() => {
                  setMenuOpen(false);
                  setAdjustOpen(true);
                }}
                className="flex min-h-11 w-full items-center px-4 text-sm font-medium text-text hover:bg-surface-sunken"
              >
                Manual adjustment
              </button>
            </div>
          )}
        </div>
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
        className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface-raised px-6 py-6 text-center shadow-sm sm:flex-row sm:justify-between sm:gap-4 sm:text-left"
      >
        <div>
          {/* Blueprint 03 §3 hero contract: success up, danger down, text at $0. */}
          <p
            className={`text-3xl font-bold tracking-tight ${
              netCents > 0 ? 'text-success' : netCents < 0 ? 'text-danger' : 'text-text'
            }`}
          >
            {heroText(netCents)}
          </p>
          <p className="mt-1 text-sm text-text-muted">with {other.name}</p>
        </div>
        <button
          type="button"
          data-testid="settle-up"
          onClick={() => setSettleOpen(true)}
          className="min-h-11 shrink-0 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
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
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
            <p className="text-sm font-medium text-text">
              {chip === 'all' ? 'All square so far.' : 'Nothing of this kind yet.'}
            </p>
            <p className="text-sm text-text-muted">
              Takes, restock credits, and payments between your households land here.
            </p>
          </div>
        )}
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm empty:hidden">
          {visible.map((row) => {
            const isOpen = expanded === row.id;
            const date = localDateParts(row.createdAt);
            return (
              <li key={row.id} data-testid="ledger-row" data-new={row.isNew || undefined}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : row.id)}
                  className="flex min-h-12 w-full items-center gap-3 py-2.5 text-left"
                >
                  <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                    {date.short}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    {/* Subtle "new since you looked" marker (blueprint 02). */}
                    {row.isNew && (
                      <span
                        data-testid="ledger-row-new"
                        title="New since you last looked"
                        className="mr-1.5 inline-block size-2 rounded-full bg-accent align-middle"
                      />
                    )}
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
                      {row.itemId && (
                        <Link href={`/items/${row.itemId}`} className="font-medium text-accent">
                          View item
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

      {settleOpen && (
        <SettleSheet
          other={other}
          yourHouseholdId={yourHouseholdId}
          netCents={netCents}
          onClose={() => setSettleOpen(false)}
          onDone={() => {
            setSettleOpen(false);
            router.refresh();
          }}
        />
      )}
      {adjustOpen && (
        <AdjustSheet
          other={other}
          yourHouseholdId={yourHouseholdId}
          onClose={() => setAdjustOpen(false)}
          onDone={() => {
            setAdjustOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

const METHODS = ['Cash', 'Venmo', 'Other'] as const;

/**
 * Settle sheet (blueprint 02): amount prefilled to bring the pair to zero,
 * direction prefilled toward zero (payer = whoever owes), method chips plus
 * an optional note. Posts a SETTLEMENT entry with payer = creditor (01 D5);
 * both households' members (except the recorder) see it flagged "new" until
 * they look (blueprint 02).
 */
function SettleSheet({
  other,
  yourHouseholdId,
  netCents,
  onClose,
  onDone,
}: {
  other: Household;
  yourHouseholdId: string;
  netCents: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  // One idempotency key per sheet open: a double-tap on "Record payment"
  // (dispatched before isPending re-renders the disabled attribute) or a
  // retry after a lost response replays as the SAME settlement server-side
  // instead of posting a second immutable entry.
  const [clientKey] = useState(newClientKey);
  const [amount, setAmount] = useState(() =>
    netCents === 0 ? '' : centsToDollarsString(Math.abs(netCents)),
  );
  // Payer = whoever owes: net > 0 means they owe you, so they pay.
  const [payer, setPayer] = useState<'them' | 'us'>(netCents > 0 ? 'them' : 'us');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('Cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const settle = useMutation(
    trpc.ledger.settle.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="settle-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const cents = parseDollarsToCents(amount);
          if (cents === null || cents <= 0) {
            setError('Amount must look like 12.40');
            return;
          }
          settle.mutate({
            payerHouseholdId: payer === 'them' ? other.id : yourHouseholdId,
            payeeHouseholdId: payer === 'them' ? yourHouseholdId : other.id,
            amountCents: cents,
            note: [method, note.trim()].filter(Boolean).join(' — '),
            clientKey,
          });
        }}
      >
        <h2 className="text-lg font-semibold">Settle up</h2>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Amount
          <input
            type="text"
            inputMode="decimal"
            required
            data-testid="settle-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="12.40"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Who paid
          <select
            data-testid="settle-direction"
            value={payer}
            onChange={(e) => setPayer(e.target.value as 'them' | 'us')}
            className={inputClass}
          >
            <option value="them">{other.name} paid us</option>
            <option value="us">We paid {other.name}</option>
          </select>
        </label>
        <div className="flex flex-col gap-1 text-sm font-medium text-text">
          Method
          <div className="flex gap-2" role="radiogroup" aria-label="Method">
            {METHODS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                onClick={() => setMethod(m)}
                className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  method === m
                    ? 'bg-accent text-accent-contrast'
                    : 'border border-border-strong text-text hover:bg-surface-sunken'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Note (optional)
          <input
            type="text"
            data-testid="settle-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="July groceries"
            className={inputClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="settle-submit"
            disabled={settle.isPending}
            className={primaryBtn}
          >
            {settle.isPending ? 'Recording…' : 'Record payment'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Manual ledger adjustment (blueprint 02's repair sheet): amount, direction,
 * REQUIRED note. Posts an ADJUSTMENT entry; the counterparty household sees
 * the in-app "new" marker (push arrives in slice 7). Wrong restock credits
 * are corrected via the linked correct-credit op, not here.
 */
function AdjustSheet({
  other,
  yourHouseholdId,
  onClose,
  onDone,
}: {
  other: Household;
  yourHouseholdId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  // One idempotency key per sheet open — a double-tap must not post the
  // adjustment twice (same guard as the settle sheet).
  const [clientKey] = useState(newClientKey);
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'they-owe' | 'we-owe'>('they-owe');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const adjust = useMutation(
    trpc.ledger.adjust.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="adjust-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const cents = parseDollarsToCents(amount);
          if (cents === null || cents <= 0) {
            setError('Amount must look like 12.40');
            return;
          }
          if (!note.trim()) {
            setError('A note explaining the adjustment is required.');
            return;
          }
          adjust.mutate({
            creditorHouseholdId: direction === 'they-owe' ? yourHouseholdId : other.id,
            debtorHouseholdId: direction === 'they-owe' ? other.id : yourHouseholdId,
            amountCents: cents,
            note: note.trim(),
            clientKey,
          });
        }}
      >
        <h2 className="text-lg font-semibold">Manual adjustment</h2>
        <p className="text-sm text-text-muted">
          For odd repairs only — members of {other.name} will see it flagged as new.
        </p>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Amount
          <input
            type="text"
            inputMode="decimal"
            required
            data-testid="adjust-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="4.50"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Direction
          <select
            data-testid="adjust-direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'they-owe' | 'we-owe')}
            className={inputClass}
          >
            <option value="they-owe">{other.name} owes us</option>
            <option value="we-owe">We owe {other.name}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Note (required)
          <input
            type="text"
            required
            data-testid="adjust-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this adjustment exists"
            className={inputClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="adjust-submit"
            disabled={adjust.isPending}
            className={primaryBtn}
          >
            {adjust.isPending ? 'Posting…' : 'Post adjustment'}
          </button>
        </div>
      </form>
    </div>
  );
}
