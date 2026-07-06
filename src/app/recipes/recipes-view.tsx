'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { BackLink } from '@/app/nav-history';
import { useTRPC } from '@/lib/trpc';
import type { SlimRecipe } from './types';

/**
 * The recipe book (REWORK G). Two sections: "Your book" (own recipes, private
 * ones flagged) and "From your connections" (recipes shared over a `recipes`
 * grant, each tagged with its household). Rows link to the detail/editor.
 */

function timeLabel(prep: number | null, cook: number | null): string | null {
  const total = (prep ?? 0) + (cook ?? 0);
  return total > 0 ? `${total} min` : null;
}

function RecipeRow({ recipe }: { recipe: SlimRecipe }) {
  const meta = [recipe.course ?? undefined, ...recipe.tags].filter((s): s is string =>
    Boolean(s),
  );
  const time = timeLabel(recipe.prepMinutes, recipe.cookMinutes);

  return (
    <Link
      href={`/recipes/${recipe.id}`}
      data-testid="recipe-row"
      className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised p-3 shadow-sm transition-colors hover:bg-surface-sunken"
    >
      {recipe.photoPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/images/${recipe.photoPath}`}
          alt=""
          className="size-14 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-xl text-text-muted">
          🍲
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-base font-medium text-text">
          {recipe.title}
          {recipe.private && (
            <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-normal text-text-muted">
              private
            </span>
          )}
        </p>
        {meta.length > 0 && <p className="truncate text-sm text-text-muted">{meta.join(' · ')}</p>}
        <p className="text-xs text-text-muted">
          {recipe.householdName && <span>{recipe.householdName}</span>}
          {recipe.householdName && time && <span> · </span>}
          {time && <span>{time}</span>}
        </p>
      </div>
      <span className="shrink-0 text-text-muted">→</span>
    </Link>
  );
}

export function RecipesView() {
  const trpc = useTRPC();
  const book = useQuery(trpc.recipe.list.queryOptions());

  const mine = (book.data?.mine ?? []) as SlimRecipe[];
  const shared = (book.data?.shared ?? []) as SlimRecipe[];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 p-4 pb-24 sm:p-6 sm:pb-24">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <BackLink fallback="/home" />
          <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">Recipes</h1>
        </div>
        <p className="pl-8 text-sm text-text-muted">
          Your family favorites, plus recipes shared by your connections.
        </p>
      </header>

      <Link
        href="/recipes/new"
        data-testid="recipe-new"
        className="min-h-14 rounded-xl border border-dashed border-border-strong px-4 py-3 text-left text-base font-medium text-text-muted transition-colors hover:bg-surface-sunken"
      >
        + New recipe
      </Link>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">Your book</h2>
        {mine.length > 0 ? (
          <div className="flex flex-col gap-2">
            {mine.map((r) => (
              <RecipeRow key={r.id} recipe={r} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
            <p className="text-4xl" aria-hidden>
              📖
            </p>
            <p className="text-base font-medium text-text">Your book is empty.</p>
            <p className="text-sm text-text-muted">Paste in the family favorites to get started.</p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          From your connections
        </h2>
        {shared.length > 0 ? (
          <div className="flex flex-col gap-2">
            {shared.map((r) => (
              <RecipeRow key={r.id} recipe={r} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border-strong px-6 py-8 text-center text-sm text-text-muted">
            Nothing shared with you yet — recipes your connections share will show up here.
          </p>
        )}
      </section>
    </div>
  );
}
