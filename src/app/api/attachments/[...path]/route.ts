import fs from 'node:fs/promises';
import { getSessionUser } from '@/server/auth';
import { isStoredAttachmentPath, resolveImagePath, sanitizeAttachmentName } from '@/server/images';

/**
 * Authenticated PDF attachment serving. Filenames are unique per content, so
 * immutable cache is fine, but it stays private because access is session-gated.
 */
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!(await getSessionUser())) return new Response('unauthorized', { status: 401 });

  const rel = (await params).path.join('/');
  if (!isStoredAttachmentPath(rel)) return new Response('nope', { status: 400 });
  const abs = resolveImagePath(rel);
  if (!abs) return new Response('nope', { status: 400 });

  const buf = await fs.readFile(abs).catch(() => null);
  if (!buf) return new Response('not found', { status: 404 });

  const filename = sanitizeAttachmentName(new URL(req.url).searchParams.get('name') ?? '');
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename.replace(/"/g, '\\"')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
