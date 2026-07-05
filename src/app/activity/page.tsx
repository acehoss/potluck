import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { ActivityView } from './activity-view';

/**
 * Activity — the acting household's one actionable home (Phase-2 Round D). Every
 * inline action reuses an existing tRPC mutation with its existing guards; the
 * list is a derived read (activity.list). Rows render actions only for what the
 * acting user can actually perform (the can/hide rule).
 */
export default async function ActivityPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return <ActivityView />;
}
