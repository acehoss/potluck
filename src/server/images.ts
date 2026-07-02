import fs from 'node:fs/promises';
import path from 'node:path';

/** Root of the image volume; blueprint 04 §1. */
export const IMAGES_DIR = process.env.IMAGES_DIR ?? './data/images';

export const IMAGE_KINDS = ['receipts', 'units', 'items'] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

/** Resolve a DB-stored relative path ("receipts/abc.jpg") safely, or null. */
export function resolveImagePath(rel: string) {
  const abs = path.resolve(IMAGES_DIR, rel);
  if (!abs.startsWith(path.resolve(IMAGES_DIR) + path.sep)) return null;
  return abs;
}

/**
 * True when `rel` has the exact shape of a server-generated stored file of
 * `kind` (the upload route names files as 16 random bytes in hex). Attach
 * mutations must never accept any other client-supplied string as a path.
 */
export function isStoredImagePath(kind: ImageKind, rel: string) {
  return new RegExp(`^${kind}/[0-9a-f]{32}\\.jpg$`).test(rel);
}

/** Whether the stored file actually exists on the image volume. */
export async function imageFileExists(rel: string) {
  const abs = resolveImagePath(rel);
  if (!abs) return false;
  return fs.access(abs).then(
    () => true,
    () => false,
  );
}

/** Best-effort delete of a stored image file (draft abandon / photo removal). */
export async function deleteImageFile(rel: string) {
  const abs = resolveImagePath(rel);
  if (!abs) return;
  await fs.unlink(abs).catch(() => {});
}
