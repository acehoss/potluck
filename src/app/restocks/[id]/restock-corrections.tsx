'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';

/**
 * Auditable corrections for a FINALIZED restock (blueprint 01 Immutability +
 * invariant 5). FINALIZED stays terminal — nothing here rewrites a frozen unit
 * cost that takes already used. Two ops, each previewing the exact ledger
 * change before it commits (Aaron's ask):
 *  - Correct received counts → restock.correctCredit (reverse + repost credit).
 *  - Void (entered in error) → restock.voidInError (reverse credit, zero stock).
 * Only rendered for the purchaser / pantry-owning household on a live restock.
 */

export type CorrectionLot = {
  id: string;
  productName: string;
  purchasedCount: number;
  receivedCount: number;
  unitCostCents: number;
};

const sheetPrimaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:opacity-50';
const sheetSecondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken';
const stepperBtn =
  'flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40';

export function RestockCorrections({
  restockId,
  crossHousehold,
  purchaserName,
  currentCreditCents,
  hasTakes,
  lots,
}: {
  restockId: string;
  crossHousehold: boolean;
  purchaserName: string;
  currentCreditCents: number;
  hasTakes: boolean;
  lots: CorrectionLot[];
}) {
  const [sheet, setSheet] = useState<null | 'correct' | 'void'>(null);

  return (
    <section
      data-testid="corrections"
      className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Corrections</h2>
      <p className="mt-2 text-sm text-text-muted">
        This restock is finalized. Fixes stay on the record — nothing is erased.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {crossHousehold && (
          <button
            type="button"
            data-testid="open-correct"
            onClick={() => setSheet('correct')}
            className="min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 text-sm font-medium text-text transition-colors hover:bg-surface-sunken"
          >
            Correct received counts
          </button>
        )}
        <button
          type="button"
          data-testid="open-void"
          onClick={() => setSheet('void')}
          className="min-h-11 flex-1 rounded-lg border border-danger/40 px-4 py-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
        >
          Void — entered in error
        </button>
      </div>

      {sheet === 'correct' && (
        <CorrectCreditSheet
          restockId={restockId}
          purchaserName={purchaserName}
          currentCreditCents={currentCreditCents}
          lots={lots}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'void' && (
        <VoidSheet
          restockId={restockId}
          purchaserName={purchaserName}
          crossHousehold={crossHousehold}
          currentCreditCents={currentCreditCents}
          hasTakes={hasTakes}
          unitTotal={lots.reduce((s, l) => s + l.receivedCount, 0)}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
}

function CorrectCreditSheet({
  restockId,
  purchaserName,
  currentCreditCents,
  lots,
  onClose,
}: {
  restockId: string;
  purchaserName: string;
  currentCreditCents: number;
  lots: CorrectionLot[];
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, number>>(
    Object.fromEntries(lots.map((l) => [l.id, l.receivedCount])),
  );
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const correct = useMutation(
    trpc.restock.correctCredit.mutationOptions({
      onSuccess: () => {
        onClose();
        router.refresh();
      },
      onError: (e) => setError(e.message),
    }),
  );

  // Preview mirrors the server: credit = Σ receivedCount × frozen unitCost.
  const correctedCredit = lots.reduce((s, l) => s + counts[l.id] * l.unitCostCents, 0);
  const changed = lots.filter((l) => counts[l.id] !== l.receivedCount);
  const noChange = changed.length === 0;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="correct-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold">Correct received counts</h2>
        <p className="text-sm text-text-muted">
          Set what actually went into the pantry. The credit is recomputed at the frozen unit
          costs; physical shelf drift is a <span className="font-medium text-text">recount</span>,
          not this.
        </p>

        <ul className="flex flex-col gap-3">
          {lots.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-text">{l.productName}</p>
                <p className="text-xs text-text-muted">
                  of {l.purchasedCount} · {formatCents(l.unitCostCents)}/u
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label={`Fewer ${l.productName}`}
                  disabled={counts[l.id] <= 0}
                  onClick={() =>
                    setCounts((c) => ({ ...c, [l.id]: Math.max(0, c[l.id] - 1) }))
                  }
                  className={stepperBtn}
                >
                  −
                </button>
                <span
                  data-testid={`correct-count-${l.id}`}
                  className="w-8 text-center font-mono tabular-nums"
                >
                  {counts[l.id]}
                </span>
                <button
                  type="button"
                  aria-label={`More ${l.productName}`}
                  disabled={counts[l.id] >= l.purchasedCount}
                  onClick={() =>
                    setCounts((c) => ({
                      ...c,
                      [l.id]: Math.min(l.purchasedCount, c[l.id] + 1),
                    }))
                  }
                  className={stepperBtn}
                >
                  +
                </button>
              </div>
            </li>
          ))}
        </ul>

        {reviewing && (
          <div
            data-testid="correct-preview"
            className="flex flex-col gap-1 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-sm"
          >
            <p className="font-medium text-accent-strong">This will:</p>
            <p className="text-text">
              Reverse {purchaserName}&apos;s current credit of{' '}
              <span className="font-medium">{formatCents(currentCreditCents)}</span>
            </p>
            <p className="text-text">
              {correctedCredit > 0 ? (
                <>
                  Post a corrected credit of{' '}
                  <span className="font-medium">{formatCents(correctedCredit)}</span>
                </>
              ) : (
                <>Post no new credit ({purchaserName} owed nothing for received units)</>
              )}
            </p>
            <p className="mt-1 text-text-muted">
              Net change to what {purchaserName} is owed:{' '}
              {formatCents(correctedCredit - currentCreditCents)}
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={sheetSecondaryBtn}>
            Cancel
          </button>
          {reviewing ? (
            <button
              type="button"
              data-testid="correct-confirm"
              disabled={correct.isPending || noChange}
              onClick={() =>
                correct.mutate({
                  restockId,
                  corrections: changed.map((l) => ({ lotId: l.id, receivedCount: counts[l.id] })),
                })
              }
              className={sheetPrimaryBtn}
            >
              {correct.isPending ? 'Posting…' : 'Confirm correction'}
            </button>
          ) : (
            <button
              type="button"
              data-testid="correct-review"
              disabled={noChange}
              onClick={() => setReviewing(true)}
              className={sheetPrimaryBtn}
            >
              {noChange ? 'No changes' : 'Review changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function VoidSheet({
  restockId,
  purchaserName,
  crossHousehold,
  currentCreditCents,
  hasTakes,
  unitTotal,
  onClose,
}: {
  restockId: string;
  purchaserName: string;
  crossHousehold: boolean;
  currentCreditCents: number;
  hasTakes: boolean;
  unitTotal: number;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const voidRestock = useMutation(
    trpc.restock.voidInError.mutationOptions({
      onSuccess: () => {
        onClose();
        router.refresh();
      },
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="void-sheet"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold">Void this restock</h2>
        {hasTakes ? (
          <p className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm font-medium text-warn">
            This restock already has takes against its lots. Undo those first, or use{' '}
            <span className="font-medium">Correct received counts</span> — voiding can&apos;t
            pretend a taken lot never existed.
          </p>
        ) : (
          <div
            data-testid="void-preview"
            className="flex flex-col gap-1 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm"
          >
            <p className="font-medium text-danger">This will:</p>
            {crossHousehold && currentCreditCents > 0 && (
              <p className="text-text">
                Reverse {purchaserName}&apos;s credit of{' '}
                <span className="font-medium">{formatCents(currentCreditCents)}</span>
              </p>
            )}
            <p className="text-text">
              Remove all <span className="font-medium">{unitTotal}</span> received units of this
              restock from inventory
            </p>
            <p className="mt-1 text-text-muted">
              The restock stays on the record, marked voided. It can&apos;t be undone.
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={sheetSecondaryBtn}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="void-confirm"
            disabled={voidRestock.isPending || hasTakes}
            onClick={() => voidRestock.mutate({ restockId })}
            className="min-h-11 flex-1 rounded-lg bg-danger px-4 py-2.5 font-medium text-danger-contrast transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {voidRestock.isPending ? 'Voiding…' : 'Void restock'}
          </button>
        </div>
      </div>
    </div>
  );
}
