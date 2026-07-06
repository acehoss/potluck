'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BackLink } from '@/app/nav-history';
import { useRef, useState } from 'react';
import { ScanSheet } from '@/app/scan-sheet';
import { newClientKey } from '@/lib/client-key';
import { downscaleToJpeg, uploadImage } from '@/lib/downscale';
import { formatCents, parseDollarsToCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';
import { VisibilityControl } from '../../visibility-control';

export type ProductGroup = {
  productId: string;
  name: string;
  upc: string | null;
  photoPath: string | null;
  total: number;
  lots: {
    id: string;
    restockId: string;
    code: string;
    remaining: number;
    unitCostCents: number;
    purchasedAt: string; // ISO
    bestBy: string | null; // ISO
    unitPhotoPath: string | null;
  }[];
};

type Household = { id: string; name: string };

/** A lot plus its product name, for the lot menu and adjustment sheets. */
type LotRef = { lot: ProductGroup['lots'][number]; productName: string };

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
  cart,
  cartQtyByLot,
  visibility,
  scopeCircleIds,
  canManageVisibility,
}: {
  pantry: { id: string; name: string; householdName: string };
  isOwn: boolean;
  groups: ProductGroup[];
  draft: { id: string; retailer: string } | null;
  households: Household[];
  yourHouseholdId: string;
  cart: { orderId: string; count: number; units: number } | null;
  cartQtyByLot: Record<string, number>;
  /** Pantry circle-scoped visibility (REWORK P4); control shown to owner
   *  managers only. */
  visibility: 'ALL' | 'SELECT' | 'PRIVATE';
  scopeCircleIds: string[];
  canManageVisibility: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [startOpen, setStartOpen] = useState(false);
  // Find-by-scan in the take flow (SPEC §5: "find product (search/scan)"):
  // a scan that matches a product's UPC jumps straight into its take sheet.
  // Same camera-API gate as the receive wizard's line sheet — hidden on
  // plain-http LAN, where typing stays the path. Safe to read during render:
  // this is a client component and the value never changes within a page.
  const canScan =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const [scanOpen, setScanOpen] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [orderFor, setOrderFor] = useState<ProductGroup | null>(null);
  const [lotMenu, setLotMenu] = useState<LotRef | null>(null);
  const [recountFor, setRecountFor] = useState<LotRef | null>(null);
  const [writeOffFor, setWriteOffFor] = useState<LotRef | null>(null);

  const visible = groups.filter((g) => g.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center gap-3">
        <BackLink fallback="/home" />
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
          {pantry.name} <span className="font-normal text-text-muted">({pantry.householdName})</span>
        </h1>
        {canManageVisibility && (
          <VisibilityControl
            idPrefix="pantry"
            targetId={pantry.id}
            visibility={visibility}
            circleIds={scopeCircleIds}
          />
        )}
        {isOwn && (
          <Link
            href={`/pantries/${pantry.id}/restocks`}
            data-testid="restock-history-link"
            className="shrink-0 rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-sunken"
          >
            History
          </Link>
        )}
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
        <div className="flex gap-2">
          <input
            type="search"
            placeholder="search products…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
          {canScan && (
            <button
              type="button"
              data-testid="inventory-scan"
              aria-label="Scan barcode to take"
              onClick={() => {
                setScanNotice(null);
                setScanOpen(true);
              }}
              className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm font-medium text-text transition-colors hover:bg-surface-sunken"
            >
              <span aria-hidden>▥</span> Scan
            </button>
          )}
        </div>
      )}

      {scanNotice && (
        <p role="status" data-testid="inventory-scan-notice" className="text-sm text-text-muted">
          {scanNotice}
        </p>
      )}

      <main className="flex flex-col gap-3">
        {groups.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
            {isOwn ? (
              <>
                <p className="text-4xl" aria-hidden>
                  🧺
                </p>
                <p className="text-base font-medium text-text">Your pantry&apos;s empty — for now.</p>
                <p className="text-sm text-text-muted">
                  Snap a receipt from your last shopping trip and everything on it shows up here,
                  ready to share at cost. Takes about two minutes.
                </p>
                <button
                  type="button"
                  onClick={() => setStartOpen(true)}
                  className="mt-1 min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
                >
                  Receive a shopping trip
                </button>
              </>
            ) : (
              <>
                <p className="text-4xl" aria-hidden>
                  🧺
                </p>
                <p className="text-base font-medium text-text">Nothing to browse yet.</p>
                <p className="text-sm text-text-muted">
                  The {pantry.householdName} household hasn&apos;t added anything here yet. Once
                  they receive a shopping trip, you&apos;ll be able to grab what you need.
                </p>
              </>
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
              {/* Row tap adds to your order; expanding lots is the other
                  affordance — chevron only. */}
              <div className="flex min-h-14 w-full items-center">
                <button
                  type="button"
                  onClick={() => setOrderFor(group)}
                  className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left"
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
                  <span
                    data-testid="product-total"
                    className="shrink-0 font-mono text-sm tabular-nums text-text-muted"
                  >
                    {group.total}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="product-expand"
                  aria-label={isExpanded ? `Hide ${group.name} lots` : `Show ${group.name} lots`}
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.productId)) next.delete(group.productId);
                      else next.add(group.productId);
                      return next;
                    })
                  }
                  className="flex w-14 shrink-0 items-center justify-center self-stretch text-sm text-text-muted transition-colors hover:bg-surface-sunken"
                >
                  {isExpanded ? '▾' : '▸'}
                </button>
              </div>
              {isExpanded && (
                <ul className="divide-y divide-border border-t border-border px-3">
                  {group.lots.map((lot) => (
                    <li
                      key={lot.id}
                      data-testid="lot-row"
                      className="flex min-h-11 items-center justify-between gap-2 py-1"
                    >
                      <p className="text-sm text-text">
                        {/* Code links to the restock detail — that's also where
                            own-household takes can be undone after the toast. */}
                        <Link
                          href={`/restocks/${lot.restockId}`}
                          className="font-mono text-accent underline-offset-2 hover:underline"
                        >
                          {lot.code}
                        </Link>{' '}
                        · {lot.remaining} left
                      </p>
                      <p className="min-w-0 flex-1 text-right text-sm text-text-muted">
                        {ageLabel(lot.purchasedAt)}
                        {lot.bestBy && <> · {bestByBadge(lot.bestBy)}</>}
                      </p>
                      {isOwn && (
                        <button
                          type="button"
                          data-testid="lot-menu"
                          aria-label={`Lot ${lot.code} actions`}
                          onClick={() => setLotMenu({ lot, productName: group.name })}
                          className="-my-1 flex size-11 shrink-0 items-center justify-center rounded-lg text-base text-text-muted transition-colors hover:bg-surface-sunken"
                        >
                          ⋯
                        </button>
                      )}
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
          className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-10 min-h-12 rounded-full bg-accent px-5 py-3 font-medium text-accent-contrast shadow-sm transition-colors hover:bg-accent-strong"
        >
          + Receive
        </button>
      )}

      {scanOpen && (
        <ScanSheet
          onDetected={(code) => {
            setScanOpen(false);
            // Codes are stored normalized (server-side), so an exact match
            // against the pantry's products is the whole lookup.
            const group = groups.find((g) => g.upc === code);
            if (group) {
              setOrderFor(group);
            } else {
              setScanNotice(`Scanned ${code} — nothing with this UPC in this pantry.`);
            }
          }}
          onClose={() => setScanOpen(false)}
        />
      )}

      {startOpen && (
        <StartRestockSheet
          pantryId={pantry.id}
          households={households}
          yourHouseholdId={yourHouseholdId}
          onClose={() => setStartOpen(false)}
        />
      )}

      {lotMenu && (
        <LotMenuSheet
          lotRef={lotMenu}
          onClose={() => setLotMenu(null)}
          onRecount={() => {
            setRecountFor(lotMenu);
            setLotMenu(null);
          }}
          onWriteOff={() => {
            setWriteOffFor(lotMenu);
            setLotMenu(null);
          }}
          onPhotoSet={() => {
            setLotMenu(null);
            router.refresh();
          }}
        />
      )}

      {recountFor && (
        <RecountSheet
          lotRef={recountFor}
          onClose={() => setRecountFor(null)}
          onDone={() => {
            setRecountFor(null);
            router.refresh();
          }}
        />
      )}

      {writeOffFor && (
        <WriteOffSheet
          lotRef={writeOffFor}
          onClose={() => setWriteOffFor(null)}
          onDone={() => {
            setWriteOffFor(null);
            router.refresh();
          }}
        />
      )}

      {orderFor && (
        <AddToOrderSheet
          group={orderFor}
          pantryId={pantry.id}
          ownerName={pantry.householdName}
          isOwn={isOwn}
          cartQtyByLot={cartQtyByLot}
          onClose={() => setOrderFor(null)}
          onAdded={() => {
            setOrderFor(null);
            router.refresh();
          }}
        />
      )}

      {cart && (
        <Link
          href={`/orders/${cart.orderId}`}
          data-testid="cart-bar"
          className="fixed inset-x-4 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 shadow-sm"
        >
          <span className="text-sm font-medium text-accent-strong">
            🛒 {cart.units} {cart.units === 1 ? 'unit' : 'units'} in your order
          </span>
          <span className="shrink-0 text-sm font-semibold text-accent-strong">Review →</span>
        </Link>
      )}
    </div>
  );
}

/**
 * Take sheet (blueprint 02): two taps for the common case. Oldest lot
 * preselected with a FIFO badge — suggested, never enforced; overtake is
 * blocked at the stepper (and again by the server's conditional decrement).
 */
function AddToOrderSheet({
  group,
  pantryId,
  ownerName,
  isOwn,
  cartQtyByLot,
  onClose,
  onAdded,
}: {
  group: ProductGroup;
  pantryId: string;
  ownerName: string;
  isOwn: boolean;
  cartQtyByLot: Record<string, number>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const trpc = useTRPC();
  // Lots arrive oldest-first (FIFO order); index 0 is the suggestion.
  const cartQtyOf = (lotId: string) => cartQtyByLot[lotId] ?? 0;
  const seedQty = (l: ProductGroup['lots'][number]) =>
    Math.min(Math.max(cartQtyOf(l.id) || 1, 1), l.remaining);
  const [lotId, setLotId] = useState(group.lots[0].id);
  const [qty, setQty] = useState(() => seedQty(group.lots[0]));
  const [error, setError] = useState<string | null>(null);
  const lot = group.lots.find((l) => l.id === lotId) ?? group.lots[0];
  const isFifo = lot.id === group.lots[0].id;
  const inCart = cartQtyOf(lot.id) > 0;
  const costCents = qty * lot.unitCostCents;

  const add = useMutation(
    trpc.order.addToCart.mutationOptions({
      onSuccess: () => onAdded(),
      onError: (e) => setError(e.message),
    }),
  );

  const stepperBtn =
    'flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="order-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold">Add to order: {group.name}</h2>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          <span className="flex items-center gap-2">
            Lot
            {isFifo && (
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                oldest ✓
              </span>
            )}
          </span>
          <select
            data-testid="order-lot"
            value={lotId}
            onChange={(e) => {
              const next = group.lots.find((l) => l.id === e.target.value) ?? group.lots[0];
              setLotId(next.id);
              setQty(seedQty(next));
            }}
            className="min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          >
            {group.lots.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} · {l.remaining} available
              </option>
            ))}
          </select>
          <span className="text-xs font-normal text-text-muted">
            {lot.remaining} available
            {lot.bestBy && <> · {bestByBadge(lot.bestBy)}</>}
            {inCart && <> · {cartQtyOf(lot.id)} already in your order</>}
          </span>
        </label>

        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text">
            Qty <span className="font-normal text-text-muted">{formatCents(lot.unitCostCents)}/u</span>
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Fewer"
              disabled={qty <= 1}
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className={stepperBtn}
            >
              −
            </button>
            <span data-testid="order-qty" className="w-8 text-center font-mono tabular-nums">
              {qty}
            </span>
            <button
              type="button"
              aria-label="More"
              disabled={qty >= lot.remaining}
              onClick={() => setQty((q) => Math.min(lot.remaining, q + 1))}
              className={stepperBtn}
            >
              +
            </button>
          </div>
        </div>

        <p data-testid="order-cost" className="text-sm font-medium text-text">
          {isOwn ? (
            'No charge — your own pantry'
          ) : (
            <>
              Adds {formatCents(costCents)} you&apos;d owe {ownerName} at pickup
            </>
          )}
        </p>

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
            type="button"
            data-testid="order-add"
            disabled={add.isPending}
            onClick={() => add.mutate({ pantryId, lotId: lot.id, quantity: qty })}
            className="min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            {add.isPending ? 'Saving…' : inCart ? 'Update order' : 'Add to order'}
          </button>
        </div>
      </div>
    </div>
  );
}

const sheetInputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const sheetStepperBtn =
  'flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40';
const sheetPrimaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50';
const sheetSecondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken';

/**
 * Lot `⋯` menu (blueprint 02, slice 4): Recount / Write off / Add photo /
 * View restock. Only rendered on the viewer's own household's pantries
 * (authz matrix: recount/write-off are owner-household-only; the server
 * gates too). The photo action is the "add photos later" path the receive
 * wizard's skip copy promises (blueprint 02 receiving step 4) — it uploads a
 * unit photo and attaches it via restock.setUnitPhoto, which stays open
 * after finalize.
 */
function LotMenuSheet({
  lotRef,
  onClose,
  onRecount,
  onWriteOff,
  onPhotoSet,
}: {
  lotRef: LotRef;
  onClose: () => void;
  onRecount: () => void;
  onWriteOff: () => void;
  onPhotoSet: () => void;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setUnitPhoto = useMutation(trpc.restock.setUnitPhoto.mutationOptions());

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const jpeg = await downscaleToJpeg(file);
      const { path } = await uploadImage('units', jpeg);
      await setUnitPhoto.mutateAsync({ lotId: lotRef.lot.id, path });
      onPhotoSet();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const itemClass =
    'flex min-h-12 w-full items-center rounded-lg px-3 text-left text-base font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="lot-menu-sheet"
        className="flex w-full max-w-md flex-col gap-2 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold">
          <span className="font-mono">{lotRef.lot.code}</span> · {lotRef.productName}
        </h2>
        <p className="text-sm text-text-muted">{lotRef.lot.remaining} left</p>
        <button type="button" data-testid="menu-recount" onClick={onRecount} className={itemClass}>
          Recount
        </button>
        <button
          type="button"
          data-testid="menu-writeoff"
          onClick={onWriteOff}
          className={itemClass}
        >
          Write off
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          data-testid="menu-photo-input"
          onChange={(e) => handleFile(e.target.files)}
          className="hidden"
        />
        <button
          type="button"
          data-testid="menu-photo"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className={itemClass}
        >
          {uploading
            ? 'Uploading…'
            : lotRef.lot.unitPhotoPath
              ? 'Replace unit photo'
              : 'Add unit photo'}
        </button>
        <Link
          href={`/restocks/${lotRef.lot.restockId}`}
          data-testid="menu-view-restock"
          className={itemClass}
        >
          View restock
        </Link>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button type="button" onClick={onClose} className={sheetSecondaryBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Recount sheet (blueprint 02): "Counted how many? (app says N)". The client
 * sends the target count ONLY — the server reads countBefore in-transaction
 * and writes via a guarded updateMany (blueprint 01 D3/B3). No ledger effect
 * in v1: the owner eats count drift.
 */
function RecountSheet({
  lotRef,
  onClose,
  onDone,
}: {
  lotRef: LotRef;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  // One idempotency key per sheet open — a double-tap replays as the same
  // adjustment instead of recording twice.
  const [clientKey] = useState(newClientKey);
  const [count, setCount] = useState(lotRef.lot.remaining);
  const [error, setError] = useState<string | null>(null);

  const recount = useMutation(
    trpc.adjustment.recount.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="recount-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold">Recount: {lotRef.productName}</h2>
        <p className="text-sm text-text-muted">
          Lot <span className="font-mono">{lotRef.lot.code}</span>
          {' — '}fix count drift by entering what&apos;s physically on the shelf. Spoiled or
          damaged units should be a{' '}
          <span className="font-medium text-text">write-off</span> instead.
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text">
            Counted how many?{' '}
            <span className="font-normal text-text-muted">(app says {lotRef.lot.remaining})</span>
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Fewer"
              disabled={count <= 0}
              onClick={() => setCount((c) => Math.max(0, c - 1))}
              className={sheetStepperBtn}
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={10_000}
              data-testid="recount-count"
              aria-label="Counted units"
              value={count}
              onChange={(e) => {
                const n = Number(e.target.value);
                setCount(Number.isInteger(n) && n >= 0 ? Math.min(n, 10_000) : 0);
              }}
              className={`${sheetInputClass} w-20 text-center font-mono tabular-nums`}
            />
            <button
              type="button"
              aria-label="More"
              disabled={count >= 10_000}
              onClick={() => setCount((c) => Math.min(10_000, c + 1))}
              className={sheetStepperBtn}
            >
              +
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={sheetSecondaryBtn}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="recount-submit"
            disabled={recount.isPending}
            onClick={() => recount.mutate({ lotId: lotRef.lot.id, countAfter: count, clientKey })}
            className={sheetPrimaryBtn}
          >
            {recount.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const WRITE_OFF_REASONS = ['Expired', 'Damaged', 'Other'] as const;

/**
 * Write-off sheet (blueprint 02): count (default all remaining) + required
 * reason. Decrements inventory; the owner household eats the cost in v1
 * (blueprint 01 invariant 8) — no ledger entry.
 */
function WriteOffSheet({
  lotRef,
  onClose,
  onDone,
}: {
  lotRef: LotRef;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  // One idempotency key per sheet open: write-offs are CUMULATIVE, so a
  // double-tap without this would decrement the lot twice.
  const [clientKey] = useState(newClientKey);
  const [count, setCount] = useState(Math.max(1, lotRef.lot.remaining));
  const [reason, setReason] = useState<(typeof WRITE_OFF_REASONS)[number]>('Expired');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const writeOff = useMutation(
    trpc.adjustment.writeOff.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="writeoff-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold">Write off: {lotRef.productName}</h2>
        <p className="text-sm text-text-muted">
          Lot <span className="font-mono">{lotRef.lot.code}</span> — for expired, spoiled, or
          damaged units. Your household eats the cost. If the shelf count is just off, use{' '}
          <span className="font-medium text-text">Recount</span> instead.
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text">
            Units{' '}
            <span className="font-normal text-text-muted">of {lotRef.lot.remaining} left</span>
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Fewer"
              disabled={count <= 1}
              onClick={() => setCount((c) => Math.max(1, c - 1))}
              className={sheetStepperBtn}
            >
              −
            </button>
            <span data-testid="writeoff-count" className="w-8 text-center font-mono tabular-nums">
              {count}
            </span>
            <button
              type="button"
              aria-label="More"
              disabled={count >= lotRef.lot.remaining}
              onClick={() => setCount((c) => Math.min(lotRef.lot.remaining, c + 1))}
              className={sheetStepperBtn}
            >
              +
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium text-text">
          Reason
          <div className="flex gap-2" role="radiogroup" aria-label="Reason">
            {WRITE_OFF_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={reason === r}
                onClick={() => setReason(r)}
                className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  reason === r
                    ? 'bg-accent text-accent-contrast'
                    : 'border border-border-strong text-text hover:bg-surface-sunken'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Note (optional)
          <input
            type="text"
            data-testid="writeoff-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Freezer failure"
            className={sheetInputClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={sheetSecondaryBtn}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="writeoff-submit"
            disabled={writeOff.isPending || lotRef.lot.remaining === 0}
            onClick={() =>
              writeOff.mutate({
                lotId: lotRef.lot.id,
                count,
                reason: [reason, note.trim()].filter(Boolean).join(' — '),
                clientKey,
              })
            }
            className={sheetPrimaryBtn}
          >
            {writeOff.isPending ? 'Writing off…' : 'Write off'}
          </button>
        </div>
      </div>
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
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
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
