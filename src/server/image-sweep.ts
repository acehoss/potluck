import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from './db';
import { IMAGES_DIR, IMAGE_KINDS } from './images';

/** Leave young files alone — they may be an upload whose attach is in flight. */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Startup GC for orphaned image files. Uploads land on disk before any row
 * references them; if the follow-up attach mutation never happens (tab
 * closed, draft deleted concurrently, network drop) the file would otherwise
 * sit on the volume forever. Runs at server boot (src/instrumentation.ts).
 */
export async function sweepOrphanImages(now = Date.now()) {
  const [images, lots, items] = await Promise.all([
    db.restockImage.findMany({ select: { path: true } }),
    db.lot.findMany({ where: { unitPhotoPath: { not: null } }, select: { unitPhotoPath: true } }),
    db.item.findMany({ where: { photoPath: { not: null } }, select: { photoPath: true } }),
  ]);
  const referenced = new Set<string>([
    ...images.map((i) => i.path),
    ...lots.map((l) => l.unitPhotoPath!),
    ...items.map((i) => i.photoPath!),
  ]);

  let removed = 0;
  for (const kind of IMAGE_KINDS) {
    const dir = path.join(IMAGES_DIR, kind);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (referenced.has(`${kind}/${name}`)) continue;
      const abs = path.join(dir, name);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || now - stat.mtimeMs < MIN_AGE_MS) continue;
      await fs.unlink(abs).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}
