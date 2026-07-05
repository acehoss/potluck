'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';

/**
 * My contact-card visibility (REWORK P5, Round C). Every member self-serves who
 * can see their card on a connected household's contact page: ALL (everyone I've
 * connected with) / SELECT (only the listed circles) / PRIVATE. Runs through
 * membership.setVisibility against the ACTING membership — no capability needed
 * to hide yourself. The SELECT circle list uses circle.names (any-member,
 * id+name only), so a plain member without manageConnections can still scope
 * their card to specific circles (Round E closes that Round-C gap).
 */

type Visibility = 'ALL' | 'SELECT' | 'PRIVATE';

const MODE_LABELS: Record<Visibility, string> = {
  ALL: "Everyone I've connected with",
  SELECT: 'Only these circles…',
  PRIVATE: 'Just my household (private)',
};

function summary(visibility: Visibility): string {
  if (visibility === 'ALL') return 'visible to all connections';
  if (visibility === 'SELECT') return 'visible to some circles';
  return 'private';
}

const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';
const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';

export function MemberVisibilityCard({
  membershipId,
  visibility,
  circleIds,
}: {
  membershipId: string;
  visibility: Visibility;
  circleIds: string[];
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Visibility>(visibility);
  const [selected, setSelected] = useState<Set<string>>(new Set(circleIds));
  const [error, setError] = useState<string | null>(null);

  // Only fetch circles once the sheet opens. circle.names is any-member, so a
  // plain member can scope to SELECT circles without manageConnections.
  const circles = useQuery({ ...trpc.circle.names.queryOptions(), enabled: open, retry: false });

  const setVis = useMutation(
    trpc.membership.setVisibility.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setError(null);
        router.refresh();
      },
      onError: (e) => setError(e.message),
    }),
  );

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
    setVis.mutate({
      membershipId,
      visibility: mode,
      circleIds: mode === 'SELECT' ? [...selected] : undefined,
    });
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text">Who can see my contact card</h2>
          <p className="text-sm text-text-muted">
            Your photo, phone, and bio on a connected household&apos;s people page.
          </p>
        </div>
        <button
          type="button"
          data-testid="member-visibility"
          onClick={start}
          className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            visibility === 'PRIVATE'
              ? 'border border-border-strong text-text-muted hover:bg-surface-sunken'
              : 'bg-accent-soft text-accent-strong hover:bg-accent-soft/70'
          }`}
        >
          {summary(visibility)}
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
          <div
            data-testid="member-visibility-sheet"
            className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
          >
            <h2 className="text-lg font-semibold">Who can see my contact card?</h2>

            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Card visibility">
              {(['ALL', 'SELECT', 'PRIVATE'] as const).map((m) => (
                <label
                  key={m}
                  className="flex min-h-11 items-center gap-3 rounded-lg border border-border px-3 text-sm text-text"
                >
                  <input
                    type="radio"
                    name="member-visibility-mode"
                    data-testid={`member-visibility-${m.toLowerCase()}`}
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
                            data-testid={`member-circle-${c.id}`}
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
              <button type="button" onClick={() => setOpen(false)} className={secondaryBtn}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="member-visibility-save"
                disabled={setVis.isPending || (mode === 'SELECT' && selected.size === 0)}
                onClick={save}
                className={primaryBtn}
              >
                {setVis.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
