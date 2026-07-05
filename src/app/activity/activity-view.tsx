'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { newClientKey } from '@/lib/client-key';
import { useTRPC } from '@/lib/trpc';
import type { ActivityItem } from '@/server/routers/activity';
import { CirclePicker, defaultCircleId, type GrantSet } from '../more/connections-card';

/**
 * The Activity screen (Phase-2 Round D). Rows are grouped by attention —
 * "Needs your action" (things this user can advance now), "Requests" (incoming
 * connections), "In motion" (waiting on the other side, or informative rows for
 * users who lack the capability). Inline actions call the SAME mutations as each
 * item's origin surface, at the same guards — the duplication rule (density may
 * differ, available actions may not). Money never fires from a row: an order
 * ready for pickup deep-links to its detail instead.
 */

const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast hover:bg-accent-strong disabled:opacity-50';
const secondaryBtn =
  'min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text hover:bg-surface-sunken disabled:opacity-50';
const dangerBtn =
  'min-h-11 rounded-lg border border-danger/40 px-4 py-2.5 font-medium text-danger hover:bg-danger-soft disabled:opacity-50';
const linkBtn =
  'min-h-11 inline-flex items-center rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text hover:bg-surface-sunken';

type Circle = { id: string; name: string; grants: GrantSet };

const ORDER_STATUS: Record<string, string> = {
  REQUESTED: 'Requested',
  PICKING: 'Being picked',
  READY: 'Ready',
};

export function ActivityView() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const list = useQuery(trpc.activity.list.queryOptions(undefined, { staleTime: 0 }));
  const items = list.data?.items ?? [];
  const hasConnections = items.some((i) => i.type === 'connection');

  // Circles are needed only to accept a connection (the picker) — load lazily.
  const circlesQuery = useQuery({
    ...trpc.circle.list.queryOptions(),
    enabled: hasConnections,
    retry: false,
  });
  const circles: Circle[] = circlesQuery.data?.circles ?? [];

  const refresh = () => {
    setError(null);
    void queryClient.invalidateQueries(trpc.activity.list.pathFilter());
  };
  const onError = (e: { message: string }) => setError(e.message);

  const deleteDraft = useMutation(
    trpc.restock.deleteDraft.mutationOptions({ onSuccess: refresh, onError }),
  );
  const startPicking = useMutation(
    trpc.order.startPicking.mutationOptions({ onSuccess: refresh, onError }),
  );
  const markReady = useMutation(
    trpc.order.markReady.mutationOptions({ onSuccess: refresh, onError }),
  );
  const respondConnection = useMutation(
    trpc.connection.respond.mutationOptions({ onSuccess: refresh, onError }),
  );
  const respondClaim = useMutation(
    trpc.share.respond.mutationOptions({ onSuccess: refresh, onError }),
  );

  // One idempotency key per claim answered — a confirm posts the $0 gift, so a
  // double-tap must not double it (mirrors the shares surface).
  const claimKeys = useRef(new Map<string, string>());
  const claimKey = (id: string) => {
    let k = claimKeys.current.get(id);
    if (!k) {
      k = newClientKey();
      claimKeys.current.set(id, k);
    }
    return k;
  };

  const busy =
    deleteDraft.isPending ||
    startPicking.isPending ||
    markReady.isPending ||
    respondConnection.isPending ||
    respondClaim.isPending;

  const handlers = {
    busy,
    circles,
    circlesError: circlesQuery.isError ? circlesQuery.error.message : null,
    onAbandonDraft: (restockId: string) => {
      if (window.confirm('Abandon this receiving draft? Its lines and photos are discarded.')) {
        deleteDraft.mutate({ restockId });
      }
    },
    onStartPicking: (orderId: string) => startPicking.mutate({ orderId }),
    onMarkReady: (orderId: string) => markReady.mutate({ orderId }),
    onAcceptConnection: (connectionId: string, circleId: string) =>
      respondConnection.mutate({ connectionId, accept: true, circleId }),
    onDeclineConnection: (connectionId: string) => {
      if (window.confirm('Decline this connection request?')) {
        respondConnection.mutate({ connectionId, accept: false });
      }
    },
    onConfirmClaim: (claimId: string) =>
      respondClaim.mutate({ claimId, action: 'confirm', clientKey: claimKey(claimId) }),
    onReleaseClaim: (claimId: string) =>
      respondClaim.mutate({ claimId, action: 'release', clientKey: claimKey(claimId) }),
  };

  const needsAction = items.filter((i) => i.actionable && i.type !== 'connection');
  const requests = items.filter((i) => i.type === 'connection');
  const inMotion = items.filter((i) => !i.actionable && i.type !== 'connection');
  const allCaughtUp = items.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6">
      <h1 className="text-xl font-semibold tracking-tight">Activity</h1>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {allCaughtUp ? (
        <div
          data-testid="activity-empty"
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-12 text-center"
        >
          <p className="text-4xl" aria-hidden>
            🎉
          </p>
          <p className="text-base font-medium text-text">All caught up.</p>
          <p className="text-sm text-text-muted">
            Nothing needs your attention right now.
          </p>
        </div>
      ) : (
        <ul data-testid="activity-list" className="flex flex-col gap-6">
          <Section title="Needs your action" items={needsAction} handlers={handlers} />
          <Section title="Requests" items={requests} handlers={handlers} />
          <Section title="In motion" items={inMotion} handlers={handlers} />
        </ul>
      )}
    </div>
  );
}

type Handlers = {
  busy: boolean;
  circles: Circle[];
  circlesError: string | null;
  onAbandonDraft: (restockId: string) => void;
  onStartPicking: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onAcceptConnection: (connectionId: string, circleId: string) => void;
  onDeclineConnection: (connectionId: string) => void;
  onConfirmClaim: (claimId: string) => void;
  onReleaseClaim: (claimId: string) => void;
};

function Section({
  title,
  items,
  handlers,
}: {
  title: string;
  items: ActivityItem[];
  handlers: Handlers;
}) {
  if (items.length === 0) return null;
  return (
    <li>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">{title}</h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <ActivityRow key={item.id} item={item} handlers={handlers} />
        ))}
      </ul>
    </li>
  );
}

const rowClass =
  'flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm';

function ActivityRow({ item, handlers }: { item: ActivityItem; handlers: Handlers }) {
  switch (item.type) {
    case 'draft':
      return (
        <li data-testid="activity-item" data-kind="draft" className={rowClass}>
          <RowHead
            title={`Receiving at ${item.pantryName}`}
            sub={`${item.code ? `${item.code} · ` : ''}started by ${item.startedBy}`}
          />
          {item.actionable && (
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/pantries/${item.pantryId}/receive/${item.restockId}?step=2`}
                data-testid="activity-draft-resume"
                className={linkBtn}
              >
                Resume
              </Link>
              <button
                type="button"
                data-testid="activity-draft-abandon"
                disabled={handlers.busy}
                onClick={() => handlers.onAbandonDraft(item.restockId)}
                className={dangerBtn}
              >
                Abandon
              </button>
            </div>
          )}
        </li>
      );

    case 'order-in':
      return (
        <li data-testid="activity-item" data-kind="order-in" className={rowClass}>
          <RowHead
            title={`Order from ${item.counterpartyName}`}
            sub={`${item.lineCount} ${item.lineCount === 1 ? 'item' : 'items'} · ${ORDER_STATUS[item.status] ?? item.status}`}
            href={`/orders/${item.orderId}`}
          />
          {/* Same transitions as /orders/[id] for this state (duplication rule);
              rendered only for fulfill-holders (can/hide). */}
          {item.actionable && item.status === 'REQUESTED' && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="activity-order-start-picking"
                disabled={handlers.busy}
                onClick={() => handlers.onStartPicking(item.orderId)}
                className={primaryBtn}
              >
                Start picking
              </button>
            </div>
          )}
          {item.actionable && item.status === 'PICKING' && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="activity-order-mark-ready"
                disabled={handlers.busy}
                onClick={() => handlers.onMarkReady(item.orderId)}
                className={primaryBtn}
              >
                Mark ready for pickup
              </button>
            </div>
          )}
        </li>
      );

    case 'order-out':
      return (
        <li data-testid="activity-item" data-kind="order-out" className={rowClass}>
          <RowHead
            title={`Your order · ${item.pantryName}`}
            sub={
              item.status === 'READY'
                ? `${item.ownerHouseholdName} · ready — go pick up`
                : `${item.ownerHouseholdName} · ${ORDER_STATUS[item.status] ?? item.status}`
            }
            href={`/orders/${item.orderId}`}
          />
          {/* Pickup posts money — never inline from a list row (money moment).
              Deep-link to the detail where pickup lives. */}
          {item.status === 'READY' && (
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/orders/${item.orderId}`}
                data-testid="activity-order-pickup-link"
                className={linkBtn}
              >
                Go to pickup
              </Link>
            </div>
          )}
        </li>
      );

    case 'connection':
      return <ConnectionRow item={item} handlers={handlers} />;

    case 'claim':
      return (
        <li data-testid="activity-item" data-kind="claim" className={rowClass}>
          <RowHead
            title={`${item.claimantName} wants “${item.postTitle}”`}
            sub={
              item.quantity != null
                ? `${item.quantity}${item.unit ? ` ${item.unit}` : ''} claimed`
                : 'claimed'
            }
            href="/shares"
          />
          {/* Same confirm/release as the shares surface; fulfill-holders only. */}
          {item.actionable && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="activity-claim-confirm"
                disabled={handlers.busy}
                onClick={() => handlers.onConfirmClaim(item.claimId)}
                className={primaryBtn}
              >
                Confirm handoff
              </button>
              <button
                type="button"
                data-testid="activity-claim-release"
                disabled={handlers.busy}
                onClick={() => handlers.onReleaseClaim(item.claimId)}
                className={secondaryBtn}
              >
                Release
              </button>
            </div>
          )}
        </li>
      );
  }
}

function ConnectionRow({
  item,
  handlers,
}: {
  item: Extract<ActivityItem, { type: 'connection' }>;
  handlers: Handlers;
}) {
  const [choosing, setChoosing] = useState(false);
  const [circleId, setCircleId] = useState<string | null>(null);

  return (
    <li data-testid="activity-item" data-kind="connection" className={rowClass}>
      <RowHead title={item.requesterName} sub={`@${item.requesterSlug} · wants to connect`} />
      {/* Accept (choose a circle) / decline — same as the More card; needs
          manageConnections (can/hide). */}
      {item.actionable &&
        (choosing ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-text">Put them in which circle?</p>
            {handlers.circlesError ? (
              <p role="alert" className="text-sm text-danger">
                {handlers.circlesError}
              </p>
            ) : (
              <CirclePicker circles={handlers.circles} value={circleId} onChange={setCircleId} />
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="activity-connection-accept-confirm"
                disabled={handlers.busy || handlers.circles.length === 0}
                onClick={() => {
                  // Fall back to the default circle if the picker's selection
                  // hasn't been touched (circles may have loaded after Accept).
                  const cid = circleId ?? defaultCircleId(handlers.circles);
                  if (cid) handlers.onAcceptConnection(item.connectionId, cid);
                }}
                className={primaryBtn}
              >
                Accept &amp; connect
              </button>
              <button type="button" onClick={() => setChoosing(false)} className={secondaryBtn}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="activity-connection-accept"
              onClick={() => {
                setCircleId(defaultCircleId(handlers.circles));
                setChoosing(true);
              }}
              className={primaryBtn}
            >
              Accept…
            </button>
            <button
              type="button"
              data-testid="activity-connection-decline"
              disabled={handlers.busy}
              onClick={() => handlers.onDeclineConnection(item.connectionId)}
              className={secondaryBtn}
            >
              Decline
            </button>
          </div>
        ))}
    </li>
  );
}

function RowHead({ title, sub, href }: { title: string; sub: string; href?: string }) {
  const body = (
    <>
      <p className="truncate font-medium text-text">{title}</p>
      <p className="truncate text-sm text-text-muted">{sub}</p>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="min-w-0 hover:opacity-80">
        {body}
      </Link>
    );
  }
  return <div className="min-w-0">{body}</div>;
}
