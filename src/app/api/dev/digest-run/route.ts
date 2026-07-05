/**
 * Dev/e2e-only digest trigger, enabled ONLY on demo/e2e stacks (SEED_DEMO=1 —
 * same gate as push-sink / mail-test; 404 otherwise). Runs `digestFor` for a
 * single user, BYPASSING the weekly TZ send window (which `runDigest` enforces),
 * so the suite can assemble + send a digest on demand and read the CapturedEmail
 * `digest` row back.
 *
 * POST { identifier, force? } (identifier = username or email):
 *   - force omitted/false → honors the per-user lastDigestAt idempotency guard
 *     (a second call the same week returns { sent:false, reason:'already-sent' }).
 *   - force true → also bypasses that guard, so repeated triggers each send.
 * Returns { ok, sent, capturedId, reason? }.
 *
 * Production scheduling is an EXTERNAL cron hitting an authenticated trigger for
 * `runDigest` (self-hosted compose model) — see the README deploy note; there is
 * no in-process scheduler this round.
 */

import { digestFor } from '@/server/digest';
import { db } from '@/server/db';

const enabled = () => process.env.SEED_DEMO === '1';

export async function POST(req: Request) {
  if (!enabled()) return new Response('not found', { status: 404 });

  let body: { identifier?: string; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const id = body.identifier?.trim().toLowerCase();
  if (!id) return Response.json({ ok: false, error: 'identifier required' }, { status: 400 });

  const user = await db.user.findFirst({
    where: id.includes('@') ? { email: id } : { username: id },
    select: { id: true },
  });
  if (!user) return Response.json({ ok: false, error: 'no such user' }, { status: 404 });

  const res = await digestFor(user.id, { force: body.force === true });
  return Response.json({
    ok: true,
    sent: res.sent,
    capturedId: res.capturedId,
    reason: res.reason ?? null,
  });
}
