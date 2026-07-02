import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { restockCode, unitCostCents } from '@/lib/domain';
import { formatCents } from '@/lib/money';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { getActiveRestockCredit } from '@/server/ledger';
import { TakesList, type TakeRow } from './takes-list';

/** Restock detail (blueprint 02): code, photos, lines, credit. */
export default async function RestockDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const restock = await db.restock.findUnique({
    where: { id },
    include: {
      pantry: { include: { household: { select: { name: true } } } },
      purchaserHousehold: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      images: { orderBy: { position: 'asc' } },
      lots: {
        orderBy: { position: 'asc' },
        include: { product: { select: { name: true } } },
      },
    },
  });
  if (!restock) notFound();

  const credit = await getActiveRestockCredit(restock.id);
  // Takes against this restock's lots — the persistent undo path for
  // own-household takes (no ledger row exists to undo them from).
  const takes = await db.take.findMany({
    where: { lot: { restockId: restock.id } },
    orderBy: { takenAt: 'desc' },
    include: {
      taker: { select: { name: true, householdId: true } },
      lot: { select: { product: { select: { name: true } } } },
    },
  });
  const takeRows: TakeRow[] = takes.map((t) => ({
    id: t.id,
    quantity: t.quantity,
    productName: t.lot.product.name,
    takerName: t.taker.name,
    takenAt: t.takenAt.toISOString(),
    costCents: t.costCents,
    reversed: t.reversedAt !== null,
    canUndo: t.reversedAt === null && t.taker.householdId === user.householdId,
  }));
  const lineSum = restock.lots.reduce((s, l) => s + l.lineTotalCents, 0);
  const code =
    restock.dateCode && restock.seq !== null
      ? restockCode(restock.dateCode, restock.seq)
      : 'DRAFT';

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center gap-3">
        <Link
          href={`/pantries/${restock.pantryId}`}
          aria-label="Back to pantry"
          className="text-lg text-text-muted"
        >
          ←
        </Link>
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-widest" data-testid="restock-code">
            {code}
          </h1>
          <p className="text-sm text-text-muted">
            {restock.retailer} · {restock.purchasedAt.toISOString().slice(0, 10)} · into{' '}
            {restock.pantry.name} ({restock.pantry.household.name})
          </p>
        </div>
      </header>

      <main className="flex flex-col gap-4">
        <section className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Summary</h2>
          <p className="mt-2 text-base text-text">
            {restock.lots.length} {restock.lots.length === 1 ? 'line' : 'lines'} ·{' '}
            {restock.lots.reduce((s, l) => s + l.receivedCount, 0)} received units ·{' '}
            {formatCents(lineSum)}
          </p>
          <p className="mt-1 text-sm text-text-muted">
            Purchased by {restock.purchaserHousehold.name} · received by {restock.createdBy.name}
            {restock.receiptTotalCents !== null && (
              <> · receipt {formatCents(restock.receiptTotalCents)}</>
            )}
            {restock.varianceCents !== null && restock.varianceCents !== 0 && (
              <> · variance {formatCents(restock.varianceCents)}</>
            )}
          </p>
          {credit && (
            <p data-testid="restock-credit" className="mt-2 text-sm font-medium text-success">
              {restock.purchaserHousehold.name} credited {formatCents(credit.amountCents)} at cost
            </p>
          )}
        </section>

        {restock.images.length > 0 && (
          <section className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
            <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Receipt
            </h2>
            <div className="mt-2 flex flex-wrap gap-3">
              {restock.images.map((image) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={image.id}
                  src={`/api/images/${image.path}`}
                  alt={`Receipt page ${image.position}`}
                  className="h-40 w-28 rounded-lg border border-border object-cover"
                />
              ))}
            </div>
          </section>
        )}

        <section className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Lines</h2>
          <ul className="mt-1 divide-y divide-border">
            {restock.lots.map((lot) => {
              const unitCost =
                lot.unitCostCents ?? unitCostCents(lot.lineTotalCents, lot.purchasedCount);
              return (
                <li key={lot.id} className="flex min-h-14 items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {lot.unitPhotoPath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/images/${lot.unitPhotoPath}`}
                        alt=""
                        className="size-10 shrink-0 rounded-lg border border-border object-cover"
                      />
                    ) : (
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-muted">
                        🖼
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-base text-text">{lot.product.name}</p>
                      <p className="text-sm text-text-muted">
                        recv {lot.receivedCount}/{lot.purchasedCount} ·{' '}
                        {formatCents(unitCost)}/u
                        {lot.bestBy && <> · BB {lot.bestBy.toISOString().slice(0, 10)}</>}
                      </p>
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-text-muted">
                    {formatCents(lot.lineTotalCents)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <TakesList takes={takeRows} />
      </main>
    </div>
  );
}
