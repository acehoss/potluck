'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';
import { Avatar } from './profile-card';

/**
 * Connection management (REWORK P4 circles): the /more card where a household
 * requests, answers, re-circles, and severs its edges. Grants are no longer
 * edited per-connection — each side places the OTHER household into one of ITS
 * OWN circles (a named grant bundle) and can move them anytime, unilaterally.
 * What THEY grant us is shown as a plain readable summary; their circle NAME is
 * their private business and never surfaces here.
 */

export type Grant = 'pantry' | 'lending' | 'recipes' | 'shareTo' | 'shareFrom' | 'reshare';
export type GrantSet = Record<Grant, boolean>;
type Circle = { id: string; name: string; grants: GrantSet };

/** Plain-language grant labels (Walt rule) for the circle create/edit sheet. */
export const GRANT_LABELS: { key: Grant; label: string }[] = [
  { key: 'pantry', label: 'They can browse & order from shared pantries' },
  { key: 'lending', label: 'They can borrow shared items' },
  { key: 'recipes', label: 'They can see shared recipes' },
  { key: 'shareTo', label: 'They see our needs & surpluses' },
  { key: 'shareFrom', label: 'We see their needs & surpluses' },
  { key: 'reshare', label: 'They can pass our posts along' },
];

/** A short plain-language summary of what a grant bundle extends. */
export function grantsSummary(g: GrantSet): string {
  const parts: string[] = [];
  if (g.pantry) parts.push('pantry');
  if (g.lending) parts.push('lending');
  if (g.recipes) parts.push('recipes');
  if (g.shareTo || g.shareFrom) parts.push('shares');
  if (g.reshare) parts.push('resharing');
  if (parts.length === 0) return 'no access';
  if (parts.length === 1 && parts[0] === 'shares') return 'shares only';
  return parts.join(', ');
}

const cardClass =
  'flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm';
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text hover:bg-surface-sunken disabled:opacity-50';
const dangerBtn =
  'min-h-11 rounded-lg border border-danger/40 px-4 py-2.5 font-medium text-danger hover:bg-danger-soft disabled:opacity-50';
const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';

/**
 * A radio-style circle picker (request / accept / move). Rows show the circle
 * name plus a plain summary of what it grants — the same everywhere a household
 * chooses which of ITS circles to place a counterparty in.
 */
export function CirclePicker({
  circles,
  value,
  onChange,
}: {
  circles: Circle[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div
      className="flex flex-col gap-1"
      data-testid="connection-circle-picker"
      role="radiogroup"
      aria-label="Circle"
    >
      {circles.map((c) => (
        <label
          key={c.id}
          className="flex min-h-11 items-center gap-3 rounded-lg border border-border px-3 text-sm text-text"
        >
          <input
            type="radio"
            name="connection-circle"
            data-testid={`connection-circle-option-${c.id}`}
            checked={value === c.id}
            onChange={() => onChange(c.id)}
            className="size-5 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="font-medium">{c.name}</span>
            <span className="block text-xs text-text-muted">{grantsSummary(c.grants)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function statusPill(status: string, requestedByUs: boolean) {
  if (status === 'ACTIVE')
    return (
      <span className="rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success">
        connected
      </span>
    );
  if (status === 'SEVERED')
    return (
      <span className="rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger">
        severed
      </span>
    );
  return (
    <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-medium text-text">
      {requestedByUs ? 'request sent' : 'wants to connect'}
    </span>
  );
}

/** Pick a sensible default circle to preselect (Friends-ish, else the first). */
export function defaultCircleId(circles: Circle[]): string | null {
  if (circles.length === 0) return null;
  const friend = circles.find((c) => c.name.toLowerCase() === 'friends');
  return (friend ?? circles[0]).id;
}

export function ConnectionsCard() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.connection.list.queryOptions());
  const canManage = list.data?.canManage ?? false;
  const circlesQuery = useQuery({
    ...trpc.circle.list.queryOptions(),
    enabled: canManage,
    retry: false,
  });
  const circles: Circle[] = circlesQuery.data?.circles ?? [];

  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [requestCircle, setRequestCircle] = useState<string | null>(null);
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
  const assign = useMutation(
    trpc.connection.assign.mutationOptions({
      onSuccess: () => {
        setMoveId(null);
        setMoveTo(null);
        refresh();
      },
      onError,
    }),
  );
  const sever = useMutation(trpc.connection.sever.mutationOptions({ onSuccess: refresh, onError }));

  if (!list.data) return null;
  const { connections } = list.data;

  return (
    <section data-testid="connections-card" className={cardClass}>
      <h2 className="text-lg font-semibold">Connections</h2>
      <p className="text-sm text-text-muted">
        Households you&apos;re linked with. You place each into one of your circles — that&apos;s
        what decides how much they can do with your things — and can move them anytime.
      </p>

      {connections.length === 0 && <p className="text-sm text-text-muted">No connections yet.</p>}
      <ul className="flex flex-col">
        {connections.map((c) => {
          const moving = moveId === c.id;
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
                {statusPill(c.status, c.requestedByUs)}
              </div>

              {/* ACTIVE / outgoing-PENDING: which of OUR circles they sit in,
                  plus what THEY grant us (readable — never their circle name). */}
              {c.status !== 'SEVERED' && !(c.status === 'PENDING' && !c.requestedByUs) && (
                <div className="flex flex-col gap-1 text-sm">
                  {c.myCircle && (
                    <p className="text-text">
                      In:{' '}
                      <span data-testid="connection-circle" className="font-medium">
                        {c.myCircle.name}
                      </span>{' '}
                      <span className="text-text-muted">({grantsSummary(c.myCircle.grants)})</span>
                    </p>
                  )}
                  {c.status === 'ACTIVE' && (
                    <p className="text-text-muted">
                      They grant us: {grantsSummary(c.theyGrant)}
                    </p>
                  )}
                  {c.status === 'ACTIVE' && (
                    <Link
                      href={`/households/${c.counterparty.id}`}
                      data-testid="people-contact-link"
                      className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-medium text-accent transition-colors hover:text-accent-strong"
                    >
                      People &amp; contact →
                    </Link>
                  )}
                </div>
              )}

              {/* Incoming request: see who's asking (any member), then answer
                  it choosing a circle first (manageConnections only). */}
              {c.status === 'PENDING' && !c.requestedByUs && (
                <div className="flex flex-col gap-3">
                  <RequestPreview connectionId={c.id} />
                  {canManage && (
                    <IncomingResponder
                      circles={circles}
                      onAccept={(circleId) =>
                        respond.mutate({ connectionId: c.id, accept: true, circleId })
                      }
                      onDecline={() => respond.mutate({ connectionId: c.id, accept: false })}
                      pending={respond.isPending}
                    />
                  )}
                </div>
              )}

              {/* Move + sever controls (our side, any non-severed edge). */}
              {canManage && c.status !== 'SEVERED' && !(c.status === 'PENDING' && !c.requestedByUs) && (
                <div className="flex flex-col gap-2">
                  {moving ? (
                    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                      <p className="text-sm font-medium text-text">Move to which circle?</p>
                      {circlesQuery.isError ? (
                        <p role="alert" className="text-sm text-danger">
                          {circlesQuery.error.message}
                        </p>
                      ) : (
                        <CirclePicker
                          circles={circles}
                          value={moveTo}
                          onChange={setMoveTo}
                        />
                      )}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          data-testid="connection-move-save"
                          disabled={assign.isPending || !moveTo}
                          onClick={() =>
                            moveTo && assign.mutate({ connectionId: c.id, circleId: moveTo })
                          }
                          className={primaryBtn}
                        >
                          Move
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMoveId(null);
                            setMoveTo(null);
                          }}
                          className={secondaryBtn}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid="connection-move"
                        onClick={() => {
                          setMoveId(c.id);
                          setMoveTo(c.myCircle?.id ?? defaultCircleId(circles));
                          setError(null);
                        }}
                        className={secondaryBtn}
                      >
                        Move…
                      </button>
                      <button
                        type="button"
                        data-testid="connection-sever"
                        disabled={sever.isPending}
                        onClick={() => {
                          const verb =
                            c.status === 'PENDING'
                              ? 'Withdraw this request?'
                              : 'Sever this connection? Open orders are canceled; loans run to return; the balance and history stay.';
                          if (window.confirm(verb)) sever.mutate({ connectionId: c.id });
                        }}
                        className={dangerBtn}
                      >
                        {c.status === 'PENDING' ? 'Withdraw' : 'Sever'}
                      </button>
                    </div>
                  )}
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
            setRequestCircle(defaultCircleId(circles));
            setError(null);
          }}
          className={secondaryBtn}
        >
          Connect a household…
        </button>
      )}
      {canManage && <InviteHousehold circles={circles} circlesError={circlesQuery.error?.message} />}
      {canManage && connectOpen && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!requestCircle) {
              setError('Pick a circle for them.');
              return;
            }
            request.mutate({ slug: handle, circleId: requestCircle });
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
          <p className="text-sm font-medium text-text">Put them in which circle?</p>
          {circlesQuery.isError ? (
            <p role="alert" className="text-sm text-danger">
              {circlesQuery.error.message}
            </p>
          ) : (
            <CirclePicker circles={circles} value={requestCircle} onChange={setRequestCircle} />
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              data-testid="connect-submit"
              disabled={request.isPending}
              className={primaryBtn}
            >
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

/**
 * Mint a NEW-household invite (REWORK A1, Phase-2 P4 circles): the accepted link
 * founds a household whose first connection edge is ours. The inviter picks one
 * of ITS circles; the server snapshots that circle's CURRENT grants into the
 * invite at mint time (grantsJson — no schema change) and maps it back to the
 * matching circle on both sides at accept. Friends is preselected so the mint
 * stays one-click. The instance-admin growth toggle is enforced server-side.
 */
function InviteHousehold({
  circles,
  circlesError,
}: {
  circles: Circle[];
  circlesError?: string;
}) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [circleId, setCircleId] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mint = useMutation(
    trpc.invite.createHousehold.mutationOptions({
      onSuccess: (data) => {
        setError(null);
        setLink(`${window.location.origin}${data.path}`);
      },
      onError: (e) => setError(e.message),
    }),
  );

  if (!open) {
    return (
      <button
        type="button"
        data-testid="invite-household-open"
        onClick={() => {
          setOpen(true);
          setCircleId(defaultCircleId(circles));
          setError(null);
        }}
        className={secondaryBtn}
      >
        Invite a NEW household…
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <p className="text-sm text-text-muted">
        For a family that isn&apos;t on this server yet: the link lets them start their own
        household, connected to yours from day one. Works once, expires in 7 days.
      </p>
      <p className="text-sm font-medium text-text">They&apos;ll start in this circle:</p>
      {circlesError ? (
        <p role="alert" className="text-sm text-danger">
          {circlesError}
        </p>
      ) : (
        <CirclePicker circles={circles} value={circleId} onChange={setCircleId} />
      )}
      <p className="text-xs text-text-muted">They&apos;ll start with the same access toward you.</p>
      {link ? (
        <p
          data-testid="household-invite-url"
          className="break-all rounded-lg bg-surface-sunken p-3 font-mono text-xs text-text"
        >
          {link}
        </p>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="invite-household-submit"
            disabled={mint.isPending || !circleId}
            onClick={() => circleId && mint.mutate({ circleId })}
            className={primaryBtn}
          >
            Create invite link
          </button>
          <button type="button" onClick={() => setOpen(false)} className={secondaryBtn}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Name-only preview of the household behind an incoming request (REWORK P5):
 * requester household name + member mini-cards (photo, name, bio) so the
 * addressee can "see who before I say yes." No phone/email/address pre-accept —
 * the server (contacts.requestPreview) returns exactly this narrow shape.
 */
function RequestPreview({ connectionId }: { connectionId: string }) {
  const trpc = useTRPC();
  const preview = useQuery({
    ...trpc.contacts.requestPreview.queryOptions({ connectionId }),
    retry: false,
  });

  if (!preview.data) return null;
  const { householdName, members } = preview.data;

  return (
    <div
      data-testid="request-preview"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3"
    >
      <p className="text-sm text-text">
        <span className="font-medium">{householdName}</span> wants to connect.
      </p>
      {members.length > 0 && (
        <ul className="flex flex-col gap-2">
          {members.map((m, i) => (
            <li key={i} className="flex items-center gap-3">
              <Avatar photoPath={m.photoPath} name={m.name} className="size-10" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{m.name}</p>
                {m.bio && <p className="truncate text-xs text-text-muted">{m.bio}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Accept-with-circle / decline block for an incoming request. */
function IncomingResponder({
  circles,
  onAccept,
  onDecline,
  pending,
}: {
  circles: Circle[];
  onAccept: (circleId: string) => void;
  onDecline: () => void;
  pending: boolean;
}) {
  const [circleId, setCircleId] = useState<string | null>(defaultCircleId(circles));
  const [choosing, setChoosing] = useState(false);
  if (!choosing) {
    return (
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="connection-accept"
          onClick={() => {
            setCircleId(defaultCircleId(circles));
            setChoosing(true);
          }}
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
      <p className="text-sm font-medium text-text">Put them in which circle?</p>
      <CirclePicker circles={circles} value={circleId} onChange={setCircleId} />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="connection-accept-confirm"
          disabled={pending || !circleId}
          onClick={() => circleId && onAccept(circleId)}
          className={primaryBtn}
        >
          Accept &amp; connect
        </button>
        <button type="button" onClick={() => setChoosing(false)} className={secondaryBtn}>
          Back
        </button>
      </div>
    </div>
  );
}
