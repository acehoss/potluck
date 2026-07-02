import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
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
  return <ReceiveWizard pantryId={id} restockId={restockId} />;
}
