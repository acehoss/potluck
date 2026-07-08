import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';

/**
 * Phase 4 (REWORK S1/S2): the ONE place placement counts move. A Stock row is
 * the units of one lot currently in one pantry; `count` and `reservedCount`
 * change only through these helpers, all of which follow the proven B3 guard:
 * read the row in-tx, decide, then write via updateMany conditioned on the
 * values just read, retrying on a miss (under dbTransaction's app-wide lock a
 * miss is already impossible; the retry is the belt to that suspender).
 *
 * Money never moves here — reservations are soft holds, recounts/write-offs
 * are amountless (invariant 8), and takes price from the LOT's frozen
 * unitCost at the caller. Availability everywhere is count − reservedCount.
 */

/** Availability of a placement: free units not held by open orders. */
export function availableOf(s: { count: number; reservedCount: number }): number {
  return s.count - s.reservedCount;
}

/**
 * Round-3 seam (REWORK A2): every placement mutation announces itself here so
 * the reconcile freeze has one enforcement point. The cutoff model:
 * - 'consume-reserved' (pickup) stays ALLOWED under a freeze — it decrements
 *   count and reservedCount together, so free stock (the count baseline) is
 *   undisturbed;
 * - 'consume-free', 'reserve', 'release' (cancel/edit-down would grow free
 *   stock under the counter), 'recount', and 'restore' will be REFUSED on a
 *   frozen placement.
 * Round 1 ships no sessions, so this is a no-op; Round 3 fills it in.
 */
export type StockMutationKind =
  | 'reserve'
  | 'release'
  | 'consume-reserved'
  | 'consume-free'
  | 'restore'
  | 'recount'
  | 'transfer-out'
  | 'transfer-in';

/** DRAFT sessions idle past this are dead — their freeze no longer binds. */
export const RECONCILE_STALE_ABANDON_MS = 24 * 60 * 60 * 1000;

export async function assertStockMutable(
  tx: Prisma.TransactionClient,
  stockId: string,
  kind: StockMutationKind,
): Promise<void> {
  // The cutoff model (A2): consuming already-reserved units decrements count
  // and reservedCount together, leaving free stock — the count baseline —
  // untouched, so pickups ride through a freeze. Everything else moves FREE
  // stock and is refused while a live DRAFT session scopes this placement.
  if (kind === 'consume-reserved') return;
  const line = await tx.reconcileLine.findFirst({
    where: { stockId, session: { status: 'DRAFT' } },
    select: { session: { select: { id: true, lastActivityAt: true } } },
  });
  if (!line) return;
  // Lazy 24h auto-abandon (A3): a forgotten session must never strand stock.
  // Flipping status here (not just ignoring the row) releases the whole
  // session everywhere at once and shows up honestly in its history.
  if (line.session.lastActivityAt.getTime() < Date.now() - RECONCILE_STALE_ABANDON_MS) {
    await tx.reconcileSession.update({
      where: { id: line.session.id },
      data: { status: 'ABANDONED', abandonedAt: new Date() },
    });
    return;
  }
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'This shelf is being counted — it will be back shortly.',
  });
}

/**
 * Pantry-level freeze companion to assertStockMutable: paths that CREATE
 * placements (restock finalize, transfer destinations) would otherwise slip
 * uncounted stock into a pantry mid-count — the new row has no ReconcileLine,
 * so the per-placement check never fires. Reconcile's own scope growth
 * (addLine) and commit-derived moves are exempt by construction: commit flips
 * the session off DRAFT before it moves anything.
 */
export async function assertPantriesNotUnderCount(
  tx: Prisma.TransactionClient,
  pantryIds: string[],
): Promise<void> {
  if (pantryIds.length === 0) return;
  const scope = await tx.reconcilePantry.findFirst({
    where: { pantryId: { in: pantryIds }, session: { status: 'DRAFT' } },
    select: { session: { select: { id: true, lastActivityAt: true } } },
  });
  if (!scope) return;
  if (scope.session.lastActivityAt.getTime() < Date.now() - RECONCILE_STALE_ABANDON_MS) {
    await tx.reconcileSession.update({
      where: { id: scope.session.id },
      data: { status: 'ABANDONED', abandonedAt: new Date() },
    });
    return;
  }
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'That pantry is being counted — try again shortly.',
  });
}

const CHANGED = 'That item changed underneath you — try again.';

type Guarded = { count: number; reservedCount: number };

/**
 * Core guarded read-check-write loop. `decide` returns the fields to update
 * (or throws); the write only lands if the row still matches the read.
 */
async function guardedUpdate(
  tx: Prisma.TransactionClient,
  stockId: string,
  decide: (s: Guarded) => { count?: number; reservedCount?: number },
): Promise<Guarded> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = await tx.stock.findUniqueOrThrow({
      where: { id: stockId },
      select: { count: true, reservedCount: true },
    });
    const data = decide(s);
    const hit = await tx.stock.updateMany({
      where: { id: stockId, count: s.count, reservedCount: s.reservedCount },
      data,
    });
    if (hit.count === 1) return s;
  }
  throw new TRPCError({ code: 'CONFLICT', message: CHANGED });
}

/** Reserve `qty` units (order request): available must cover it. */
export async function reserveStock(
  tx: Prisma.TransactionClient,
  stockId: string,
  qty: number,
): Promise<void> {
  await assertStockMutable(tx, stockId, 'reserve');
  await guardedUpdate(tx, stockId, (s) => {
    if (availableOf(s) < qty) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left to reserve.' });
    }
    return { reservedCount: s.reservedCount + qty };
  });
}

/**
 * Release `qty` reserved units (cancel / edit-down). Mirrors the old silent
 * release: clamps at zero rather than erroring on an over-release.
 */
export async function releaseStock(
  tx: Prisma.TransactionClient,
  stockId: string,
  qty: number,
): Promise<void> {
  if (qty <= 0) return;
  await assertStockMutable(tx, stockId, 'release');
  await tx.stock.updateMany({
    where: { id: stockId, reservedCount: { gte: qty } },
    data: { reservedCount: { decrement: qty } },
  });
}

/**
 * Consume `qty` previously-reserved units (order pickup): count and
 * reservedCount decrement together — free stock is untouched, which is why
 * pickups ride through a reconcile freeze (A2).
 */
export async function consumeReservedStock(
  tx: Prisma.TransactionClient,
  stockId: string,
  qty: number,
): Promise<void> {
  await assertStockMutable(tx, stockId, 'consume-reserved');
  await guardedUpdate(tx, stockId, (s) => {
    if (s.count < qty || s.reservedCount < qty) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left.' });
    }
    return { count: s.count - qty, reservedCount: s.reservedCount - qty };
  });
}

/**
 * Consume `qty` FREE units (own-household take, share-gift handoff): available
 * must cover it so reserved holds are never eaten.
 */
export async function consumeFreeStock(
  tx: Prisma.TransactionClient,
  stockId: string,
  qty: number,
): Promise<void> {
  await assertStockMutable(tx, stockId, 'consume-free');
  await guardedUpdate(tx, stockId, (s) => {
    if (availableOf(s) < qty) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left.' });
    }
    return { count: s.count - qty };
  });
}

/** Put `qty` units back (take.undo): plain increment, no guard needed. */
export async function restoreStock(
  tx: Prisma.TransactionClient,
  stockId: string,
  qty: number,
): Promise<void> {
  await assertStockMutable(tx, stockId, 'restore');
  await tx.stock.update({ where: { id: stockId }, data: { count: { increment: qty } } });
}

/**
 * Recount/write-off primitive (moved from adjustment.ts's guardedRecount):
 * set count to `next(countBefore)`, refusing negatives and refusing to drop
 * below the units reserved by open orders (a strand there would wedge the
 * order at pickup).
 */
export async function guardedRecountStock(
  tx: Prisma.TransactionClient,
  stockId: string,
  next: (countBefore: number) => number,
): Promise<{ countBefore: number; countAfter: number }> {
  await assertStockMutable(tx, stockId, 'recount');
  let result: { countBefore: number; countAfter: number } | null = null;
  await guardedUpdate(tx, stockId, (s) => {
    const countAfter = next(s.count);
    if (countAfter < 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left.' });
    }
    if (countAfter < s.reservedCount) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `${s.reservedCount} unit(s) are held by open orders — cancel or complete those first.`,
      });
    }
    result = { countBefore: s.count, countAfter };
    return { count: countAfter };
  });
  return result!;
}

/**
 * Move `qty` FREE units of a placement to another pantry (REWORK S3): the one
 * sanctioned way units change pantry outside receive. Never touches reserved
 * units (movable = count − reservedCount), never money — the lot (and its
 * frozen unitCost) rides along via the destination placement's lotId. Returns
 * both placement ids so the caller can pin them on the TransferLine.
 */
export async function moveStock(
  tx: Prisma.TransactionClient,
  fromStockId: string,
  toPantryId: string,
  qty: number,
): Promise<{ fromStockId: string; toStockId: string; lotId: string }> {
  const from = await tx.stock.findUniqueOrThrow({
    where: { id: fromStockId },
    select: { id: true, lotId: true, pantryId: true },
  });
  if (from.pantryId === toPantryId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Source and destination are the same pantry.' });
  }
  await assertStockMutable(tx, fromStockId, 'transfer-out');
  await guardedUpdate(tx, fromStockId, (s) => {
    if (availableOf(s) < qty) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left to move.' });
    }
    return { count: s.count - qty };
  });
  const dest = await ensureStock(tx, from.lotId, toPantryId);
  await assertStockMutable(tx, dest.id, 'transfer-in');
  await tx.stock.update({ where: { id: dest.id }, data: { count: { increment: qty } } });
  return { fromStockId: from.id, toStockId: dest.id, lotId: from.lotId };
}

/**
 * Find-or-create the placement for (lot, pantry). Restock finalize uses this
 * to materialize placements; Round 2's transfer + per-line receive splits
 * reuse it for destinations. Durable once created (history FKs point here).
 */
export async function ensureStock(
  tx: Prisma.TransactionClient,
  lotId: string,
  pantryId: string,
): Promise<{ id: string; count: number; reservedCount: number }> {
  const existing = await tx.stock.findUnique({
    where: { lotId_pantryId: { lotId, pantryId } },
    select: { id: true, count: true, reservedCount: true },
  });
  if (existing) return existing;
  return tx.stock.create({
    data: { lotId, pantryId },
    select: { id: true, count: true, reservedCount: true },
  });
}
