import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatCents } from '@/lib/money';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  REQUESTED: 'Requested',
  PICKING: 'Being picked',
  READY: 'Ready',
  PICKED_UP: 'Picked up',
  CANCELED: 'Canceled',
};

type Row = {
  id: string;
  status: string;
  pantryName: string;
  counterparty: string;
  itemCount: number;
  units: number;
  costCents: number;
  cross: boolean;
};

function OrderRow({ row, kind }: { row: Row; kind: 'mine' | 'incoming' }) {
  return (
    <Link
      href={`/orders/${row.id}`}
      data-testid={kind === 'incoming' ? 'incoming-row' : 'order-row'}
      className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised p-3 shadow-sm transition-colors hover:bg-surface-sunken"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-text">
          {kind === 'incoming' ? row.counterparty : row.pantryName}
        </p>
        <p className="text-sm text-text-muted">
          {row.itemCount} {row.itemCount === 1 ? 'item' : 'items'} · {row.units}{' '}
          {row.units === 1 ? 'unit' : 'units'}
          {row.cross && row.costCents > 0 && <> · {formatCents(row.costCents)}</>}
        </p>
      </div>
      <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong">
        {STATUS_LABEL[row.status] ?? row.status}
      </span>
    </Link>
  );
}

/** Orders home: the household's own orders + incoming requests to its pantries. */
export default async function OrdersPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const summarize = (o: {
    id: string;
    status: string;
    householdId: string;
    pantry: { name: string; householdId: string; household: { name: string } };
    household: { name: string };
    lines: { quantity: number; lot: { unitCostCents: number | null } }[];
  }): Row => {
    const cross = o.householdId !== o.pantry.householdId;
    return {
      id: o.id,
      status: o.status,
      pantryName: o.pantry.name,
      counterparty: o.household.name,
      itemCount: o.lines.length,
      units: o.lines.reduce((s, l) => s + l.quantity, 0),
      costCents: cross ? o.lines.reduce((s, l) => s + l.quantity * (l.lot.unitCostCents ?? 0), 0) : 0,
      cross,
    };
  };

  const include = {
    pantry: { select: { name: true, householdId: true, household: { select: { name: true } } } },
    household: { select: { name: true } },
    lines: { select: { quantity: true, lot: { select: { unitCostCents: true } } } },
  } as const;

  const [mineRaw, incomingRaw] = await Promise.all([
    db.order.findMany({
      where: {
        householdId: user.householdId,
        OR: [
          { status: { in: ['REQUESTED', 'PICKING', 'READY', 'PICKED_UP', 'CANCELED'] } },
          { status: 'DRAFT', lines: { some: {} } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include,
    }),
    db.order.findMany({
      where: {
        pantry: { householdId: user.householdId },
        householdId: { not: user.householdId },
        status: { in: ['REQUESTED', 'PICKING', 'READY'] },
      },
      orderBy: { createdAt: 'desc' },
      include,
    }),
  ]);

  const ACTIVE = new Set(['DRAFT', 'REQUESTED', 'PICKING', 'READY']);
  const mine = mineRaw.map(summarize);
  const active = mine.filter((r) => ACTIVE.has(r.status));
  const past = mine.filter((r) => !ACTIVE.has(r.status)).slice(0, 20);
  const incoming = incomingRaw.map((o) => summarize(o));

  const empty = mine.length === 0 && incoming.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 p-4 pb-24 sm:p-6">
      <h1 className="text-xl font-semibold tracking-tight">Orders</h1>

      {empty && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
          <p className="text-4xl" aria-hidden>
            🛒
          </p>
          <p className="text-base font-medium text-text">No orders yet.</p>
          <p className="text-sm text-text-muted">
            Browse a pantry and add items to build an order — the household picks it and sets it
            aside for pickup.
          </p>
          <Link
            href="/"
            className="mt-1 min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
          >
            Browse pantries
          </Link>
        </div>
      )}

      {incoming.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Incoming requests
          </h2>
          {incoming.map((row) => (
            <OrderRow key={row.id} row={row} kind="incoming" />
          ))}
        </section>
      )}

      {active.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Your orders</h2>
          {active.map((row) => (
            <OrderRow key={row.id} row={row} kind="mine" />
          ))}
        </section>
      )}

      {past.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Past</h2>
          {past.map((row) => (
            <OrderRow key={row.id} row={row} kind="mine" />
          ))}
        </section>
      )}
    </div>
  );
}
