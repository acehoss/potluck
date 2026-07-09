import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { restockCode } from '@/lib/domain';
import type { Prisma } from '@/generated/prisma/client';
import type { SessionUser } from '../auth';
import { requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { drainNotifyOutbox } from '../notify-outbox';
import { reconcileMath, type ReconcileMathLine } from '../reconcile-math';
import {
  ensureStock,
  guardedRecountStock,
  moveStock,
  RECONCILE_STALE_ABANDON_MS,
  releaseStock,
} from '../stock';
import { protectedProcedure, router } from '../trpc';

const EXPIRED = 'That count expired.';
const OPEN_ORDER_STATUSES = ['REQUESTED', 'PICKING', 'READY'] as const;

const sessionIdSchema = z.object({ sessionId: z.string().min(1) });

const acknowledgedVarianceSchema = z.object({
  lineId: z.string().min(1),
  delta: z.number().int().min(-10_000).max(10_000),
});

const shortageResolutionSchema = z.object({
  orderLineId: z.string().min(1),
  action: z.enum(['reduce', 'cancelLine']),
});

const addLineSchema = z
  .object({
    sessionId: z.string().min(1),
    stockId: z.string().min(1).optional(),
    lotId: z.string().min(1).optional(),
    pantryId: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    const byStock = !!input.stockId && !input.lotId && !input.pantryId;
    const byLotPantry = !input.stockId && !!input.lotId && !!input.pantryId;
    if (!byStock && !byLotPantry) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide either stockId, or lotId and pantryId.',
        path: ['stockId'],
      });
    }
  });

type Tx = Prisma.TransactionClient;

type CommitLine = {
  id: string;
  stockId: string;
  countedCount: number;
  stock: {
    id: string;
    lotId: string;
    pantryId: string;
    count: number;
    reservedCount: number;
  };
};

type ShortageResolutionPlan = {
  orderLineId: string;
  orderId: string;
  requesterHouseholdId: string;
  stockId: string;
  oldQuantity: number;
  newQuantity: number;
};

function realInventoryLotWhere(): Prisma.LotWhereInput {
  return {
    restock: { status: 'FINALIZED', voidedAt: null },
    excluded: false,
    productId: { not: null },
    unitCostCents: { not: null },
  };
}

function isRealInventoryLot(lot: {
  excluded: boolean;
  productId: string | null;
  unitCostCents: number | null;
  restock: { status: string; voidedAt: Date | null };
}) {
  return (
    lot.restock.status === 'FINALIZED' &&
    lot.restock.voidedAt === null &&
    !lot.excluded &&
    lot.productId !== null &&
    lot.unitCostCents !== null
  );
}

function isStale(lastActivityAt: Date, now: Date) {
  return lastActivityAt.getTime() < now.getTime() - RECONCILE_STALE_ABANDON_MS;
}

async function abandonExpiredDraft(tx: Tx, session: { id: string; lastActivityAt: Date }, now: Date) {
  if (!isStale(session.lastActivityAt, now)) return false;
  await tx.reconcileSession.update({
    where: { id: session.id },
    data: { status: 'ABANDONED', abandonedAt: now },
  });
  return true;
}

async function loadDraftSession(tx: Tx, user: SessionUser, sessionId: string, now: Date) {
  const session = await tx.reconcileSession.findUnique({
    where: { id: sessionId },
    select: { id: true, householdId: true, status: true, lastActivityAt: true },
  });
  if (!session || session.householdId !== user.householdId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Count not found.' });
  }
  if (session.status !== 'DRAFT') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'That count is no longer in progress.',
    });
  }
  if (await abandonExpiredDraft(tx, session, now)) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: EXPIRED });
  }
  return session;
}

async function touchSession(tx: Tx, sessionId: string, now: Date) {
  await tx.reconcileSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: now },
  });
}

function assertNoDuplicates(ids: readonly string[], message: string) {
  if (new Set(ids).size !== ids.length) {
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  }
}

async function assertOwnedPantries(tx: Tx, householdId: string, pantryIds: readonly string[]) {
  const pantries = await tx.pantry.findMany({
    where: { id: { in: [...pantryIds] }, householdId },
    select: { id: true },
  });
  if (pantries.length !== pantryIds.length) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
  }
}

async function ensureSessionPantry(tx: Tx, sessionId: string, pantryId: string) {
  const existing = await tx.reconcilePantry.findUnique({
    where: { sessionId_pantryId: { sessionId, pantryId } },
    select: { id: true },
  });
  if (existing) return;
  await tx.reconcilePantry.create({ data: { sessionId, pantryId } });
}

async function createScopedLinesForStocks(
  tx: Tx,
  sessionId: string,
  stocks: readonly { id: string; count: number; reservedCount: number }[],
) {
  if (stocks.length === 0) return;
  const existing = await tx.reconcileLine.findMany({
    where: { sessionId, stockId: { in: stocks.map((s) => s.id) } },
    select: { stockId: true },
  });
  const seen = new Set(existing.map((line) => line.stockId));
  for (const stock of stocks) {
    if (seen.has(stock.id)) continue;
    await tx.reconcileLine.create({
      data: {
        sessionId,
        stockId: stock.id,
        expectedCount: stock.count,
        expectedReserved: stock.reservedCount,
      },
    });
  }
}

async function scopedStocksForPantries(tx: Tx, pantryIds: readonly string[]) {
  return tx.stock.findMany({
    where: {
      pantryId: { in: [...pantryIds] },
      OR: [{ count: { gt: 0 } }, { reservedCount: { gt: 0 } }],
      lot: realInventoryLotWhere(),
    },
    select: { id: true, count: true, reservedCount: true },
  });
}

async function sessionPayload(tx: Tx, householdId: string, sessionId: string) {
  const session = await tx.reconcileSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      householdId: true,
      status: true,
      blind: true,
      note: true,
      createdAt: true,
      lastActivityAt: true,
      createdBy: { select: { name: true } },
      pantries: {
        select: {
          pantryId: true,
          claimedById: true,
          pantry: { select: { name: true } },
        },
      },
      lines: {
        select: {
          id: true,
          stockId: true,
          expectedCount: true,
          expectedReserved: true,
          countedCount: true,
          countedById: true,
          countedAt: true,
          stock: {
            select: {
              pantryId: true,
              lotId: true,
              // Live values: the review preview must mirror what commit will
              // compute (pickups ride through the freeze and shift these).
              count: true,
              reservedCount: true,
              lot: {
                select: {
                  productId: true,
                  bestBy: true,
                  unitPhotoPath: true,
                  product: { select: { name: true } },
                  restock: { select: { dateCode: true, seq: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!session || session.householdId !== householdId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Count not found.' });
  }

  const userIds = [
    ...new Set(
      [
        ...session.pantries.flatMap((p) => (p.claimedById ? [p.claimedById] : [])),
        ...session.lines.flatMap((l) => (l.countedById ? [l.countedById] : [])),
      ],
    ),
  ];
  const users = userIds.length
    ? await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const nameByUserId = new Map(users.map((u) => [u.id, u.name]));

  const statsByPantry = new Map<string, { total: number; counted: number }>();
  for (const line of session.lines) {
    const stats = statsByPantry.get(line.stock.pantryId) ?? { total: 0, counted: 0 };
    stats.total += 1;
    if (line.countedCount !== null) stats.counted += 1;
    statsByPantry.set(line.stock.pantryId, stats);
  }

  const pantries = session.pantries
    .map((p) => ({
      pantryId: p.pantryId,
      name: p.pantry.name,
      claimedById: p.claimedById,
      claimedByName: p.claimedById ? nameByUserId.get(p.claimedById) ?? null : null,
      lineStats: statsByPantry.get(p.pantryId) ?? { total: 0, counted: 0 },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Open order lines holding each reserved placement — the review screen's
  // shortage-resolution choices need them (A7). Own-household view only: the
  // owner already sees requester names on orders against their pantry.
  const reservedStockIds = session.lines
    .filter((l) => l.stock.reservedCount > 0)
    .map((l) => l.stockId);
  const openOrderLines = reservedStockIds.length
    ? await tx.orderLine.findMany({
        where: {
          stockId: { in: reservedStockIds },
          order: { status: { in: [...OPEN_ORDER_STATUSES] } },
        },
        select: {
          id: true,
          stockId: true,
          quantity: true,
          orderId: true,
          order: { select: { household: { select: { name: true } } } },
        },
        orderBy: { id: 'asc' },
      })
    : [];
  type OpenLineRef = { orderLineId: string; orderId: string; quantity: number; requesterHouseholdName: string };
  const orderLinesByStockId = new Map<string, OpenLineRef[]>();
  for (const ol of openOrderLines) {
    const group = orderLinesByStockId.get(ol.stockId) ?? [];
    group.push({
      orderLineId: ol.id,
      orderId: ol.orderId,
      quantity: ol.quantity,
      requesterHouseholdName: ol.order.household.name,
    });
    orderLinesByStockId.set(ol.stockId, group);
  }

  const pantryNameById = new Map(pantries.map((p) => [p.pantryId, p.name]));
  // Round 4: flag lines whose placement was picked from AFTER they were
  // counted — the walk shows "recount", the review refuses to ack them, and
  // commit hard-rejects them regardless.
  const takesFor = await takesSinceCount(tx, session.lines);
  const lines = session.lines
    .map((line) => {
      const lot = line.stock.lot;
      const lotCode =
        lot.restock.dateCode && lot.restock.seq !== null
          ? restockCode(lot.restock.dateCode, lot.restock.seq)
          : null;
      return {
        lineId: line.id,
        stockId: line.stockId,
        pantryId: line.stock.pantryId,
        lotId: line.stock.lotId,
        productId: lot.productId,
        productName: lot.product?.name ?? 'item',
        lotCode,
        bestBy: lot.bestBy?.toISOString() ?? null,
        expectedCount: line.expectedCount,
        expectedReserved: line.expectedReserved,
        liveCount: line.stock.count,
        liveReserved: line.stock.reservedCount,
        openOrderLines: orderLinesByStockId.get(line.stockId) ?? [],
        countedCount: line.countedCount,
        countedByName: line.countedById ? nameByUserId.get(line.countedById) ?? null : null,
        takenSinceCount: takesFor(line),
        unitPhotoPath: lot.unitPhotoPath,
      };
    })
    .sort((a, b) => {
      const pantry = (pantryNameById.get(a.pantryId) ?? '').localeCompare(
        pantryNameById.get(b.pantryId) ?? '',
      );
      if (pantry !== 0) return pantry;
      const product = a.productName.localeCompare(b.productName);
      if (product !== 0) return product;
      return (a.lotCode ?? '').localeCompare(b.lotCode ?? '');
    });

  return {
    sessionId: session.id,
    status: session.status,
    blind: session.blind,
    note: session.note,
    createdByName: session.createdBy.name,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pantries,
    lines,
  };
}

function assertVarianceAcknowledgement(
  variances: readonly { stockId: string; delta: number }[],
  lineIdByStockId: ReadonlyMap<string, string>,
  acknowledged: readonly { lineId: string; delta: number }[],
) {
  const ackByLineId = new Map<string, number>();
  for (const ack of acknowledged) {
    if (ackByLineId.has(ack.lineId)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Duplicate variance acknowledgement.' });
    }
    ackByLineId.set(ack.lineId, ack.delta);
  }
  if (ackByLineId.size !== variances.length) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Counts changed — review again.' });
  }
  for (const variance of variances) {
    const lineId = lineIdByStockId.get(variance.stockId);
    if (!lineId || ackByLineId.get(lineId) !== variance.delta) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Counts changed — review again.' });
    }
  }
}

async function planShortageResolutions(
  tx: Tx,
  shortages: readonly { stockId: string; counted: number; liveReserved: number }[],
  resolutions: readonly { orderLineId: string; action: 'reduce' | 'cancelLine' }[],
) {
  const resolutionIds = resolutions.map((r) => r.orderLineId);
  assertNoDuplicates(resolutionIds, 'Duplicate shortage resolution.');
  if (shortages.length === 0) {
    if (resolutionIds.length > 0) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Counts changed — review again.' });
    }
    return { plans: [] as ShortageResolutionPlan[], affectedOrders: new Map<string, string>() };
  }

  const shortageByStockId = new Map(shortages.map((s) => [s.stockId, s]));
  const openLines = await tx.orderLine.findMany({
    where: {
      stockId: { in: [...shortageByStockId.keys()] },
      order: { status: { in: [...OPEN_ORDER_STATUSES] } },
    },
    select: {
      id: true,
      stockId: true,
      quantity: true,
      orderId: true,
      order: { select: { id: true, householdId: true } },
    },
    orderBy: { id: 'asc' },
  });

  const openByStockId = new Map<string, typeof openLines>();
  for (const line of openLines) {
    const group = openByStockId.get(line.stockId) ?? [];
    group.push(line);
    openByStockId.set(line.stockId, group);
  }
  for (const shortage of shortages) {
    const reservedByOrders = (openByStockId.get(shortage.stockId) ?? []).reduce(
      (sum, line) => sum + line.quantity,
      0,
    );
    if (reservedByOrders !== shortage.liveReserved) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Orders changed — review again.',
      });
    }
  }

  const lineById = new Map(openLines.map((line) => [line.id, line]));
  const remainingByLineId = new Map(openLines.map((line) => [line.id, line.quantity]));
  const plansByLineId = new Map<string, ShortageResolutionPlan>();

  const remainingForStock = (stockId: string) =>
    (openByStockId.get(stockId) ?? []).reduce(
      (sum, line) => sum + (remainingByLineId.get(line.id) ?? 0),
      0,
    );

  for (const resolution of resolutions) {
    const line = lineById.get(resolution.orderLineId);
    if (!line || !shortageByStockId.has(line.stockId)) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Counts changed — review again.' });
    }
    const currentQuantity = remainingByLineId.get(line.id) ?? 0;
    if (currentQuantity <= 0) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Counts changed — review again.' });
    }
    const shortage = shortageByStockId.get(line.stockId)!;
    const newQuantity =
      resolution.action === 'cancelLine'
        ? 0
        : Math.max(
            0,
            Math.min(currentQuantity, shortage.counted - (remainingForStock(line.stockId) - currentQuantity)),
          );
    remainingByLineId.set(line.id, newQuantity);
    if (newQuantity < line.quantity) {
      plansByLineId.set(line.id, {
        orderLineId: line.id,
        orderId: line.orderId,
        requesterHouseholdId: line.order.householdId,
        stockId: line.stockId,
        oldQuantity: line.quantity,
        newQuantity,
      });
    }
  }

  for (const shortage of shortages) {
    if (remainingForStock(shortage.stockId) > shortage.counted) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Resolve the order shortage before committing.',
      });
    }
  }

  const affectedOrders = new Map<string, string>();
  for (const plan of plansByLineId.values()) affectedOrders.set(plan.orderId, plan.requesterHouseholdId);
  return { plans: [...plansByLineId.values()], affectedOrders };
}

async function applyShortageResolutionPlans(
  tx: Tx,
  plans: readonly ShortageResolutionPlan[],
  now: Date,
) {
  for (const plan of plans) {
    const releaseQty = plan.oldQuantity - plan.newQuantity;
    if (releaseQty <= 0) continue;
    await releaseStock(tx, plan.stockId, releaseQty);
    if (plan.newQuantity === 0) {
      await tx.orderLine.delete({ where: { id: plan.orderLineId } });
    } else {
      await tx.orderLine.update({
        where: { id: plan.orderLineId },
        data: { quantity: plan.newQuantity },
      });
    }
    const remainingLines = await tx.orderLine.count({ where: { orderId: plan.orderId } });
    if (remainingLines === 0) {
      await tx.order.updateMany({
        where: { id: plan.orderId, status: { in: [...OPEN_ORDER_STATUSES] } },
        data: { status: 'CANCELED', canceledAt: now },
      });
    }
  }
}

function unchangedCount(
  lines: readonly CommitLine[],
  moves: readonly { fromStockId: string; toStockId: string }[],
  variances: readonly { stockId: string }[],
) {
  const touched = new Set<string>();
  for (const move of moves) {
    touched.add(move.fromStockId);
    touched.add(move.toStockId);
  }
  for (const variance of variances) touched.add(variance.stockId);
  return lines.filter((line) => !touched.has(line.stockId)).length;
}

async function replayedCommitSummary(
  tx: Tx,
  sessionId: string,
  shortageResolutions: readonly { orderLineId: string }[],
) {
  const lines = await tx.reconcileLine.findMany({
    where: { sessionId },
    select: { stockId: true },
  });
  const transferLines = await tx.transferLine.findMany({
    where: { transfer: { reconcileSessionId: sessionId } },
    select: { fromStockId: true, toStockId: true },
  });
  const adjustments = await tx.adjustment.findMany({
    where: { reconcileSessionId: sessionId },
    select: { stockId: true },
  });
  const touched = new Set<string>();
  for (const line of transferLines) {
    touched.add(line.fromStockId);
    touched.add(line.toStockId);
  }
  for (const adjustment of adjustments) touched.add(adjustment.stockId);
  return {
    committed: true as const,
    moves: transferLines.length,
    variances: adjustments.length,
    unchanged: lines.filter((line) => !touched.has(line.stockId)).length,
    // The current schema stores no shortage-resolution summary. Replays are
    // no-op safe; the live commit path below returns the exact order count.
    ordersAffected: new Set(shortageResolutions.map((r) => r.orderLineId)).size,
  };
}

/**
 * Takes recorded against a (lot, pantry) AFTER a line was counted: the only
 * stock movement the freeze admits is a reserved pickup, and each one logs a
 * Take with the placement's pantry snapshot. A counted number older than such
 * a take is STALE — committing it would "find" the picked-up units and
 * restore them to the shelf. Both the payload (per-line flag for the UI) and
 * commit (hard refusal) consult this.
 */
async function takesSinceCount(
  tx: Tx,
  lines: readonly {
    countedAt: Date | null;
    stock: { lotId: string; pantryId: string };
  }[],
): Promise<(line: { countedAt: Date | null; stock: { lotId: string; pantryId: string } }) => number> {
  const counted = lines.filter((l) => l.countedAt !== null);
  if (counted.length === 0) return () => 0;
  const earliest = new Date(Math.min(...counted.map((l) => l.countedAt!.getTime())));
  // gte, not gt — a take in the same millisecond as the count is ambiguous
  // ordering, and ambiguity fails CLOSED (a spurious recount is cheap; a
  // phantom restore is not). Takes now carry app-side ms timestamps; legacy
  // second-precision rows only widen the flagged window, never narrow it.
  const takes = await tx.take.findMany({
    where: {
      lotId: { in: [...new Set(counted.map((l) => l.stock.lotId))] },
      pantryId: { in: [...new Set(counted.map((l) => l.stock.pantryId))] },
      takenAt: { gte: earliest },
    },
    select: { lotId: true, pantryId: true, takenAt: true },
  });
  return (line) =>
    line.countedAt === null
      ? 0
      : takes.filter(
          (t) =>
            t.lotId === line.stock.lotId &&
            t.pantryId === line.stock.pantryId &&
            t.takenAt.getTime() >= line.countedAt!.getTime(),
        ).length;
}

export const reconcileRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        pantryIds: z.array(z.string().min(1)).min(1).max(20),
        blind: z.boolean().optional(),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'adjustInventory');
      assertNoDuplicates(input.pantryIds, 'Duplicate pantry.');
      return dbTransaction(async (tx) => {
        const now = new Date();
        const existing = await tx.reconcileSession.findFirst({
          where: { householdId: ctx.user.householdId, status: 'DRAFT' },
          select: { id: true, lastActivityAt: true },
        });
        if (existing && !(await abandonExpiredDraft(tx, existing, now))) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A count is already in progress.',
          });
        }

        await assertOwnedPantries(tx, ctx.user.householdId, input.pantryIds);
        const session = await tx.reconcileSession.create({
          data: {
            householdId: ctx.user.householdId,
            blind: input.blind ?? true,
            note: input.note || null,
            createdById: ctx.user.id,
            lastActivityAt: now,
          },
          select: { id: true },
        });
        for (const pantryId of input.pantryIds) {
          await tx.reconcilePantry.create({ data: { sessionId: session.id, pantryId } });
        }
        await createScopedLinesForStocks(
          tx,
          session.id,
          await scopedStocksForPantries(tx, input.pantryIds),
        );
        return sessionPayload(tx, ctx.user.householdId, session.id);
      });
    }),

  get: protectedProcedure.input(sessionIdSchema).query(async ({ ctx, input }) => {
    return dbTransaction((tx) => sessionPayload(tx, ctx.user.householdId, input.sessionId));
  }),

  open: protectedProcedure.query(async ({ ctx }) => {
    const cutoff = new Date(Date.now() - RECONCILE_STALE_ABANDON_MS);
    const session = await db.reconcileSession.findFirst({
      where: {
        householdId: ctx.user.householdId,
        status: 'DRAFT',
        lastActivityAt: { gte: cutoff },
      },
      select: {
        id: true,
        blind: true,
        note: true,
        createdAt: true,
        lastActivityAt: true,
        createdById: true,
        createdBy: { select: { name: true } },
        pantries: {
          select: {
            pantryId: true,
            claimedById: true,
            pantry: { select: { name: true } },
          },
        },
        lines: {
          select: {
            countedCount: true,
            countedById: true,
            stock: { select: { pantryId: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!session) return null;

    // A3 audience rule: the standing banner belongs to participants (creator,
    // claimers, counters) and adjustInventory holders. Everyone else learns a
    // shelf is being counted only at the moment they touch it (the 412s).
    const participates =
      session.createdById === ctx.user.id ||
      session.pantries.some((p) => p.claimedById === ctx.user.id) ||
      session.lines.some((l) => l.countedById === ctx.user.id) ||
      ctx.user.activeMembership.adjustInventory;
    if (!participates) return null;

    const progressByPantry = new Map<string, { total: number; counted: number }>();
    for (const line of session.lines) {
      const progress = progressByPantry.get(line.stock.pantryId) ?? { total: 0, counted: 0 };
      progress.total += 1;
      if (line.countedCount !== null) progress.counted += 1;
      progressByPantry.set(line.stock.pantryId, progress);
    }
    const total = session.lines.length;
    const counted = session.lines.filter((line) => line.countedCount !== null).length;
    return {
      sessionId: session.id,
      blind: session.blind,
      note: session.note,
      startedByName: session.createdBy.name,
      startedAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      progress: { total, counted },
      pantries: session.pantries
        .map((p) => ({
          pantryId: p.pantryId,
          name: p.pantry.name,
          claimedById: p.claimedById,
          lineStats: progressByPantry.get(p.pantryId) ?? { total: 0, counted: 0 },
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }),

  /**
   * Candidate lots for the count walk's "+ Found something" (A4): every real
   * (finalized, non-voided, non-excluded) lot of an OWN product, with its
   * current placements — the counter picks the lot they're holding and
   * addLine scopes it into the pantry where it was found.
   */
  lotCandidates: protectedProcedure
    .input(sessionIdSchema.extend({ productId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const session = await db.reconcileSession.findUnique({
        where: { id: input.sessionId },
        select: { householdId: true },
      });
      if (!session || session.householdId !== ctx.user.householdId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Count not found.' });
      }
      const product = await db.product.findUnique({
        where: { id: input.productId },
        select: { householdId: true },
      });
      if (!product || product.householdId !== ctx.user.householdId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
      }
      const lots = await db.lot.findMany({
        where: {
          productId: input.productId,
          excluded: false,
          unitCostCents: { not: null },
          restock: { status: 'FINALIZED', voidedAt: null },
        },
        select: {
          id: true,
          bestBy: true,
          unitPhotoPath: true,
          restock: { select: { dateCode: true, seq: true, purchasedAt: true } },
          stocks: {
            select: {
              id: true,
              pantryId: true,
              count: true,
              pantry: { select: { name: true } },
            },
          },
        },
        orderBy: { restock: { purchasedAt: 'desc' } },
        take: 20,
      });
      return lots.map((l) => ({
        lotId: l.id,
        lotCode:
          l.restock.dateCode && l.restock.seq !== null
            ? restockCode(l.restock.dateCode, l.restock.seq)
            : null,
        bestBy: l.bestBy?.toISOString() ?? null,
        unitPhotoPath: l.unitPhotoPath,
        placements: l.stocks.map((s) => ({
          stockId: s.id,
          pantryId: s.pantryId,
          pantryName: s.pantry.name,
          count: s.count,
        })),
      }));
    }),

  addPantry: protectedProcedure
    .input(sessionIdSchema.extend({ pantryId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'adjustInventory');
      return dbTransaction(async (tx) => {
        const now = new Date();
        await loadDraftSession(tx, ctx.user, input.sessionId, now);
        await assertOwnedPantries(tx, ctx.user.householdId, [input.pantryId]);
        await ensureSessionPantry(tx, input.sessionId, input.pantryId);
        await createScopedLinesForStocks(
          tx,
          input.sessionId,
          await scopedStocksForPantries(tx, [input.pantryId]),
        );
        await touchSession(tx, input.sessionId, now);
        return sessionPayload(tx, ctx.user.householdId, input.sessionId);
      });
    }),

  addLine: protectedProcedure.input(addLineSchema).mutation(async ({ ctx, input }) => {
    requireCapability(ctx.user, 'adjustInventory');
    return dbTransaction(async (tx) => {
      const now = new Date();
      await loadDraftSession(tx, ctx.user, input.sessionId, now);
      const stock =
        input.stockId !== undefined
          ? await (async () => {
              const row = await tx.stock.findUnique({
                where: { id: input.stockId },
                select: {
                  id: true,
                  lotId: true,
                  pantryId: true,
                  count: true,
                  reservedCount: true,
                  pantry: { select: { householdId: true } },
                  lot: {
                    select: {
                      excluded: true,
                      productId: true,
                      unitCostCents: true,
                      restock: { select: { status: true, voidedAt: true } },
                    },
                  },
                },
              });
              if (!row || row.pantry.householdId !== ctx.user.householdId) {
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock not found.' });
              }
              if (!isRealInventoryLot(row.lot)) {
                throw new TRPCError({ code: 'CONFLICT', message: 'That item is not countable.' });
              }
              return row;
            })()
          : await (async () => {
              await assertOwnedPantries(tx, ctx.user.householdId, [input.pantryId!]);
              const lot = await tx.lot.findUnique({
                where: { id: input.lotId },
                select: {
                  id: true,
                  excluded: true,
                  productId: true,
                  unitCostCents: true,
                  restock: {
                    select: {
                      status: true,
                      voidedAt: true,
                      pantry: { select: { householdId: true } },
                    },
                  },
                },
              });
              if (!lot || lot.restock.pantry.householdId !== ctx.user.householdId) {
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Lot not found.' });
              }
              if (!isRealInventoryLot(lot)) {
                throw new TRPCError({ code: 'CONFLICT', message: 'That item is not countable.' });
              }
              const ensured = await ensureStock(tx, lot.id, input.pantryId!);
              return { ...ensured, lotId: lot.id, pantryId: input.pantryId! };
            })();

      await ensureSessionPantry(tx, input.sessionId, stock.pantryId);
      await createScopedLinesForStocks(tx, input.sessionId, [stock]);
      await touchSession(tx, input.sessionId, now);
      return sessionPayload(tx, ctx.user.householdId, input.sessionId);
    });
  }),

  claimPantry: protectedProcedure
    .input(sessionIdSchema.extend({ pantryId: z.string().min(1), release: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const now = new Date();
        await loadDraftSession(tx, ctx.user, input.sessionId, now);
        const row = await tx.reconcilePantry.findUnique({
          where: { sessionId_pantryId: { sessionId: input.sessionId, pantryId: input.pantryId } },
          select: { id: true },
        });
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not in this count.' });
        await tx.reconcilePantry.update({
          where: { id: row.id },
          data: { claimedById: input.release ? null : ctx.user.id },
        });
        await touchSession(tx, input.sessionId, now);
        return { ok: true };
      });
    }),

  count: protectedProcedure
    .input(
      sessionIdSchema.extend({
        lineId: z.string().min(1),
        counted: z.number().int().min(0).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return dbTransaction(async (tx) => {
        const now = new Date();
        await loadDraftSession(tx, ctx.user, input.sessionId, now);
        const line = await tx.reconcileLine.findUnique({
          where: { id: input.lineId },
          select: { id: true, sessionId: true },
        });
        if (!line || line.sessionId !== input.sessionId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Count line not found.' });
        }
        await tx.reconcileLine.update({
          where: { id: line.id },
          data: { countedCount: input.counted, countedById: ctx.user.id, countedAt: now },
        });
        await touchSession(tx, input.sessionId, now);
        return { ok: true };
      });
    }),

  removeLine: protectedProcedure
    .input(sessionIdSchema.extend({ lineId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'adjustInventory');
      return dbTransaction(async (tx) => {
        const now = new Date();
        await loadDraftSession(tx, ctx.user, input.sessionId, now);
        const line = await tx.reconcileLine.findUnique({
          where: { id: input.lineId },
          select: { id: true, sessionId: true },
        });
        if (!line || line.sessionId !== input.sessionId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Count line not found.' });
        }
        await tx.reconcileLine.delete({ where: { id: line.id } });
        await touchSession(tx, input.sessionId, now);
        return sessionPayload(tx, ctx.user.householdId, input.sessionId);
      });
    }),

  removePantry: protectedProcedure
    .input(sessionIdSchema.extend({ pantryId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'adjustInventory');
      return dbTransaction(async (tx) => {
        const now = new Date();
        await loadDraftSession(tx, ctx.user, input.sessionId, now);
        const row = await tx.reconcilePantry.findUnique({
          where: { sessionId_pantryId: { sessionId: input.sessionId, pantryId: input.pantryId } },
          select: { id: true },
        });
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not in this count.' });
        await tx.reconcileLine.deleteMany({
          where: { sessionId: input.sessionId, stock: { pantryId: input.pantryId } },
        });
        await tx.reconcilePantry.delete({ where: { id: row.id } });
        await touchSession(tx, input.sessionId, now);
        return sessionPayload(tx, ctx.user.householdId, input.sessionId);
      });
    }),

  commit: protectedProcedure
    .input(
      sessionIdSchema.extend({
        commitClientKey: z.string().min(8).max(64),
        acknowledgedVariances: z.array(acknowledgedVarianceSchema),
        rejectedMoveLots: z.array(z.string().min(1)),
        shortageResolutions: z.array(shortageResolutionSchema),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'adjustInventory');
      const result = await dbTransaction(async (tx) => {
        const replay = await tx.reconcileSession.findUnique({
          where: { commitClientKey: input.commitClientKey },
          select: { id: true, householdId: true, status: true, commitSummary: true },
        });
        if (replay) {
          if (replay.id !== input.sessionId) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
          }
          if (replay.householdId !== ctx.user.householdId) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Count not found.' });
          }
          if (replay.status === 'COMMITTED') {
            // The stored summary is what the original commit returned; the
            // durable reconstruction is only a fallback for pre-column rows.
            const summary = replay.commitSummary
              ? (JSON.parse(replay.commitSummary) as Awaited<
                  ReturnType<typeof replayedCommitSummary>
                >)
              : await replayedCommitSummary(tx, replay.id, input.shortageResolutions);
            return { summary, affectedOrders: new Map<string, string>() };
          }
          throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
        }

        const now = new Date();
        await loadDraftSession(tx, ctx.user, input.sessionId, now);
        const uncounted = await tx.reconcileLine.count({
          where: { sessionId: input.sessionId, countedCount: null },
        });
        if (uncounted > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `${uncounted} count line(s) still need a count or removal.`,
          });
        }

        const rawLines = await tx.reconcileLine.findMany({
          where: { sessionId: input.sessionId },
          select: {
            id: true,
            stockId: true,
            countedCount: true,
            countedAt: true,
            stock: {
              select: {
                id: true,
                lotId: true,
                pantryId: true,
                count: true,
                reservedCount: true,
              },
            },
          },
        });
        // Stale-count refusal (Round 4): a pickup between count and commit
        // means the counted number predates units leaving the shelf —
        // committing it would restore them as a phantom "found" variance.
        const takesFor = await takesSinceCount(tx, rawLines);
        const stale = rawLines.filter((line) => takesFor(line) > 0);
        if (stale.length > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `${stale.length} line(s) were picked from after they were counted — recount them and review again.`,
          });
        }
        const lines: CommitLine[] = rawLines.map((line) => ({
          ...line,
          countedCount: line.countedCount!,
        }));
        const mathInput: ReconcileMathLine[] = lines.map((line) => ({
          stockId: line.stockId,
          lotId: line.stock.lotId,
          pantryId: line.stock.pantryId,
          liveCount: line.stock.count,
          liveReserved: line.stock.reservedCount,
          counted: line.countedCount,
        }));
        const math = reconcileMath(mathInput, { noMoveLots: new Set(input.rejectedMoveLots) });
        const lineIdByStockId = new Map(lines.map((line) => [line.stockId, line.id]));
        assertVarianceAcknowledgement(math.variances, lineIdByStockId, input.acknowledgedVariances);
        const { plans: shortagePlans, affectedOrders } = await planShortageResolutions(
          tx,
          math.shortages,
          input.shortageResolutions,
        );

        await tx.reconcileSession.update({
          where: { id: input.sessionId },
          data: { status: 'COMMITTED' },
        });

        await applyShortageResolutionPlans(tx, shortagePlans, now);

        // Outbox rows ride the commit tx (Round 4): the requester's "your
        // order changed" notice survives a crash between commit and send.
        for (const [orderId, requesterHouseholdId] of affectedOrders.entries()) {
          await tx.notifyOutbox.create({
            data: {
              kind: 'reconcile-shortage',
              payload: JSON.stringify({ orderId, requesterHouseholdId, actorId: ctx.user.id }),
            },
          });
        }

        for (const move of math.moves) {
          const transfer = await tx.transfer.create({
            data: {
              householdId: ctx.user.householdId,
              fromPantryId: move.fromPantryId,
              toPantryId: move.toPantryId,
              reconcileSessionId: input.sessionId,
              createdById: ctx.user.id,
            },
            select: { id: true },
          });
          const moved = await moveStock(tx, move.fromStockId, move.toPantryId, move.quantity);
          if (moved.toStockId !== move.toStockId) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Reconcile move target drifted.',
            });
          }
          await tx.transferLine.create({
            data: {
              transferId: transfer.id,
              lotId: moved.lotId,
              fromStockId: moved.fromStockId,
              toStockId: moved.toStockId,
              quantity: move.quantity,
            },
          });
        }

        for (const variance of math.variances) {
          const line = lines.find((candidate) => candidate.stockId === variance.stockId);
          if (!line) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Reconcile variance target drifted.',
            });
          }
          const { countBefore, countAfter } = await guardedRecountStock(
            tx,
            variance.stockId,
            (before) => before + variance.delta,
          );
          await tx.adjustment.create({
            data: {
              lotId: line.stock.lotId,
              stockId: variance.stockId,
              reconcileSessionId: input.sessionId,
              type: 'RECOUNT',
              countBefore,
              countAfter,
              note: 'reconcile',
              createdById: ctx.user.id,
            },
          });
        }

        await tx.stock.updateMany({
          where: { id: { in: lines.map((line) => line.stockId) } },
          data: { lastCountedAt: now },
        });

        const finalStocks = await tx.stock.findMany({
          where: { id: { in: lines.map((line) => line.stockId) } },
          select: { id: true, count: true, reservedCount: true },
        });
        const finalById = new Map(finalStocks.map((stock) => [stock.id, stock]));
        for (const line of lines) {
          const final = finalById.get(line.stockId);
          if (!final || final.count !== line.countedCount || final.reservedCount > final.count) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Reconcile final count drifted.',
            });
          }
        }

        const summary = {
          committed: true as const,
          moves: math.moves.length,
          variances: math.variances.length,
          unchanged: unchangedCount(lines, math.moves, math.variances),
          ordersAffected: affectedOrders.size,
        };
        await tx.reconcileSession.update({
          where: { id: input.sessionId },
          data: {
            committedAt: now,
            commitClientKey: input.commitClientKey,
            commitSummary: JSON.stringify(summary),
            lastActivityAt: now,
          },
        });

        return { summary, affectedOrders };
      });
      if (result.affectedOrders.size > 0) await drainNotifyOutbox();
      return result.summary;
    }),

  abandon: protectedProcedure.input(sessionIdSchema).mutation(async ({ ctx, input }) => {
    requireCapability(ctx.user, 'adjustInventory');
    return dbTransaction(async (tx) => {
      const now = new Date();
      await loadDraftSession(tx, ctx.user, input.sessionId, now);
      await tx.reconcileSession.update({
        where: { id: input.sessionId },
        data: { status: 'ABANDONED', abandonedAt: now, lastActivityAt: now },
      });
      return { ok: true };
    });
  }),
});
