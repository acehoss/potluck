import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { restockCode } from '@/lib/domain';
import { formatCents } from '@/lib/money';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';

/**
 * Restock history for a pantry (Aaron's ask): every shopping run into this
 * pantry, newest first. Drafts the viewer can act on resume the wizard;
 * finalized/voided ones open the detail, where the auditable corrections live.
 * Read-only otherwise — a finalized restock is never reopened for free edits
 * (that would rewrite frozen unit costs takes already used).
 */
export default async function RestockHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const pantry = await db.pantry.findUnique({
    where: { id },
    include: { household: { select: { name: true } } },
  });
  if (!pantry) notFound();
  // Receiving history is owner-side data (costs, drafts, receipts): the
  // acting household must own the pantry (REWORK B4 — connected households
  // see inventory, not the books; a purchaser reads its credit's audit trail
  // on the restock detail instead).
  if (pantry.householdId !== user.householdId) notFound();

  const restocks = await db.restock.findMany({
    where: { pantryId: id },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      purchaserHousehold: { select: { name: true } },
      lots: { select: { receivedCount: true, excluded: true } },
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center gap-3">
        <Link
          href={`/pantries/${id}`}
          aria-label="Back to pantry"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-lg text-text-muted transition-colors hover:bg-surface-sunken"
        >
          ←
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          Restock history{' '}
          <span className="font-normal text-text-muted">({pantry.household.name})</span>
        </h1>
      </header>

      {restocks.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
          <p className="text-sm font-medium text-text">No restocks yet.</p>
          <p className="text-sm text-text-muted">
            Every shopping run you receive into this pantry shows up here.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {restocks.map((r) => {
            const receivedUnits = r.lots.reduce((s, l) => s + l.receivedCount, 0);
            const lineCount = r.lots.filter((l) => !l.excluded).length;
            const code =
              r.dateCode && r.seq !== null ? restockCode(r.dateCode, r.seq) : 'DRAFT';
            const isDraft = r.status === 'DRAFT';
            const voided = r.voidedAt !== null;
            // Resume only for a draft the viewer can edit/finalize — the page
            // is already owner-household-gated, so that's the receiveStock
            // capability (matches the restock router's gate).
            const canResume = isDraft && user.activeMembership.receiveStock;
            const href = isDraft
              ? `/pantries/${id}/receive/${r.id}?step=2`
              : `/restocks/${r.id}`;

            const body = (
              <div
                className={`flex items-center justify-between gap-3 rounded-xl border p-3 shadow-sm ${
                  voided
                    ? 'border-border bg-surface-sunken'
                    : 'border-border bg-surface-raised'
                }`}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-mono text-base font-medium tracking-widest text-text">
                    {code}
                    {isDraft && (
                      <span className="rounded-full bg-warn-soft px-2 py-0.5 font-sans text-xs font-medium tracking-normal text-warn">
                        draft
                      </span>
                    )}
                    {voided && (
                      <span className="rounded-full bg-danger/10 px-2 py-0.5 font-sans text-xs font-medium tracking-normal text-danger">
                        voided
                      </span>
                    )}
                  </p>
                  <p className="truncate text-sm text-text-muted">
                    {r.retailer} · {r.purchasedAt.toISOString().slice(0, 10)} ·{' '}
                    {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {receivedUnits} units
                  </p>
                  {r.purchaserHouseholdId !== pantry.householdId && (
                    <p className="text-xs text-text-muted">
                      bought by {r.purchaserHousehold.name}
                    </p>
                  )}
                </div>
                {r.receiptTotalCents !== null && (
                  <span className="shrink-0 font-mono text-sm tabular-nums text-text-muted">
                    {formatCents(r.receiptTotalCents)}
                  </span>
                )}
              </div>
            );

            if (isDraft && !canResume) {
              return (
                <li key={r.id} data-testid="history-row" className="opacity-70">
                  {body}
                </li>
              );
            }
            return (
              <li key={r.id} data-testid="history-row">
                <Link href={href} data-testid={isDraft ? 'history-resume' : 'history-view'}>
                  {body}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
