/**
 * Dev/e2e-only: clear a user's consumed-TOTP-step marker (`totpLastStep`).
 * Enabled ONLY on demo/e2e stacks (SEED_DEMO=1 — same gate as push-sink /
 * mail-test; 404 otherwise).
 *
 * WHY: a TOTP code is single-use within its 30-second step (the login
 * anti-replay guard in `verifyLoginMfa` rejects a step <= the last consumed
 * one). The e2e suite logs in as the enrolled fixture account (`aaron`) hundreds
 * of times, far more than there are distinct 30s windows, so the shared
 * `login()`/`apiLogin()` helpers call this before completing a SETUP challenge
 * to clear the marker — their computed fixture code is then never a same-window
 * replay. This never weakens production (the route 404s off a demo stack) and
 * the dedicated replay-rejection test drives raw tRPC on an EPHEMERAL account,
 * so the guard stays fully exercised.
 *
 * POST { identifier } (username or email) → { ok, cleared }.
 */

import { db } from '@/server/db';

const enabled = () => process.env.SEED_DEMO === '1';

export async function POST(req: Request) {
  if (!enabled()) return new Response('not found', { status: 404 });

  let body: { identifier?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const id = body.identifier?.trim().toLowerCase();
  if (!id) return Response.json({ ok: false, error: 'identifier required' }, { status: 400 });

  const res = await db.user.updateMany({
    where: id.includes('@') ? { email: id } : { username: id },
    data: { totpLastStep: null },
  });
  return Response.json({ ok: true, cleared: res.count });
}
