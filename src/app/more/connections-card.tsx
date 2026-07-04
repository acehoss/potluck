'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * Connection management (REWORK B1/B2/B6): the /more card where a household
 * requests, answers, tunes, and severs its edges. Every grant checkbox is OUR
 * side only — what we let THEM do with our stuff — editable unilaterally at
 * any time. Presets are starting points, not walls.
 */

const GRANT_LABELS = [
  ['pantry', 'Pantry — browse & order our shared pantries'],
  ['lending', 'Lending — borrow our shared items'],
  ['recipes', 'Recipes — browse our recipe book (soon)'],
  ['shareTo', 'They receive our needs & surpluses (soon)'],
  ['shareFrom', 'We receive theirs (soon)'],
  ['reshare', 'They may reshare our posts onward (soon)'],
] as const;

type GrantSet = Record<(typeof GRANT_LABELS)[number][0], boolean>;

const PRESETS: { name: string; label: string; grants: GrantSet }[] = [
  {
    name: 'neighbor',
    label: 'Neighbor',
    grants: {
      pantry: false,
      lending: false,
      recipes: false,
      shareTo: true,
      shareFrom: true,
      reshare: false,
    },
  },
  {
    name: 'friend',
    label: 'Friend',
    grants: {
      pantry: true,
      lending: true,
      recipes: true,
      shareTo: true,
      shareFrom: true,
      reshare: false,
    },
  },
  {
    name: 'family',
    label: 'Family',
    grants: {
      pantry: true,
      lending: true,
      recipes: true,
      shareTo: true,
      shareFrom: true,
      reshare: true,
    },
  },
];

const cardClass = 'flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm';
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text hover:bg-surface-sunken disabled:opacity-50';
const dangerBtn =
  'min-h-11 rounded-lg border border-danger/40 px-4 py-2.5 font-medium text-danger hover:bg-danger-soft disabled:opacity-50';
const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';

function GrantEditor({
  value,
  onChange,
}: {
  value: GrantSet;
  onChange: (next: GrantSet) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            data-testid={`preset-${p.name}`}
            onClick={() => onChange(p.grants)}
            className="min-h-11 rounded-full border border-border-strong px-4 py-1.5 text-sm font-medium text-text hover:bg-surface-sunken"
          >
            {p.label}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-1">
        {GRANT_LABELS.map(([key, label]) => (
          <li key={key}>
            <label className="flex min-h-11 items-center gap-3 text-sm text-text">
              <input
                type="checkbox"
                data-testid={`grant-${key}`}
                checked={value[key]}
                onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
                className="size-5 accent-[var(--color-accent)]"
              />
              {label}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusPill(status: string, requestedByUs: boolean) {
  if (status === 'ACTIVE')
    return <span className="rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success">connected</span>;
  if (status === 'SEVERED')
    return <span className="rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger">severed</span>;
  return (
    <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-medium text-text">
      {requestedByUs ? 'request sent' : 'wants to connect'}
    </span>
  );
}

export function ConnectionsCard() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.connection.list.queryOptions());

  const [openId, setOpenId] = useState<string | null>(null);
  const [draftGrants, setDraftGrants] = useState<GrantSet | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [requestGrants, setRequestGrants] = useState<GrantSet>(PRESETS[1].grants);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void queryClient.invalidateQueries(trpc.connection.list.pathFilter());
    router.refresh(); // scoped pages (pantries, items, ledger) follow the edges
  };
  const onError = (e: { message: string }) => setError(e.message);

  const request = useMutation(
    trpc.connection.request.mutationOptions({
      onSuccess: () => {
        setConnectOpen(false);
        setHandle('');
        refresh();
      },
      onError,
    }),
  );
  const respond = useMutation(
    trpc.connection.respond.mutationOptions({ onSuccess: refresh, onError }),
  );
  const setGrants = useMutation(
    trpc.connection.setGrants.mutationOptions({
      onSuccess: () => {
        setOpenId(null);
        setDraftGrants(null);
        refresh();
      },
      onError,
    }),
  );
  const sever = useMutation(trpc.connection.sever.mutationOptions({ onSuccess: refresh, onError }));

  if (!list.data) return null;
  const { canManage, connections } = list.data;

  return (
    <section data-testid="connections-card" className={cardClass}>
      <h2 className="text-lg font-semibold">Connections</h2>
      <p className="text-sm text-text-muted">
        Households you&apos;re linked with. Each side controls what the other may do with its
        own pantries, items, and posts — and can change that at any time.
      </p>

      {connections.length === 0 && (
        <p className="text-sm text-text-muted">No connections yet.</p>
      )}
      <ul className="flex flex-col">
        {connections.map((c) => {
          const expanded = openId === c.id;
          const grants = draftGrants ?? c.weGrant;
          return (
            <li
              key={c.id}
              data-testid="connection-row"
              className="flex flex-col gap-3 border-b border-border py-3 last:border-b-0"
            >
              <div className="flex min-h-11 items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-text">{c.counterparty.name}</p>
                  <p className="text-xs text-text-muted">@{c.counterparty.slug}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {statusPill(c.status, c.requestedByUs)}
                  {canManage && c.status !== 'SEVERED' && !(c.status === 'PENDING' && !c.requestedByUs) && (
                    <button
                      type="button"
                      data-testid="connection-edit"
                      onClick={() => {
                        setOpenId(expanded ? null : c.id);
                        setDraftGrants(expanded ? null : { ...c.weGrant });
                        setError(null);
                      }}
                      className="min-h-11 rounded-lg px-3 text-sm font-medium text-accent-strong hover:bg-surface-sunken"
                    >
                      {expanded ? 'Close' : 'Edit'}
                    </button>
                  )}
                </div>
              </div>

              {/* Incoming request: answer it. */}
              {canManage && c.status === 'PENDING' && !c.requestedByUs && (
                <IncomingResponder
                  onAccept={(g) =>
                    respond.mutate({ connectionId: c.id, accept: true, grants: g })
                  }
                  onDecline={() => respond.mutate({ connectionId: c.id, accept: false })}
                  pending={respond.isPending}
                />
              )}

              {expanded && draftGrants && (
                <div className="flex flex-col gap-3">
                  <GrantEditor value={grants} onChange={setDraftGrants} />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-testid="grants-save"
                      disabled={setGrants.isPending}
                      onClick={() => setGrants.mutate({ connectionId: c.id, grants })}
                      className={primaryBtn}
                    >
                      Save grants
                    </button>
                    <button
                      type="button"
                      data-testid="connection-sever"
                      disabled={sever.isPending}
                      onClick={() => {
                        const verb = c.status === 'PENDING' ? 'Withdraw this request?' :
                          'Sever this connection? Open orders are canceled; loans run to return; the balance and history stay.';
                        if (window.confirm(verb)) sever.mutate({ connectionId: c.id });
                      }}
                      className={dangerBtn}
                    >
                      {c.status === 'PENDING' ? 'Withdraw' : 'Sever'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {canManage && !connectOpen && (
        <button
          type="button"
          data-testid="connect-open"
          onClick={() => {
            setConnectOpen(true);
            setError(null);
          }}
          className={secondaryBtn}
        >
          Connect a household…
        </button>
      )}
      {canManage && connectOpen && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate({ slug: handle, grants: requestGrants });
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            Household handle
            <input
              type="text"
              required
              data-testid="connect-handle"
              placeholder="their-handle"
              autoCapitalize="none"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              className={inputClass}
            />
            <span className="text-xs font-normal text-text-muted">
              Ask them for it — there&apos;s no browsing or discovery, on purpose.
            </span>
          </label>
          <p className="text-sm font-medium text-text">What they may do with our things:</p>
          <GrantEditor value={requestGrants} onChange={setRequestGrants} />
          <div className="flex gap-2">
            <button type="submit" data-testid="connect-submit" disabled={request.isPending} className={primaryBtn}>
              Send request
            </button>
            <button type="button" onClick={() => setConnectOpen(false)} className={secondaryBtn}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/** Accept-with-grants / decline block for an incoming request. */
function IncomingResponder({
  onAccept,
  onDecline,
  pending,
}: {
  onAccept: (grants: GrantSet) => void;
  onDecline: () => void;
  pending: boolean;
}) {
  const [grants, setGrants] = useState<GrantSet>(PRESETS[1].grants);
  const [choosing, setChoosing] = useState(false);
  if (!choosing) {
    return (
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="connection-accept"
          onClick={() => setChoosing(true)}
          className={primaryBtn}
        >
          Accept…
        </button>
        <button
          type="button"
          data-testid="connection-decline"
          disabled={pending}
          onClick={onDecline}
          className={secondaryBtn}
        >
          Decline
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-text">What THEY may do with our things:</p>
      <GrantEditor value={grants} onChange={setGrants} />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="connection-accept-confirm"
          disabled={pending}
          onClick={() => onAccept(grants)}
          className={primaryBtn}
        >
          Accept & connect
        </button>
        <button type="button" onClick={() => setChoosing(false)} className={secondaryBtn}>
          Back
        </button>
      </div>
    </div>
  );
}
