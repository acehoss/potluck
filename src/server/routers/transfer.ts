import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { SessionUser } from '../auth';
import { requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { moveStock } from '../stock';
import { protectedProcedure, router } from '../trpc';

const lineSchema = z.object({
  stockId: z.string().min(1),
  quantity: z.number().int().min(1).max(10_000),
});

function transferResult(transfer: { id: string; lines: { quantity: number }[] }) {
  return {
    id: transfer.id,
    movedLines: transfer.lines.length,
    movedUnits: transfer.lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}

async function findReplayedTransfer(
  tx: Prisma.TransactionClient,
  clientKey: string | undefined,
  input: { fromPantryId: string; toPantryId: string; lines: { stockId: string; quantity: number }[] },
  user: SessionUser,
) {
  if (!clientKey) return null;
  const existing = await tx.transfer.findUnique({
    where: { clientKey },
    include: { lines: { select: { fromStockId: true, quantity: true } } },
  });
  if (!existing) return null;
  // A replay must be the SAME operation — same actor, pantry pair, AND lines.
  // Returning the original for a different payload would be a silent lie (the
  // caller believes a different move happened); reject the key instead.
  const fingerprint = (lines: { stockId: string; quantity: number }[]) =>
    lines
      .map((l) => `${l.stockId}:${l.quantity}`)
      .sort()
      .join('|');
  if (
    existing.createdById !== user.id ||
    existing.householdId !== user.householdId ||
    existing.fromPantryId !== input.fromPantryId ||
    existing.toPantryId !== input.toPantryId ||
    fingerprint(existing.lines.map((l) => ({ stockId: l.fromStockId, quantity: l.quantity }))) !==
      fingerprint(input.lines)
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate request key.' });
  }
  return transferResult(existing);
}

async function assertOwnPantries(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  fromPantryId: string,
  toPantryId: string,
) {
  const pantries = await tx.pantry.findMany({
    where: { id: { in: [fromPantryId, toPantryId] }, householdId: user.householdId },
    select: { id: true },
  });
  if (pantries.length !== 2) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Pantry not found.' });
  }
}

async function assertMovableStock(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  stockId: string,
  fromPantryId: string,
) {
  const stock = await tx.stock.findUnique({
    where: { id: stockId },
    include: {
      pantry: { select: { householdId: true } },
      lot: { include: { restock: { select: { status: true, voidedAt: true } } } },
    },
  });
  if (!stock || stock.pantryId !== fromPantryId || stock.pantry.householdId !== user.householdId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found in source pantry.' });
  }
  if (
    stock.lot.restock.status !== 'FINALIZED' ||
    stock.lot.restock.voidedAt !== null ||
    stock.lot.excluded ||
    stock.lot.unitCostCents === null
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That item is not movable.' });
  }
}

export const transferRouter = router({
  /**
   * Move free units from one owned pantry to another, atomically across all
   * lines. The immutable Transfer/TransferLine rows are the audit trail; a bad
   * move is corrected by transferring back.
   */
  create: protectedProcedure
    .input(
      z.object({
        fromPantryId: z.string().min(1),
        toPantryId: z.string().min(1),
        note: z.string().trim().max(200).optional(),
        clientKey: z.string().min(8).max(64).optional(),
        lines: z.array(lineSchema).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'adjustInventory');
      if (input.fromPantryId === input.toPantryId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick two different pantries.' });
      }
      const seen = new Set<string>();
      for (const line of input.lines) {
        if (seen.has(line.stockId)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Duplicate stock line.' });
        }
        seen.add(line.stockId);
      }

      return dbTransaction(async (tx) => {
        await assertOwnPantries(tx, ctx.user, input.fromPantryId, input.toPantryId);
        const replayed = await findReplayedTransfer(tx, input.clientKey, input, ctx.user);
        if (replayed) return replayed;

        for (const line of input.lines) {
          await assertMovableStock(tx, ctx.user, line.stockId, input.fromPantryId);
        }

        const transfer = await tx.transfer.create({
          data: {
            clientKey: input.clientKey ?? null,
            householdId: ctx.user.householdId,
            fromPantryId: input.fromPantryId,
            toPantryId: input.toPantryId,
            note: input.note || null,
            createdById: ctx.user.id,
          },
        });
        for (const line of input.lines) {
          const moved = await moveStock(tx, line.stockId, input.toPantryId, line.quantity);
          await tx.transferLine.create({
            data: {
              transferId: transfer.id,
              lotId: moved.lotId,
              fromStockId: moved.fromStockId,
              toStockId: moved.toStockId,
              quantity: line.quantity,
            },
          });
        }
        return {
          id: transfer.id,
          movedLines: input.lines.length,
          movedUnits: input.lines.reduce((sum, line) => sum + line.quantity, 0),
        };
      });
    }),

  /**
   * Recent transfer history for the acting household. Kept deliberately small
   * for the later history surface.
   */
  listForHousehold: protectedProcedure.query(async ({ ctx }) => {
    const transfers = await db.transfer.findMany({
      where: { householdId: ctx.user.householdId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        fromPantry: { select: { id: true, name: true } },
        toPantry: { select: { id: true, name: true } },
        createdBy: { select: { name: true } },
        lines: { select: { quantity: true } },
      },
    });
    return transfers.map((transfer) => ({
      id: transfer.id,
      fromPantry: transfer.fromPantry,
      toPantry: transfer.toPantry,
      lineCount: transfer.lines.length,
      unitSum: transfer.lines.reduce((sum, line) => sum + line.quantity, 0),
      note: transfer.note,
      createdByName: transfer.createdBy.name,
      createdAt: transfer.createdAt.toISOString(),
    }));
  }),
});
