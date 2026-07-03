'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { newClientKey } from '@/lib/client-key';
import { downscaleToJpeg, uploadImage } from '@/lib/downscale';
import { centsToDollarsString, formatCents, parseDollarsToCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';
import { dueShortDate, isOverdue, localShortDate } from '../format';
import { FeeBadge, OverdueBadge } from '../items-view';

export type ItemDetail = {
  id: string;
  name: string;
  photoPath: string | null;
  notes: string | null;
  feeCents: number;
  householdId: string;
  householdName: string;
  isYours: boolean;
  /** Newest first; the first unreturned loan (if any) is the active one. */
  loans: {
    id: string;
    borrowerName: string;
    borrowerHouseholdId: string;
    borrowerHouseholdName: string;
    chargedFeeCents: number;
    /** True when undoCheckout posted a REVERSAL — the fee netted $0. */
    feeReversed: boolean;
    outAt: string; // ISO
    dueAt: string | null; // ISO, date-only (UTC midnight)
    returnedAt: string | null; // ISO
    conditionReturned: string | null;
  }[];
};

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

export function ItemDetailView({
  item,
  yourHouseholdId,
}: {
  item: ItemDetail;
  yourHouseholdId: string;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [toast, setToast] = useState<{ loanId: string; label: string } | null>(null);
  const [toastError, setToastError] = useState<string | null>(null);

  const active = item.loans.find((l) => l.returnedAt === null) ?? null;
  const overdue = active !== null && isOverdue(active.dueAt);
  // Return is gated to the borrower's or the owner's household (blueprint 01
  // authz matrix); the server enforces the same rule.
  const mayReturn =
    active !== null && (active.borrowerHouseholdId === yourHouseholdId || item.isYours);

  // Mirrors the take toast: the undo affordance lives 10s; the server allows
  // the undo for a longer grace window (a mistaken checkout, fee reversed).
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const undo = useMutation(
    trpc.loan.undoCheckout.mutationOptions({
      onSuccess: () => {
        setToast(null);
        setToastError(null);
        router.refresh();
      },
      onError: (e) => setToastError(e.message),
    }),
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center gap-3">
        <Link href="/items" aria-label="Back to items" className="shrink-0 text-lg text-text-muted">
          ←
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
          {item.name}
        </h1>
        {item.isYours && (
          <button
            type="button"
            data-testid="edit-item"
            onClick={() => setEditOpen(true)}
            className="min-h-11 shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-surface-sunken"
          >
            Edit
          </button>
        )}
      </header>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
        <div className="flex items-start gap-4">
          {item.photoPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/images/${item.photoPath}`}
              alt={item.name}
              className="size-24 shrink-0 rounded-lg border border-border object-cover"
            />
          ) : (
            <span className="flex size-24 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-2xl text-text-muted">
              ⛏
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
              {item.isYours ? 'Yours' : item.householdName}
              <FeeBadge feeCents={item.feeCents} />
              {item.feeCents === 0 && <span>· no fee</span>}
            </p>
            {item.notes && <p className="mt-1 text-sm text-text">{item.notes}</p>}
            <p data-testid="item-status" className="mt-2 flex items-center gap-2 text-sm">
              {active ? (
                <>
                  <span className="text-text">
                    Out to{' '}
                    {active.borrowerHouseholdId === yourHouseholdId
                      ? active.borrowerName
                      : active.borrowerHouseholdName}{' '}
                    since {localShortDate(active.outAt)}
                    {active.dueAt && <> · due {dueShortDate(active.dueAt)}</>}
                  </span>
                  {overdue && <OverdueBadge />}
                </>
              ) : (
                <span className="font-medium text-success">Available</span>
              )}
            </p>
          </div>
        </div>

        {active === null ? (
          <button
            type="button"
            data-testid="open-checkout"
            onClick={() => setCheckoutOpen(true)}
            className={primaryBtn}
          >
            Check out…
          </button>
        ) : mayReturn ? (
          <button
            type="button"
            data-testid="open-return"
            onClick={() => setReturnOpen(true)}
            className={primaryBtn}
          >
            Return…
          </button>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          History · {item.loans.length} {item.loans.length === 1 ? 'loan' : 'loans'}
        </h2>
        {item.loans.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border-strong px-6 py-8 text-center text-sm text-text-muted">
            Never borrowed yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
            {item.loans.map((loan) => (
              <li key={loan.id} data-testid="loan-row" className="flex flex-col gap-0.5 py-3">
                <p className="flex items-center gap-2 text-sm text-text">
                  <span className="min-w-0 truncate">
                    {loan.borrowerName} ({loan.borrowerHouseholdName})
                  </span>
                  {loan.chargedFeeCents > 0 &&
                    (loan.feeReversed ? (
                      <span
                        data-testid="loan-fee-reversed"
                        className="shrink-0 font-mono text-xs tabular-nums text-text-muted"
                      >
                        <s>fee {formatCents(loan.chargedFeeCents)}</s> reversed
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                        fee {formatCents(loan.chargedFeeCents)}
                      </span>
                    ))}
                </p>
                <p className="flex items-center gap-2 text-sm text-text-muted">
                  {localShortDate(loan.outAt)} →{' '}
                  {loan.returnedAt ? localShortDate(loan.returnedAt) : 'out'}
                  {loan.dueAt && !loan.returnedAt && <> · due {dueShortDate(loan.dueAt)}</>}
                  {!loan.returnedAt && isOverdue(loan.dueAt) && <OverdueBadge />}
                </p>
                {loan.conditionReturned && (
                  <p data-testid="loan-condition" className="text-sm text-text-muted">
                    “{loan.conditionReturned}”
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {checkoutOpen && (
        <CheckoutSheet
          item={item}
          cross={!item.isYours}
          onClose={() => setCheckoutOpen(false)}
          onDone={(loanId) => {
            setCheckoutOpen(false);
            setToastError(null);
            setToast({ loanId, label: `Checked out ${item.name}` });
            router.refresh();
          }}
        />
      )}

      {returnOpen && active && (
        <ReturnSheet
          loanId={active.id}
          itemName={item.name}
          onClose={() => setReturnOpen(false)}
          onDone={() => {
            setReturnOpen(false);
            router.refresh();
          }}
        />
      )}

      {editOpen && (
        <EditItemSheet
          item={item}
          onClose={() => setEditOpen(false)}
          onDone={() => {
            setEditOpen(false);
            router.refresh();
          }}
        />
      )}

      {toast && (
        <div
          role="status"
          data-testid="checkout-toast"
          data-loan-id={toast.loanId}
          className="fixed inset-x-4 bottom-16 z-30 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3 shadow-sm"
        >
          <p className="min-w-0 truncate text-sm text-text">{toastError ?? toast.label}</p>
          <button
            type="button"
            data-testid="checkout-undo"
            disabled={undo.isPending}
            onClick={() => undo.mutate({ loanId: toast.loanId })}
            className="shrink-0 text-sm font-medium text-accent disabled:opacity-50"
          >
            {undo.isPending ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Check-out sheet (blueprint 02): borrower is always the acting user — no
 * picker. Due date optional; the fee is read-only, with "posts to the ledger
 * now" when it will actually post (fee > 0 AND cross-household, invariant 10).
 */
function CheckoutSheet({
  item,
  cross,
  onClose,
  onDone,
}: {
  item: ItemDetail;
  cross: boolean;
  onClose: () => void;
  onDone: (loanId: string) => void;
}) {
  const trpc = useTRPC();
  // One idempotency key per sheet open: a double-tap on "Check out" (racing
  // the disabled re-render) or a retry after a lost response replays as the
  // SAME loan server-side — the fee can never post twice.
  const [clientKey] = useState(newClientKey);
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const checkout = useMutation(
    trpc.loan.checkout.mutationOptions({
      onSuccess: (r) => onDone(r.loanId),
      onError: (e) => setError(e.message),
    }),
  );

  const feePosts = cross && item.feeCents > 0;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="checkout-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          // expectedFeeCents = the fee this sheet DISPLAYED: the server
          // rejects (412) if the owner changed it since page load, so the
          // borrower is never charged an amount they didn't see.
          checkout.mutate({
            itemId: item.id,
            dueAt: dueAt || null,
            expectedFeeCents: item.feeCents,
            clientKey,
          });
        }}
      >
        <h2 className="text-lg font-semibold">Check out: {item.name}</h2>
        <p className="text-sm text-text-muted">
          You&apos;re the borrower — loans are always checked out to yourself.
        </p>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Due back (optional)
          <input
            type="date"
            data-testid="checkout-due"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className={inputClass}
          />
        </label>

        {feePosts ? (
          <div
            role="status"
            data-testid="checkout-fee-note"
            className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm font-medium text-warn"
          >
            Fee {formatCents(item.feeCents)} — posts to the ledger now, not at return.
          </div>
        ) : item.feeCents > 0 ? (
          <p data-testid="checkout-fee-note" className="text-sm text-text-muted">
            No fee — your household&apos;s own item.
          </p>
        ) : null}

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
            data-testid="checkout-submit"
            disabled={checkout.isPending}
            className={primaryBtn}
          >
            {checkout.isPending ? 'Checking out…' : 'Check out'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Return sheet (blueprint 02): optional condition note → status flips. */
function ReturnSheet({
  loanId,
  itemName,
  onClose,
  onDone,
}: {
  loanId: string;
  itemName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const doReturn = useMutation(
    trpc.loan.return.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="return-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          doReturn.mutate({ loanId, conditionNote: note.trim() || undefined });
        }}
      >
        <h2 className="text-lg font-semibold">Return: {itemName}</h2>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Condition note (optional)
          <input
            type="text"
            data-testid="return-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Works fine, gasket looks tired"
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
            data-testid="return-submit"
            disabled={doReturn.isPending}
            className={primaryBtn}
          >
            {doReturn.isPending ? 'Returning…' : 'Return'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Owner-household edit (blueprint 01 authz: "Create/edit Item, edit
 * feeCents"). Fee changes affect future loans only — the snapshot on past
 * loans is immutable.
 */
function EditItemSheet({
  item,
  onClose,
  onDone,
}: {
  item: ItemDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(item.name);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [fee, setFee] = useState(item.feeCents === 0 ? '' : centsToDollarsString(item.feeCents));
  const [newPhoto, setNewPhoto] = useState<{ path: string; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useMutation(
    trpc.item.update.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const jpeg = await downscaleToJpeg(file);
      const { path } = await uploadImage('items', jpeg);
      if (newPhoto) URL.revokeObjectURL(newPhoto.preview);
      setNewPhoto({ path, preview: URL.createObjectURL(jpeg) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const previewSrc = newPhoto
    ? newPhoto.preview
    : item.photoPath
      ? `/api/images/${item.photoPath}`
      : null;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="edit-item-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const feeCents = fee.trim() ? parseDollarsToCents(fee) : 0;
          if (feeCents === null) {
            setError('Fee must look like 5.00 (or be left empty).');
            return;
          }
          update.mutate({
            itemId: item.id,
            name: name.trim(),
            notes: notes.trim() || null,
            feeCents,
            photoPath: newPhoto?.path, // undefined = keep the current photo
          });
        }}
      >
        <h2 className="text-lg font-semibold">Edit item</h2>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Name
          <input
            type="text"
            required
            data-testid="edit-item-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>

        <div className="flex items-center gap-3">
          {previewSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewSrc}
              alt="Item"
              className="size-16 shrink-0 rounded-lg border border-border object-cover"
            />
          ) : (
            <span className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-muted">
              ⛏
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => handleFile(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : previewSrc ? 'Replace photo' : 'Photo (optional)'}
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Notes (optional)
          <input
            type="text"
            data-testid="edit-item-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Fee per loan (optional)
          <input
            type="text"
            inputMode="decimal"
            data-testid="edit-item-fee"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder="0.00"
            className={inputClass}
          />
          <span className="text-xs font-normal text-text-muted">
            Applies to future loans only — fees already posted never change.
          </span>
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
            data-testid="edit-item-save"
            disabled={update.isPending || uploading}
            className={primaryBtn}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
