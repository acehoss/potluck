import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { circleToGrantSet, requireCapability } from '../authz';
import { grantColumnsOf } from '../circles';
import { db, dbTransaction } from '../db';
import { protectedProcedure, router } from '../trpc';

/**
 * Circle management (REWORK Phase-2 P4): a household's named grant bundles.
 * Circles ARE the directional grants — editing a circle's six flags is how a
 * household changes what it extends to everyone placed in that circle (this
 * replaces the old per-connection setGrants). All writes need manageConnections
 * on the ACTING membership; list is a manager read (it drives the connection
 * assign UI). A circle is only ever assigned on its OWNER household's side of an
 * edge, so counting uses of a circle only inspects that side.
 */

const grantsSchema = z.object({
  pantry: z.boolean(),
  lending: z.boolean(),
  recipes: z.boolean(),
  shareTo: z.boolean(),
  shareFrom: z.boolean(),
  reshare: z.boolean(),
});

const nameSchema = z.string().trim().min(1).max(40);

/** How many ACTIVE/PENDING/SEVERED edges place a counterparty in this circle. */
function connectionUses(tx: Prisma.TransactionClient, householdId: string, circleId: string) {
  return tx.connection.count({
    where: {
      OR: [
        { householdAId: householdId, aCircleId: circleId },
        { householdBId: householdId, bCircleId: circleId },
      ],
    },
  });
}

/** Load an OWN circle by id, else 404. */
async function requireOwnCircle(
  tx: Prisma.TransactionClient,
  householdId: string,
  circleId: string,
) {
  const circle = await tx.circle.findUnique({ where: { id: circleId } });
  if (!circle || circle.householdId !== householdId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No such circle.' });
  }
  return circle;
}

export const circleRouter = router({
  /**
   * The acting household's circles, in display order, each with what it grants
   * and how many connections currently sit in it (the delete/assign UI reads
   * both). manageConnections-gated — circles are connection administration.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    requireCapability(ctx.user, 'manageConnections');
    const me = ctx.user.householdId;
    const circles = await db.circle.findMany({
      where: { householdId: me },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    const counts = await Promise.all(
      circles.map(async (c) => ({
        connections: await db.connection.count({
          where: {
            OR: [
              { householdAId: me, aCircleId: c.id },
              { householdBId: me, bCircleId: c.id },
            ],
          },
        }),
        scopes:
          (await db.pantryCircle.count({ where: { circleId: c.id } })) +
          (await db.itemCircle.count({ where: { circleId: c.id } })) +
          (await db.membershipCircle.count({ where: { circleId: c.id } })),
      })),
    );
    return {
      canManage: ctx.user.activeMembership.manageConnections,
      circles: circles.map((c, i) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        grants: circleToGrantSet(c),
        connectionCount: counts[i].connections,
        scopeCount: counts[i].scopes,
      })),
    };
  }),

  /** Create a circle (name 1..40, unique per household → 409; six grant flags). */
  create: protectedProcedure
    .input(z.object({ name: nameSchema, grants: grantsSchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const clash = await tx.circle.findUnique({
          where: { householdId_name: { householdId: me, name: input.name } },
        });
        if (clash) {
          throw new TRPCError({ code: 'CONFLICT', message: 'You already have a circle by that name.' });
        }
        const max = await tx.circle.aggregate({
          where: { householdId: me },
          _max: { position: true },
        });
        const circle = await tx.circle.create({
          data: {
            householdId: me,
            name: input.name,
            position: (max._max.position ?? -1) + 1,
            ...grantColumnsOf(input.grants),
          },
        });
        return { id: circle.id };
      });
    }),

  /**
   * Rename and/or re-grant a circle. Editing the grants IS the new setGrants:
   * everyone in this circle immediately sees the change (unilateral, P4). Name
   * collisions inside the household are 409.
   */
  update: protectedProcedure
    .input(
      z.object({
        circleId: z.string().min(1),
        name: nameSchema.optional(),
        grants: grantsSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        await requireOwnCircle(tx, me, input.circleId);
        if (input.name) {
          const clash = await tx.circle.findUnique({
            where: { householdId_name: { householdId: me, name: input.name } },
          });
          if (clash && clash.id !== input.circleId) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'You already have a circle by that name.',
            });
          }
        }
        await tx.circle.update({
          where: { id: input.circleId },
          data: {
            name: input.name,
            ...(input.grants ? grantColumnsOf(input.grants) : {}),
          },
        });
        return { ok: true };
      });
    }),

  /**
   * Delete a circle. 409 while any connection still sits in it OR any pantry/
   * item/member is scoped to it — reassign/rescope first (deleting would drop a
   * side's grants to nothing or orphan a SELECT scope silently).
   */
  delete: protectedProcedure
    .input(z.object({ circleId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        await requireOwnCircle(tx, me, input.circleId);
        const uses = await connectionUses(tx, me, input.circleId);
        if (uses > 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Move the connections in this circle somewhere else first.',
          });
        }
        const scopes =
          (await tx.pantryCircle.count({ where: { circleId: input.circleId } })) +
          (await tx.itemCircle.count({ where: { circleId: input.circleId } })) +
          (await tx.membershipCircle.count({ where: { circleId: input.circleId } }));
        if (scopes > 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This circle still scopes a pantry, item, or member.',
          });
        }
        await tx.circle.delete({ where: { id: input.circleId } });
        return { ok: true };
      });
    }),

  /** Set a circle's display order (drag-to-reorder in the UI). */
  reorder: protectedProcedure
    .input(z.object({ circleId: z.string().min(1), position: z.number().int().min(0).max(999) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'manageConnections');
      const me = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        await requireOwnCircle(tx, me, input.circleId);
        await tx.circle.update({
          where: { id: input.circleId },
          data: { position: input.position },
        });
        return { ok: true };
      });
    }),
});
