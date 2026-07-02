import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSessionUser } from '@/server/auth';
import { IMAGES_DIR, IMAGE_KINDS, type ImageKind } from '@/server/images';
import { checkRateLimit } from '@/server/rate-limit';

const MAX_BYTES = 8 * 1024 * 1024;
// Per-user uploads per 15-minute window. A heavy receiving session is a few
// receipt pages plus a few dozen unit photos; this bounds both memory abuse
// and how fast one stolen session can fill the images volume.
const UPLOADS_PER_WINDOW = 120;

/**
 * Multipart image upload (blueprint 04 §1). A route handler, not a Server
 * Action — Server Actions default to a 1MB body limit. The client always
 * re-encodes to JPEG before uploading (src/lib/downscale.ts); the server
 * names files, so the client filename is ignored.
 */
export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response('unauthorized', { status: 401 });

  const { kind } = await params;
  if (!IMAGE_KINDS.includes(kind as ImageKind)) return new Response('bad kind', { status: 400 });

  if (!checkRateLimit(`upload:${user.id}`, UPLOADS_PER_WINDOW)) {
    return new Response('too many uploads', { status: 429 });
  }

  // Reject oversized bodies BEFORE buffering them — formData() would happily
  // materialize a multi-hundred-MB body in memory first. fetch/FormData
  // clients always send Content-Length; chunked bodies are refused.
  const declared = Number(req.headers.get('content-length'));
  if (!Number.isFinite(declared) || declared <= 0) {
    return new Response('length required', { status: 411 });
  }
  if (declared > MAX_BYTES + 64 * 1024) return new Response('too large', { status: 413 });

  const file = (await req.formData()).get('file');
  if (!(file instanceof File)) return new Response('no file', { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_BYTES) return new Response('too large', { status: 413 });
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return new Response('not jpeg', { status: 415 });

  const name = `${randomBytes(16).toString('hex')}.jpg`;
  await fs.mkdir(path.join(IMAGES_DIR, kind), { recursive: true });
  await fs.writeFile(path.join(IMAGES_DIR, kind, name), buf);

  return Response.json({ path: `${kind}/${name}` });
}
