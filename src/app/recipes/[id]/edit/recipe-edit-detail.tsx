'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTRPC } from '@/lib/trpc';
import { RecipeEditor } from '../../recipe-editor';
import type { RecipeDto } from '../../types';

/**
 * The own-recipe editor route (Round R). The read view moved to /recipes/[id];
 * editing is a deliberate second click. A recipe you don't own (or can't see)
 * has no editable form here — the same gentle not-found the detail view shows.
 */
export function RecipeEditDetail({ id }: { id: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.recipe.get.queryOptions({ id }, { retry: false }));

  if (query.isLoading) {
    return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  }
  const recipe = query.data as RecipeDto | undefined;
  if (query.isError || !recipe || !recipe.mine) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center gap-3 p-6 pb-24 text-center">
        <p className="text-4xl" aria-hidden>
          🤷
        </p>
        <p className="text-base font-medium text-text">This recipe can&apos;t be edited.</p>
        <Link href={`/recipes/${id}`} className="text-sm text-accent underline">
          Back to the recipe
        </Link>
      </div>
    );
  }

  return <RecipeEditor initial={recipe} backFallback={`/recipes/${id}`} />;
}
