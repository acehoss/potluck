import { restockCode } from '@/lib/domain';
import { db } from './db';

/**
 * The acting household's open attention loops — the DERIVED read shared by the
 * /activity bell (`activity.list`) and the digest. Lives in its own trpc-free
 * module so background jobs (the digest batch + its in-process scheduler) can
 * import it WITHOUT dragging the tRPC/auth layer (and its native argon2 dep)
 * into their module graph — the router in `routers/activity.ts` re-exports the
 * `ActivityItem` type and wraps `openLoopsFor` in its `list` procedure.
 */

// The order states that still want attention on either side.
const OPEN_ORDER = ['REQUESTED', 'PICKING', 'READY'] as const;

export type ActivityItem =
  | {
      type: 'draft';
      id: string;
      createdAt: string;
      actionable: boolean;
      restockId: string;
      pantryId: string;
      pantryName: string;
      code: string | null;
      startedBy: string;
    }
  | {
      type: 'order-in';
      id: string;
      createdAt: string;
      actionable: boolean;
      orderId: string;
      counterpartyName: string;
      lineCount: number;
      status: string;
    }
  | {
      type: 'order-out';
      id: string;
      createdAt: string;
      actionable: boolean;
      orderId: string;
      pantryName: string;
      ownerHouseholdName: string;
      lineCount: number;
      status: string;
    }
  | {
      type: 'connection';
      id: string;
      createdAt: string;
      actionable: boolean;
      connectionId: string;
      requesterName: string;
      requesterSlug: string;
    }
  | {
      type: 'claim';
      id: string;
      createdAt: string;
      actionable: boolean;
      claimId: string;
      postTitle: string;
      claimantName: string;
      quantity: number | null;
      unit: string | null;
    };

/** The membership capability flags the attention feed consults. */
type LoopMembership = {
  receiveStock: boolean;
  fulfill: boolean;
  spend: boolean;
  manageConnections: boolean;
};

/**
 * The acting household's open attention loops (newest first, capped at 50) — a
 * DERIVED read over existing state, shared by the /activity bell (`list`) and
 * the digest. `actionable` = "THIS membership can advance it";
 * `actionableCount` is the bell badge. Factored out so the digest reports the
 * same loops the in-app feed does, from one source of truth.
 */
export async function openLoopsFor(
  H: string,
  m: LoopMembership,
): Promise<{ items: ActivityItem[]; actionableCount: number }> {
  const now = new Date();

    const [drafts, incoming, outgoing, pending, claims] = await Promise.all([
      // 1. Own DRAFT restocks — receiving that was started and left open.
      db.restock.findMany({
        where: { status: 'DRAFT', pantry: { householdId: H } },
        include: {
          pantry: { select: { id: true, name: true } },
          createdBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      // 2. Incoming orders ON our pantries (someone ordering from us).
      db.order.findMany({
        where: {
          pantry: { householdId: H },
          householdId: { not: H },
          status: { in: [...OPEN_ORDER] },
        },
        include: {
          household: { select: { name: true } },
          _count: { select: { lines: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      // 3. Our orders on OTHERS' pantries (READY = go pick up).
      db.order.findMany({
        where: {
          householdId: H,
          pantry: { householdId: { not: H } },
          status: { in: [...OPEN_ORDER] },
        },
        include: {
          pantry: { select: { name: true, household: { select: { name: true } } } },
          _count: { select: { lines: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      // 4. Incoming PENDING connection requests (someone else asked to connect).
      db.connection.findMany({
        where: {
          status: 'PENDING',
          requestedByHouseholdId: { not: H },
          OR: [{ householdAId: H }, { householdBId: H }],
        },
        include: {
          householdA: { select: { id: true, name: true, slug: true } },
          householdB: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      // 5. PENDING claims on our own live posts (someone wants what we shared).
      db.shareClaim.findMany({
        where: {
          status: 'PENDING',
          post: { householdId: H, status: { in: ['OPEN', 'CLAIMED'] }, expiresAt: { gt: now } },
        },
        include: { post: { select: { title: true, unit: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    // ShareClaim.householdId is a relation-free snapshot (like the ledger), so
    // resolve claimant names in one lookup.
    const claimantIds = [...new Set(claims.map((c) => c.householdId))];
    const claimants = claimantIds.length
      ? await db.household.findMany({
          where: { id: { in: claimantIds } },
          select: { id: true, name: true },
        })
      : [];
    const claimantName = new Map(claimants.map((h) => [h.id, h.name]));

    const items: ActivityItem[] = [];

    for (const r of drafts) {
      items.push({
        type: 'draft',
        id: `draft:${r.id}`,
        createdAt: r.createdAt.toISOString(),
        // Drafts are own-household; anyone who can receive can resume/abandon.
        actionable: m.receiveStock,
        restockId: r.id,
        pantryId: r.pantry.id,
        pantryName: r.pantry.name,
        code:
          r.dateCode && r.seq !== null ? restockCode(r.dateCode, r.seq) : null,
        startedBy: r.createdBy.name,
      });
    }

    for (const o of incoming) {
      // Owner side advances REQUESTED→PICKING→READY (fulfill). At READY the
      // owner is done — the buyer picks up — so it's informative, not actionable.
      const advanceable = o.status === 'REQUESTED' || o.status === 'PICKING';
      items.push({
        type: 'order-in',
        id: `order-in:${o.id}`,
        createdAt: (o.readyAt ?? o.pickingAt ?? o.requestedAt ?? o.createdAt).toISOString(),
        actionable: m.fulfill && advanceable,
        orderId: o.id,
        counterpartyName: o.household.name,
        lineCount: o._count.lines,
        status: o.status,
      });
    }

    for (const o of outgoing) {
      // READY is the attention state: go pick up. Pickup posts money on a
      // cross-household order, so the requester side needs `spend` (order.pickup's
      // gate) — but the row deep-links to the detail; money never fires here.
      const ready = o.status === 'READY';
      items.push({
        type: 'order-out',
        id: `order-out:${o.id}`,
        createdAt: (o.readyAt ?? o.pickingAt ?? o.requestedAt ?? o.createdAt).toISOString(),
        actionable: ready && m.spend,
        orderId: o.id,
        pantryName: o.pantry.name,
        ownerHouseholdName: o.pantry.household.name,
        lineCount: o._count.lines,
        status: o.status,
      });
    }

    for (const c of pending) {
      const requester = c.householdAId === H ? c.householdB : c.householdA;
      items.push({
        type: 'connection',
        id: `connection:${c.id}`,
        createdAt: c.createdAt.toISOString(),
        actionable: m.manageConnections,
        connectionId: c.id,
        requesterName: requester.name,
        requesterSlug: requester.slug,
      });
    }

    for (const c of claims) {
      items.push({
        type: 'claim',
        id: `claim:${c.id}`,
        createdAt: c.createdAt.toISOString(),
        // Confirming/releasing a claim is a fulfillment action.
        actionable: m.fulfill,
        claimId: c.id,
        postTitle: c.post.title,
        claimantName: claimantName.get(c.householdId) ?? 'Someone',
        quantity: c.quantity,
        unit: c.post.unit,
      });
    }

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const capped = items.slice(0, 50);
  const actionableCount = capped.filter((i) => i.actionable).length;
  return { items: capped, actionableCount };
}
