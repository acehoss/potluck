import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { ReconcileView } from './reconcile-view';

/**
 * Reconcile session screen (Phase 4 S5/S6). One route for the whole flow —
 * the count walk and the review/commit step are modes inside the client view.
 * Membership is enough to VIEW and enter counts (A5); commit/abandon/scope
 * edits are re-gated by the server on adjustInventory, and mirrored here so the
 * UI only offers what will succeed. The session itself is fetched client-side
 * (reconcile.get) so autosaved counts stay live without a reload.
 */
export default async function ReconcilePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const { id } = await params;
  return (
    <ReconcileView
      sessionId={id}
      currentUserId={user.id}
      canAdjust={user.activeMembership.adjustInventory}
    />
  );
}
