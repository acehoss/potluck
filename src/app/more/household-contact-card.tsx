'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * Household contact card (REWORK P5, Round C): the acting household's pickup
 * logistics — address + "usual pickup notes" — that a connected household sees
 * on the contact page. manageHousehold holders edit via a sheet
 * (household.updateContact); everyone else sees the values read-only.
 */

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

export function HouseholdContactCard({
  householdName,
  address,
  pickupNotes,
  canManage,
}: {
  householdName: string;
  address: string | null;
  pickupNotes: string | null;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <section
      data-testid="household-contact-card"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text">Pickup &amp; address</h2>
          <p className="text-sm text-text-muted">
            What {householdName} shows connections when they come to pick things up.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            data-testid="household-contact-edit"
            onClick={() => setEditing(true)}
            className="min-h-11 shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-surface-sunken"
          >
            Edit
          </button>
        )}
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Address</dt>
          <dd className="whitespace-pre-line text-text">
            {address || <span className="text-text-muted">Not set yet.</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Usual pickup notes
          </dt>
          <dd className="whitespace-pre-line text-text">
            {pickupNotes || <span className="text-text-muted">Not set yet.</span>}
          </dd>
        </div>
      </dl>

      {editing && (
        <ContactSheet
          address={address}
          pickupNotes={pickupNotes}
          onClose={() => setEditing(false)}
        />
      )}
    </section>
  );
}

function ContactSheet({
  address,
  pickupNotes,
  onClose,
}: {
  address: string | null;
  pickupNotes: string | null;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [addr, setAddr] = useState(address ?? '');
  const [notes, setNotes] = useState(pickupNotes ?? '');
  const [error, setError] = useState<string | null>(null);

  const update = useMutation(
    trpc.household.updateContact.mutationOptions({
      onSuccess: () => {
        onClose();
        router.refresh(); // the card reads server props
      },
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="household-contact-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ address: addr.trim() || null, pickupNotes: notes.trim() || null });
        }}
      >
        <h2 className="text-lg font-semibold">Pickup &amp; address</h2>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Address
          <textarea
            data-testid="household-address"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            rows={3}
            placeholder={'742 Evergreen Terrace\nSpringfield'}
            className={`${inputClass} resize-none`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Usual pickup notes
          <textarea
            data-testid="household-pickup-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Side door off the driveway — text when you're 5 minutes out."
            className={`${inputClass} resize-none`}
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
            data-testid="household-contact-save"
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
