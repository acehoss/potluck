'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { BackLink } from '@/app/nav-history';
import { newClientKey } from '@/lib/client-key';
import { useTRPC } from '@/lib/trpc';
import { reconcileMath, type ReconcileMathLine } from '@/server/reconcile-math';

/**
 * Reconcile session UI (Phase 4 S5/S6, focus-group A1–A8). One route, two
 * modes: the COUNT WALK (per-pantry, one-handed, blind by default, every entry
 * autosaved via reconcile.count) and REVIEW, which runs the REAL commit math:
 * reconcileMath is pure TypeScript with zero server-only imports, so the
 * client imports it directly and previews exactly what commit will compute —
 * on the same live stock values the get payload carries (liveCount /
 * liveReserved). If stock still drifts between review and commit (a reserved
 * pickup rides through the freeze mid-review), commit answers
 * PRECONDITION_FAILED 'Counts changed — review again.' and we refetch+rebuild.
 */

type OpenOrderLine = {
  orderLineId: string;
  orderId: string;
  quantity: number;
  requesterHouseholdName: string;
};

type RLine = {
  lineId: string;
  stockId: string;
  pantryId: string;
  lotId: string;
  productId: string | null;
  productName: string;
  lotCode: string | null;
  bestBy: string | null;
  expectedCount: number;
  expectedReserved: number;
  liveCount: number;
  liveReserved: number;
  openOrderLines: OpenOrderLine[];
  countedCount: number | null;
  countedByName: string | null;
  unitPhotoPath: string | null;
};

type RPantry = {
  pantryId: string;
  name: string;
  claimedById: string | null;
  claimedByName: string | null;
  lineStats: { total: number; counted: number };
};

function ago(iso: string) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function bestByLabel(bestBy: string | null) {
  if (!bestBy) return null;
  const d = new Date(bestBy);
  return `BB ${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}

const btnPrimary =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50';
const btnSecondary =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken';
const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';

export function ReconcileView({
  sessionId,
  currentUserId,
  canAdjust,
}: {
  sessionId: string;
  currentUserId: string;
  canAdjust: boolean;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const query = useQuery(trpc.reconcile.get.queryOptions({ sessionId }));

  const [mode, setMode] = useState<'walk' | 'review'>('walk');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Optimistic count overlay so an entry settles instantly (autosave fires in
  // the background). Never cleared on refetch — server and overlay agree once
  // the mutation lands.
  const [localCounts, setLocalCounts] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const data = query.data as
    | { status: string; blind: boolean; note: string | null; createdByName: string; createdAt: string; pantries: RPantry[]; lines: RLine[] }
    | undefined;

  const effectiveCount = (line: RLine): number | null =>
    line.lineId in localCounts ? localCounts[line.lineId] : line.countedCount;

  const count = useMutation(
    trpc.reconcile.count.mutationOptions({
      onError: (e) => setNotice(e.message),
    }),
  );
  const claim = useMutation(
    trpc.reconcile.claimPantry.mutationOptions({
      onSuccess: () => query.refetch(),
      onError: (e) => setNotice(e.message),
    }),
  );
  const addLine = useMutation(
    trpc.reconcile.addLine.mutationOptions({
      onSuccess: () => query.refetch(),
      onError: (e) => setNotice(e.message),
    }),
  );
  const removeLine = useMutation(
    trpc.reconcile.removeLine.mutationOptions({
      onSuccess: () => query.refetch(),
      onError: (e) => setNotice(e.message),
    }),
  );
  const abandon = useMutation(
    trpc.reconcile.abandon.mutationOptions({
      onSuccess: () => router.push('/home'),
      onError: (e) => setNotice(e.message),
    }),
  );

  if (query.isPending) {
    return <p className="p-6 text-center text-sm text-text-muted">Loading count…</p>;
  }
  if (query.isError || !data) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
        <header className="flex items-center gap-3">
          <BackLink fallback="/home" />
          <h1 className="text-xl font-semibold">Count</h1>
        </header>
        <p role="alert" className="text-sm text-text-muted">
          This count isn&apos;t available — it may have been committed or abandoned.
        </p>
      </div>
    );
  }

  const lines = data.lines;
  const pantryName = new Map(data.pantries.map((p) => [p.pantryId, p.name]));
  const totalCounted = lines.filter((l) => effectiveCount(l) !== null).length;
  const allCounted = lines.length > 0 && totalCounted === lines.length;
  const remaining = lines.length - totalCounted;

  const linesInPantry = (pantryId: string) =>
    lines.filter((l) => l.pantryId === pantryId);

  function commitLine(line: RLine, raw?: string) {
    const source = raw ?? drafts[line.lineId] ?? '';
    const n = Number(source);
    if (source.trim() === '' || !Number.isInteger(n) || n < 0 || n > 10_000) {
      setNotice('Enter a whole number (0 or more).');
      return;
    }
    setNotice(null);
    setLocalCounts((prev) => ({ ...prev, [line.lineId]: n }));
    setDrafts((prev) => ({ ...prev, [line.lineId]: String(n) }));
    count.mutate({ sessionId, lineId: line.lineId, counted: n });
    // Auto-advance to the next uncounted line in this pantry.
    const order = linesInPantry(line.pantryId);
    const idx = order.findIndex((l) => l.lineId === line.lineId);
    const next = order.slice(idx + 1).find((l) => effectiveCount(l) === null && l.lineId !== line.lineId);
    if (next) window.setTimeout(() => inputRefs.current.get(next.lineId)?.focus(), 0);
  }

  // ── REVIEW MODE ────────────────────────────────────────────────────────────
  if (mode === 'review') {
    return (
      <ReviewScreen
        sessionId={sessionId}
        lines={lines}
        pantryName={pantryName}
        effectiveCount={effectiveCount}
        canAdjust={canAdjust}
        onBack={() => setMode('walk')}
        onDone={() => router.push('/home')}
        refetch={() => query.refetch()}
      />
    );
  }

  // ── COUNT WALK ─────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-40 sm:p-6">
      <header data-testid="session-screen" className="flex items-center gap-3">
        <BackLink fallback="/home" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">Count</h1>
          <p className="truncate text-sm text-text-muted">
            Started by {data.createdByName} · {ago(data.createdAt)}
            {data.blind ? ' · blind' : ''}
          </p>
        </div>
      </header>

      {data.note && <p className="text-sm text-text-muted">“{data.note}”</p>}
      {notice && (
        <p role="status" className="text-sm font-medium text-danger">
          {notice}
        </p>
      )}

      <main className="flex flex-col gap-3">
        {data.pantries.map((p) => {
          const pLines = linesInPantry(p.pantryId);
          const counted = pLines.filter((l) => effectiveCount(l) !== null).length;
          const isOpen = expanded === p.pantryId;
          const mine = p.claimedById === currentUserId;
          return (
            <section
              key={p.pantryId}
              data-testid="session-pantry"
              className="rounded-xl border border-border bg-surface-raised shadow-sm"
            >
              <div className="flex items-center gap-2 p-3">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : p.pantryId)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-base font-medium text-text">
                      {p.name}
                    </span>
                    <span aria-hidden className="text-text-muted">
                      {isOpen ? '▾' : '▸'}
                    </span>
                  </span>
                  <span className="text-sm text-text-muted">
                    {counted} of {pLines.length} counted
                    {p.claimedByName && !mine && <> · {p.claimedByName} is counting</>}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="claim-pantry"
                  onClick={() => claim.mutate({ sessionId, pantryId: p.pantryId, release: mine })}
                  disabled={claim.isPending}
                  className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium transition-colors ${
                    mine
                      ? 'bg-accent-soft text-accent-strong hover:bg-accent-soft/70'
                      : 'border border-border-strong text-text hover:bg-surface-sunken'
                  } disabled:opacity-50`}
                >
                  {mine ? 'You — release' : p.claimedById ? 'Take over' : "I'll count this"}
                </button>
              </div>

              {isOpen && (
                <div className="border-t border-border p-3">
                  <CountWalk
                    lines={pLines}
                    blind={data.blind}
                    canAdjust={canAdjust}
                    effectiveCount={effectiveCount}
                    drafts={drafts}
                    setDrafts={setDrafts}
                    commitLine={commitLine}
                    inputRefs={inputRefs}
                    onRemove={(lineId) => removeLine.mutate({ sessionId, lineId })}
                    sessionId={sessionId}
                    onAddLot={(lotId) => addLine.mutate({ sessionId, lotId, pantryId: p.pantryId })}
                  />
                </div>
              )}
            </section>
          );
        })}
      </main>

      <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface-raised px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-2xl gap-2">
          {canAdjust && (
            <button
              type="button"
              data-testid="reconcile-abandon"
              onClick={() => {
                if (window.confirm('Abandon this count? Everything unfreezes and nothing is applied.'))
                  abandon.mutate({ sessionId });
              }}
              className={btnSecondary}
            >
              Abandon count
            </button>
          )}
          <button
            type="button"
            data-testid="review-button"
            disabled={!canAdjust || !allCounted}
            onClick={() => {
              query.refetch();
              setMode('review');
            }}
            className={btnPrimary}
          >
            {allCounted ? 'Review & commit' : `${remaining} left to count`}
          </button>
        </div>
      </footer>
    </div>
  );
}

// ── Count walk for one pantry ─────────────────────────────────────────────────
function CountWalk({
  lines,
  blind,
  canAdjust,
  effectiveCount,
  drafts,
  setDrafts,
  commitLine,
  inputRefs,
  onRemove,
  sessionId,
  onAddLot,
}: {
  lines: RLine[];
  blind: boolean;
  canAdjust: boolean;
  effectiveCount: (line: RLine) => number | null;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  commitLine: (line: RLine, raw?: string) => void;
  inputRefs: React.MutableRefObject<Map<string, HTMLInputElement>>;
  onRemove: (lineId: string) => void;
  sessionId: string;
  onAddLot: (lotId: string) => void;
}) {
  // Group by product: a single-lot product reads product-level; multi-lot lists
  // its lots (code + best-by disambiguate).
  const groups = useMemo(() => {
    const map = new Map<string, RLine[]>();
    for (const l of lines) {
      const key = l.productId ?? l.lotId;
      (map.get(key) ?? map.set(key, []).get(key)!).push(l);
    }
    return [...map.values()];
  }, [lines]);

  return (
    <div className="flex flex-col gap-3">
      {groups.map((groupLines) => {
        const multi = groupLines.length > 1;
        return (
          <div key={groupLines[0].lineId} className="flex flex-col gap-1.5">
            {multi && (
              <p className="text-sm font-medium text-text">{groupLines[0].productName}</p>
            )}
            {groupLines.map((line) => (
              <CountLine
                key={line.lineId}
                line={line}
                label={multi ? line.lotCode ?? 'lot' : line.productName}
                sub={
                  multi
                    ? bestByLabel(line.bestBy)
                    : line.lotCode
                      ? `${line.lotCode}${bestByLabel(line.bestBy) ? ` · ${bestByLabel(line.bestBy)}` : ''}`
                      : bestByLabel(line.bestBy)
                }
                blind={blind}
                canAdjust={canAdjust}
                counted={effectiveCount(line)}
                draft={drafts[line.lineId]}
                setDraft={(v) => setDrafts((prev) => ({ ...prev, [line.lineId]: v }))}
                onCommit={(raw) => commitLine(line, raw)}
                inputRefs={inputRefs}
                onRemove={() => onRemove(line.lineId)}
              />
            ))}
          </div>
        );
      })}

      {canAdjust && (
        <div className="border-t border-border pt-2">
          <FoundSomething sessionId={sessionId} onAddLot={onAddLot} />
        </div>
      )}
    </div>
  );
}

/**
 * "+ Found something" (A4): search the household's product catalog
 * (product.search — same idiom as the receive line sheet), pick the product,
 * then pick the LOT you're holding from reconcile.lotCandidates (code,
 * best-by, and where the app thinks it lives). addLine scopes it into the
 * pantry being counted — including lots with zero expected there. A product
 * with no lot anywhere still can't be conjured: that's a receive.
 */
function FoundSomething({
  sessionId,
  onAddLot,
}: {
  sessionId: string;
  onAddLot: (lotId: string) => void;
}) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [product, setProduct] = useState<{ id: string; name: string } | null>(null);

  const products = useQuery(
    trpc.product.search.queryOptions({ query: search }, { enabled: open && !product }),
  );
  const lots = useQuery(
    trpc.reconcile.lotCandidates.queryOptions(
      { sessionId, productId: product?.id ?? '' },
      { enabled: open && !!product },
    ),
  );

  const reset = () => {
    setOpen(false);
    setSearch('');
    setProduct(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        data-testid="found-something"
        onClick={() => setOpen(true)}
        className="self-start text-sm font-medium text-accent hover:underline"
      >
        + Found something
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-strong p-2">
      {!product ? (
        <>
          <input
            type="search"
            autoFocus
            data-testid="found-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your products…"
            className={inputClass}
          />
          {products.isPending ? (
            <p className="px-1 py-2 text-xs text-text-muted">Searching…</p>
          ) : (products.data ?? []).length === 0 ? (
            <p className="px-1 py-2 text-xs text-text-muted">
              No matching product. A brand-new item is a receive.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {(products.data ?? []).map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    data-testid="found-product"
                    onClick={() => setProduct({ id: p.id, name: p.name })}
                    className="flex min-h-11 w-full items-center rounded-lg px-2 text-left text-sm text-text hover:bg-surface-sunken"
                  >
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <p className="px-1 text-sm font-medium text-text">
            {product.name} <span className="font-normal text-text-muted">— which lot?</span>
          </p>
          {lots.isPending ? (
            <p className="px-1 py-2 text-xs text-text-muted">Loading lots…</p>
          ) : (lots.data ?? []).length === 0 ? (
            <p className="px-1 py-2 text-xs text-text-muted">
              No lots of this product exist — receive it first.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {(lots.data ?? []).map((lot) => (
                <li key={lot.lotId}>
                  <button
                    type="button"
                    data-testid="found-lot"
                    onClick={() => {
                      onAddLot(lot.lotId);
                      reset();
                    }}
                    className="flex w-full flex-col items-start rounded-lg px-2 py-2 text-left hover:bg-surface-sunken"
                  >
                    <span className="text-sm text-text">
                      <span className="font-mono">{lot.lotCode ?? 'lot'}</span>
                      {bestByLabel(lot.bestBy) && <> · {bestByLabel(lot.bestBy)}</>}
                    </span>
                    <span className="text-xs text-text-muted">
                      {lot.placements.length === 0
                        ? 'not placed anywhere'
                        : lot.placements
                            .map((pl) => `${pl.pantryName} ×${pl.count}`)
                            .join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => setProduct(null)}
            className="self-start text-xs font-medium text-text-muted hover:underline"
          >
            ← Different product
          </button>
        </>
      )}
      <button
        type="button"
        onClick={reset}
        className="self-start text-xs font-medium text-text-muted hover:underline"
      >
        Close
      </button>
    </div>
  );
}

// ── One countable line ────────────────────────────────────────────────────────
function CountLine({
  line,
  label,
  sub,
  blind,
  canAdjust,
  counted,
  draft,
  setDraft,
  onCommit,
  inputRefs,
  onRemove,
}: {
  line: RLine;
  label: string;
  sub: string | null;
  blind: boolean;
  canAdjust: boolean;
  counted: number | null;
  draft: string | undefined;
  setDraft: (v: string) => void;
  onCommit: (raw?: string) => void;
  inputRefs: React.MutableRefObject<Map<string, HTMLInputElement>>;
  onRemove: () => void;
}) {
  const isCounted = counted !== null;
  const value = draft ?? (counted !== null ? String(counted) : '');
  return (
    <div
      data-testid="count-line"
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
        isCounted ? 'border-border bg-surface-sunken/40' : 'border-border-strong'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm ${isCounted ? 'text-text-muted' : 'text-text'}`}>
          {isCounted && <span aria-hidden className="text-success">✓ </span>}
          <span className={label === line.lotCode ? 'font-mono' : ''}>{label}</span>
        </p>
        {sub && <p className="truncate text-xs text-text-muted">{sub}</p>}
        {!blind && (
          <p className="text-xs text-text-muted">app says {line.expectedCount}</p>
        )}
      </div>

      {!blind && !isCounted && (
        <button
          type="button"
          data-testid="count-matches"
          onClick={() => onCommit(String(line.expectedCount))}
          className="min-h-11 shrink-0 rounded-lg border border-border-strong px-2.5 text-xs font-medium text-text hover:bg-surface-sunken"
        >
          matches
        </button>
      )}
      <button
        type="button"
        data-testid="count-zero"
        onClick={() => onCommit('0')}
        className="min-h-11 shrink-0 rounded-lg border border-border-strong px-2.5 text-xs font-medium text-text hover:bg-surface-sunken"
      >
        0
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={`Count for ${label}`}
        data-testid="count-input"
        ref={(el) => {
          if (el) inputRefs.current.set(line.lineId, el);
          else inputRefs.current.delete(line.lineId);
        }}
        value={value}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit();
          }
        }}
        onBlur={() => {
          if ((draft ?? '') !== '' && draft !== (counted !== null ? String(counted) : '')) onCommit();
        }}
        className={`${inputClass} w-16 text-center font-mono tabular-nums`}
      />
      {canAdjust && (
        <button
          type="button"
          aria-label={`Remove ${label} from count`}
          onClick={onRemove}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm text-text-muted hover:bg-surface-sunken"
        >
          🗑
        </button>
      )}
    </div>
  );
}

// ── Review & commit ───────────────────────────────────────────────────────────
function ReviewScreen({
  sessionId,
  lines,
  pantryName,
  effectiveCount,
  canAdjust,
  onBack,
  onDone,
  refetch,
}: {
  sessionId: string;
  lines: RLine[];
  pantryName: Map<string, string>;
  effectiveCount: (line: RLine) => number | null;
  canAdjust: boolean;
  onBack: () => void;
  onDone: () => void;
  refetch: () => void;
}) {
  const trpc = useTRPC();
  const [commitKey, setCommitKey] = useState(newClientKey);
  const [rejectedMoveLots, setRejectedMoveLots] = useState<Set<string>>(new Set());
  const [acked, setAcked] = useState<Set<string>>(new Set());
  // Per affected ORDER LINE (A7): the committer chooses reduce/cancel for each
  // open order line drawing on a shortage stock; commit sends them all.
  const [shortageChoice, setShortageChoice] = useState<Record<string, 'reduce' | 'cancelLine'>>({});
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    moves: number;
    variances: number;
    unchanged: number;
    ordersAffected: number;
  } | null>(null);

  const lineByStock = useMemo(() => new Map(lines.map((l) => [l.stockId, l])), [lines]);

  const preview = useMemo(() => {
    const mathLines: ReconcileMathLine[] = lines.map((l) => ({
      stockId: l.stockId,
      lotId: l.lotId,
      pantryId: l.pantryId,
      liveCount: l.liveCount,
      liveReserved: l.liveReserved,
      counted: effectiveCount(l) ?? l.liveCount,
    }));
    return reconcileMath(mathLines, { noMoveLots: rejectedMoveLots });
  }, [lines, rejectedMoveLots, effectiveCount]);

  const commit = useMutation(
    trpc.reconcile.commit.mutationOptions({
      onSuccess: (res) => setSummary(res),
      onError: (e) => {
        setError(e.message);
        // "Counts changed — review again." → rebuild from fresh data + new key.
        if (/review again/i.test(e.message)) {
          refetch();
          setCommitKey(newClientKey());
          setAcked(new Set());
          setShortageChoice({});
        }
      },
    }),
  );

  if (summary) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">Count committed</h1>
        <p data-testid="commit-summary" className="text-base text-text">
          {summary.moves} moved · {summary.variances} adjusted · {summary.unchanged} unchanged ·{' '}
          {summary.ordersAffected} {summary.ordersAffected === 1 ? 'order' : 'orders'} affected
        </p>
        <button type="button" onClick={onDone} className={btnPrimary}>
          Done
        </button>
      </div>
    );
  }

  const allAcked = preview.variances.every((v) => acked.has(v.stockId));
  const hasShortage = preview.shortages.length > 0;
  // Every open order line on every shortage stock needs an explicit choice.
  const shortageOrderLines = preview.shortages.flatMap(
    (s) => lineByStock.get(s.stockId)?.openOrderLines ?? [],
  );
  const shortagesResolved = shortageOrderLines.every((ol) => shortageChoice[ol.orderLineId]);
  const shortageResolutions = shortageOrderLines.flatMap((ol) =>
    shortageChoice[ol.orderLineId]
      ? [{ orderLineId: ol.orderLineId, action: shortageChoice[ol.orderLineId] }]
      : [],
  );
  const canCommit = canAdjust && allAcked && (!hasShortage || shortagesResolved) && !commit.isPending;

  return (
    <div data-testid="review-screen" className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-28 sm:p-6">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to count"
          className="shrink-0 text-lg text-text-muted"
        >
          ←
        </button>
        <button type="button" onClick={onBack} className="min-w-0 flex-1 text-left">
          <h1 className="text-xl font-semibold tracking-tight">Review &amp; commit</h1>
          <p className="text-sm text-text-muted">Tap to keep counting</p>
        </button>
      </header>

      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {/* (a) Derived moves */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          Moves ({preview.moves.length})
        </h2>
        {preview.moves.length === 0 ? (
          <p className="text-sm text-text-muted">No items moved between pantries.</p>
        ) : (
          preview.moves.map((m, i) => {
            const line = lineByStock.get(m.toStockId) ?? lineByStock.get(m.fromStockId);
            const rejected = rejectedMoveLots.has(m.lotId);
            return (
              <div
                key={`${m.fromStockId}-${m.toStockId}-${i}`}
                data-testid="move-row"
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
              >
                <p className="min-w-0 flex-1 text-sm text-text">
                  <span className="font-mono">{m.quantity}</span> · {line?.productName ?? 'item'}{' '}
                  <span className="font-mono text-xs text-text-muted">{line?.lotCode}</span>
                  <span className="block text-xs text-text-muted">
                    {pantryName.get(m.fromPantryId)} → {pantryName.get(m.toPantryId)}
                  </span>
                </p>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={rejected}
                  data-testid="move-reject"
                  onClick={() =>
                    setRejectedMoveLots((prev) => {
                      const next = new Set(prev);
                      if (next.has(m.lotId)) next.delete(m.lotId);
                      else next.add(m.lotId);
                      return next;
                    })
                  }
                  className={`min-h-11 shrink-0 rounded-lg px-2.5 text-xs font-medium ${
                    rejected
                      ? 'bg-warn-soft text-warn'
                      : 'border border-border-strong text-text-muted hover:bg-surface-sunken'
                  }`}
                >
                  {rejected ? 'not a move ✓' : 'this wasn’t a move'}
                </button>
              </div>
            );
          })
        )}
      </section>

      {/* (b) Variances */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          Variances ({preview.variances.length})
        </h2>
        {preview.variances.length === 0 ? (
          <p className="text-sm text-text-muted">Every count matched. Nothing to adjust.</p>
        ) : (
          preview.variances.map((v) => {
            const line = lineByStock.get(v.stockId);
            const on = acked.has(v.stockId);
            return (
              <label
                key={v.stockId}
                data-testid="variance-row"
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <input
                  type="checkbox"
                  data-testid="variance-ack"
                  checked={on}
                  onChange={() =>
                    setAcked((prev) => {
                      const next = new Set(prev);
                      if (next.has(v.stockId)) next.delete(v.stockId);
                      else next.add(v.stockId);
                      return next;
                    })
                  }
                  className="size-5 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1 text-sm text-text">
                  {line?.productName ?? 'item'}{' '}
                  <span className="font-mono text-xs text-text-muted">{line?.lotCode}</span>
                  <span className="block text-xs text-text-muted">
                    {pantryName.get(v.pantryId)} · {v.delta < 0 ? `short ${-v.delta}` : `found ${v.delta}`}
                  </span>
                </span>
              </label>
            );
          })
        )}
      </section>

      {/* (c) Shortages (A7): per affected open order line, an explicit choice.
          The requester is notified by the server inside the commit tx. */}
      {hasShortage && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-danger">
            Order shortages ({preview.shortages.length})
          </h2>
          <p className="text-xs text-text-muted">
            Counted below what open orders reserved. Choose what happens to each affected order line —
            the requesting household gets notified.
          </p>
          {preview.shortages.map((s) => {
            const line = lineByStock.get(s.stockId);
            return (
              <div key={s.stockId} className="flex flex-col gap-2">
                <p className="text-sm text-text">
                  {line?.productName ?? 'item'}{' '}
                  <span className="font-mono text-xs text-text-muted">{line?.lotCode}</span> — counted{' '}
                  {s.counted} of {s.liveReserved} reserved
                  <span className="block text-xs text-text-muted">{pantryName.get(s.pantryId)}</span>
                </p>
                {(line?.openOrderLines ?? []).map((ol) => {
                  const choice = shortageChoice[ol.orderLineId];
                  return (
                    <div
                      key={ol.orderLineId}
                      data-testid="shortage-row"
                      className="flex flex-col gap-2 rounded-lg border border-danger/40 px-3 py-2"
                    >
                      <p className="text-sm text-text">
                        {ol.requesterHouseholdName}&apos;s order · {ol.quantity}{' '}
                        {ol.quantity === 1 ? 'unit' : 'units'} reserved
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          data-testid="shortage-reduce"
                          aria-pressed={choice === 'reduce'}
                          onClick={() =>
                            setShortageChoice((p) => ({ ...p, [ol.orderLineId]: 'reduce' }))
                          }
                          className={`min-h-11 flex-1 rounded-lg px-3 text-xs font-medium ${
                            choice === 'reduce'
                              ? 'bg-accent text-accent-contrast'
                              : 'border border-border-strong text-text hover:bg-surface-sunken'
                          }`}
                        >
                          Reduce their order to what&apos;s left
                        </button>
                        <button
                          type="button"
                          data-testid="shortage-cancel"
                          aria-pressed={choice === 'cancelLine'}
                          onClick={() =>
                            setShortageChoice((p) => ({ ...p, [ol.orderLineId]: 'cancelLine' }))
                          }
                          className={`min-h-11 flex-1 rounded-lg px-3 text-xs font-medium ${
                            choice === 'cancelLine'
                              ? 'bg-accent text-accent-contrast'
                              : 'border border-border-strong text-text hover:bg-surface-sunken'
                          }`}
                        >
                          Cancel that line
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface-raised px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-2xl">
          <button
            type="button"
            data-testid="commit-button"
            disabled={!canCommit}
            onClick={() => {
              setError(null);
              commit.mutate({
                sessionId,
                commitClientKey: commitKey,
                acknowledgedVariances: preview.variances.map((v) => ({
                  lineId: lineByStock.get(v.stockId)?.lineId ?? v.stockId,
                  delta: v.delta,
                })),
                rejectedMoveLots: [...rejectedMoveLots],
                shortageResolutions,
              });
            }}
            className="min-h-12 w-full rounded-lg bg-accent px-4 py-3 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            {commit.isPending
              ? 'Committing…'
              : !allAcked
                ? 'Acknowledge every variance to commit'
                : hasShortage && !shortagesResolved
                  ? 'Resolve order shortages first'
                  : 'Commit count'}
          </button>
        </div>
      </div>
    </div>
  );
}
