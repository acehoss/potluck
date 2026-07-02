import fs from 'node:fs/promises';
import { getSessionUser } from '@/server/auth';
import { resolveImagePath } from '@/server/images';

/**
 * Authenticated image serving (blueprint 04 §1). Immutable cache is safe —
 * filenames are unique per content — but `private` because auth is per-session.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!(await getSessionUser())) return new Response('unauthorized', { status: 401 });

  const abs = resolveImagePath((await params).path.join('/'));
  if (!abs) return new Response('nope', { status: 400 });

  const buf = await fs.readFile(abs).catch(() => null);
  if (!buf) return new Response('not found', { status: 404 });

  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
