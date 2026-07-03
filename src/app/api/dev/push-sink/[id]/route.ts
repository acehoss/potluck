/**
 * e2e-only push-service stand-in, enabled ONLY on demo/e2e stacks
 * (SEED_DEMO=1 — the same gate as the seeded fixtures; 404 otherwise).
 *
 * Real push round-trips need a browser connected to FCM/APNs, which headless
 * test browsers can't do reliably. Instead the e2e suite subscribes with an
 * endpoint pointing HERE; the real web-push sender then encrypts and POSTs
 * the notification to this route exactly as it would to a push service, and
 * the test reads back what arrived via GET. `?status=410` makes the sink
 * answer like an expired subscription so pruning is testable.
 *
 * State is in-memory (single next-start process; mirrors the rate limiter).
 */

/**
 * Besides the body size, the sink records the headers a real push service
 * would reject the request without: the VAPID `Authorization` and the
 * `Content-Encoding` of the encrypted payload. e2e asserts on them so a
 * regression in the sender's header mapping (or an accidentally-plaintext
 * body) can't stay green just because bytes arrived.
 */
type SinkHit = {
  at: number;
  bodyBytes: number;
  ttl: string | null;
  authorization: string | null;
  contentEncoding: string | null;
};

const globalStore = globalThis as unknown as { __coopPushSink?: Map<string, SinkHit[]> };
const sink = (globalStore.__coopPushSink ??= new Map<string, SinkHit[]>());

const enabled = () => process.env.SEED_DEMO === '1';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!enabled()) return new Response('not found', { status: 404 });
  const { id } = await params;
  const url = new URL(req.url);
  const status = Number(url.searchParams.get('status') ?? '201');
  const body = await req.arrayBuffer();
  const hits = sink.get(id) ?? [];
  hits.push({
    at: Date.now(),
    bodyBytes: body.byteLength,
    ttl: req.headers.get('ttl'),
    authorization: req.headers.get('authorization'),
    contentEncoding: req.headers.get('content-encoding'),
  });
  sink.set(id, hits);
  return new Response(null, { status: Number.isFinite(status) ? status : 201 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!enabled()) return new Response('not found', { status: 404 });
  const { id } = await params;
  return Response.json({ hits: sink.get(id) ?? [] });
}
