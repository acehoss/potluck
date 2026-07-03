'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { reconcileVariance, restockCode, unitCostCents, varianceAutoPasses } from '@/lib/domain';
import { downscaleToJpeg, sha256HexOfFile, uploadImage } from '@/lib/downscale';
import { centsToDollarsString, formatCents, parseDollarsToCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers';
import { ScanSheet } from '@/app/scan-sheet';

type Restock = inferRouterOutputs<AppRouter>['restock']['get'];
type Line = Restock['lots'][number];

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
// Disabled state uses translucent COLORS, not element opacity: `opacity-50`
// promotes the button to its own compositor layer, and Chromium's tiled
// rasterization rounds the blended color slightly differently per tile — a
// visible vertical seam ("darker patch") across the disabled button on
// desktop-light (seen in the slice-5 screenshots). Alpha on the background/
// text blends in normal paint, so there is no layer and no seam.
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

export function ReceiveWizard({ pantryId, restockId }: { pantryId: string; restockId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();

  const query = useQuery(trpc.restock.get.queryOptions({ id: restockId }));
  const restock = query.data;

  const [editOpen, setEditOpen] = useState(false);
  const [abandonError, setAbandonError] = useState<string | null>(null);

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: trpc.restock.get.queryKey({ id: restockId }) });

  const deleteDraft = useMutation(
    trpc.restock.deleteDraft.mutationOptions({
      onSuccess: () => {
        router.replace(`/pantries/${pantryId}`);
        router.refresh();
      },
      // Never swallow a FORBIDDEN (only the creator or purchaser household
      // may abandon) — the user must see why nothing happened.
      onError: (e) => setAbandonError(e.message),
    }),
  );

  const requestedStep = Number(searchParams.get('step') ?? '2');
  const step = restock?.status === 'FINALIZED' ? 6 : Math.min(Math.max(requestedStep, 2), 5);
  const goToStep = (n: number) =>
    router.replace(`/pantries/${pantryId}/receive/${restockId}?step=${n}`, { scroll: true });

  if (query.isLoading) {
    return <p className="p-6 text-sm text-text-muted">Loading restock…</p>;
  }
  if (!restock) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
        <p role="alert" className="text-sm text-danger">
          Restock not found.
        </p>
        <Link href={`/pantries/${pantryId}`} className="text-sm font-medium text-accent">
          ← Back to pantry
        </Link>
      </div>
    );
  }

  const titles: Record<number, string> = {
    2: 'Receipt photos',
    3: 'Review lines',
    4: 'Unit photos',
    5: 'Reconcile',
    6: 'Done',
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        {step < 6 ? (
          <button
            type="button"
            aria-label="Abandon restock"
            onClick={() => {
              if (window.confirm('Abandon this restock? The draft and its photos are deleted.')) {
                deleteDraft.mutate({ restockId });
              }
            }}
            className="text-lg text-text-muted"
          >
            ✕
          </button>
        ) : (
          <span />
        )}
        <h1 className="text-xl font-semibold tracking-tight">{titles[step]}</h1>
        <span className="font-mono text-sm tabular-nums text-text-muted">
          {step < 6 ? `(${step - 1}/4)` : ''}
        </span>
      </header>

      {step < 6 && restock.status === 'DRAFT' && (
        // Step-1 header fields stay reachable on every later step — a typoed
        // receipt total or date must be fixable without abandoning the draft.
        <button
          type="button"
          data-testid="edit-details"
          onClick={() => setEditOpen(true)}
          className="self-start text-left text-sm text-text-muted"
        >
          {restock.retailer} · {restock.purchasedAt} ·{' '}
          {restock.receiptTotalCents !== null
            ? `receipt ${formatCents(restock.receiptTotalCents)}`
            : 'no receipt total'}{' '}
          <span className="font-medium text-accent">Edit details</span>
        </button>
      )}

      {abandonError && (
        <p role="alert" className="text-sm text-danger">
          {abandonError}
        </p>
      )}

      {/* The label code is assigned up front (not at finalize) so you can mark
          each item as it goes on the shelf — see the router's assignRestockCode.
          Shown from the photos step through reconcile. */}
      {step < 6 && restock.status === 'DRAFT' && restock.code && (
        <div
          data-testid="draft-code-banner"
          className="flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3"
        >
          <span className="text-sm font-medium text-accent-strong">Label everything</span>
          <span
            data-testid="draft-code"
            className="font-mono text-2xl font-bold tracking-widest text-accent-strong"
          >
            {restock.code}
          </span>
        </div>
      )}

      {step === 2 && <PhotosStep restock={restock} refetch={refetch} onNext={() => goToStep(3)} />}
      {step === 3 && (
        <LinesStep
          restock={restock}
          refetch={refetch}
          onBack={() => goToStep(2)}
          onNext={() => goToStep(4)}
          onEditDetails={() => setEditOpen(true)}
        />
      )}
      {step === 4 && (
        <UnitPhotosStep
          restock={restock}
          refetch={refetch}
          onBack={() => goToStep(3)}
          onNext={() => goToStep(5)}
        />
      )}
      {step === 5 && (
        <ReconcileStep
          restock={restock}
          restockId={restockId}
          onBack={() => goToStep(4)}
          onEditDetails={() => setEditOpen(true)}
          onDone={async () => {
            await refetch();
            goToStep(6);
          }}
        />
      )}
      {step === 6 && <DoneStep restock={restock} pantryId={pantryId} />}

      {editOpen && (
        <EditDetailsSheet
          restock={restock}
          onClose={async (changed) => {
            if (changed) await refetch();
            setEditOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ---- edit details (step-1 header fields, editable on any draft step) --------

function EditDetailsSheet({
  restock,
  onClose,
}: {
  restock: Restock;
  onClose: (changed: boolean) => void;
}) {
  const trpc = useTRPC();
  const [retailer, setRetailer] = useState(restock.retailer);
  const [purchasedAt, setPurchasedAt] = useState(restock.purchasedAt);
  const [purchaserHouseholdId, setPurchaserHouseholdId] = useState(restock.purchaserHousehold.id);
  const [receiptTotal, setReceiptTotal] = useState(
    restock.receiptTotalCents !== null ? centsToDollarsString(restock.receiptTotalCents) : '',
  );
  const [tax, setTax] = useState(
    restock.taxCents !== null ? centsToDollarsString(restock.taxCents) : '',
  );
  const [fees, setFees] = useState(
    restock.feesCents !== null ? centsToDollarsString(restock.feesCents) : '',
  );
  const [feesDistributed, setFeesDistributed] = useState(restock.feesDistributed);
  const [error, setError] = useState<string | null>(null);

  const households = useQuery(trpc.household.overview.queryOptions());

  const updateDraft = useMutation(
    trpc.restock.updateDraft.mutationOptions({
      onSuccess: () => onClose(true),
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl">
        <h2 className="text-lg font-semibold">Edit details</h2>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const cents = receiptTotal.trim() ? parseDollarsToCents(receiptTotal) : null;
            if (receiptTotal.trim() && cents === null) {
              setError('Receipt total must look like 86.02');
              return;
            }
            const taxCents = tax.trim() ? parseDollarsToCents(tax) : null;
            if (tax.trim() && taxCents === null) {
              setError('Tax must look like 1.72');
              return;
            }
            const feesCents = fees.trim() ? parseDollarsToCents(fees) : null;
            if (fees.trim() && feesCents === null) {
              setError('Fees must look like 4.99');
              return;
            }
            updateDraft.mutate({
              restockId: restock.id,
              retailer,
              purchasedAt,
              purchaserHouseholdId,
              receiptTotalCents: cents,
              taxCents,
              feesCents,
              feesDistributed,
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
              {(households.data?.households ?? [restock.purchaserHousehold]).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {households.data && h.id === households.data.yourHouseholdId ? ' (yours)' : ''}
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
              data-testid="edit-receipt-total"
              className={inputClass}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              Tax (optional)
              <input
                type="text"
                inputMode="decimal"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
                placeholder="1.72"
                data-testid="edit-tax"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              Fees (optional)
              <input
                type="text"
                inputMode="decimal"
                value={fees}
                onChange={(e) => setFees(e.target.value)}
                placeholder="delivery, etc."
                data-testid="edit-fees"
                className={inputClass}
              />
            </label>
          </div>
          <p className="-mt-1 text-xs text-text-muted">
            Tax is split across taxable lines. Fees are the purchaser&apos;s unless you share them.
          </p>
          {fees.trim() && (
            <label className="flex items-start gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={feesDistributed}
                data-testid="edit-fees-distributed"
                onChange={(e) => setFeesDistributed(e.target.checked)}
                className="mt-0.5 size-5 accent-accent"
              />
              <span>
                Share fees across all lines
                <span className="block text-xs text-text-muted">
                  Everyone who takes an item pays a proportional bit of the fee.
                </span>
              </span>
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => onClose(false)} className={`${secondaryBtn} flex-1`}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={updateDraft.isPending}
              data-testid="save-details"
              className={`${primaryBtn} flex-1`}
            >
              {updateDraft.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- step 2: receipt photos ------------------------------------------------

function PhotosStep({
  restock,
  refetch,
  onNext,
}: {
  restock: Restock;
  refetch: () => Promise<unknown>;
  onNext: () => void;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addImage = useMutation(trpc.restock.addImage.mutationOptions());
  const removeImage = useMutation(
    trpc.restock.removeImage.mutationOptions({ onSuccess: refetch }),
  );

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        // Hash the ORIGINAL bytes before the downscale re-encode — the sha
        // keys fixture-mode extraction (blueprint 04 §3). Null is fine
        // (non-secure contexts); live extraction never needs it.
        const originalSha256 = await sha256HexOfFile(file);
        const jpeg = await downscaleToJpeg(file);
        const uploaded = await uploadImage('receipts', jpeg, originalSha256);
        await addImage.mutateAsync({
          restockId: restock.id,
          path: uploaded.path,
          originalSha256: uploaded.originalSha256,
        });
      }
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Snap the receipt — multiple pages are fine. Photos are kept permanently and drive
        extraction later.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        data-testid="receipt-photo-input"
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
      />
      {restock.images.length > 0 && (
        <div className="flex flex-wrap gap-3" data-testid="receipt-thumbs">
          {restock.images.map((image) => (
            <div key={image.id} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/images/${image.path}`}
                alt={`Receipt page ${image.position}`}
                className="h-28 w-20 rounded-lg border border-border object-cover"
              />
              <button
                type="button"
                aria-label={`Remove page ${image.position}`}
                onClick={() => removeImage.mutate({ imageId: image.id })}
                className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full bg-danger text-xs text-danger-contrast"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className={secondaryBtn}
      >
        {uploading ? 'Uploading…' : restock.images.length > 0 ? '+ Add page' : 'Add receipt photos'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <button type="button" onClick={onNext} disabled={uploading} className={primaryBtn}>
        {restock.images.length > 0 ? 'Next' : 'Skip photos'}
      </button>
    </div>
  );
}

// ---- step 3: line review (THE screen) --------------------------------------

function reconcileParts(restock: Restock) {
  const lineSumCents = restock.lots.reduce((s, l) => s + l.lineTotalCents, 0);
  const nonInventoryCents = (restock.taxCents ?? 0) + (restock.feesCents ?? 0);
  const varianceCents = reconcileVariance(
    restock.receiptTotalCents,
    lineSumCents,
    restock.taxCents,
    restock.feesCents,
  );
  const autoPass =
    varianceCents === null || varianceAutoPasses(varianceCents, restock.lots.length);
  return { lineSumCents, nonInventoryCents, varianceCents, autoPass };
}

/** "Lines $X + tax $Y + fees $Z" — omits the tax/fee parts when zero/unset. */
function accountedLabel(restock: Restock, lineSumCents: number) {
  let label = `Lines ${formatCents(lineSumCents)}`;
  if (restock.taxCents) label += ` + tax ${formatCents(restock.taxCents)}`;
  if (restock.feesCents) label += ` + fees ${formatCents(restock.feesCents)}`;
  return label;
}

function VarianceBanner({
  restock,
  onEditDetails,
}: {
  restock: Restock;
  onEditDetails?: () => void;
}) {
  const { lineSumCents, varianceCents, autoPass } = reconcileParts(restock);
  if (varianceCents === null) {
    return (
      <p className="text-sm text-text-muted">
        {accountedLabel(restock, lineSumCents)} · no receipt total entered
      </p>
    );
  }
  const label = `${accountedLabel(restock, lineSumCents)} / Receipt ${formatCents(
    restock.receiptTotalCents!,
  )}`;
  if (autoPass) {
    return (
      <div
        role="status"
        className="rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-sm font-medium text-success"
      >
        {label} — reconciled
      </div>
    );
  }
  // A short receipt with no tax entered is almost always unrecorded tax/fees —
  // point the user at the fix instead of leaving them feeling they mis-entered.
  const looksLikeTax = varianceCents > 0 && !restock.taxCents;
  return (
    <div
      role="status"
      data-testid="variance-banner"
      className="flex flex-col gap-2 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm font-medium text-warn"
    >
      <span>
        {label} — ⚠ {formatCents(Math.abs(varianceCents))} {varianceCents > 0 ? 'short' : 'over'}
      </span>
      {looksLikeTax && onEditDetails && (
        <button
          type="button"
          data-testid="add-tax-hint"
          onClick={onEditDetails}
          className="min-h-11 self-start rounded-lg border border-warn/40 px-3 py-2 text-sm font-medium text-warn hover:bg-warn/10"
        >
          Add tax or fees →
        </button>
      )}
    </div>
  );
}

// ---- slice 5: VLM proposals (advisory — derived from server state) ----------
//
// Proposals are DERIVED, never duplicated client state: restock.get returns
// the stored extraction lines plus the indices already resolved (confirmed or
// dismissed, persisted via restock.resolveProposal), so the pending list
// survives refresh, tab-kill, and step changes (blueprint 02) without ever
// writing unconfirmed lines to the draft.

type ProposedLine = {
  index: number; // position in Restock.extractionJson.lines — the resolve key
  description: string; // clean product name
  receiptText: string | null; // raw line as printed (shown for reconciliation)
  unitCount: number;
  lineTotalCents: number;
  taxable: boolean | null;
  confidence: number | null;
};

/**
 * Suggestion query for product.search: the longest plain word of the receipt
 * description (Costco prints "KS DICED TOMATOES 8CT"; "TOMATOES" is what a
 * product name will contain). Digit-bearing tokens (2L, 8CT) and brand
 * prefixes never match product names, so they're skipped.
 */
const SUGGESTION_STOP_WORDS = new Set(['KIRKLAND', 'SIGNATURE']);
function suggestionQueryFor(description: string) {
  const tokens = description
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 4 && !/\d/.test(t) && !SUGGESTION_STOP_WORDS.has(t));
  return tokens.reduce((a, b) => (b.length > a.length ? b : a), '');
}

const clampInt = (n: number, min: number, max: number) =>
  Math.min(Math.max(Math.round(n), min), max);

/**
 * Sanitize one model-proposed line into saveLine's accepted ranges — model
 * output is untrusted input. Non-positive totals (a discount the model
 * disobediently emitted as its own line, or a free promo) are DROPPED, never
 * clamped to $0.00: the prompt nets item discounts into the item, and a
 * surviving $0.00 row would overstate what the purchaser paid elsewhere.
 */
function sanitizeProposal(
  line: {
    description: string;
    receiptText: string | null;
    unitCount: number;
    lineTotalCents: number;
    taxable: boolean | null;
    confidence: number | null;
  },
  index: number,
): ProposedLine | null {
  const lineTotalCents = Math.round(line.lineTotalCents);
  if (!Number.isFinite(lineTotalCents) || lineTotalCents <= 0) return null;
  return {
    index,
    // saveLine's newProductName schema is .max(200).
    description: (line.description.trim() || 'Unlabeled item').slice(0, 200),
    receiptText: line.receiptText?.trim().slice(0, 300) || null,
    unitCount: clampInt(line.unitCount, 1, 10_000),
    lineTotalCents: Math.min(lineTotalCents, 100_000_000),
    taxable: line.taxable,
    confidence: line.confidence,
  };
}

/**
 * The pending proposals: stored extraction lines, minus resolved indices,
 * minus lines that already exist as draft lots. The lot dedupe covers
 * re-extraction (which resets the resolved set and re-proposes everything):
 * each lot consumes at most one proposal — exact name+units+total match
 * first, then units+total only (a confirm that matched an existing product
 * keeps the product's name, not the receipt description). The fallback can
 * suppress an unconfirmed proposal that coincidentally shares units+total
 * with a manual line — the safe direction (re-add manually) versus
 * double-counting money into the purchaser credit.
 */
function pendingProposals(restock: Restock): ProposedLine[] {
  if (!restock.extractionLines) return [];
  const resolved = new Set(restock.extractionResolved);
  const pending = restock.extractionLines
    .map((line, index) => (resolved.has(index) ? null : sanitizeProposal(line, index)))
    .filter((p): p is ProposedLine => p !== null);

  // Excluded (non-inventory) lots never came from a proposal, so they don't
  // consume one; only real product lots participate in the dedupe.
  const lots = restock.lots
    .filter((l) => !l.excluded && l.product)
    .map((l) => ({
      name: l.product!.name.toUpperCase(),
      key: `${l.purchasedCount}|${l.lineTotalCents}`,
      used: false,
    }));
  const hidden = new Set<number>();
  for (const exactName of [true, false]) {
    for (const p of pending) {
      if (hidden.has(p.index)) continue;
      const key = `${p.unitCount}|${p.lineTotalCents}`;
      const lot = lots.find(
        (l) => !l.used && l.key === key && (!exactName || l.name === p.description.toUpperCase()),
      );
      if (lot) {
        lot.used = true;
        hidden.add(p.index);
      }
    }
  }
  return pending.filter((p) => !hidden.has(p.index));
}

function ProposalRow({
  restockId,
  proposal,
  onConsumed,
  onSaved,
  onEdit,
}: {
  restockId: string;
  proposal: ProposedLine;
  onConsumed: () => void;
  onSaved: () => void;
  onEdit: (suggested: { id: string; name: string } | null) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const suggestionQuery = suggestionQueryFor(proposal.description);
  const search = useQuery(
    trpc.product.search.queryOptions(
      { query: suggestionQuery },
      { enabled: suggestionQuery.length > 0 },
    ),
  );
  const suggested = search.data?.[0] ?? null;
  // The match suggestion resolves asynchronously AFTER the row renders; until
  // it lands the row must say "matching…" (with Confirm held disabled below),
  // never "new product" — or a fast Confirm creates a duplicate product.
  const matching = suggestionQuery.length > 0 && search.isPending;

  const saveLine = useMutation(
    trpc.restock.saveLine.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.product.search.pathFilter());
        // The parent resolves the proposal + refetches IMMEDIATELY (so the
        // lines list and the reconcile totals already contain the new lot
        // while the "✓ Added" flash shows) and keeps the flash row alive for
        // a beat — otherwise the confirmed line "teleports" to the lots list
        // below with no nearby feedback.
        onSaved();
      },
      onError: (e) => setError(e.message),
    }),
  );

  // The 1-tap confirm (blueprint 02): the normal saveLine flow, prefilled.
  // Matched → the suggested product; unmatched → create-new with the
  // proposed description. All units received by default; hold-backs via Edit.
  function confirm() {
    saveLine.mutate({
      restockId,
      productId: suggested?.id,
      newProductName: suggested ? undefined : proposal.description,
      purchasedCount: proposal.unitCount,
      receivedCount: proposal.unitCount,
      lineTotalCents: proposal.lineTotalCents,
      taxable: proposal.taxable ?? false,
      receiptText: proposal.receiptText ?? proposal.description,
      bestBy: null,
    });
  }

  const unitCost = unitCostCents(proposal.lineTotalCents, proposal.unitCount);
  const smallBtn =
    'min-h-11 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50';

  return (
    <li
      data-testid="proposed-row"
      className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-surface-raised p-3 shadow-sm"
    >
      <div className="min-w-0">
        <p className="text-base text-text">
          <span aria-hidden className="mr-1.5 text-accent">
            ●
          </span>
          {proposal.description}
        </p>
        {proposal.receiptText && proposal.receiptText !== proposal.description && (
          <p className="font-mono text-xs text-text-muted">{proposal.receiptText}</p>
        )}
        <p className="text-sm text-text-muted">
          {proposal.unitCount} {proposal.unitCount === 1 ? 'unit' : 'units'} ·{' '}
          {formatCents(proposal.lineTotalCents)}
          {proposal.unitCount > 1 && <> → {formatCents(unitCost)}/u</>}
          {proposal.taxable && (
            <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-strong">
              taxed
            </span>
          )}
        </p>
        <p data-testid="proposed-match" className="text-sm text-text-muted">
          {matching ? (
            <>matching…</>
          ) : suggested ? (
            <>
              matches <span className="font-medium text-text">{suggested.name}</span>
            </>
          ) : (
            <>new product</>
          )}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="proposed-confirm"
          onClick={confirm}
          disabled={saveLine.isPending || matching}
          className={`${smallBtn} flex-1 bg-accent text-accent-contrast hover:bg-accent-strong`}
        >
          {saveLine.isPending ? 'Saving…' : 'Confirm'}
        </button>
        <button
          type="button"
          data-testid="proposed-edit"
          onClick={() => onEdit(suggested)}
          className={`${smallBtn} border border-border-strong text-text hover:bg-surface-sunken`}
        >
          Edit
        </button>
        <button
          type="button"
          data-testid="proposed-dismiss"
          onClick={onConsumed}
          className={`${smallBtn} border border-border-strong text-text hover:bg-surface-sunken`}
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}

function LinesStep({
  restock,
  refetch,
  onBack,
  onNext,
  onEditDetails,
}: {
  restock: Restock;
  refetch: () => Promise<unknown>;
  onBack: () => void;
  onNext: () => void;
  onEditDetails: () => void;
}) {
  const trpc = useTRPC();
  const [sheet, setSheet] = useState<{
    open: boolean;
    line: Line | null;
    proposal: (ProposedLine & { suggested: { id: string; name: string } | null }) | null;
    startExcluded?: boolean;
  }>({ open: false, line: null, proposal: null });
  const [extractError, setExtractError] = useState<string | null>(null);

  // Pending proposals are derived from the query data — nothing to lose on
  // refresh/step-back, and nothing to re-spend an API call rehydrating.
  const proposals = pendingProposals(restock);

  // The receipt's printed tax, read by extraction — surfaced as a one-tap
  // suggestion (NOT silently written: tax feeds the tax-inclusive unit cost, so
  // applying it stays an explicit choice, money rule #2).
  const [suggestedTaxCents, setSuggestedTaxCents] = useState<number | null>(null);
  const updateDraft = useMutation(
    trpc.restock.updateDraft.mutationOptions({ onSuccess: () => refetch() }),
  );

  const extract = useMutation(
    trpc.restock.extract.mutationOptions({
      onSuccess: async (res) => {
        if (res.status !== 'ok') {
          setExtractError(res.reason);
          return;
        }
        setExtractError(
          res.lines.length === 0 ? 'No lines found on the receipt — enter them manually.' : null,
        );
        setSuggestedTaxCents(res.taxCents != null && res.taxCents > 0 ? res.taxCents : null);
        await refetch(); // the server stored the extraction; proposals derive from it
      },
      onError: (e) => setExtractError(e.message),
    }),
  );

  // Auto-extract on arriving at Review lines with receipt photos and nothing
  // extracted yet — the user snapped the receipt to get lines, not to press a
  // button (Aaron: "if a receipt is provided, the lines should be created").
  // Fires at most once per mount; the manual "Re-extract" stays for retries.
  const canExtract =
    restock.extractionEnabled && restock.status === 'DRAFT' && restock.images.length > 0;
  const autoExtractedRef = useRef(false);
  useEffect(() => {
    if (canExtract && !restock.extractedAt && !extract.isPending && !autoExtractedRef.current) {
      autoExtractedRef.current = true;
      extract.mutate({ restockId: restock.id });
    }
    // extract.mutate is stable; guarded by the ref so this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canExtract, restock.extractedAt]);

  // Confirm/dismiss/edit-save all resolve the line server-side so it never
  // comes back; refetch on settle updates both the lot list and proposals.
  const resolve = useMutation(
    trpc.restock.resolveProposal.mutationOptions({ onSettled: refetch }),
  );
  const consumeProposal = (index: number) => resolve.mutate({ restockId: restock.id, index });

  // Confirmed proposals collapse to a "✓ Added" flash for a beat so the row
  // doesn't teleport to the lots list with no nearby feedback. The resolve +
  // refetch fire IMMEDIATELY (the lot is really "in the lines below" and the
  // reconcile math is current while the flash shows); only this purely visual
  // row lives on the timer. A tab-kill mid-flash is covered by the lot dedupe.
  const [savedFlashes, setSavedFlashes] = useState<ProposedLine[]>([]);
  function onProposalSaved(proposal: ProposedLine) {
    consumeProposal(proposal.index);
    setSavedFlashes((f) => [...f, proposal]);
    setTimeout(
      () => setSavedFlashes((f) => f.filter((p) => p.index !== proposal.index)),
      900,
    );
  }
  // Until the resolve's refetch lands, the confirmed line is still in the
  // derived pending set — the flash replaces the row, never joins it.
  const flashing = new Set(savedFlashes.map((p) => p.index));
  const visibleProposals = proposals.filter((p) => !flashing.has(p.index));

  return (
    <div className="flex flex-col gap-4">
      <VarianceBanner restock={restock} onEditDetails={onEditDetails} />

      {canExtract && !extract.isPending && (
        <button
          type="button"
          data-testid="extract"
          onClick={() => extract.mutate({ restockId: restock.id })}
          className={secondaryBtn}
        >
          ✨ {restock.extractedAt !== null ? 'Re-extract from receipt' : 'Extract from receipt'}
        </button>
      )}

      {extract.isPending && (
        <div data-testid="extract-pending" className="flex flex-col gap-2" aria-busy="true">
          <p className="text-sm text-text-muted">Reading the receipt…</p>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-border bg-surface-sunken"
            />
          ))}
        </div>
      )}

      {extractError && !extract.isPending && (
        <div
          role="status"
          data-testid="extract-error"
          className="flex flex-col gap-2 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm font-medium text-warn"
        >
          <p>{extractError}</p>
          {/* Dismissible per blueprint 04 §3; both controls at the 44px
              minimum tap target (blueprint 03 §4). */}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="extract-retry"
              onClick={() => extract.mutate({ restockId: restock.id })}
              className="min-h-11 rounded-lg border border-warn/40 px-3 py-2 text-sm font-medium text-warn hover:bg-warn/10"
            >
              Try again
            </button>
            <button
              type="button"
              data-testid="extract-error-dismiss"
              onClick={() => setExtractError(null)}
              className="min-h-11 rounded-lg px-3 py-2 text-sm font-medium text-warn hover:bg-warn/10"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {suggestedTaxCents !== null && restock.taxCents === null && (
        <div
          data-testid="tax-suggestion"
          className="flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-sm"
        >
          <span className="text-accent-strong">
            Receipt shows {formatCents(suggestedTaxCents)} tax.
          </span>
          <button
            type="button"
            data-testid="apply-tax"
            onClick={() =>
              updateDraft.mutate({ restockId: restock.id, taxCents: suggestedTaxCents })
            }
            className="min-h-9 shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast hover:bg-accent-strong"
          >
            Add tax
          </button>
        </div>
      )}

      {!extract.isPending && (visibleProposals.length > 0 || savedFlashes.length > 0) && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Proposed from receipt — confirm, edit, or dismiss each
          </h2>
          <ul className="flex flex-col gap-2">
            {savedFlashes.map((proposal) => (
              <li
                key={`saved-${proposal.index}`}
                data-testid="proposed-row-saved"
                className="flex min-h-11 items-center gap-2 rounded-xl border border-success/30 bg-success-soft p-3 text-sm font-medium text-success shadow-sm"
              >
                ✓ Added {proposal.description} — now in the lines below
              </li>
            ))}
            {visibleProposals.map((proposal) => (
              <ProposalRow
                key={proposal.index}
                restockId={restock.id}
                proposal={proposal}
                onConsumed={() => consumeProposal(proposal.index)}
                onSaved={() => onProposalSaved(proposal)}
                onEdit={(suggested) =>
                  setSheet({ open: true, line: null, proposal: { ...proposal, suggested } })
                }
              />
            ))}
          </ul>
        </section>
      )}

      {restock.lots.length === 0 &&
        !extract.isPending &&
        proposals.length === 0 &&
        savedFlashes.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
            <p className="text-sm font-medium text-text">No lines yet.</p>
            <p className="text-sm text-text-muted">
              Add each line from your receipt, or extract them from a photo.
            </p>
          </div>
        )}

      <ul className="flex flex-col gap-2">
        {restock.lots.map((lot) => {
          const taxBadge = lot.taxable && (
            <span className="ml-2 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
              taxed
            </span>
          );
          if (lot.excluded) {
            return (
              <li key={lot.id}>
                <button
                  type="button"
                  data-testid="line-row"
                  onClick={() => setSheet({ open: true, line: lot, proposal: null })}
                  className="flex w-full flex-col gap-0.5 rounded-xl border border-dashed border-border-strong bg-surface-raised p-3 text-left shadow-sm"
                >
                  <p className="text-base text-text-muted">
                    {lot.receiptText || 'Excluded line'}
                    <span className="ml-2 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-text-muted">
                      not stocked
                    </span>
                  </p>
                  <p className="text-sm text-text-muted">
                    {formatCents(lot.lineTotalCents)} · counts toward the receipt only
                    {taxBadge}
                  </p>
                </button>
              </li>
            );
          }
          const unitCost = unitCostCents(lot.lineTotalCents, lot.purchasedCount);
          const heldBack = lot.receivedCount < lot.purchasedCount;
          return (
            <li key={lot.id}>
              <button
                type="button"
                data-testid="line-row"
                onClick={() => setSheet({ open: true, line: lot, proposal: null })}
                className="flex w-full flex-col gap-0.5 rounded-xl border border-border bg-surface-raised p-3 text-left shadow-sm"
              >
                <p className="text-base text-text">
                  {lot.product?.name ?? 'Unnamed'}
                  {taxBadge}
                </p>
                <p className="text-sm text-text-muted">
                  {lot.purchasedCount} {lot.purchasedCount === 1 ? 'unit' : 'units'} ·{' '}
                  {formatCents(lot.lineTotalCents)}
                  {lot.purchasedCount > 1 && <> → {formatCents(unitCost)}/u</>}
                </p>
                <p className="text-sm text-text-muted">
                  recv {lot.receivedCount}/{lot.purchasedCount}
                  {lot.bestBy && <> · BB {lot.bestBy}</>}
                  {heldBack && (
                    <span className="ml-2 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                      ⌂ held back
                    </span>
                  )}
                </p>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="add-line"
          onClick={() => setSheet({ open: true, line: null, proposal: null })}
          className={`${secondaryBtn} flex-1`}
        >
          + Add line
        </button>
        <button
          type="button"
          data-testid="add-excluded-line"
          onClick={() =>
            setSheet({ open: true, line: null, proposal: null, startExcluded: true })
          }
          className={`${secondaryBtn} flex-1`}
        >
          + Non-coop line
        </button>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={onBack} className={`${secondaryBtn} flex-1`}>
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={restock.lots.length === 0}
          className={`${primaryBtn} flex-1`}
        >
          Next
        </button>
      </div>

      {sheet.open && (
        <LineSheet
          restockId={restock.id}
          line={sheet.line}
          proposal={sheet.proposal}
          startExcluded={sheet.startExcluded}
          onClose={async (changed) => {
            // A saved proposal-edit consumes its proposal, like Confirm
            // (consumeProposal refetches when it settles).
            if (changed && sheet.proposal) consumeProposal(sheet.proposal.index);
            else if (changed) await refetch();
            setSheet({ open: false, line: null, proposal: null });
          }}
        />
      )}
    </div>
  );
}

function LineSheet({
  restockId,
  line,
  proposal,
  startExcluded,
  onClose,
}: {
  restockId: string;
  line: Line | null;
  /** VLM proposal prefill (slice 5): editing a proposed line opens the normal sheet, prefilled. */
  proposal?: (ProposedLine & { suggested: { id: string; name: string } | null }) | null;
  /** Open a NEW line straight into excluded (non-inventory) mode. */
  startExcluded?: boolean;
  onClose: (changed: boolean) => void;
}) {
  const trpc = useTRPC();
  // An excluded line has no product/units — only a total and taxable flag.
  const [excluded, setExcluded] = useState(line?.excluded ?? startExcluded ?? false);
  const [taxable, setTaxable] = useState(line?.taxable ?? proposal?.taxable ?? false);
  // The raw receipt text, when this line came from extraction — shown read-only
  // so the user always sees what the receipt actually said (falls back to the
  // clean name for older proposals without a raw line).
  const receiptText = line?.receiptText ?? proposal?.receiptText ?? proposal?.description ?? null;
  const [productQuery, setProductQuery] = useState('');
  const [product, setProduct] = useState<{ id: string | null; name: string } | null>(
    line?.product
      ? { id: line.product.id, name: line.product.name }
      : proposal
        ? (proposal.suggested ?? { id: null, name: proposal.description })
        : null,
  );
  // Camera UPC scan (blueprint 04 §2). The button renders only when a camera
  // API exists (secure context — plain-http LAN gets the manual path only,
  // which is why the search field also matches typed UPC digits). A scanned
  // code with no product match is KEPT and saved onto the inline-created
  // product. This sheet only ever renders client-side (opened by a tap), so
  // reading navigator during render is safe.
  const canScan =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const [scanOpen, setScanOpen] = useState(false);
  const [pendingUpc, setPendingUpc] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [units, setUnits] = useState(line?.purchasedCount ?? proposal?.unitCount ?? 1);
  const [lineTotal, setLineTotal] = useState(
    line
      ? centsToDollarsString(line.lineTotalCents)
      : proposal
        ? centsToDollarsString(proposal.lineTotalCents)
        : '',
  );
  const [received, setReceived] = useState(line?.receivedCount ?? 1);
  const [receivedTouched, setReceivedTouched] = useState(
    line ? line.receivedCount !== line.purchasedCount : false,
  );
  const [bestBy, setBestBy] = useState(line?.bestBy ?? '');
  const [error, setError] = useState<string | null>(null);

  const search = useQuery(
    trpc.product.search.queryOptions(
      { query: productQuery },
      { enabled: product === null },
    ),
  );

  const queryClient = useQueryClient();
  const saveLine = useMutation(
    trpc.restock.saveLine.mutationOptions({
      onSuccess: () => {
        // The save may have created a Product; cached search results from
        // before it existed (30s staleTime) would hide it from the next
        // line's picker — or the next restock's, in the same session.
        void queryClient.invalidateQueries(trpc.product.search.pathFilter());
        onClose(true);
      },
      onError: (e) => setError(e.message),
    }),
  );
  const deleteLine = useMutation(
    trpc.restock.deleteLine.mutationOptions({
      onSuccess: () => onClose(true),
      onError: (e) => setError(e.message),
    }),
  );

  const effectiveReceived = receivedTouched ? Math.min(received, units) : units;
  const totalCents = parseDollarsToCents(lineTotal);
  const unitCostPreview =
    totalCents !== null && units > 0 ? unitCostCents(totalCents, units) : null;

  function submit() {
    if (totalCents === null) {
      setError('Line total must look like 8.99');
      return;
    }
    if (excluded) {
      saveLine.mutate({
        restockId,
        lotId: line?.id,
        excluded: true,
        taxable,
        receiptText: receiptText ?? undefined,
        // Non-inventory: no product, no units.
        purchasedCount: 0,
        receivedCount: 0,
        lineTotalCents: totalCents,
        bestBy: null,
      });
      return;
    }
    if (!product) {
      setError('Pick a product or create one.');
      return;
    }
    saveLine.mutate({
      restockId,
      lotId: line?.id,
      productId: product.id ?? undefined,
      newProductName: product.id === null ? product.name : undefined,
      // A scanned-but-unmatched UPC rides along: onto the inline-created
      // product, or onto a picked EXISTING product that has no UPC yet (so a
      // pre-scan-era product gains its code and the next scan matches). The
      // chip below the picker shows exactly what will be saved, with a ✕ to
      // drop it.
      upc: pendingUpc ?? undefined,
      taxable,
      receiptText: receiptText ?? undefined,
      purchasedCount: units,
      receivedCount: effectiveReceived,
      lineTotalCents: totalCents,
      bestBy: bestBy || null,
    });
  }

  /** Scan result → product lookup (product.search matches upc for digit queries). */
  async function onScanDetected(code: string) {
    setScanOpen(false);
    try {
      const results = await queryClient.fetchQuery(
        trpc.product.search.queryOptions({ query: code }),
      );
      const match = results.find((p) => p.upc === code) ?? null;
      if (match) {
        setProduct({ id: match.id, name: match.name });
        setPendingUpc(null);
        setScanNotice(`Scanned ${code} — matched ${match.name}.`);
      } else {
        setProduct(null);
        setPendingUpc(code);
        setProductQuery('');
        setScanNotice(
          `Scanned ${code} — no product with this UPC yet. Pick or create one and the code sticks to it.`,
        );
      }
    } catch {
      setScanNotice(`Scanned ${code}, but the lookup failed — try the search field.`);
    }
  }

  const stepperBtn =
    'flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl">
        <h2 className="text-lg font-semibold">
          {line ? 'Edit line' : excluded ? 'Non-coop line' : proposal ? 'Edit proposed line' : 'Add line'}
        </h2>

        {/* The receipt line exactly as printed (extraction) — always shown so
            the user can reconcile the product they pick against the paper. */}
        {receiptText && (
          <p
            data-testid="line-receipt-text"
            className="rounded-lg bg-surface-sunken px-3 py-2 font-mono text-sm text-text-muted"
          >
            {receiptText}
          </p>
        )}

        {/* Exclude toggle: a whole receipt line that isn't going into the
            pantry — kept only so the receipt reconciles and fees distribute
            right (blueprint 01 D7). No product, no units. */}
        <label className="flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={excluded}
            data-testid="line-excluded"
            onChange={(e) => setExcluded(e.target.checked)}
            className="mt-0.5 size-5 accent-accent"
          />
          <span>
            Not going into the pantry
            <span className="block text-xs text-text-muted">
              A personal/non-coop line — counts toward the receipt and fee split only.
            </span>
          </span>
        </label>

        {/* Product picker: search-as-you-type, create inline (blueprint 02). */}
        {!excluded &&
          (product ? (
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-base text-text">
              {product.name}
              {product.id === null && (
                <span className="ml-2 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                  new
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={() => {
                setProduct(null);
                setProductQuery('');
              }}
              className="shrink-0 text-sm font-medium text-accent"
            >
              Change
            </button>
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Product
            <div className="flex gap-2">
              <input
                type="text"
                autoFocus
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
                placeholder="search, UPC, or create…"
                data-testid="product-search"
                className={`${inputClass} min-w-0 flex-1`}
              />
              {canScan && (
                <button
                  type="button"
                  data-testid="scan-upc"
                  aria-label="Scan barcode"
                  onClick={() => setScanOpen(true)}
                  className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm font-medium text-text transition-colors hover:bg-surface-sunken"
                >
                  <span aria-hidden>▥</span> Scan
                </button>
              )}
            </div>
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {productQuery.trim() &&
                !search.data?.some(
                  (p) => p.name.toLowerCase() === productQuery.trim().toLowerCase(),
                ) && (
                  <button
                    type="button"
                    data-testid="create-product"
                    onClick={() => setProduct({ id: null, name: productQuery.trim() })}
                    className="px-3 py-2.5 text-left text-sm font-medium text-accent"
                  >
                    Create &lsquo;{productQuery.trim()}&rsquo;
                  </button>
                )}
              {(search.data ?? []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid="product-result"
                  onClick={() => {
                    setProduct({ id: p.id, name: p.name });
                    // A product that already has a UPC can't take the scanned
                    // one — drop it rather than show a chip that would lie.
                    if (p.upc) setPendingUpc(null);
                  }}
                  className="px-3 py-2.5 text-left text-sm text-text hover:bg-surface-sunken"
                >
                  {p.name}
                  {p.upc && (
                    <span className="ml-2 font-mono text-xs text-text-muted">{p.upc}</span>
                  )}
                </button>
              ))}
            </div>
          </label>
          ))}

        {/* Scanned-UPC chip: visible from the scan all the way to Save (never
            silently attached), whatever the picker state — with ✕ to drop it
            if the scan was a mistake or belongs to something else. */}
        {!excluded && pendingUpc && (
          <span className="flex items-center gap-2 text-xs text-text-muted">
            <span
              data-testid="pending-upc"
              className="rounded-full bg-accent-soft px-2.5 py-0.5 font-mono font-medium text-accent-strong"
            >
              UPC {pendingUpc}
            </span>
            {product === null
              ? 'will be saved with the product you pick or create'
              : product.id === null
                ? 'will be saved with the new product'
                : `will be saved onto ${product.name}`}
            <button
              type="button"
              aria-label="Drop scanned UPC"
              onClick={() => setPendingUpc(null)}
              className="font-medium text-accent"
            >
              ✕
            </button>
          </span>
        )}

        {scanNotice && (
          <p role="status" data-testid="scan-notice" className="text-sm text-text-muted">
            {scanNotice}
          </p>
        )}

        {!excluded && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-text">Units</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Fewer units"
                disabled={units <= 1}
                onClick={() => setUnits((u) => Math.max(1, u - 1))}
                className={stepperBtn}
              >
                −
              </button>
              <span data-testid="units-value" className="w-8 text-center font-mono tabular-nums">
                {units}
              </span>
              <button
                type="button"
                aria-label="More units"
                onClick={() => setUnits((u) => u + 1)}
                className={stepperBtn}
              >
                +
              </button>
            </div>
          </div>
        )}

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {excluded ? 'Line total (from the receipt)' : 'Line total'}
          <input
            type="text"
            inputMode="decimal"
            value={lineTotal}
            onChange={(e) => setLineTotal(e.target.value)}
            placeholder="8.99"
            data-testid="line-total"
            className={inputClass}
          />
          {!excluded && unitCostPreview !== null && units > 1 && (
            <span className="text-xs font-normal text-text-muted">
              {formatCents(unitCostPreview)}/unit
            </span>
          )}
        </label>

        {/* Taxable: earns a share of the receipt tax at finalize (folded into
            the unit cost). Available on excluded lines too — their share is the
            purchaser's own cost. */}
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={taxable}
            data-testid="line-taxable"
            onChange={(e) => setTaxable(e.target.checked)}
            className="size-5 accent-accent"
          />
          Taxable — this line was taxed on the receipt
        </label>

        {!excluded && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-text">
              Received{' '}
              <span className="font-normal text-text-muted">
                {effectiveReceived}/{units}
                {effectiveReceived === 0 && ' — personal item'}
              </span>
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Receive fewer"
                disabled={effectiveReceived <= 0}
                onClick={() => {
                  setReceivedTouched(true);
                  setReceived(Math.max(0, effectiveReceived - 1));
                }}
                className={stepperBtn}
              >
                −
              </button>
              <span className="w-8 text-center font-mono tabular-nums">{effectiveReceived}</span>
              <button
                type="button"
                aria-label="Receive more"
                disabled={effectiveReceived >= units}
                onClick={() => {
                  setReceivedTouched(true);
                  setReceived(Math.min(units, effectiveReceived + 1));
                }}
                className={stepperBtn}
              >
                +
              </button>
            </div>
          </div>
        )}

        {!excluded && (
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Best-by (optional)
            <input
              type="date"
              value={bestBy}
              onChange={(e) => setBestBy(e.target.value)}
              className={inputClass}
            />
          </label>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          {line ? (
            <button
              type="button"
              onClick={() => deleteLine.mutate({ lotId: line.id })}
              disabled={deleteLine.isPending}
              className="min-h-11 rounded-lg bg-danger px-4 py-2.5 font-medium text-danger-contrast transition-colors hover:opacity-90 disabled:opacity-50"
            >
              Delete
            </button>
          ) : (
            <button type="button" onClick={() => onClose(false)} className={secondaryBtn}>
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={saveLine.isPending}
            data-testid="save-line"
            className={`${primaryBtn} flex-1`}
          >
            {saveLine.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {scanOpen && <ScanSheet onDetected={onScanDetected} onClose={() => setScanOpen(false)} />}
    </div>
  );
}

// ---- step 4: unit photos ----------------------------------------------------

function UnitPhotoCard({
  lot,
  restock,
  refetch,
}: {
  lot: Line;
  restock: Restock;
  refetch: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const setUnitPhoto = useMutation(trpc.restock.setUnitPhoto.mutationOptions());

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const jpeg = await downscaleToJpeg(file);
      const { path } = await uploadImage('units', jpeg);
      await setUnitPhoto.mutateAsync({ lotId: lot.id, path });
      await refetch();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <section
      data-testid="unit-photo-card"
      className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised p-3 shadow-sm"
    >
      {lot.unitPhotoPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/images/${lot.unitPhotoPath}`}
          alt={`${lot.product?.name ?? 'lot'} unit`}
          className="size-16 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : (
        <span className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-muted">
          🖼
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-text">{lot.product?.name ?? 'Unnamed'}</p>
        <p className="text-sm text-text-muted">{lot.receivedCount} into {restock.pantry.name}</p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        data-testid={`unit-photo-input-${lot.position}`}
        onChange={(e) => handleFile(e.target.files)}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="min-h-11 shrink-0 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : lot.unitPhotoPath ? 'Retake' : 'Photo'}
      </button>
    </section>
  );
}

function UnitPhotosStep({
  restock,
  refetch,
  onBack,
  onNext,
}: {
  restock: Restock;
  refetch: () => Promise<unknown>;
  onBack: () => void;
  onNext: () => void;
}) {
  const receiving = restock.lots.filter((l) => l.receivedCount > 0);
  const missing = receiving.filter((l) => !l.unitPhotoPath).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        One photo per new lot documents the packaging; the newest becomes the product photo.
      </p>
      {receiving.length === 0 && (
        <p className="text-sm text-text-muted">No received lines — nothing to photograph.</p>
      )}
      {receiving.map((lot) => (
        <UnitPhotoCard key={lot.id} lot={lot} restock={restock} refetch={refetch} />
      ))}
      {missing > 0 && (
        <div
          role="status"
          className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm font-medium text-warn"
        >
          {missing} {missing === 1 ? 'lot has' : 'lots have'} no photo — lot label only. You can
          add photos later.
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onBack} className={`${secondaryBtn} flex-1`}>
          Back
        </button>
        <button type="button" onClick={onNext} className={`${primaryBtn} flex-1`}>
          Next
        </button>
      </div>
    </div>
  );
}

// ---- step 5: reconcile + finalize -------------------------------------------

function ReconcileStep({
  restock,
  restockId,
  onBack,
  onDone,
  onEditDetails,
}: {
  restock: Restock;
  restockId: string;
  onBack: () => void;
  onDone: () => void;
  onEditDetails: () => void;
}) {
  const trpc = useTRPC();
  const [error, setError] = useState<string | null>(null);
  // Blueprint 02: outside the D7 auto-pass window, finalizing takes an EXTRA
  // "Finalize anyway…" confirm tap — the first tap only arms the button. The
  // arm is bound to the variance it was armed for: if the draft changes under
  // the user, the acknowledgment no longer applies and the button disarms.
  const [armedFor, setArmedFor] = useState<number | null>(null);
  const { varianceCents, autoPass, lineSumCents } = reconcileParts(restock);
  const armed = armedFor !== null && armedFor === varianceCents;
  const receivedUnits = restock.lots.reduce((s, l) => s + l.receivedCount, 0);

  const finalize = useMutation(
    trpc.restock.finalize.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  function onFinalizeClick() {
    if (!autoPass && !armed) {
      setArmedFor(varianceCents);
      return;
    }
    // Echo the variance being displayed; the server rejects the finalize if
    // the draft changed and the real variance no longer matches (D7).
    finalize.mutate({
      restockId,
      acknowledgedVarianceCents: autoPass ? null : varianceCents,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
        <p className="text-sm text-text-muted">
          {restock.retailer} · {restock.purchasedAt} · purchased by{' '}
          {restock.purchaserHousehold.name}
        </p>
        <p className="text-base text-text">
          {restock.lots.length} {restock.lots.length === 1 ? 'line' : 'lines'} · {receivedUnits}{' '}
          received units
        </p>
        <p className="text-base text-text">Lines total {formatCents(lineSumCents)}</p>
        {restock.taxCents !== null && (
          <p className="text-sm text-text-muted">
            + tax {formatCents(restock.taxCents)} (split across taxable lines)
          </p>
        )}
        {restock.feesCents !== null && (
          <p className="text-sm text-text-muted">
            + fees {formatCents(restock.feesCents)}
            {restock.feesDistributed ? ' (shared across lines)' : ' (purchaser pays)'}
          </p>
        )}
        {restock.receiptTotalCents !== null && (
          <p className="text-base text-text">Receipt total {formatCents(restock.receiptTotalCents)}</p>
        )}
      </section>

      <VarianceBanner restock={restock} onEditDetails={onEditDetails} />

      {restock.purchaserHousehold.id !== restock.pantry.householdId && (
        <p className="text-sm text-text-muted">
          Cross-household restock: {restock.purchaserHousehold.name} will be credited at cost for
          received units.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onBack} className={`${secondaryBtn} flex-1`}>
          Back
        </button>
        <button
          type="button"
          data-testid="finalize"
          onClick={onFinalizeClick}
          disabled={finalize.isPending || restock.lots.length === 0}
          className={`${primaryBtn} flex-1`}
        >
          {finalize.isPending
            ? 'Finalizing…'
            : autoPass || !armed
              ? 'Finalize'
              : `Finalize anyway — receipt differs by ${formatCents(Math.abs(varianceCents!))}`}
        </button>
      </div>
    </div>
  );
}

// ---- step 6: done -------------------------------------------------------------

function DoneStep({ restock, pantryId }: { restock: Restock; pantryId: string }) {
  const { lineSumCents } = reconcileParts(restock);
  const receivedUnits = restock.lots.reduce((s, l) => s + l.receivedCount, 0);
  const code =
    restock.dateCode && restock.seq ? restockCode(restock.dateCode, restock.seq) : '—';

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-10 text-center">
      <p className="text-lg font-semibold">Restock finalized</p>
      <p
        data-testid="restock-code"
        className="rounded-xl bg-surface-sunken px-6 py-4 font-mono text-5xl font-bold tracking-widest"
      >
        {code}
      </p>
      <p className="text-sm text-text-muted">
        Label the crate/shelf with this code — it identifies these lots.
      </p>
      <p className="text-base text-text">
        {restock.lots.length} {restock.lots.length === 1 ? 'lot' : 'lots'} · {receivedUnits} units
        · {formatCents(lineSumCents)}
      </p>
      <div className="flex gap-2">
        <Link href={`/restocks/${restock.id}`} className={secondaryBtn}>
          View restock
        </Link>
        <Link href={`/pantries/${pantryId}`} className={primaryBtn}>
          Back to pantry
        </Link>
      </div>
    </div>
  );
}
