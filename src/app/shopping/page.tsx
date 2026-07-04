import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { ShoppingView } from './shopping-view';

/**
 * Shopping list (REWORK H2/H3/H4). Server shell: auth redirect only — the list
 * (generate, manual add, availability, add-to-order) drives through the tRPC
 * shopping.list query in the client view.
 */
export default async function ShoppingPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return <ShoppingView />;
}
