'use client';

export type AdjustmentRow = {
  id: string;
  type: 'RECOUNT' | 'WRITE_OFF';
  countBefore: number;
  countAfter: number;
  note: string | null;
  productName: string;
  createdByName: string;
  createdAt: string; // ISO
};

const pad2 = (n: number) => String(n).padStart(2, '0');
// Local calendar date (client component): an 8pm CDT adjustment must read
// today's date, not tomorrow's UTC one — same lesson as the ledger rows.
const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
};

/**
 * Recounts and write-offs against this restock's lots, newest first — the
 * audit trail for blueprint 01 invariant 9's adjustment term. Never money:
 * the owner household eats drift and spoilage in v1 (invariant 8).
 */
export function AdjustmentsList({ adjustments }: { adjustments: AdjustmentRow[] }) {
  if (adjustments.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
      <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Adjustments</h2>
      <ul className="mt-1 divide-y divide-border">
        {adjustments.map((a) => (
          <li
            key={a.id}
            data-testid="restock-adjustment-row"
            className="flex min-h-11 items-center justify-between gap-3 py-2"
          >
            <p className="min-w-0 flex-1 text-sm text-text">
              <span className="font-mono text-xs text-text-muted">{localDate(a.createdAt)}</span>{' '}
              {a.type === 'RECOUNT' ? (
                <>
                  {a.createdByName} recounted {a.productName}: {a.countBefore} → {a.countAfter}
                </>
              ) : (
                <>
                  {a.createdByName} wrote off {a.countBefore - a.countAfter} × {a.productName}
                </>
              )}
              {a.note && <span className="text-text-muted"> · {a.note}</span>}
            </p>
            <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
              {a.type === 'RECOUNT' ? 'recount' : 'write-off'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
