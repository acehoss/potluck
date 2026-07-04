import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { RecipesView } from './recipes-view';

/**
 * Recipe book (REWORK G). Server shell: auth redirect only — the book itself
 * (own + shared sections) drives through the tRPC recipe.list query in the
 * client view.
 */
export default async function RecipesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return <RecipesView />;
}
