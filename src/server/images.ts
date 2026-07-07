import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Root of the image volume; blueprint 04 §1. */
export const IMAGES_DIR = process.env.IMAGES_DIR ?? './data/images';

export const IMAGE_KINDS = [
  'receipts',
  'units',
  'items',
  'products',
  'shares',
  'recipes',
  'avatars',
] as const;
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

/** True when `rel` is a server-generated stored PDF attachment path. */
export function isStoredAttachmentPath(rel: string) {
  return /^attachments\/[0-9a-f]{32}\.pdf$/.test(rel) && resolveImagePath(rel) !== null;
}

/** Normalize a client-supplied attachment display name to a safe PDF basename. */
export function sanitizeAttachmentName(name: string): string {
  const basename = name.split(/[\\/]+/).filter(Boolean).pop() ?? '';
  const cleaned = basename
    .replace(/[\p{C}"'`]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'document.pdf';

  const hasPdfSuffix = /\.pdf$/i.test(cleaned);
  let stem = hasPdfSuffix ? cleaned.slice(0, -4).trim() : cleaned;
  if (!stem || /^\.+$/.test(stem)) return 'document.pdf';

  if (stem.length > 116) stem = stem.slice(0, 116).trim();
  if (!stem) return 'document.pdf';
  return `${stem}.pdf`;
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

/** Read a stored image file, or null when missing/out-of-root (extraction). */
export async function readImageFile(rel: string): Promise<Buffer | null> {
  const abs = resolveImagePath(rel);
  if (!abs) return null;
  return fs.readFile(abs).catch(() => null);
}

/**
 * Write server-owned bytes as a new stored file of `kind`, mirroring the upload
 * route's naming (16 random bytes in hex + ".jpg") so the result satisfies
 * `isStoredImagePath`. The caller is responsible for having validated the bytes
 * (JPEG magic) — this just names and persists them. Returns the DB-shaped
 * relative path ("recipes/<hex>.jpg").
 */
export async function writeImageFile(kind: ImageKind, buf: Buffer): Promise<string> {
  const name = `${randomBytes(16).toString('hex')}.jpg`;
  await fs.mkdir(path.join(IMAGES_DIR, kind), { recursive: true });
  await fs.writeFile(path.join(IMAGES_DIR, kind, name), buf);
  return `${kind}/${name}`;
}

/** Best-effort delete of a stored image file (draft abandon / photo removal). */
export async function deleteImageFile(rel: string) {
  const abs = resolveImagePath(rel);
  if (!abs) return;
  await fs.unlink(abs).catch(() => {});
}
