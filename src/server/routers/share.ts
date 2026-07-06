import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { SessionUser } from '../auth';
import { getConnection, grantsFrom, requireCapability } from '../authz';
import { db, dbTransaction } from '../db';
import { shareVisible, type Dbc } from '../share-reach';
import { imageFileExists, isStoredImagePath } from '../images';
import { notify } from '../push';
import { apportionFifo, defaultExpiresAt, MAX_EXPIRY_MS } from '../shares';
import { protectedProcedure, router } from '../trpc';

/**
 * Needs & surpluses (REWORK F). A post is a NEED or SURPLUS; households claim,
 * posters confirm/release, and connections reshare onward hop-by-hop. Shares
 * are GIFTS (C1/F5): NOTHING here ever writes a LedgerEntry. Confirming a
 * SURPLUS backed by tracked lots records $0 Takes (shareClaimId set) as the
 * audit trail — the only money-shaped side effect, and it's free.
 *
 * Visibility (F2/B2): a household sees a post iff it's own, OR — over an ACTIVE
 * connection — the poster grants it `shareTo` AND it grants the poster
 * `shareFrom` (both directions). A reshare copy is additionally live only while
 * its ORIGIN is live and every hop up to the origin still shares-through
 * (`chainEdgesAlive`) — a severed upstream edge prunes the whole downstream
 * (B6/F4). Quantity/remaining always resolve from the origin row (single source
 * of truth); a copy's DTO carries NO origin/parent household identity (F4).
 */

type PostRow = Prisma.SharePostGetPayload<Record<string, never>>;

const HOP_MAX = 3;

/** OPEN/CLAIMED and not past expiry — the base "still on the board" test. */
function feedLive(post: { status: string; expiresAt: Date }, now: Date): boolean {
  return (post.status === 'OPEN' || post.status === 'CLAIMED') && post.expiresAt > now;
}

/** The origin (root) post for any post: itself when it IS the origin. */
async function originOf(dbc: Dbc, post: PostRow): Promise<PostRow> {
  if (!post.originPostId) return post;
  return (await dbc.sharePost.findUnique({ where: { id: post.originPostId } })) ?? post;
}

/**
 * A reshare copy stays live only while every hop up to the origin still holds:
 * at each hop the broker (that copy's household) must still share-see its
 * PARENT post's household. Severing any upstream edge kills the chain
 * downstream (B6/F4). Capped at the hard reshare depth.
 */
async function chainEdgesAlive(dbc: Dbc, copy: PostRow): Promise<boolean> {
  let current: PostRow = copy;
  for (let hop = 0; hop <= HOP_MAX && current.parentPostId; hop++) {
    const parent = await dbc.sharePost.findUnique({ where: { id: current.parentPostId } });
    if (!parent) return false;
    if (!(await shareVisible(dbc, parent.householdId, current.householdId))) return false;
    current = parent;
  }
  return true;
}

/**
 * Load a post the acting household may interact with, resolving its origin and
 * whether it is still feed-live for this household. Throws 404 when the post
 * doesn't exist or isn't visible at all (own, or share-visible). `mine`/`live`
 * let callers apply the right 400/409.
 */
async function loadVisiblePost(dbc: Dbc, user: SessionUser, postId: string) {
  const post = await dbc.sharePost.findUnique({ where: { id: postId } });
  if (!post) throw new TRPCError({ code: 'NOT_FOUND', message: 'Post not found.' });
  const mine = post.householdId === user.householdId;
  if (!mine && !(await shareVisible(dbc, post.householdId, user.householdId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Post not found.' });
  }
  const origin = await originOf(dbc, post);
  const now = new Date();
  let live = feedLive(post, now) && feedLive(origin, now);
  if (live && post.originPostId) live = await chainEdgesAlive(dbc, post);
  return { post, origin, mine, live };
}

/** Derived, display-only status (WITHDRAWN never surfaces — it's pruned upstream). */
function derivedStatus(
  post: PostRow,
  origin: PostRow,
  now: Date,
): 'OPEN' | 'CLAIMED' | 'FULFILLED' | 'EXPIRED' {
  if (origin.status === 'FULFILLED' || post.status === 'FULFILLED') return 'FULFILLED';
  if (post.expiresAt <= now || origin.expiresAt <= now) return 'EXPIRED';
  if (post.status === 'CLAIMED') return 'CLAIMED';
  return 'OPEN';
}

/** Set an origin and every copy in its tree FULFILLED (leaving WITHDRAWN alone). */
async function fulfillTree(tx: Prisma.TransactionClient, originId: string) {
  await tx.sharePost.updateMany({
    where: { OR: [{ id: originId }, { originPostId: originId }], status: { in: ['OPEN', 'CLAIMED'] } },
    data: { status: 'FULFILLED' },
  });
}

/** Set a post and its descendants FULFILLED (a broker's downstream branch). */
async function fulfillSubtree(tx: Prisma.TransactionClient, postId: string) {
  const ids = new Set([postId]);
  let frontier = [postId];
  while (frontier.length) {
    const kids = await tx.sharePost.findMany({
      where: { parentPostId: { in: frontier } },
      select: { id: true },
    });
    frontier = kids.map((k) => k.id).filter((id) => !ids.has(id));
    frontier.forEach((id) => ids.add(id));
  }
  await tx.sharePost.updateMany({
    where: { id: { in: [...ids] }, status: { in: ['OPEN', 'CLAIMED'] } },
    data: { status: 'FULFILLED' },
  });
}

/**
 * The $0 gift transfer for a confirmed SURPLUS claim (C1). Draws `claim.quantity`
 * (or, for an uncounted post, everything available) FIFO across the origin's
 * linked lots by purchase date, decrementing remainingCount ONLY (reservations
 * stay honored). Each touched lot records a $0 Take with shareClaimId — NEVER a
 * LedgerEntry. A shortfall after exhausting the lots throws 409, rolling back
 * the whole confirm.
 */
async function giftFromLots(
  tx: Prisma.TransactionClient,
  postLots: { lotId: string; lot: { restock: { purchasedAt: Date } } }[],
  claim: { id: string; createdById: string; householdId: string; quantity: number | null },
  clientKey: string | null,
): Promise<number> {
  const ordered = [...postLots].sort(
    (a, b) => a.lot.restock.purchasedAt.getTime() - b.lot.restock.purchasedAt.getTime(),
  );
  const fresh: { id: string; remainingCount: number; reservedCount: number }[] = [];
  for (const pl of ordered) {
    fresh.push(
      await tx.lot.findUniqueOrThrow({
        where: { id: pl.lotId },
        select: { id: true, remainingCount: true, reservedCount: true },
      }),
    );
  }
  const avails = fresh.map((l) => Math.max(0, l.remainingCount - l.reservedCount));
  const totalAvail = avails.reduce((s, a) => s + a, 0);
  const need = claim.quantity ?? totalAvail; // whole-thing for an uncounted post
  const taken = apportionFifo(avails, need);
  if (taken.reduce((s, t) => s + t, 0) < need) {
    throw new TRPCError({ code: 'CONFLICT', message: 'The linked lots no longer cover this claim.' });
  }
  let gifted = 0;
  for (let i = 0; i < fresh.length; i++) {
    const qty = taken[i];
    if (qty <= 0) continue;
    const l = fresh[i];
    const hit = await tx.lot.updateMany({
      where: { id: l.id, remainingCount: { gte: l.reservedCount + qty } },
      data: { remainingCount: { decrement: qty } },
    });
    if (hit.count === 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'The linked lots no longer cover this claim.' });
    }
    await tx.take.create({
      data: {
        lotId: l.id,
        takerId: claim.createdById,
        householdId: claim.householdId, // snapshot recipient household (relation-free, like ledger)
        quantity: qty,
        costCents: 0, // gifts are free — no ledger entry, ever (C1)
        shareClaimId: claim.id,
        clientKey: clientKey ? `${clientKey}:gift:${l.id}` : null,
      },
    });
    gifted += qty;
  }
  return gifted;
}

/**
 * Reject a photo path that isn't a fresh `shares` upload owned by nobody yet
 * (mirrors restock.assertFreshUpload): right kind + server-generated name,
 * present on disk, referenced by no other post.
 */
async function assertFreshShareImage(tx: Prisma.TransactionClient, path: string) {
  if (!isStoredImagePath('shares', path)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an uploaded image path.' });
  }
  if (!(await imageFileExists(path))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Image not found — upload it first.' });
  }
  const used = await tx.sharePost.findFirst({ where: { photoPath: path } });
  if (used) throw new TRPCError({ code: 'CONFLICT', message: 'That image is already attached.' });
}

/**
 * A lot the acting household may offer as SURPLUS: its OWN, finalized,
 * non-voided, real inventory (not excluded), unit cost frozen. Anything else
 * reads as not-found (existence never leaks).
 */
async function loadOwnShareableLot(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  lotId: string,
) {
  const lot = await tx.lot.findUnique({
    where: { id: lotId },
    include: {
      restock: { select: { status: true, voidedAt: true, pantry: { select: { householdId: true } } } },
    },
  });
  if (
    !lot ||
    lot.restock.pantry.householdId !== user.householdId ||
    lot.restock.status !== 'FINALIZED' ||
    lot.restock.voidedAt !== null ||
    lot.excluded ||
    lot.unitCostCents === null
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not available to share.' });
  }
  return lot;
}

const clientKeySchema = z.string().min(8).max(64).optional();

export const shareRouter = router({
  /**
   * The acting household's board: its own posts (kept while OPEN/CLAIMED plus a
   * grace window after — see below) and every share-visible, feed-live post from
   * its connections. Reshare copies are anonymized to the RESHARER.
   */
  feed: protectedProcedure.query(async ({ ctx }) => {
    const H = ctx.user.householdId;
    const now = new Date();
    // Own posts stay on the board while live, and for a 7-day grace after expiry
    // so a just-fulfilled/lapsed post is still reviewable; WITHDRAWN and stale
    // husks drop off. (Deliberately simple — no per-status bookkeeping.)
    const graceStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const householdSelect = { select: { id: true, name: true } } as const;

    const ownPosts = await db.sharePost.findMany({
      where: { householdId: H, status: { not: 'WITHDRAWN' }, expiresAt: { gt: graceStart } },
      include: { household: householdSelect },
    });
    const candidates = await db.sharePost.findMany({
      where: { householdId: { not: H }, status: { in: ['OPEN', 'CLAIMED'] }, expiresAt: { gt: now } },
      include: { household: householdSelect },
    });

    type Rendered = { post: (typeof ownPosts)[number]; origin: PostRow; mine: boolean };
    const rendered: Rendered[] = [];
    for (const p of ownPosts) rendered.push({ post: p, origin: await originOf(db, p), mine: true });
    for (const p of candidates) {
      if (!(await shareVisible(db, p.householdId, H))) continue;
      const origin = await originOf(db, p);
      if (!feedLive(origin, now)) continue; // origin drives status/expiry
      if (p.originPostId && !(await chainEdgesAlive(db, p))) continue;
      rendered.push({ post: p, origin, mine: false });
    }
    rendered.sort((a, b) => b.post.createdAt.getTime() - a.post.createdAt.getTime());

    const postIds = rendered.map((r) => r.post.id);
    const ownIds = ownPosts.map((p) => p.id);
    const [myClaims, ownClaims, myReshares] = await Promise.all([
      db.shareClaim.findMany({
        where: { postId: { in: postIds }, householdId: H, status: { in: ['PENDING', 'CONFIRMED'] } },
        orderBy: { createdAt: 'desc' },
      }),
      db.shareClaim.findMany({
        where: { postId: { in: ownIds }, status: { in: ['PENDING', 'CONFIRMED'] } },
        orderBy: { createdAt: 'asc' },
      }),
      db.sharePost.findMany({
        where: { parentPostId: { in: postIds }, householdId: H },
        select: { parentPostId: true },
      }),
    ]);
    const myClaimByPost = new Map<string, (typeof myClaims)[number]>();
    for (const c of myClaims) if (!myClaimByPost.has(c.postId)) myClaimByPost.set(c.postId, c);
    const resharedParents = new Set(myReshares.map((r) => r.parentPostId));
    const claimantIds = [...new Set(ownClaims.map((c) => c.householdId))];
    const claimants = await db.household.findMany({
      where: { id: { in: claimantIds } },
      select: { id: true, name: true },
    });
    const claimantName = new Map(claimants.map((h) => [h.id, h.name]));
    const claimsByPost = new Map<string, typeof ownClaims>();
    for (const c of ownClaims) (claimsByPost.get(c.postId) ?? claimsByPost.set(c.postId, []).get(c.postId)!).push(c);

    const posts = [];
    for (const { post: p, origin, mine } of rendered) {
      let canReshare = false;
      if (!mine && p.hopsRemaining > 0 && !resharedParents.has(p.id)) {
        const conn = await getConnection(db, p.householdId, H);
        canReshare =
          !!conn && conn.status === 'ACTIVE' && grantsFrom(conn, p.householdId).reshare;
      }
      const myClaim = myClaimByPost.get(p.id);
      posts.push({
        id: p.id,
        type: p.type,
        title: p.title,
        description: p.description,
        photoPath: p.photoPath,
        quantity: origin.quantity,
        unit: origin.unit,
        remaining: origin.remaining,
        expiresAt: origin.expiresAt.toISOString(),
        status: derivedStatus(p, origin, now),
        mine,
        isReshare: p.originPostId != null,
        // For a reshare copy this is the RESHARER — never the origin/parent (F4).
        poster: { householdId: p.householdId, householdName: p.household.name },
        canReshare,
        hopsRemaining: p.hopsRemaining,
        myClaim: myClaim
          ? { id: myClaim.id, status: myClaim.status, quantity: myClaim.quantity }
          : null,
        ...(mine
          ? {
              claims: (claimsByPost.get(p.id) ?? []).map((c) => ({
                id: c.id,
                householdName: claimantName.get(c.householdId) ?? 'Unknown',
                quantity: c.quantity,
                note: c.note,
                status: c.status,
                createdAt: c.createdAt.toISOString(),
              })),
            }
          : {}),
      });
    }
    return { posts };
  }),

  /** Post a NEED or SURPLUS. SURPLUS may link own finalized lots to gift from. */
  create: protectedProcedure
    .input(
      z.object({
        type: z.enum(['NEED', 'SURPLUS']),
        title: z.string().trim().min(1).max(140),
        description: z.string().trim().max(1000).optional(),
        quantity: z.number().int().min(1).max(10_000).optional(),
        unit: z.string().trim().min(1).max(20).optional(),
        expiresAt: z.string().min(1).max(40).optional(),
        hopsAllowance: z.number().int().min(0).max(HOP_MAX).default(1),
        lotIds: z.array(z.string().min(1)).max(20).optional(),
        photoPath: z.string().min(1).max(300).optional(),
        clientKey: clientKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'postShares');
      if (input.unit && input.quantity == null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A unit needs a quantity.' });
      }
      if (input.lotIds?.length && input.type !== 'SURPLUS') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a surplus can offer stock.' });
      }
      const now = new Date();
      let expiresAt: Date;
      if (input.expiresAt) {
        expiresAt = new Date(input.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a real date.' });
        }
        if (expiresAt <= now) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expiry must be in the future.' });
        }
        if (expiresAt.getTime() > now.getTime() + MAX_EXPIRY_MS) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expiry is too far out (60 days max).' });
        }
      } else {
        expiresAt = defaultExpiresAt(input.type, now);
      }

      const result = await dbTransaction(async (tx) => {
        if (input.clientKey) {
          const prior = await tx.sharePost.findUnique({ where: { clientKey: input.clientKey } });
          if (prior) return { id: prior.id, created: false };
        }
        if (input.photoPath) await assertFreshShareImage(tx, input.photoPath);
        const lotIds = input.type === 'SURPLUS' ? input.lotIds ?? [] : [];
        for (const lotId of lotIds) await loadOwnShareableLot(tx, ctx.user, lotId);

        const post = await tx.sharePost.create({
          data: {
            clientKey: input.clientKey ?? null,
            type: input.type,
            householdId: ctx.user.householdId,
            createdById: ctx.user.id,
            title: input.title,
            description: input.description ?? null,
            photoPath: input.photoPath ?? null,
            quantity: input.quantity ?? null,
            unit: input.quantity != null ? input.unit ?? null : null,
            remaining: input.quantity ?? null,
            expiresAt,
            status: 'OPEN',
            hopsRemaining: input.hopsAllowance,
          },
        });
        for (const lotId of lotIds) {
          await tx.sharePostLot.create({ data: { postId: post.id, lotId } });
        }
        return { id: post.id, created: true };
      });
      // Post-commit: notify every connected household that can SEE this new post
      // (poster's ACTIVE connections filtered by shareVisible — both directions).
      // category circle (ambient neighborhood activity, default push/email OFF —
      // it's the digest's home); generic content (N4). Skipped on clientKey replay.
      if (result.created) {
        const poster = ctx.user.householdId;
        const conns = await db.connection.findMany({
          where: { status: 'ACTIVE', OR: [{ householdAId: poster }, { householdBId: poster }] },
        });
        const audience: string[] = [];
        for (const c of conns) {
          const other = c.householdAId === poster ? c.householdBId : c.householdAId;
          if (await shareVisible(db, poster, other)) audience.push(other);
        }
        if (audience.length > 0) {
          void notify({
            recipientHouseholdIds: audience,
            excludeUserId: ctx.user.id,
            category: 'circle',
            url: '/shares',
            title: 'New neighborhood activity for {household}',
            body: 'A connected household posted a new share.',
            detail: `From ${ctx.user.household.name}.`,
          });
        }
      }
      return { id: result.id };
    }),

  /**
   * Withdraw a post you own, and its whole reshare subtree (so a severed-off
   * downstream branch dies too). PENDING claims become unanswerable (respond →
   * 409). Idempotent — already-terminal posts are left as they are.
   */
  withdraw: protectedProcedure
    .input(z.object({ postId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'postShares');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const post = await tx.sharePost.findUnique({ where: { id: input.postId } });
        if (!post) throw new TRPCError({ code: 'NOT_FOUND', message: 'Post not found.' });
        if (post.householdId !== H) {
          const visible = await shareVisible(tx, post.householdId, H);
          throw new TRPCError({
            code: visible ? 'FORBIDDEN' : 'NOT_FOUND',
            message: visible ? 'Only the posting household can withdraw this.' : 'Post not found.',
          });
        }
        const ids = new Set([post.id]);
        let frontier = [post.id];
        while (frontier.length) {
          const kids = await tx.sharePost.findMany({
            where: { parentPostId: { in: frontier } },
            select: { id: true },
          });
          frontier = kids.map((k) => k.id).filter((id) => !ids.has(id));
          frontier.forEach((id) => ids.add(id));
        }
        await tx.sharePost.updateMany({
          where: { id: { in: [...ids] }, status: { in: ['OPEN', 'CLAIMED'] } },
          data: { status: 'WITHDRAWN' },
        });
        return { ok: true };
      });
    }),

  /**
   * Claim a visible, feed-live post (not your own). A counted post takes a
   * quantity (soft-capped to the origin's remaining — F3, no hard reservation);
   * an uncounted post is single-claimant and flips OPEN→CLAIMED under the lock.
   */
  claim: protectedProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        quantity: z.number().int().min(1).max(10_000).optional(),
        note: z.string().trim().max(300).optional(),
        clientKey: clientKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'postShares');
      const H = ctx.user.householdId;
      const result = await dbTransaction(async (tx) => {
        if (input.clientKey) {
          const prior = await tx.shareClaim.findUnique({ where: { clientKey: input.clientKey } });
          if (prior) return { id: prior.id, status: prior.status, created: false, postHouseholdId: null };
        }
        const { post, origin, mine, live } = await loadVisiblePost(tx, ctx.user, input.postId);
        if (mine) throw new TRPCError({ code: 'BAD_REQUEST', message: "You can't claim your own post." });
        if (!live) throw new TRPCError({ code: 'CONFLICT', message: 'No longer available.' });

        if (origin.quantity != null) {
          const remaining = origin.remaining ?? 0;
          if (input.quantity == null) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Say how many you want.' });
          }
          if (input.quantity > remaining) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: "That's more than is left." });
          }
        } else if (input.quantity != null) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: "This post isn't counted." });
        }

        const dup = await tx.shareClaim.findFirst({
          where: { postId: post.id, householdId: H, status: 'PENDING' },
        });
        if (dup) {
          throw new TRPCError({ code: 'CONFLICT', message: 'You already have a pending claim here.' });
        }
        // Uncounted post: one claimant at a time (guarded OPEN→CLAIMED on the
        // claimed row — origin or copy). A lost race reads 409.
        if (origin.quantity == null) {
          const moved = await tx.sharePost.updateMany({
            where: { id: post.id, status: 'OPEN' },
            data: { status: 'CLAIMED' },
          });
          if (moved.count === 0) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Someone beat you to it.' });
          }
        }
        const claim = await tx.shareClaim.create({
          data: {
            clientKey: input.clientKey ?? null,
            postId: post.id,
            householdId: H,
            createdById: ctx.user.id,
            quantity: input.quantity ?? null,
            note: input.note ?? null,
            status: 'PENDING',
          },
        });
        return {
          id: claim.id,
          status: 'PENDING' as const,
          created: true,
          postHouseholdId: post.householdId,
        };
      });
      // Post-commit: notify the household that OWNS the claimed post (the origin
      // poster, or the resharer for a copy) that someone wants what they shared.
      // category pickups (a handoff waiting on them); generic content (N4).
      if (result.created && result.postHouseholdId) {
        void notify({
          recipientHouseholdIds: [result.postHouseholdId],
          excludeUserId: ctx.user.id,
          category: 'pickups',
          url: '/shares',
          title: 'Someone claimed your share in {household}',
          body: 'A household wants something you posted.',
          detail: `From ${ctx.user.household.name}.`,
        });
      }
      return { id: result.id, status: result.status };
    }),

  /** Retract your own PENDING claim; an uncounted post returns CLAIMED→OPEN. */
  cancelClaim: protectedProcedure
    .input(z.object({ claimId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'postShares');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const claim = await tx.shareClaim.findUnique({ where: { id: input.claimId } });
        if (!claim || claim.householdId !== H) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Claim not found.' });
        }
        if (claim.status !== 'PENDING') {
          throw new TRPCError({ code: 'CONFLICT', message: 'This claim was already answered.' });
        }
        await tx.shareClaim.update({
          where: { id: claim.id },
          data: { status: 'CANCELED', resolvedAt: new Date() },
        });
        const post = await tx.sharePost.findUnique({ where: { id: claim.postId } });
        if (post) {
          const origin = await originOf(tx, post);
          if (origin.quantity == null) {
            await tx.sharePost.updateMany({
              where: { id: post.id, status: 'CLAIMED' },
              data: { status: 'OPEN' },
            });
          }
        }
        return { ok: true };
      });
    }),

  /**
   * The poster answers a claim on their own post. `release` frees it (uncounted
   * → CLAIMED→OPEN). `confirm` marks the claim CONFIRMED and does the quantity
   * accounting on the ORIGIN row only; when the confirmed post is an origin
   * SURPLUS with linked lots and a cross-household claimant, it records the $0
   * gift (C1). A broker confirming a downstream copy claim gifts/decrements
   * NOTHING — they source goods by claiming upstream themselves (F4).
   */
  respond: protectedProcedure
    .input(
      z.object({
        claimId: z.string().min(1),
        action: z.enum(['confirm', 'release']),
        clientKey: clientKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        const claim = await tx.shareClaim.findUnique({ where: { id: input.claimId } });
        if (!claim) throw new TRPCError({ code: 'NOT_FOUND', message: 'Claim not found.' });
        const post = await tx.sharePost.findUnique({
          where: { id: claim.postId },
          include: { lots: { include: { lot: { select: { restock: { select: { purchasedAt: true } } } } } } },
        });
        if (!post) throw new TRPCError({ code: 'NOT_FOUND', message: 'Post not found.' });
        // The claim's post must belong to the acting household (404/403 convention).
        if (post.householdId !== H) {
          const visible = await shareVisible(tx, post.householdId, H);
          throw new TRPCError({
            code: visible ? 'FORBIDDEN' : 'NOT_FOUND',
            message: visible ? 'Only the posting household can answer this.' : 'Claim not found.',
          });
        }
        requireCapability(ctx.user, 'fulfill');

        // Replay: a repeated confirm/release returns the original outcome
        // (no re-gift, no double-decrement).
        if (claim.status !== 'PENDING') {
          if (input.action === 'confirm' && claim.status === 'CONFIRMED') {
            return { ok: true, status: 'CONFIRMED' as const, gifted: 0 };
          }
          if (input.action === 'release' && claim.status === 'RELEASED') {
            return { ok: true, status: 'RELEASED' as const, gifted: 0 };
          }
          throw new TRPCError({ code: 'CONFLICT', message: 'This claim was already answered.' });
        }

        const origin = await originOf(tx, post);
        const now = new Date();
        if (
          post.status === 'WITHDRAWN' ||
          origin.status === 'WITHDRAWN' ||
          post.expiresAt <= now ||
          origin.expiresAt <= now
        ) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This post is no longer open.' });
        }

        if (input.action === 'release') {
          await tx.shareClaim.update({
            where: { id: claim.id },
            data: { status: 'RELEASED', resolvedAt: now },
          });
          if (origin.quantity == null) {
            await tx.sharePost.updateMany({
              where: { id: post.id, status: 'CLAIMED' },
              data: { status: 'OPEN' },
            });
          }
          return { ok: true, status: 'RELEASED' as const, gifted: 0 };
        }

        // confirm
        await tx.shareClaim.update({
          where: { id: claim.id },
          data: { status: 'CONFIRMED', resolvedAt: now },
        });
        const isOrigin = post.originPostId == null;
        if (origin.quantity != null) {
          if (isOrigin) {
            const qty = claim.quantity ?? 0;
            const moved = await tx.sharePost.updateMany({
              where: { id: origin.id, remaining: { gte: qty } },
              data: { remaining: { decrement: qty } },
            });
            if (moved.count === 0) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left.' });
            }
            const after = await tx.sharePost.findUnique({
              where: { id: origin.id },
              select: { remaining: true },
            });
            if ((after?.remaining ?? 0) <= 0) await fulfillTree(tx, origin.id);
          }
          // A counted copy stays OPEN (the broker claims upstream themselves).
        } else if (isOrigin) {
          await fulfillTree(tx, origin.id);
        } else {
          await fulfillSubtree(tx, post.id);
        }

        let gifted = 0;
        if (
          isOrigin &&
          post.type === 'SURPLUS' &&
          post.lots.length > 0 &&
          claim.householdId !== post.householdId
        ) {
          gifted = await giftFromLots(tx, post.lots, claim, input.clientKey ?? null);
        }
        return { ok: true, status: 'CONFIRMED' as const, gifted };
      });
    }),

  /**
   * Reshare a visible, feed-live post from a connection that grants you
   * `reshare`, minting an anonymized copy attributed to YOU with one fewer hop.
   * No lots are copied (you don't own them); the photo reference is copied.
   */
  reshare: protectedProcedure
    .input(z.object({ postId: z.string().min(1), clientKey: clientKeySchema }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx.user, 'postShares');
      const H = ctx.user.householdId;
      return dbTransaction(async (tx) => {
        if (input.clientKey) {
          const prior = await tx.sharePost.findUnique({ where: { clientKey: input.clientKey } });
          if (prior) return { id: prior.id };
        }
        const { post: source, mine, live } = await loadVisiblePost(tx, ctx.user, input.postId);
        if (mine) throw new TRPCError({ code: 'BAD_REQUEST', message: "You can't reshare your own post." });
        if (!live) throw new TRPCError({ code: 'CONFLICT', message: 'This post is no longer available.' });
        const conn = await getConnection(tx, source.householdId, H);
        if (!conn || conn.status !== 'ACTIVE' || !grantsFrom(conn, source.householdId).reshare) {
          throw new TRPCError({ code: 'FORBIDDEN', message: "They haven't allowed resharing this." });
        }
        if (source.hopsRemaining <= 0) {
          throw new TRPCError({ code: 'CONFLICT', message: "This post can't travel further." });
        }
        const already = await tx.sharePost.findFirst({
          where: { parentPostId: source.id, householdId: H },
        });
        if (already) {
          throw new TRPCError({ code: 'CONFLICT', message: "You've already reshared this." });
        }
        const copy = await tx.sharePost.create({
          data: {
            clientKey: input.clientKey ?? null,
            type: source.type,
            householdId: H,
            createdById: ctx.user.id,
            title: source.title,
            description: source.description,
            photoPath: source.photoPath,
            quantity: source.quantity,
            unit: source.unit,
            remaining: null, // resolved from the origin at read time (F4)
            expiresAt: source.expiresAt,
            status: 'OPEN',
            originPostId: source.originPostId ?? source.id,
            parentPostId: source.id,
            hopsRemaining: source.hopsRemaining - 1,
          },
        });
        return { id: copy.id };
      });
    }),
});
