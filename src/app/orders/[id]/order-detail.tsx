'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { newClientKey } from '@/lib/client-key';
import { formatCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';

type Line = {
  id: string;
  lotId: string;
  productName: string;
  code: string;
  quantity: number;
  unitCostCents: number;
  maxQty: number;
};

type Order = {
  id: string;
  status: string;
  pantryId: string;
  pantryName: string;
  ownerHouseholdName: string;
  ownerAddress: string | null;
  ownerPickupNotes: string | null;
  requesterHouseholdName: string;
  requestedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  REQUESTED: 'Requested',
  PICKING: 'Being picked',
  READY: 'Ready for pickup',
  PICKED_UP: 'Picked up',
  CANCELED: 'Canceled',
};

function fmtDate(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function OrderDetail({
  order,
  lines,
  totalCents,
  cross,
  role,
}: {
  order: Order;
  lines: Line[];
  totalCents: number;
  cross: boolean;
  role: { isRequester: boolean; isOwner: boolean };
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pickupKey] = useState(newClientKey);

  const editable =
    role.isRequester && (order.status === 'DRAFT' || order.status === 'REQUESTED');
  const refresh = () => router.refresh();
  const onError = (e: { message: string }) => setError(e.message);

  const setLine = useMutation(trpc.order.setLine.mutationOptions({ onSuccess: refresh, onError }));
  const submit = useMutation(trpc.order.submit.mutationOptions({ onSuccess: refresh, onError }));
  const startPicking = useMutation(
    trpc.order.startPicking.mutationOptions({ onSuccess: refresh, onError }),
  );
  const markReady = useMutation(trpc.order.markReady.mutationOptions({ onSuccess: refresh, onError }));
  const pickup = useMutation(
    trpc.order.pickup.mutationOptions({
      onSuccess: () => router.push('/orders'),
      onError,
    }),
  );
  const cancel = useMutation(
    trpc.order.cancel.mutationOptions({ onSuccess: () => router.push('/orders'), onError }),
  );

  const busy =
    setLine.isPending ||
    submit.isPending ||
    startPicking.isPending ||
    markReady.isPending ||
    pickup.isPending ||
    cancel.isPending;

  const counterparty = role.isRequester ? order.ownerHouseholdName : order.requesterHouseholdName;
  const stepperBtn =
    'flex size-10 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40';

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6">
      <header className="flex items-center gap-3">
        <Link href="/orders" aria-label="Back to orders" className="text-lg text-text-muted">
          ←
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
          Order · {order.pantryName}
        </h1>
        <span
          data-testid="order-status"
          className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong"
        >
          {STATUS_LABEL[order.status] ?? order.status}
        </span>
      </header>

      <p className="text-sm text-text-muted">
        {role.isRequester ? (
          <>
            From <span className="font-medium text-text">{order.ownerHouseholdName}</span>&rsquo;s
            pantry
          </>
        ) : (
          <>
            Requested by{' '}
            <span className="font-medium text-text">{order.requesterHouseholdName}</span>
          </>
        )}
        {order.status === 'PICKED_UP' && order.pickedUpAt && <> · picked up {fmtDate(order.pickedUpAt)}</>}
        {order.status === 'READY' && <> · set aside for you</>}
      </p>

      {/* Ready-order pickup logistics for the buyer (REWORK P5). */}
      {role.isRequester &&
        order.status === 'READY' &&
        (order.ownerAddress || order.ownerPickupNotes) && (
          <div
            data-testid="order-pickup-info"
            className="flex flex-col gap-2 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Pickup at {order.ownerHouseholdName}
            </p>
            {order.ownerAddress && (
              <>
                <p className="whitespace-pre-line text-base text-text">{order.ownerAddress}</p>
                <a
                  data-testid="order-map-link"
                  href={`https://maps.apple.com/?q=${encodeURIComponent(order.ownerAddress)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg bg-accent-soft px-4 py-2.5 text-sm font-medium text-accent-strong transition-colors hover:bg-accent-soft/70"
                >
                  📍 Open in maps
                </a>
              </>
            )}
            {order.ownerPickupNotes && (
              <p className="whitespace-pre-line text-sm text-text-muted">{order.ownerPickupNotes}</p>
            )}
          </div>
        )}

      {lines.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-strong px-6 py-8 text-center text-sm text-text-muted">
          Nothing in this order yet.
        </p>
      ) : (
        <ul data-testid="order-lines" className="flex flex-col gap-2">
          {lines.map((line) => (
            <li
              key={line.id}
              data-testid="order-line"
              className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised p-3 shadow-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-text">{line.productName}</p>
                <p className="text-sm text-text-muted">
                  <span className="font-mono">{line.code}</span> · {formatCents(line.unitCostCents)}/u
                  {cross && <> · {formatCents(line.quantity * line.unitCostCents)}</>}
                </p>
              </div>
              {editable ? (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Fewer ${line.productName}`}
                    disabled={busy}
                    onClick={() =>
                      setLine.mutate({ orderId: order.id, lotId: line.lotId, quantity: line.quantity - 1 })
                    }
                    className={stepperBtn}
                  >
                    −
                  </button>
                  <span data-testid="order-line-qty" className="w-6 text-center font-mono tabular-nums">
                    {line.quantity}
                  </span>
                  <button
                    type="button"
                    aria-label={`More ${line.productName}`}
                    disabled={busy || line.quantity >= line.maxQty}
                    onClick={() =>
                      setLine.mutate({ orderId: order.id, lotId: line.lotId, quantity: line.quantity + 1 })
                    }
                    className={stepperBtn}
                  >
                    +
                  </button>
                </div>
              ) : (
                <span data-testid="order-line-qty" className="shrink-0 font-mono tabular-nums text-text">
                  ×{line.quantity}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {lines.length > 0 && (
        <p data-testid="order-total" className="text-right text-sm font-medium text-text">
          {cross ? (
            <>
              {role.isRequester ? 'You’ll owe' : `${order.requesterHouseholdName} owes`}{' '}
              {order.ownerHouseholdName} {formatCents(totalCents)}
            </>
          ) : (
            <>No charge — your own pantry</>
          )}
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {/* Actions by (status × role). */}
      <div className="mt-2 flex flex-col gap-2">
        {editable && order.status === 'DRAFT' && (
          <>
            <button
              type="button"
              data-testid="order-request"
              disabled={busy || lines.length === 0}
              onClick={() => submit.mutate({ orderId: order.id })}
              className="min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
            >
              {submit.isPending ? 'Requesting…' : `Request from ${order.ownerHouseholdName}`}
            </button>
            <Link
              href={`/pantries/${order.pantryId}`}
              className="min-h-11 rounded-lg border border-border-strong px-4 py-2.5 text-center font-medium text-text transition-colors hover:bg-surface-sunken"
            >
              Add more items
            </Link>
          </>
        )}

        {order.status === 'REQUESTED' && (
          <p className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-text-muted">
            {role.isOwner
              ? 'Start picking to set these aside — that locks further changes.'
              : `Waiting for ${order.ownerHouseholdName} to pick your order. You can still change it until they start.`}
          </p>
        )}
        {role.isOwner && order.status === 'REQUESTED' && (
          <button
            type="button"
            data-testid="order-start-picking"
            disabled={busy}
            onClick={() => startPicking.mutate({ orderId: order.id })}
            className="min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            {startPicking.isPending ? 'Starting…' : 'Start picking'}
          </button>
        )}

        {role.isOwner && order.status === 'PICKING' && (
          <button
            type="button"
            data-testid="order-mark-ready"
            disabled={busy}
            onClick={() => markReady.mutate({ orderId: order.id })}
            className="min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            {markReady.isPending ? 'Readying…' : 'Mark ready for pickup'}
          </button>
        )}
        {role.isRequester && order.status === 'PICKING' && (
          <p className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-text-muted">
            {order.ownerHouseholdName} is picking your order — it&apos;s locked now.
          </p>
        )}

        {order.status === 'READY' && (
          <button
            type="button"
            data-testid="order-pickup"
            disabled={busy}
            onClick={() => pickup.mutate({ orderId: order.id, clientKey: pickupKey })}
            className="min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            {pickup.isPending ? 'Confirming…' : 'Mark picked up'}
          </button>
        )}

        {/* Cancel: requester any time before picking; owner may decline a request. */}
        {((role.isRequester && (order.status === 'DRAFT' || order.status === 'REQUESTED')) ||
          (role.isOwner && order.status === 'REQUESTED')) && (
          <button
            type="button"
            data-testid="order-cancel"
            disabled={busy}
            onClick={() => cancel.mutate({ orderId: order.id })}
            className="min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
          >
            {order.status === 'DRAFT'
              ? 'Discard order'
              : role.isOwner
                ? 'Decline request'
                : 'Cancel order'}
          </button>
        )}

        {order.status === 'PICKED_UP' && (
          <p data-testid="order-done" className="rounded-lg bg-success-soft px-3 py-2 text-sm font-medium text-success">
            Picked up{order.pickedUpAt ? ` ${fmtDate(order.pickedUpAt)}` : ''} — {counterparty}
            {cross ? ` · ${formatCents(totalCents)} on the ledger` : ' · no charge'}.
          </p>
        )}
        {order.status === 'CANCELED' && (
          <p className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-text-muted">
            This order was canceled — nothing was charged.
          </p>
        )}
      </div>
    </div>
  );
}
