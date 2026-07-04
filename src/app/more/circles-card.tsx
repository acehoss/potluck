'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';
import { GRANT_LABELS, type GrantSet, grantsSummary } from './connections-card';

/**
 * Circle management (REWORK P4): a household's named grant bundles. A circle IS
 * the six directional grants that used to live per-connection — editing one
 * changes what everyone placed in it may do, immediately. manageConnections-
 * gated (circle.list 403s otherwise, and this card renders nothing). Deleting a
 * circle still in use (connections or scoped resources) is a 409, surfaced
 * inline so the manager knows to reassign/rescope first.
 */

const cardClass =
  'flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm';
const primaryBtn =
  'min-h-11 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text hover:bg-surface-sunken disabled:opacity-50';
const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';

type Circle = {
  id: string;
  name: string;
  grants: GrantSet;
  connectionCount: number;
  scopeCount: number;
};

const EMPTY_GRANTS: GrantSet = {
  pantry: false,
  lending: false,
  recipes: false,
  shareTo: false,
  shareFrom: false,
  reshare: false,
};

export function CirclesCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const circles = useQuery({ ...trpc.circle.list.queryOptions(), retry: false });

  const [editing, setEditing] = useState<Circle | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void queryClient.invalidateQueries(trpc.circle.list.pathFilter());
  };
  const onError = (e: { message: string }) => setError(e.message);

  const del = useMutation(trpc.circle.delete.mutationOptions({ onSuccess: refresh, onError }));

  // manageConnections-gated read; anyone without it (or a load error) gets no card.
  if (circles.isError || !circles.data) return null;
  const rows = circles.data.circles as Circle[];

  return (
    <section data-testid="circles-card" className={cardClass}>
      <h2 className="text-lg font-semibold">Circles</h2>
      <p className="text-sm text-text-muted">
        Named groups that decide what a connected household may do with your things. Place each
        connection into one.
      </p>

      <ul className="flex flex-col">
        {rows.map((c) => (
          <li
            key={c.id}
            data-testid="circle-row"
            className="flex min-h-11 items-center justify-between gap-2 border-b border-border py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-text">{c.name}</p>
              <p className="text-xs text-text-muted">
                {grantsSummary(c.grants)} ·{' '}
                {c.connectionCount === 1 ? '1 connection' : `${c.connectionCount} connections`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                data-testid="circle-edit"
                onClick={() => {
                  setError(null);
                  setEditing(c);
                }}
                className="min-h-11 rounded-lg px-3 text-sm font-medium text-accent-strong hover:bg-surface-sunken"
              >
                Edit
              </button>
              <button
                type="button"
                data-testid="circle-delete"
                disabled={del.isPending}
                onClick={() => {
                  if (window.confirm(`Delete the "${c.name}" circle?`)) {
                    del.mutate({ circleId: c.id });
                  }
                }}
                className="min-h-11 rounded-lg px-3 text-sm font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      <button
        type="button"
        data-testid="circle-create"
        onClick={() => {
          setError(null);
          setEditing('new');
        }}
        className={secondaryBtn}
      >
        New circle…
      </button>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {editing && (
        <CircleSheet
          circle={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

/** Create/edit sheet: name + the six plain-language grant checkboxes. */
function CircleSheet({
  circle,
  onClose,
  onDone,
}: {
  circle: Circle | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const [name, setName] = useState(circle?.name ?? '');
  const [grants, setGrants] = useState<GrantSet>(circle ? { ...circle.grants } : { ...EMPTY_GRANTS });
  const [error, setError] = useState<string | null>(null);

  const onError = (e: { message: string }) => setError(e.message);
  const create = useMutation(trpc.circle.create.mutationOptions({ onSuccess: onDone, onError }));
  const update = useMutation(trpc.circle.update.mutationOptions({ onSuccess: onDone, onError }));
  const saving = create.isPending || update.isPending;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the circle a name.');
      return;
    }
    if (circle) update.mutate({ circleId: circle.id, name: trimmed, grants });
    else create.mutate({ name: trimmed, grants });
  };

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <div
        data-testid="circle-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
      >
        <h2 className="text-lg font-semibold">{circle ? 'Edit circle' : 'New circle'}</h2>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Name
          <input
            type="text"
            required
            data-testid="circle-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Book club"
            className={inputClass}
          />
        </label>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text">What it lets them do:</p>
          <ul className="flex flex-col gap-1">
            {GRANT_LABELS.map(({ key, label }) => (
              <li key={key}>
                <label className="flex min-h-11 items-center gap-3 text-sm text-text">
                  <input
                    type="checkbox"
                    data-testid={`circle-grant-${key}`}
                    checked={grants[key]}
                    onChange={(e) => setGrants({ ...grants, [key]: e.target.checked })}
                    className="size-5 accent-[var(--color-accent)]"
                  />
                  {label}
                </label>
              </li>
            ))}
          </ul>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondaryBtn} flex-1`}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="circle-save"
            disabled={saving}
            onClick={submit}
            className={`${primaryBtn} flex-1`}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
