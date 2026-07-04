import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { PlanView } from './plan-view';

/**
 * Meal planner (REWORK H1). Server shell: auth redirect only — the week grid
 * itself drives through the tRPC plan.week query in the client view.
 */
export default async function PlanPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return <PlanView />;
}
