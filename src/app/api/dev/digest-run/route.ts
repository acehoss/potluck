/**
 * Dev/e2e-only digest trigger, enabled ONLY on demo/e2e stacks (SEED_DEMO=1 —
 * same gate as push-sink / mail-test; 404 otherwise).
 *
 * Two shapes:
 *   POST { identifier, force?, now? } (identifier = username or email):
 *     Runs `digestFor` for a single user, BYPASSING the cadence send window
 *     (the cadence/hour/weekday gate `runDigest` enforces), so the suite can
 *     assemble + send a digest on demand and read the CapturedEmail `digest`
 *     row back. `force` also bypasses the per-user lastDigestAt idempotency
 *     guard; a cadence of 'off' is still honored. `now` (ISO) drives the
 *     assembled period ("today" vs "this week") + the idempotency window.
 *     Returns { ok, sent, capturedId, reason? }.
 *
 *   POST { batch: true, now? } (ISO `now`):
 *     Runs the FULL `runDigest(new Date(now))` sweep — respecting each user's
 *     cadence, local send hour/weekday, and window idempotency — so the suite
 *     can prove "daily only at their hour", "weekly only on their weekday",
 *     "off never", and same-window idempotency at an injected wall-clock.
 *     Returns { ok, sent, considered }.
 *
 * Production scheduling is the in-process scheduler (src/instrumentation.ts,
 * DIGEST_SCHEDULER) or the run-digest CLI as a cron fallback — see the README.
 */

import { digestFor, runDigest } from '@/server/digest';
import { db } from '@/server/db';

const enabled = () => process.env.SEED_DEMO === '1';

/** Parse an optional ISO `now`; a malformed value is a 400 (never silently now). */
function parseNow(raw: unknown): Date | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return 'invalid';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

export async function POST(req: Request) {
  if (!enabled()) return new Response('not found', { status: 404 });

  let body: { identifier?: string; force?: boolean; now?: string; batch?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const now = parseNow(body.now);
  if (now === 'invalid') {
    return Response.json({ ok: false, error: 'invalid now (expected ISO string)' }, { status: 400 });
  }

  if (body.batch === true) {
    const res = await runDigest(now ?? new Date());
    return Response.json({ ok: true, sent: res.sent, considered: res.considered });
  }

  const id = body.identifier?.trim().toLowerCase();
  if (!id) return Response.json({ ok: false, error: 'identifier required' }, { status: 400 });

  const user = await db.user.findFirst({
    where: id.includes('@') ? { email: id } : { username: id },
    select: { id: true },
  });
  if (!user) return Response.json({ ok: false, error: 'no such user' }, { status: 404 });

  const res = await digestFor(user.id, { force: body.force === true, now: now ?? undefined });
  return Response.json({
    ok: true,
    sent: res.sent,
    capturedId: res.capturedId,
    reason: res.reason ?? null,
  });
}
