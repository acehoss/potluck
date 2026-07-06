'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/app/more/profile-card';
import { phoneHref } from '@/lib/phone';

/**
 * A connected household's people & contact page (REWORK P5, Round C). Pickup
 * logistics lead (focus group: address → map link → pickup notes BEFORE
 * phone/text/email), then the member cards; tapping one opens a detail sheet
 * with big tel:/sms: rows (Walt's glasses), email, bio, and a "Save contact"
 * vCard download. Every member/address shown here already passed the server's
 * circle/visibility gate — this component only renders what it was handed.
 */

export type ContactMember = {
  membershipId: string;
  userId: string;
  name: string;
  photoPath: string | null;
  phone: string | null;
  email: string;
  bio: string | null;
};

export type ContactHousehold = {
  householdName: string;
  slug: string;
  address: string | null;
  pickupNotes: string | null;
  members: ContactMember[];
};

/** Apple Maps deep link — degrades to a normal maps search on Android/desktop. */
function mapsHref(address: string) {
  return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
}

function PickupBlock({
  address,
  pickupNotes,
}: {
  address: string | null;
  pickupNotes: string | null;
}) {
  if (!address && !pickupNotes) return null;
  return (
    <div
      data-testid="household-contact-card"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
    >
      {address && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Address</p>
          <p data-testid="household-address" className="whitespace-pre-line text-base text-text">
            {address}
          </p>
          <a
            data-testid="household-map-link"
            href={mapsHref(address)}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex min-h-11 w-fit items-center gap-2 rounded-lg bg-accent-soft px-4 py-2.5 text-sm font-medium text-accent-strong transition-colors hover:bg-accent-soft/70"
          >
            📍 Open in maps
          </a>
        </div>
      )}
      {pickupNotes && (
        <div
          data-testid="household-pickup-notes"
          className="flex flex-col gap-1 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-warn">Pickup notes</p>
          <p className="whitespace-pre-line text-sm text-text">{pickupNotes}</p>
        </div>
      )}
    </div>
  );
}

export function ContactPageView({
  household,
  isOwn,
}: {
  household: ContactHousehold;
  isOwn: boolean;
}) {
  const [detail, setDetail] = useState<ContactMember | null>(null);

  return (
    <div
      data-testid="contact-page"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6 sm:pb-24"
    >
      <header className="flex items-center gap-3">
        <Link href="/more" aria-label="Back" className="shrink-0 text-lg text-text-muted">
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">
            {household.householdName}
            {isOwn && (
              <span className="ml-2 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
                your household
              </span>
            )}
          </h1>
          <p className="truncate text-sm text-text-muted">@{household.slug}</p>
        </div>
      </header>

      {/* Pickup logistics FIRST (focus-group priority). */}
      <PickupBlock address={household.address} pickupNotes={household.pickupNotes} />

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          People · {household.members.length}
        </h2>
        {household.members.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border-strong px-6 py-8 text-center text-sm text-text-muted">
            No one here shares their contact card with you.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {household.members.map((m) => (
              <li key={m.membershipId}>
                <button
                  type="button"
                  data-testid="member-card"
                  onClick={() => setDetail(m)}
                  className="flex min-h-14 w-full items-center gap-4 rounded-xl border border-border bg-surface-raised p-3 text-left shadow-sm transition-colors hover:bg-surface-sunken"
                >
                  <Avatar photoPath={m.photoPath} name={m.name} className="size-16 text-xl" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-bold text-text">{m.name}</p>
                    {m.bio && <p className="truncate text-sm text-text-muted">{m.bio}</p>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail && (
        <MemberDetailSheet
          member={detail}
          household={household}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function MemberDetailSheet({
  member,
  household,
  onClose,
}: {
  member: ContactMember;
  household: ContactHousehold;
  onClose: () => void;
}) {
  const rowClass =
    'flex min-h-14 w-full items-center gap-3 rounded-xl border border-border-strong px-4 py-3 text-left text-base font-medium text-text transition-colors hover:bg-surface-sunken';

  return (
    <div
      className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center"
      onClick={onClose}
    >
      <div
        data-testid="member-detail-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4">
          <Avatar photoPath={member.photoPath} name={member.name} className="size-20 text-2xl" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-bold text-text">{member.name}</h2>
            <p className="truncate text-sm text-text-muted">{household.householdName}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="min-h-11 shrink-0 rounded-lg px-3 text-lg text-text-muted hover:bg-surface-sunken"
          >
            ✕
          </button>
        </div>

        {/* Pickup logistics repeated here, ahead of contact methods. */}
        {(household.address || household.pickupNotes) && (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-sunken px-4 py-3 text-sm">
            {household.address && (
              <p className="whitespace-pre-line text-text">{household.address}</p>
            )}
            {household.pickupNotes && (
              <p className="whitespace-pre-line text-text-muted">{household.pickupNotes}</p>
            )}
          </div>
        )}

        {/* tel: and sms: as two clearly-separated big tappable rows. */}
        <div className="flex flex-col gap-2">
          {member.phone && (
            <>
              <a
                data-testid="member-phone"
                href={`tel:${phoneHref(member.phone)}`}
                className={rowClass}
              >
                <span aria-hidden>📞</span>
                <span className="min-w-0 flex-1">
                  <span className="block">Call</span>
                  <span className="block truncate text-sm font-normal text-text-muted">
                    {member.phone}
                  </span>
                </span>
              </a>
              <a
                data-testid="member-sms"
                href={`sms:${phoneHref(member.phone)}`}
                className={rowClass}
              >
                <span aria-hidden>💬</span>
                <span className="min-w-0 flex-1">
                  <span className="block">Text</span>
                  <span className="block truncate text-sm font-normal text-text-muted">
                    {member.phone}
                  </span>
                </span>
              </a>
            </>
          )}
          <a data-testid="member-email" href={`mailto:${member.email}`} className={rowClass}>
            <span aria-hidden>✉️</span>
            <span className="min-w-0 flex-1">
              <span className="block">Email</span>
              <span className="block truncate text-sm font-normal text-text-muted">
                {member.email}
              </span>
            </span>
          </a>
        </div>

        {member.bio && <p className="text-sm text-text-muted">{member.bio}</p>}

        <a
          data-testid="member-vcard"
          href={`/api/vcard/${member.userId}`}
          download
          className="min-h-11 rounded-lg bg-accent px-4 py-2.5 text-center font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
        >
          Save contact
        </a>
      </div>
    </div>
  );
}
