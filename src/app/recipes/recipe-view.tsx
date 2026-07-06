'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BackLink } from '@/app/nav-history';
import { newClientKey } from '@/lib/client-key';
import { useTRPC } from '@/lib/trpc';
import { IngredientLinkControl } from './ingredient-link-control';
import { scaleAmount } from './scale';
import { splitSteps } from './steps';
import type { RecipeDto } from './types';
import { primaryBtn, secondaryBtn } from './ui';

/**
 * The recipe read view (Round R) — one presentation for BOTH own and shared
 * recipes. Photo, meta, the display-time servings scaler (G1), scaled
 * ingredients with the per-viewer ingredient-link affordance (G2), and
 * directions rendered as numbered steps (same `splitSteps` the Cook view uses).
 *
 * Actions branch on ownership: **Cook** always (opens the hands-free stepper);
 * **Edit** on your own recipes (the editor moved to /recipes/[id]/edit); **Save
 * to my book** (fork) on a connection's shared recipe. Links are the *viewer's*
 * household map, so they work on someone else's recipe too.
 */

function timeLabel(prep: number | null, cook: number | null): string | null {
  const total = (prep ?? 0) + (cook ?? 0);
  return total > 0 ? `${total} min` : null;
}

export function RecipeView({ recipe }: { recipe: RecipeDto }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [clientKey] = useState(newClientKey);
  const [error, setError] = useState<string | null>(null);

  const base = recipe.servings ?? null;
  const [target, setTarget] = useState<number>(base ?? 1);
  const factor = base && base > 0 ? target / base : 1;

  const fork = useMutation(
    trpc.recipe.fork.mutationOptions({
      onSuccess: (res) => {
        queryClient.invalidateQueries(trpc.recipe.list.pathFilter());
        router.push(`/recipes/${res.id}`);
      },
      onError: (e) => setError(e.message),
    }),
  );

  const time = timeLabel(recipe.prepMinutes, recipe.cookMinutes);
  const metaLine = [recipe.course ?? undefined, recipe.cuisine ?? undefined, ...recipe.tags].filter(
    (s): s is string => Boolean(s),
  );
  const steps = splitSteps(recipe.directions);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex items-center gap-3">
        <BackLink fallback="/recipes" label="Back to book" />
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
          {recipe.title}
        </h1>
      </header>

      {!recipe.mine && (
        <p className="text-sm text-text-muted">
          Shared by {recipe.householdName}
          {recipe.forkedFromTitle && recipe.forkedFromHouseholdName && (
            <>
              {' '}
              · forked from {recipe.forkedFromTitle} · {recipe.forkedFromHouseholdName}
            </>
          )}
        </p>
      )}
      {recipe.mine && recipe.forkedFromTitle && recipe.forkedFromHouseholdName && (
        <p className="text-sm text-text-muted">
          Forked from {recipe.forkedFromTitle} · {recipe.forkedFromHouseholdName}
        </p>
      )}

      {/* Actions: Cook is always the primary act; Edit (own) / fork (shared) ride beside it. */}
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/recipes/${recipe.id}/cook`}
          data-testid="recipe-cook"
          className={`${primaryBtn} inline-flex items-center justify-center`}
        >
          Cook
        </Link>
        {recipe.mine ? (
          <Link
            href={`/recipes/${recipe.id}/edit`}
            data-testid="recipe-edit"
            className={`${secondaryBtn} inline-flex items-center justify-center`}
          >
            Edit
          </Link>
        ) : (
          <button
            type="button"
            data-testid="recipe-fork"
            disabled={fork.isPending}
            onClick={() => {
              setError(null);
              fork.mutate({ recipeId: recipe.id, clientKey });
            }}
            className={secondaryBtn}
          >
            {fork.isPending ? 'Saving…' : 'Save to my book'}
          </button>
        )}
      </div>
      {!recipe.mine && (
        <p className="-mt-3 text-xs text-text-muted">
          A saved copy starts private — share it onward from your own book if you like.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {recipe.photoPath && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/images/${recipe.photoPath}`}
          alt=""
          className="aspect-video w-full rounded-xl border border-border object-cover"
        />
      )}

      {recipe.description && <p className="text-base text-text">{recipe.description}</p>}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
        {metaLine.length > 0 && <span>{metaLine.join(' · ')}</span>}
        {time && <span>{time}</span>}
        {recipe.yieldText && <span>Makes {recipe.yieldText}</span>}
      </div>

      {/* Servings scaler (display-time only). */}
      {base != null && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised p-3 shadow-sm">
          <span className="text-sm font-medium text-text">
            Servings{' '}
            {factor !== 1 && (
              <span className="font-normal text-text-muted">(recipe makes {base})</span>
            )}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Fewer servings"
              disabled={target <= 1}
              onClick={() => setTarget((t) => Math.max(1, t - 1))}
              className="flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken disabled:opacity-40"
            >
              −
            </button>
            <span
              data-testid="recipe-servings-value"
              className="w-8 text-center font-mono text-base tabular-nums text-text"
            >
              {target}
            </span>
            <button
              type="button"
              aria-label="More servings"
              onClick={() => setTarget((t) => t + 1)}
              className="flex size-11 items-center justify-center rounded-lg border border-border-strong text-lg font-medium text-text hover:bg-surface-sunken"
            >
              +
            </button>
          </div>
        </div>
      )}

      <IngredientList recipe={recipe} factor={factor} />

      {steps.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text">Directions</h2>
          <ol className="flex flex-col gap-3">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span
                  aria-hidden
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken font-mono text-sm tabular-nums text-text-muted"
                >
                  {i + 1}
                </span>
                <p className="min-w-0 text-base text-text">{step}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {recipe.sourceUrl && (
        <p className="text-xs text-text-muted">
          Source:{' '}
          <a href={recipe.sourceUrl} target="_blank" rel="noreferrer" className="text-accent underline">
            {recipe.sourceUrl}
          </a>
        </p>
      )}
    </div>
  );
}

/** The scaled ingredient list, shared between own read and shared read. */
function IngredientList({ recipe, factor }: { recipe: RecipeDto; factor: number }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold text-text">Ingredients</h2>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-raised px-3 shadow-sm">
        {recipe.ingredients.map((ing) =>
          ing.kind === 'heading' ? (
            <li
              key={ing.id}
              className="pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-text-muted"
            >
              {ing.text}
            </li>
          ) : (
            <li key={ing.id} className="flex flex-col gap-1 py-2">
              <div className="flex items-baseline gap-2">
                {ing.amount && (() => {
                  const s = scaleAmount(ing.amount, factor);
                  return (
                    <span className="shrink-0 font-mono text-sm tabular-nums text-text">
                      {s.approx && '~'}
                      {s.display}
                    </span>
                  );
                })()}
                {ing.unit && <span className="shrink-0 text-sm text-text-muted">{ing.unit}</span>}
                <span className="min-w-0 text-base text-text">{ing.text}</span>
              </div>
              {ing.note && <p className="text-sm text-text-muted">{ing.note}</p>}
              <IngredientLinkControl text={ing.text} initialLink={ing.link} />
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
