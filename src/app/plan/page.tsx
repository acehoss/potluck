import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { db } from '@/server/db';
import { PlanView } from './plan-view';

/**
 * Meal planner (REWORK H1) + the Plan tab's network sections (Phase-2 P3): the
 * week grid drives through tRPC in the client view, while the household's
 * outgoing orders and its own live share posts are server-fetched here (no new
 * query endpoints — direct reads) and handed down. Outgoing orders = the
 * acting household's in-flight orders on OTHERS' pantries; my posts = its own
 * live needs/surpluses.
 */
export default async function PlanPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const me = user.householdId;
  const now = new Date();

  const [orders, posts] = await Promise.all([
    db.order.findMany({
      where: {
        householdId: me,
        status: { in: ['REQUESTED', 'PICKING', 'READY'] },
        pantry: { householdId: { not: me } },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        pantry: { select: { name: true, household: { select: { name: true } } } },
        _count: { select: { lines: true } },
      },
    }),
    db.sharePost.findMany({
      where: {
        householdId: me,
        status: { in: ['OPEN', 'CLAIMED'] },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, type: true, title: true, status: true },
    }),
  ]);

  const outgoingOrders = orders.map((o) => ({
    id: o.id,
    status: o.status,
    pantryName: o.pantry.name,
    ownerHouseholdName: o.pantry.household.name,
    lineCount: o._count.lines,
  }));
  const myPosts = posts.map((p) => ({
    id: p.id,
    type: p.type,
    title: p.title,
    status: p.status,
  }));

  return <PlanView outgoingOrders={outgoingOrders} myPosts={myPosts} />;
}
