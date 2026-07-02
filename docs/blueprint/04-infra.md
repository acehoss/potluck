# 04 — Infrastructure: images, barcode, VLM, PWA, container

Facts verified against `node_modules/next/dist/docs/` (Next 16.2.10), `npm view` (2026-07-02), and the claude-api skill (pricing/API shapes cached 2026-06). No guessed APIs.

## 1. Image pipeline

**Capture:** plain `<input type="file" accept="image/*" capture="environment">` — native camera UI on iOS
Safari and Android Chrome, zero permission ceremony. `getUserMedia` is reserved for barcode scanning
(slice 7); do not build a custom camera view for photos. Multi-page receipts: `multiple` attr.

**Downscale client-side, no sharp.** Canvas resize to ≤2048px long edge, JPEG q0.85, before upload. Keeps
the container free of native deps (sharp 0.35.3 is healthy — published 2026-07-01 — but adds platform
binaries for no gain); 2048px matches what the VLM can use (claude-api skill: high-res vision caps at 2576px
long edge), so retained receipts stay re-extractable per SPEC §4. iPhone HEIC re-encodes to JPEG for free.

```ts
// src/lib/downscale.ts — pure browser, no deps
export async function downscaleToJpeg(file: File, maxEdge = 2048): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.85));
}
```

**Upload:** multipart FormData POST to a route handler — *not* a Server Action (Server Actions default to a
1MB `bodySizeLimit`, verified in `05-config/01-next-config-js/serverActions.md`; route handlers need no body
config, verified in `03-file-conventions/route.md` §"Request Body FormData" and the "no bodyParser" note).

```ts
// src/app/api/upload/[kind]/route.ts   kind ∈ receipts | units | items
export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const user = await getSessionUser();                       // same helper as slice 1
  if (!user) return new Response('unauthorized', { status: 401 });
  const { kind } = await params;
  if (!['receipts', 'units', 'items'].includes(kind)) return new Response('bad kind', { status: 400 });
  const file = (await req.formData()).get('file');
  if (!(file instanceof File)) return new Response('no file', { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) return new Response('too large', { status: 413 });
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return new Response('not jpeg', { status: 415 }); // magic bytes
  const name = `${createId()}.jpg`;                          // server names files; client name is ignored
  await fs.mkdir(path.join(IMAGES_DIR, kind), { recursive: true });
  await fs.writeFile(path.join(IMAGES_DIR, kind, name), buf);
  return Response.json({ path: `${kind}/${name}` });         // stored in DB as the relative path
}
```

**Storage layout:** `IMAGES_DIR=/data/images` → `/data/images/{receipts,units,items}/<cuid>.jpg`.
Only JPEG exists on disk (client always re-encodes). DB columns store `receipts/abc123.jpg`.

**Serving:** authenticated route handler; immutable cache is safe because filenames are unique-per-content
(a new photo is a new cuid) — but `private` because responses are per-session.

```ts
// src/app/api/images/[...path]/route.ts
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!(await getSessionUser())) return new Response('unauthorized', { status: 401 });
  const rel = (await params).path.join('/');
  const abs = path.resolve(IMAGES_DIR, rel);
  if (!abs.startsWith(path.resolve(IMAGES_DIR) + path.sep)) return new Response('nope', { status: 400 });
  const buf = await fs.readFile(abs).catch(() => null);
  if (!buf) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(buf), { headers: {
    'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' } });
}
```

**Playwright:** commit tiny real JPEGs under `e2e/fixtures/` (`receipt-costco.jpg`, `unit-tomatoes.jpg`,
~50–100KB, real photos downscaled hard); upload via `page.setInputFiles('input[type=file]', 'e2e/fixtures/receipt-costco.jpg')`
— identical on chromium and webkit (`capture` is a hint, doesn't block programmatic set). Assert the
round-trip by fetching `/api/images/...` in-page and checking `response.ok`.

## 2. Barcode scanning (slice 7)

npm view (2026-07-02): `zxing-wasm` 3.1.0 (modified 2026-06, 3.8MB unpacked) · `barcode-detector` 3.2.0
(modified 2026-06, 262KB — W3C BarcodeDetector ponyfill *wrapping zxing-wasm*) · `@zxing/browser` 0.2.0
(stagnant API, larger) · `html5-qrcode` 2.3.8 (last publish **2023-04**, unmaintained — rejected).

**DECISION: `barcode-detector` ponyfill.** Standard W3C API (native BarcodeDetector never shipped on iOS
Safari, so WASM always runs there), maintained, swappable for native later by deleting the import.
Dynamically `import()` on the scan screen only, so the ~1MB WASM never loads elsewhere.

```ts
const { BarcodeDetector } = await import('barcode-detector/ponyfill');
const detector = new BarcodeDetector({ formats: ['upc_a', 'ean_13'] });
const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
// attach to <video playsinline muted>, then rAF loop: await detector.detect(video) → rawValue
```

**Fallback is not optional UI:** the product search field accepts typed UPC digits everywhere a scan button
appears; the button renders only if `navigator.mediaDevices?.getUserMedia` exists and hides on permission
denial. e2e covers the manual path only (camera streams aren't reliably fakeable on webkit); scanning is
verified by hand on real phones.

## 3. VLM extraction (slice 5)

**Model — DECISION: `claude-opus-4-8` default, env-overridable** (`EXTRACTION_MODEL`). Pricing $5/$25 per
MTok (claude-api skill, cached 2026-06). A 2-photo restock ≈ 6K input + 2K output ≈ **$0.08/receipt**; at a
few receipts/week that's under $1/month — Haiku would save pennies and cost accuracy on dense Costco receipts.

**Request shape — structured outputs, not forced tool use.** The current API's canonical mechanism is
`output_config.format` with a JSON schema (`client.messages.parse` + `zodOutputFormat`); assistant-prefill and
ad-hoc "reply in JSON" are dead ends on Opus 4.8. Images go in as base64 content blocks before the text.

```ts
// src/server/extraction.ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';  // supports zod v4 in current SDK
import { z } from 'zod';

const ExtractedLine = z.object({
  description: z.string(),          // as printed on the receipt
  unitCount: z.number().int(),      // eaches in the pack; 1 if unknown
  unitPriceCents: z.number().int().nullable(),
  lineTotalCents: z.number().int(), // integer cents per SPEC §6
});
const Extraction = z.object({
  retailer: z.string().nullable(),
  purchasedAt: z.string().nullable(),          // YYYY-MM-DD if legible
  lines: z.array(ExtractedLine), receiptTotalCents: z.number().int().nullable(),
});
export type ExtractionResult =
  | { status: 'ok'; data: z.infer<typeof Extraction> }
  | { status: 'unavailable'; reason: string };  // advisory per SPEC — never throws to the UI

export interface ExtractionService { extract(jpegs: Buffer[]): Promise<ExtractionResult>; }

async function liveExtract(jpegs: Buffer[]): Promise<ExtractionResult> {
  const client = new Anthropic({ maxRetries: 2, timeout: 90_000 }); // reads ANTHROPIC_API_KEY
  try {
    const res = await client.messages.parse({
      model: process.env.EXTRACTION_MODEL ?? 'claude-opus-4-8',
      max_tokens: 8192,
      output_config: { format: zodOutputFormat(Extraction) },
      messages: [{ role: 'user', content: [
        ...jpegs.map(b => ({ type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: b.toString('base64') } })),
        { type: 'text', text: 'Extract every line item from this retail receipt (pages in order). Bulk multipacks: unitCount = eaches. All money as integer US cents. Skip subtotal/tax/payment lines; put the grand total in receiptTotalCents.' },
      ]}],
    });
    if (res.stop_reason === 'refusal' || !res.parsed_output)
      return { status: 'unavailable', reason: 'model declined or unparseable' };
    return { status: 'ok', data: res.parsed_output };
  } catch (e) { return { status: 'unavailable', reason: String(e) }; }  // SDK already retried 429/5xx twice
}
```

**Mode switch:** `EXTRACTION_MODE=fixture|live|off` (default `off` until slice 5 ships).

- `off` → service returns `unavailable` immediately; receiving screen is pure manual (slice 2 behavior).
- `fixture` → deterministic: the client sha256s the **original selected file** (pre-downscale, via
  `crypto.subtle.digest` on the File bytes) and sends it as an `originalSha256` form field with the upload;
  lookup keys on that against `e2e/fixtures/extractions/<sha>.json` (committed beside its fixture JPEG).
  Hashing the *uploaded* bytes would never match — the §1 canvas re-encode makes them browser/version
  dependent. Unknown or absent sha → `unavailable`. Persist it as a nullable `originalSha256` column on
  RestockImage (slice-5 migration; live/off ignore it) so drafts survive refresh. Slice-5 e2e runs the compose stack with `EXTRACTION_MODE=fixture` — real HTTP, real
  screen prefill, zero network/API key.
- `live` → `liveExtract` above.

**Degradation (SPEC §5):** on `unavailable` the review screen renders identically with zero prefilled lines
plus a dismissible "extraction unavailable — enter lines manually" notice. Extraction is fire-once per
receipt set with a "re-run" button; no queue, no background jobs.

## 4. PWA (slice 7)

Source: `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md` (read in full).

**Manifest:** `src/app/manifest.ts` returning `MetadataRoute.Manifest`: `name: "Private Coop"`,
`short_name: "Coop"`, `start_url: "/"`, `display: "standalone"`, `background_color`/`theme_color`, icons
192/512 PNG (+ a 512 `purpose: "maskable"` variant). **Icons:** drawn once as `assets/icon.svg`, rasterized
locally (`magick icon.svg -resize 192x192 public/icon-192.png`, etc.) and **committed** — no build tooling.

**Service worker:** `public/sw.js`, registered with `{ scope: '/', updateViaCache: 'none' }` (guide §2).
Push + notificationclick handlers **only** — no fetch handler, no offline cache (offline is out of scope,
SPEC §3; install prompts don't require offline support, guide §2). Add the guide's `/sw.js` no-cache +
`X-Content-Type-Options` headers in `next.config.ts`.

**Web push:** `web-push` 3.6.7 (npm view: last publish 2024-01 — mature/stable, the de-facto standard).
Keys: `npx web-push generate-vapid-keys` at deploy time. **DECISION: no `NEXT_PUBLIC_` env for the public
key** — Next inlines `NEXT_PUBLIC_*` at *build* time, forcing an image rebuild to rotate keys; instead a
`push.publicKey` tRPC query returns `VAPID_PUBLIC_KEY` at runtime. Subscribe/unsubscribe are tRPC mutations
(not the guide's Server Actions), matching slice-1 convention.

```prisma
model PushSubscription {
  id        String   @id @default(cuid())
  userId    String
  endpoint  String   @unique
  p256dh    String
  auth      String
  createdAt DateTime @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Sender: `webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)`; on send error 404/410
delete the row (expired). **Who gets notified (minimal, per SPEC):** settlement recorded → all users of both
involved households; manual ledger adjustment → all users of the affected household. Nothing else in v1.
iOS caveats (surface in UI copy): push needs the *installed* PWA (iOS 16.4+), the permission prompt must
follow a user tap, and deleting the icon silently drops the subscription — hence pruning on 404/410.

## 5. Container / compose changes

- **Dockerfile:** unchanged (no native deps — sharp rejected, zxing is client-side WASM).
- **docker-entrypoint.sh:** add `mkdir -p /data/images/{receipts,units,items}` (expanded, sh has no braces).
- **docker-compose.yml:** images live on the existing `coop-data` volume at `/data/images` — no new volume,
  healthcheck unchanged. Pass through the env vars below.
- **Backups** (SPEC §6): one `tar` of `/data` covers DB + images together; document at slice 4.

`.env.example` additions:

```bash
IMAGES_DIR=/data/images          # host-relative ./data/images outside Docker
EXTRACTION_MODE=off              # off | fixture | live
EXTRACTION_MODEL=claude-opus-4-8
ANTHROPIC_API_KEY=               # required only when EXTRACTION_MODE=live
VAPID_PUBLIC_KEY=                # npx web-push generate-vapid-keys (slice 7)
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@example.com
```
