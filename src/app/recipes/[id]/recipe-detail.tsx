'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTRPC } from '@/lib/trpc';
import { RecipeEditor } from '../recipe-editor';
import { SharedRecipeView } from '../shared-recipe-view';
import type { RecipeDto } from '../types';

/**
 * Recipe detail router: an own recipe opens the editor (populated + delete);
 * a shared recipe opens the read-only view (scaler + fork). Visibility is the
 * server's call — a 404 renders a gentle not-found.
 */
export function RecipeDetail({ id }: { id: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.recipe.get.queryOptions({ id }, { retry: false }));

  if (query.isLoading) {
    return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center gap-3 p-6 pb-24 text-center">
        <p className="text-4xl" aria-hidden>
          🤷
        </p>
        <p className="text-base font-medium text-text">This recipe isn&apos;t available.</p>
        <Link href="/recipes" className="text-sm text-accent underline">
          Back to your book
        </Link>
      </div>
    );
  }

  const recipe = query.data as RecipeDto;
  return recipe.mine ? (
    <RecipeEditor initial={recipe} />
  ) : (
    <SharedRecipeView recipe={recipe} />
  );
}
