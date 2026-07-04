'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '@/lib/trpc';
import type { IngredientLink } from './types';

/**
 * The per-viewer-household ingredient → product link affordance (G2). Resolves
 * to a product name when linked; the picker offers fuzzy `suggestions` for the
 * current line text (never auto-links) and a clear action. Quantities never
 * convert across the link — this shows the product name only. Self-contained:
 * seeds from the recipe.get resolution and tracks its own state for the
 * session (a reload re-resolves server-side).
 */
export function IngredientLinkControl({
  text,
  initialLink,
}: {
  text: string;
  initialLink: IngredientLink | null;
}) {
  const trpc = useTRPC();
  const [link, setLink] = useState<IngredientLink | null>(initialLink);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestions = useQuery(
    trpc.recipe.suggestions.queryOptions({ text }, { enabled: open }),
  );
  const linkMut = useMutation(
    trpc.recipe.linkIngredient.mutationOptions({
      onSuccess: (res) => {
        setLink({ productId: res.productId, productName: res.productName });
        setOpen(false);
      },
      onError: (e) => setError(e.message),
    }),
  );
  const unlinkMut = useMutation(
    trpc.recipe.unlinkIngredient.mutationOptions({
      onSuccess: () => {
        setLink(null);
        setOpen(false);
      },
      onError: (e) => setError(e.message),
    }),
  );

  const canLink = text.trim().length > 0;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {link && <span className="text-accent-strong">→ {link.productName}</span>}
      <button
        type="button"
        data-testid="ingredient-link-open"
        disabled={!canLink}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="rounded-full border border-border-strong px-2.5 py-1 font-medium text-text-muted transition-colors hover:bg-surface-sunken disabled:opacity-40"
      >
        {link ? 'Change link' : '🔗 Link to product'}
      </button>

      {open && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-scrim sm:items-center">
          <div
            data-testid="ingredient-link-sheet"
            className="flex w-full max-w-md flex-col gap-3 rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
          >
            <h2 className="text-base font-semibold text-text">Link “{text.trim()}”</h2>
            <p className="text-sm text-text-muted">
              Point this ingredient at one of your products. Amounts never convert — it just links
              the name.
            </p>

            {suggestions.isLoading && <p className="text-sm text-text-muted">Finding matches…</p>}
            {suggestions.data && suggestions.data.length === 0 && (
              <p className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-center text-sm text-text-muted">
                No matching products in your catalog.
              </p>
            )}
            {suggestions.data && suggestions.data.length > 0 && (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {suggestions.data.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      data-testid="ingredient-link-pick"
                      disabled={linkMut.isPending}
                      onClick={() => {
                        setError(null);
                        linkMut.mutate({ text, productId: p.id });
                      }}
                      className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
                    >
                      <span className="truncate">{p.name}</span>
                      {link?.productId === p.id && (
                        <span className="shrink-0 text-xs text-accent-strong">linked</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              {link && (
                <button
                  type="button"
                  data-testid="ingredient-link-clear"
                  disabled={unlinkMut.isPending}
                  onClick={() => {
                    setError(null);
                    unlinkMut.mutate({ text });
                  }}
                  className="min-h-11 flex-1 rounded-lg border border-danger/40 px-4 py-2.5 font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
                >
                  Clear link
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
