/**
 * Dev/e2e mail trigger, enabled ONLY on demo/e2e stacks (SEED_DEMO=1 — the
 * same gate as push-sink; 404 otherwise). It stands in for the real app call
 * sites (verify/reset/digest) that Round B/C will add, letting the e2e suite
 * exercise the pipelines and read back the CapturedEmail row today.
 *
 * POST { to, kind?, pipeline?, userId?, category? }:
 *   - pipeline 'transactional' (default) → sendTransactional (default kind 'test').
 *   - pipeline 'subscription' → sendSubscription (needs userId; category default 'digest').
 * Returns { ok, capturedId }. In MAIL_MODE=live this performs a REAL send —
 * that is exactly how the opt-in IMAP suite drives DreamHost.
 */

import {
  sendSubscription,
  sendTransactional,
  type SubscriptionCategory,
  type SubscriptionKind,
  type TransactionalKind,
} from '@/server/mail';

const enabled = () => process.env.SEED_DEMO === '1';

export async function POST(req: Request) {
  if (!enabled()) return new Response('not found', { status: 404 });

  let body: {
    to?: string;
    kind?: string;
    pipeline?: string;
    userId?: string;
    category?: string;
    subject?: string;
    text?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const to = body.to?.trim();
  if (!to) return Response.json({ ok: false, error: 'to required' }, { status: 400 });

  const subject = body.subject ?? 'Potluck mail test';
  const text = body.text ?? 'This is a Potluck dev mail-test message.';

  if (body.pipeline === 'subscription') {
    const userId = body.userId?.trim();
    if (!userId) {
      return Response.json({ ok: false, error: 'userId required for subscription' }, { status: 400 });
    }
    const res = await sendSubscription({
      to,
      userId,
      category: (body.category as SubscriptionCategory) ?? 'digest',
      kind: (body.kind as SubscriptionKind) ?? 'digest',
      subject,
      text,
    });
    return Response.json({ ok: true, capturedId: res.capturedId, skipped: res.skipped ?? null });
  }

  const res = await sendTransactional({
    to,
    kind: (body.kind as TransactionalKind) ?? 'test',
    subject,
    text,
  });
  return Response.json({ ok: true, capturedId: res.capturedId });
}
