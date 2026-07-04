import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { RecipeEditor } from '../recipe-editor';

/** New-recipe editor. Server shell: auth redirect; the editor is client-side. */
export default async function NewRecipePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return <RecipeEditor />;
}
