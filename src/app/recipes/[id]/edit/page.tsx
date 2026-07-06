import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { RecipeEditDetail } from './recipe-edit-detail';

/**
 * Edit an own recipe. Server shell: auth redirect; ownership (and the mine flag
 * that gates the form) is resolved in the recipe.get query.
 */
export default async function RecipeEditPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const { id } = await params;
  return <RecipeEditDetail id={id} />;
}
