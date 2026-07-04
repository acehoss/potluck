'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * Circle-scoped visibility control (REWORK P4) — the shared surface behind both
 * the pantry and the item visibility toggles. Three modes: ALL (every circle we
 * grant to), SELECT (only the listed circles), PRIVATE. The circle list is
 * manageConnections-gated server-side while this control is manageHousehold-
 * gated; a manageHousehold-only user opening it sees the server's error inline
 * (circle.list 403) rather than a broken picker.
 */

type Visibility = 'ALL' | 'SELECT' | 'PRIVATE';

const MODE_LABELS: Record<Visibility, string> = {
  ALL: "Everyone I've connected with",
  SELECT: 'Only these circles…',
  PRIVATE: 'Private',
};

/** The chip summary shown on the control button and list badges. */
export function visibilitySummary(visibility: Visibility): string {
  if (visibility === 'ALL') return 'shared';
  if (visibility === 'SELECT') return 'some circles';
  return 'private';
}

const sheetSecondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken';
const sheetPrimaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';

export function VisibilityControl({
  idPrefix,
  targetId,
  visibility,
  circleIds,
}: {
  /** Testid namespace + which router to call: `${idPrefix}-visibility`, etc. */
  idPrefix: 'pantry' | 'item';
  targetId: string;
  visibility: Visibility;
  circleIds: string[];
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Visibility>(visibility);
  const [selected, setSelected] = useState<Set<string>>(new Set(circleIds));
  const [error, setError] = useState<string | null>(null);

  // Only fetch circles once the sheet opens — a manageHousehold-only user never
  // fires the manageConnections-gated query unless they reach for SELECT.
  const circles = useQuery({
    ...trpc.circle.list.queryOptions(),
    enabled: open,
    retry: false,
  });

  const onSuccess = () => {
    setOpen(false);
    setError(null);
    router.refresh();
  };
  const onError = (e: { message: string }) => setError(e.message);
  const setPantry = useMutation(trpc.pantry.setVisibility.mutationOptions({ onSuccess, onError }));
  const setItem = useMutation(trpc.item.setVisibility.mutationOptions({ onSuccess, onError }));
  const saving = setPantry.isPending || setItem.isPending;

  const start = () => {
    setMode(visibility);
    setSelected(new Set(circleIds));
    setError(null);
    setOpen(true);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = () => {
    const nextCircles = mode === 'SELECT' ? [...selected] : [];
    if (idPrefix === 'pantry') {
      setPantry.mutate({ pantryId: targetId, visibility: mode, circleIds: nextCircles });
    } else {
      setItem.mutate({ itemId: targetId, visibility: mode, circleIds: nextCircles });
    }
  };

  return (
    <>
      <button
        type="button"
        data-testid={`${idPrefix}-visibility`}
        onClick={start}
        className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
          visibility === 'PRIVATE'
            ? 'border border-border-strong text-text-muted hover:bg-surface-sunken'
            : 'bg-accent-soft text-accent-strong hover:bg-accent-soft/70'
        }`}
        title="Choose who can see this"
      >
        {visibilitySummary(visibility)}
      </button>

      {open && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
          <div
            data-testid={`${idPrefix}-visibility-sheet`}
            className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
          >
            <h2 className="text-lg font-semibold">Who can see this?</h2>

            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Visibility">
              {(['ALL', 'SELECT', 'PRIVATE'] as const).map((m) => (
                <label
                  key={m}
                  className="flex min-h-11 items-center gap-3 rounded-lg border border-border px-3 text-sm text-text"
                >
                  <input
                    type="radio"
                    name={`${idPrefix}-visibility-mode`}
                    data-testid={`${idPrefix}-visibility-${m.toLowerCase()}`}
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    className="size-5 accent-[var(--color-accent)]"
                  />
                  {MODE_LABELS[m]}
                </label>
              ))}
            </div>

            {mode === 'SELECT' && (
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                {circles.isPending ? (
                  <p className="text-sm text-text-muted">Loading circles…</p>
                ) : circles.isError ? (
                  <p role="alert" className="text-sm text-danger">
                    {circles.error.message}
                  </p>
                ) : circles.data.circles.length === 0 ? (
                  <p className="text-sm text-text-muted">You have no circles yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {circles.data.circles.map((c) => (
                      <li key={c.id}>
                        <label className="flex min-h-11 items-center gap-3 text-sm text-text">
                          <input
                            type="checkbox"
                            data-testid={`${idPrefix}-circle-${c.id}`}
                            checked={selected.has(c.id)}
                            onChange={() => toggle(c.id)}
                            className="size-5 accent-[var(--color-accent)]"
                          />
                          {c.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className={sheetSecondaryBtn}>
                Cancel
              </button>
              <button
                type="button"
                data-testid={`${idPrefix}-visibility-save`}
                disabled={saving || (mode === 'SELECT' && selected.size === 0)}
                onClick={save}
                className={sheetPrimaryBtn}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
