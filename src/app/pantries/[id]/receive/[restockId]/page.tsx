import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { ReceiveWizard } from './receive-wizard';

/** Full-screen receiving wizard (blueprint 02); the tab bar hides itself. */
export default async function ReceivePage({
  params,
}: {
  params: Promise<{ id: string; restockId: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id, restockId } = await params;
  // The wizard is an owner-household surface: every edit and finalize 403s
  // for anyone else, so don't render a dead cockpit — the purchaser (and
  // finalized restocks generally) belong on the read-only detail instead.
  const restock = await db.restock.findUnique({
    where: { id: restockId },
    select: { pantry: { select: { householdId: true } } },
  });
  if (restock && restock.pantry.householdId !== user.householdId) {
    redirect(`/restocks/${restockId}`);
  }
  return <ReceiveWizard pantryId={id} restockId={restockId} />;
}
