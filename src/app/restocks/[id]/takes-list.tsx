'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatCents } from '@/lib/money';
import { useTRPC } from '@/lib/trpc';

export type TakeRow = {
  id: string;
  quantity: number;
  productName: string;
  takerName: string;
  takenAt: string; // ISO
  costCents: number; // 0 = own-household take (no ledger entry)
  reversed: boolean;
  canUndo: boolean; // viewer's household took it and it isn't reversed
};

const pad2 = (n: number) => String(n).padStart(2, '0');
const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
};

/**
 * Takes against this restock's lots, newest first. This is the persistent
 * undo path for own-household takes (SPEC §4 "takes can be edited/undone"):
 * they post no ledger entry, so once the 10s toast is gone this list is the
 * only place a wrong-product grab can be reversed until slice-4 recounts.
 * Cross-household takes stay undoable from the ledger too.
 */
export function TakesList({ takes }: { takes: TakeRow[] }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const undo = useMutation(
    trpc.take.undo.mutationOptions({
      onSuccess: () => {
        setError(null);
        router.refresh();
      },
      onError: (e) => setError(e.message),
    }),
  );

  if (takes.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
      <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Takes</h2>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <ul className="mt-1 divide-y divide-border">
        {takes.map((t) => (
          <li
            key={t.id}
            data-testid="restock-take-row"
            className="flex min-h-11 items-center justify-between gap-3 py-2"
          >
            <p className="min-w-0 flex-1 truncate text-sm text-text">
              <span className="font-mono text-xs text-text-muted">{localDate(t.takenAt)}</span>{' '}
              {t.takerName} took {t.quantity} × {t.productName}
              {t.reversed && (
                <span className="ml-2 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
                  undone
                </span>
              )}
            </p>
            <span className="shrink-0 font-mono text-sm tabular-nums text-text-muted">
              {t.costCents === 0 ? 'no charge' : formatCents(t.costCents)}
            </span>
            {t.canUndo && (
              <button
                type="button"
                data-testid="restock-take-undo"
                disabled={undo.isPending}
                onClick={() => undo.mutate({ takeId: t.id })}
                className="shrink-0 text-sm font-medium text-danger disabled:opacity-50"
              >
                {undo.isPending ? 'Undoing…' : 'Undo'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
