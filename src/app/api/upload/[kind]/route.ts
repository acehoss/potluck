import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSessionUser } from '@/server/auth';
import { IMAGES_DIR, IMAGE_KINDS, sanitizeAttachmentName, type ImageKind } from '@/server/images';
import { checkRateLimit } from '@/server/rate-limit';

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
// Per-user uploads per 15-minute window. A heavy receiving session is a few
// receipt pages plus a few dozen unit photos; this bounds both memory abuse
// and how fast one stolen session can fill the images volume.
const UPLOADS_PER_WINDOW = 120;

/**
 * Multipart media upload (blueprint 04 §1). A route handler, not a Server
 * Action — Server Actions default to a 1MB body limit. The client always
 * re-encodes images to JPEG before uploading (src/lib/downscale.ts); the
 * server names files, so the client storage filename is ignored.
 */
export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response('unauthorized', { status: 401 });

  const { kind } = await params;
  const isAttachment = kind === 'attachments';
  if (!isAttachment && !IMAGE_KINDS.includes(kind as ImageKind)) {
    return new Response('bad kind', { status: 400 });
  }

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
  const maxBytes = isAttachment ? ATTACHMENT_MAX_BYTES : IMAGE_MAX_BYTES;
  if (declared > maxBytes + 64 * 1024) return new Response('too large', { status: 413 });

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return new Response('no file', { status: 400 });

  // Optional sha256 (hex) of the ORIGINAL selected file, hashed client-side
  // before the downscale re-encode (blueprint 04 §3). Validated here, echoed
  // back, and persisted onto RestockImage when the client attaches the photo
  // — it keys fixture-mode extraction deterministically.
  let originalSha256: string | null = null;
  if (!isAttachment) {
    const shaField = form.get('originalSha256');
    if (typeof shaField === 'string' && shaField !== '') {
      if (!/^[0-9a-f]{64}$/.test(shaField)) return new Response('bad sha256', { status: 400 });
      originalSha256 = shaField;
    }
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > maxBytes) return new Response('too large', { status: 413 });

  if (isAttachment) {
    if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
      return new Response('not pdf', { status: 415 });
    }
    const safeName = sanitizeAttachmentName(new URL(req.url).searchParams.get('name') ?? '');
    const name = `${randomBytes(16).toString('hex')}.pdf`;
    await fs.mkdir(path.join(IMAGES_DIR, 'attachments'), { recursive: true });
    await fs.writeFile(path.join(IMAGES_DIR, 'attachments', name), buf);
    return Response.json({ path: `attachments/${name}`, name: safeName });
  }

  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return new Response('not jpeg', { status: 415 });

  const name = `${randomBytes(16).toString('hex')}.jpg`;
  await fs.mkdir(path.join(IMAGES_DIR, kind), { recursive: true });
  await fs.writeFile(path.join(IMAGES_DIR, kind, name), buf);

  return Response.json({ path: `${kind}/${name}`, originalSha256 });
}
