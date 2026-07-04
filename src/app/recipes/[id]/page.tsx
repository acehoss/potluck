import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { RecipeDetail } from './recipe-detail';

/**
 * Recipe detail — own recipe opens the editor, a shared one the read-only view.
 * Server shell: auth redirect; visibility (and the mine flag that picks the
 * view) is resolved in the recipe.get query.
 */
export default async function RecipePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const { id } = await params;
  return <RecipeDetail id={id} />;
}
