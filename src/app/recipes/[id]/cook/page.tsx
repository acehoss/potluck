import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { CookView } from './cook-view';

/**
 * Cook mode — the hands-free stepper. Works for own and shared recipes alike
 * (same visibility as recipe.get). Server shell: auth redirect only; everything
 * interactive (wake lock, swipe, keys) lives client-side.
 */
export default async function CookPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const { id } = await params;
  return <CookView id={id} />;
}
