import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { RecipeDetail } from './recipe-detail';

/**
 * Recipe detail — the unified read view for own AND shared recipes (Round R);
 * the editor lives at /recipes/[id]/edit. Server shell: auth redirect;
 * visibility (and the mine flag that picks Edit vs. fork actions) is resolved
 * in the recipe.get query.
 */
export default async function RecipePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const { id } = await params;
  return <RecipeDetail id={id} />;
}
