import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { dbTransaction } from '../db';
import { deleteImageFile, imageFileExists, isStoredImagePath } from '../images';
import { protectedProcedure, router } from '../trpc';

/**
 * Own-profile contact card (REWORK P5, Round C). A user edits ONLY their own
 * profile — no capability gate, no household context: the card is the person's,
 * not a household's. photoPath is an "avatars"-kind upload, managed exactly like
 * item.update's photo (fresh-upload contract + post-commit unlink of the
 * replaced file). What a connected household actually SEES of this card is
 * governed elsewhere by Membership.visibility + circles.
 */

/**
 * An avatar may only reference a freshly uploaded "avatars" file: server-named,
 * present on disk, referenced by no other user. Same contract as item photos —
 * never trust a client string that later drives a file unlink.
 */
async function assertFreshAvatar(tx: Prisma.TransactionClient, path: string) {
  if (!isStoredImagePath('avatars', path)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an uploaded image path.' });
  }
  if (!(await imageFileExists(path))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Image not found — upload it first.' });
  }
  if (await tx.user.findFirst({ where: { photoPath: path } })) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That image is already attached.' });
  }
}

/** Avatars are referenced only by User.photoPath; unlink when orphaned. */
async function unlinkAvatarIfUnreferenced(tx: Prisma.TransactionClient, path: string) {
  if (!(await tx.user.findFirst({ where: { photoPath: path } }))) await deleteImageFile(path);
}

export const profileRouter = router({
  /** Own profile card. Email is shown (recovery/identity), never editable here. */
  get: protectedProcedure.query(({ ctx }) => {
    const { name, username, email, phone, bio, photoPath } = ctx.user;
    return { name, username, email, phone, bio, photoPath };
  }),

  /**
   * Edit own profile. phone/bio: undefined = keep, null/'' = clear. photoPath:
   * undefined = keep, null = remove, string = replace with a fresh upload
   * (old file unlinked after commit, mirroring item.update).
   */
  update: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        phone: z.string().trim().max(30).nullish(),
        bio: z.string().trim().max(500).nullish(),
        photoPath: z.string().min(1).max(300).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const oldPhoto = await dbTransaction(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
        if (typeof input.photoPath === 'string') await assertFreshAvatar(tx, input.photoPath);
        await tx.user.update({
          where: { id: user.id },
          data: {
            name: input.name,
            phone: input.phone === undefined ? undefined : input.phone || null,
            bio: input.bio === undefined ? undefined : input.bio || null,
            photoPath: input.photoPath === undefined ? undefined : input.photoPath,
          },
        });
        // Report the replaced/removed photo for cleanup after commit.
        return input.photoPath !== undefined && user.photoPath !== input.photoPath
          ? user.photoPath
          : null;
      });
      // DB first, then drop the replaced file if truly unreferenced — a crash
      // between the two leaves an orphan file, never a dangling row.
      if (oldPhoto) await dbTransaction((tx) => unlinkAvatarIfUnreferenced(tx, oldPhoto));
      return { ok: true };
    }),
});
