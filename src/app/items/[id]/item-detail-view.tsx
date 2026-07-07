'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { newClientKey } from '@/lib/client-key';
import { centsToDollarsString, formatCents, parseDollarsToCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';
import { Linkified } from '../../linkified';
import { MediaGallery, type GalleryImage } from '../../media-gallery';
import { VisibilityControl } from '../../visibility-control';
import { dueShortDate, isOverdue, localShortDate } from '../format';
import { FeeBadge, OverdueBadge } from '../items-view';

export type ItemAttachment = {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
  position: number;
};

export type ItemDetail = {
  id: string;
  name: string;
  images: GalleryImage[];
  attachments: ItemAttachment[];
  notes: string | null;
  feeCents: number;
  /** Circle-scoped visibility (REWORK P4) — PRIVATE items are connection-
   *  invisible; SELECT limits to the scoped circles. */
  visibility: 'ALL' | 'SELECT' | 'PRIVATE';
  /** Circles this item is scoped to when visibility is SELECT (owner prefill). */
  scopeCircleIds: string[];
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
  canManageVisibility,
  canManageMedia,
}: {
  item: ItemDetail;
  yourHouseholdId: string;
  /** Owner + manageHousehold — gates the visibility control (P4/A3a). */
  canManageVisibility: boolean;
  /** Owner + lendBorrow — gates photo gallery + attachment editing. */
  canManageMedia: boolean;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const addImage = useMutation(trpc.item.addImage.mutationOptions());
  const removeImage = useMutation(trpc.item.removeImage.mutationOptions());
  const setMainImage = useMutation(trpc.item.setMain.mutationOptions());
  const setImageLabel = useMutation(trpc.item.setLabel.mutationOptions());
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
        {canManageVisibility && (
          <VisibilityControl
            idPrefix="item"
            targetId={item.id}
            visibility={item.visibility}
            circleIds={item.scopeCircleIds}
          />
        )}
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
        <MediaGallery
          images={item.images}
          fallbackPath={null}
          alt={item.name}
          canEdit={canManageMedia}
          uploadKind="items"
          testIdPrefix="item"
          placeholder="⛏"
          onAddImage={async (path) => {
            await addImage.mutateAsync({ itemId: item.id, path });
            router.refresh();
          }}
          onSetMain={async (imageId) => {
            await setMainImage.mutateAsync({ imageId });
            router.refresh();
          }}
          onSetLabel={async (imageId, label) => {
            await setImageLabel.mutateAsync({ imageId, label });
            router.refresh();
          }}
          onRemove={async (imageId) => {
            await removeImage.mutateAsync({ imageId });
            router.refresh();
          }}
        />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
            {item.isYours ? 'Yours' : item.householdName}
            <FeeBadge feeCents={item.feeCents} />
            {item.feeCents === 0 && <span>· no fee</span>}
          </p>
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

      <ItemNotes itemId={item.id} notes={item.notes} canEdit={item.isYours} />

      <AttachmentsSection
        itemId={item.id}
        attachments={item.attachments}
        canEdit={canManageMedia}
        onChanged={() => router.refresh()}
      />

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
 * Item notes (media round §4). Owners get an inline textarea that autosaves on
 * blur (multiline, ≤2000 chars) with a live `<Linkified>` preview beneath;
 * viewers see the linkified notes read-only (nothing when empty). The preview
 * reads the live draft so pasted links resolve immediately.
 */
function ItemNotes({
  itemId,
  notes,
  canEdit,
}: {
  itemId: string;
  notes: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const [value, setValue] = useState(notes ?? '');
  const update = useMutation(
    trpc.item.update.mutationOptions({ onSuccess: () => router.refresh() }),
  );

  if (!canEdit) {
    if (!notes) return null;
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Notes</h2>
        <p
          data-testid="item-notes-display"
          className="whitespace-pre-line rounded-xl border border-border bg-surface-raised p-4 text-sm text-text shadow-sm"
        >
          <Linkified text={notes} />
        </p>
      </section>
    );
  }

  const trimmed = value.trim();
  return (
    <section className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        Notes
        <textarea
          data-testid="item-notes-input"
          rows={3}
          maxLength={2000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            const next = trimmed || null;
            if (next !== (notes ?? null)) update.mutate({ itemId, notes: next });
          }}
          placeholder="Care tips, model number, a link to the manual…"
          className={`${inputClass} resize-y font-normal normal-case tracking-normal`}
        />
      </label>
      {trimmed && (
        <p data-testid="item-notes-display" className="whitespace-pre-line text-sm text-text">
          <Linkified text={value} />
        </p>
      )}
    </section>
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
  const [name, setName] = useState(item.name);
  const [fee, setFee] = useState(item.feeCents === 0 ? '' : centsToDollarsString(item.feeCents));
  const [error, setError] = useState<string | null>(null);

  const update = useMutation(
    trpc.item.update.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

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
          // Photos + notes are managed inline on the detail page now — the edit
          // sheet only owns name + fee.
          update.mutate({
            itemId: item.id,
            name: name.trim(),
            feeCents,
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
            disabled={update.isPending}
            className={primaryBtn}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

const ATTACHMENT_CAP = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB, matches the upload route

/** Human file size (e.g. "2.4 MB") for attachment rows. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * Upload a raw PDF to the attachments route (media round §3). Mirrors
 * `uploadImage`'s multipart POST, but no downscale — PDFs go up as-is. The
 * display name rides the query string; the server re-stats the real size.
 */
async function uploadAttachment(file: File): Promise<{ path: string; name: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/upload/attachments?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
  return (await res.json()) as { path: string; name: string };
}

/**
 * "Manuals & documents" (media round §3): PDF attachments for an item. Rows
 * open the session-gated serving route in a new tab. Owners (lendBorrow) add
 * PDFs (≤20 MB, cap 5) and remove them with an arm-to-confirm tap. Viewers see
 * the section only when there's at least one document.
 */
function AttachmentsSection({
  itemId,
  attachments,
  canEdit,
  onChanged,
}: {
  itemId: string;
  attachments: ItemAttachment[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addAttachment = useMutation(trpc.item.addAttachment.mutationOptions());
  const removeAttachment = useMutation(trpc.item.removeAttachment.mutationOptions());

  const atCap = attachments.length >= ATTACHMENT_CAP;

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setError('Only PDF documents can be attached.');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError('That PDF is over 20 MB — attach a smaller file.');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const { path, name } = await uploadAttachment(file);
      await addAttachment.mutateAsync({ itemId, path, name, sizeBytes: file.size });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // Viewers with nothing to see get no empty section.
  if (attachments.length === 0 && !canEdit) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
        Manuals &amp; documents
      </h2>
      {attachments.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
          {attachments.map((a) => (
            <li
              key={a.id}
              data-testid="item-attachment-row"
              className="flex min-h-12 items-center gap-2 py-2"
            >
              <a
                href={`/api/attachments/${a.path}?name=${encodeURIComponent(a.name)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-base text-text-muted"
                >
                  📄
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text">{a.name}</span>
                  <span className="block text-xs text-text-muted">
                    {formatBytes(a.sizeBytes)}
                  </span>
                </span>
              </a>
              {canEdit && (
                <button
                  type="button"
                  data-testid="item-attachment-remove"
                  disabled={removeAttachment.isPending}
                  onClick={() =>
                    removeAttachment.mutate(
                      { attachmentId: a.id },
                      { onSuccess: onChanged, onError: (e) => setError(e.message) },
                    )
                  }
                  className="min-h-11 shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-surface-sunken disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {attachments.length === 0 && canEdit && (
        <p className="rounded-xl border border-dashed border-border-strong px-6 py-6 text-center text-sm text-text-muted">
          No documents yet — add a manual or spec sheet (PDF).
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            data-testid="item-attachment-add"
            onChange={(e) => handleFile(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || atCap}
            className="min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : 'Add document'}
          </button>
          {atCap && (
            <span className="text-xs text-text-muted">Up to {ATTACHMENT_CAP} documents.</span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
