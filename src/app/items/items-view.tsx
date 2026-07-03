'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { newClientKey } from '@/lib/client-key';
import { downscaleToJpeg, uploadImage } from '@/lib/downscale';
import { formatCents, parseDollarsToCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';
import { dueShortDate, isOverdue } from './format';

export type ItemGroup = {
  householdId: string;
  householdName: string;
  isYours: boolean;
  items: {
    id: string;
    name: string;
    photoPath: string | null;
    feeCents: number;
    activeLoan: {
      borrowerName: string;
      borrowerHouseholdName: string;
      borrowerIsYourHousehold: boolean;
      outAt: string; // ISO
      dueAt: string | null; // ISO, date-only (UTC midnight)
    } | null;
  }[];
};

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

/** Fee badge, shown only when nonzero (blueprint 02). */
export function FeeBadge({ feeCents }: { feeCents: number }) {
  if (feeCents === 0) return null;
  return (
    <span
      data-testid="fee-badge"
      className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong"
    >
      {formatCents(feeCents)}/loan
    </span>
  );
}

export function OverdueBadge() {
  return (
    <span
      data-testid="overdue-badge"
      className="rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger"
    >
      overdue
    </span>
  );
}

export function ItemsView({
  groups,
  yourHouseholdId,
  yourName,
}: {
  groups: ItemGroup[];
  yourHouseholdId: string;
  yourName: string;
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Items</h1>
        <p className="text-sm text-text-muted">{yourName}</p>
      </header>

      <main className="flex flex-col gap-6">
        {groups.map((group) => (
          <section key={group.householdId} data-testid="item-group" className="flex flex-col gap-2">
            <div className="flex min-h-11 items-center gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
                {group.householdName}
              </h2>
              {group.isYours && (
                <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                  your household
                </span>
              )}
              {group.isYours && (
                <button
                  type="button"
                  data-testid="add-item"
                  onClick={() => setAddOpen(true)}
                  className="ml-auto min-h-11 rounded-lg px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-surface-sunken"
                >
                  + Item
                </button>
              )}
            </div>

            {group.items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-8 text-center">
                <p className="text-sm text-text-muted">
                  {group.isYours
                    ? 'No items yet — add durable gear your coop can borrow.'
                    : `The ${group.householdName} haven't listed any items yet.`}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised px-4 shadow-sm">
                {group.items.map((item) => {
                  const loan = item.activeLoan;
                  const overdue = loan !== null && isOverdue(loan.dueAt);
                  return (
                    <li key={item.id}>
                      <Link
                        data-testid="item-row"
                        href={`/items/${item.id}`}
                        className="flex min-h-14 items-center gap-3 py-3"
                      >
                        {item.photoPath ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`/api/images/${item.photoPath}`}
                            alt=""
                            className="size-12 shrink-0 rounded-lg border border-border object-cover"
                          />
                        ) : (
                          <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-muted">
                            ⛏
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 text-base text-text">
                            <span className="truncate">{item.name}</span>
                            <FeeBadge feeCents={item.feeCents} />
                          </p>
                          <p
                            data-testid="item-status"
                            className="flex items-center gap-2 text-sm text-text-muted"
                          >
                            {loan ? (
                              <>
                                {/* Borrower name truncates; the due date never does —
                                    on 390px with the overdue badge, the blown deadline
                                    is the one thing that must stay readable. */}
                                <span className="truncate">
                                  Out →{' '}
                                  {loan.borrowerIsYourHousehold
                                    ? loan.borrowerName
                                    : loan.borrowerHouseholdName}
                                </span>
                                {loan.dueAt && (
                                  <span className="shrink-0">· due {dueShortDate(loan.dueAt)}</span>
                                )}
                                {overdue && <OverdueBadge />}
                              </>
                            ) : (
                              <span className="text-success">Available</span>
                            )}
                          </p>
                        </div>
                        <span aria-hidden className="shrink-0 text-text-muted">
                          ›
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </main>

      {addOpen && (
        <AddItemSheet
          yourHouseholdId={yourHouseholdId}
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setAddOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Add-item sheet (blueprint 02: name, photo, notes, fee — default $0). The
 * fee copy steers: $0 is normal, fees are for maintenance-heavy gear.
 */
function AddItemSheet({
  yourHouseholdId,
  onClose,
  onDone,
}: {
  yourHouseholdId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  // One idempotency key per sheet open: `disabled={isPending}` only lands on
  // the next render, so a fast double-tap (or Enter + click) fires twice —
  // the server replays the second call as the SAME item.
  const [clientKey] = useState(newClientKey);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [fee, setFee] = useState('');
  const [photo, setPhoto] = useState<{ path: string; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(
    trpc.item.create.mutationOptions({
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
      if (photo) URL.revokeObjectURL(photo.preview);
      setPhoto({ path, preview: URL.createObjectURL(jpeg) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="add-item-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const feeCents = fee.trim() ? parseDollarsToCents(fee) : 0;
          if (feeCents === null) {
            setError('Fee must look like 5.00 (or be left empty).');
            return;
          }
          create.mutate({
            householdId: yourHouseholdId,
            name: name.trim(),
            notes: notes.trim() || undefined,
            feeCents,
            photoPath: photo?.path,
            clientKey,
          });
        }}
      >
        <h2 className="text-lg font-semibold">Add item</h2>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Name
          <input
            type="text"
            required
            data-testid="item-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Pressure canner"
            className={inputClass}
          />
        </label>

        <div className="flex items-center gap-3">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo.preview}
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
            data-testid="item-photo-input"
            onChange={(e) => handleFile(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : photo ? 'Retake photo' : 'Photo (optional)'}
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Notes (optional)
          <input
            type="text"
            data-testid="item-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Gaskets in the lid box"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Fee per loan (optional)
          <input
            type="text"
            inputMode="decimal"
            data-testid="item-fee"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder="0.00"
            className={inputClass}
          />
          <span className="text-xs font-normal text-text-muted">
            Most items lend free — $0 is normal. Set a fee only for maintenance-heavy or partially
            consumable gear (blades, gas, filters).
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
            data-testid="item-save"
            disabled={create.isPending || uploading}
            className={primaryBtn}
          >
            {create.isPending ? 'Adding…' : 'Add item'}
          </button>
        </div>
      </form>
    </div>
  );
}
