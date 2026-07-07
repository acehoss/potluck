# 04 — Infrastructure: images, barcode, VLM, PWA, container, mail, auth, notifications

Facts verified against `node_modules/next/dist/docs/` (Next 16.2.10), `npm view` (2026-07-02), and the claude-api skill (pricing/API shapes cached 2026-06). No guessed APIs.

> **Potluck rebrand (Round 1, 2026-07-04).** User-facing and app-namespaced identifiers moved
> to **Potluck**: PWA manifest `name`/`short_name` = "Potluck" (§4); session cookie
> **`potluck_session`** and acting-household cookie **`potluck_household`** (`src/server/auth.ts`);
> the install/scan seams are `window.__potluckInstallPrompt` / `window.__potluckScanEmit`, the
> re-announce event `potluck:installprompt`, and localStorage key
> `potluck-install-card-dismissed` (§4). **Deliberate non-renames** — renaming would orphan an
> existing deployment's data — the SQLite file stays **`/data/coop.db`** and the Docker volume
> stays **`coop-data`** (§5); the repo-directory rename is optional/later.

> **Phase 3 (2026-07-05) + the digest-cadence round (2026-07-06).** This doc grew
> §§6–9 — the mail substrate (§6), auth flows + MFA crypto (§7), notifications /
> digest / the in-process scheduler (§8), and deep links + one-click unsubscribe
> (§9) — and §4–§5 were brought current (the notify matrix supersedes the old
> two-event push rule; `COOP_DATA`/`APP_BIND`/`APP_PORT` compose overrides;
> entrypoint boot guards; migrations through `20260706120000_plan_shopping_tracking`).
> Decision rationale lives in docs/REWORK.md § "Phase 3" (N1–N11).

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
  const name = `${randomBytes(16).toString('hex')}.jpg`;     // server names files (16 random bytes); client name ignored
  await fs.mkdir(path.join(IMAGES_DIR, kind), { recursive: true });
  await fs.writeFile(path.join(IMAGES_DIR, kind, name), buf);
  return Response.json({ path: `${kind}/${name}` });         // stored in DB as the relative path
}
```

**Storage layout:** `IMAGES_DIR=/data/images` → `/data/images/{receipts,units,items}/<cuid>.jpg`.
Only JPEG exists on disk (client always re-encodes). DB columns store `receipts/abc123.jpg`.

**Serving:** authenticated route handler; immutable cache is safe because filenames are unique-per-content
(a new photo is a fresh 16-random-byte name) — but `private` because responses are per-session.

**Round-1 scoping decision (2026-07-04).** `/api/images` stays **session-only**: any
authenticated member may fetch any image *path*. Connection-scoping it (so a household's
receipt/unit photos are reachable only by households its grants reach) is a **recorded
follow-up**, not shipped in Round 1 — mitigated meanwhile by the **unguessable 16-random-byte
filenames** (a path can't be enumerated or guessed; it only leaks if someone with a real
reference reshares the URL).

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

// As shipped (amended 2026-07-03 polish round): description is the CLEAN product
// name (SKU/tax-flag stripped — it becomes the product name); receiptText is the
// raw line as printed; taxable drives the tax split; taxCents is the printed tax.
const ExtractedLine = z.object({
  description: z.string(),          // clean product name (no SKU/item number or tax flag)
  receiptText: z.string().nullable(), // the whole line exactly as printed
  unitCount: z.number().int(),      // eaches in the pack; 1 if unknown
  lineTotalCents: z.number().int(), // integer cents per SPEC §6 (discounts netted in)
  taxable: z.boolean().nullable(),  // receipt marks this line taxed (T/E/A flag)
  confidence: z.number().nullable(),
});
const Extraction = z.object({
  retailer: z.string().nullable(),
  purchasedAt: z.string().nullable(),          // YYYY-MM-DD if legible
  lines: z.array(ExtractedLine),
  receiptTotalCents: z.number().int().nullable(),
  taxCents: z.number().int().nullable(),       // printed sales tax; split across taxable lines at finalize
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
receipt set with a "re-run" button; no queue, no background jobs **for extraction** (the app's one
background job is the in-process digest scheduler, §8 — extraction never rides it).

## 4. PWA (slice 7)

Source: `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md` (read in full).

**Manifest:** `src/app/manifest.ts` returning `MetadataRoute.Manifest`: `name: "Potluck"`,
`short_name: "Potluck"` (renamed 2026-07-04), `start_url: "/"`, `display: "standalone"`, `background_color`/`theme_color`, icons
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

Sender: `webpush.generateRequestDetails` (real VAPID signing + aes128gcm payload encryption) delivered via
`fetch` — not `webpush.sendNotification`, which hardcodes node's `https` module and refuses the e2e suite's
plain-http push sink; real push services are always https, so production behavior is identical. On send
error 404/410 delete the row (expired). **Who gets notified (superseded 2026-07-05):** the original
"exactly two events" rule (settlement recorded + manual adjustment) grew into the Phase-3 per-user
**NotificationPreference matrix**, fanned out by the generalized `notify()` layer — see §8 for the events,
categories, defaults, and the category-only content rule. Still true from Round 1: **recipients resolve via
`Membership` rows with per-user dedupe** (a person who is a member of two recipient households gets **one**
push, not two) and the **acting user is excluded per-user** (you don't get pinged for your own action).
iOS caveats (surface in UI copy): push needs the *installed* PWA (iOS 16.4+), the permission prompt must
follow a user tap, and deleting the icon silently drops the subscription — hence pruning on 404/410.

## 5. Container / compose changes

- **Dockerfile:** unchanged (still no build-time native toolchain — sharp rejected, zxing is client-side
  WASM; Phase 3's additions are pure JS (`nodemailer`, `web-push`) or ship prebuilt binaries
  (`@node-rs/argon2`)).
- **docker-entrypoint.sh:** runs, in order: `prisma migrate deploy` → `mkdir -p` for the **six** image
  kinds (`receipts units items shares recipes avatars` — expanded, sh has no braces) → the MFA key
  inject/guard (deliberately **before** the seed so fixture TOTP enrollment can encrypt its secrets) →
  the demo seed (`SEED_DEMO=1`) → the VAPID inject/guard → the mail-mode guards → the unsub-secret
  inject/guard → `exec npm run start`.
- **Boot guards** (all in the entrypoint, all fail-closed — the shared pattern: demo stacks get committed,
  publicly-known dev values injected so `SEED_DEMO=1` boots with zero setup; non-demo stacks **refuse to
  start** rather than run on a published secret):
  - **`MFA_ENC_KEY`** — demo with no key → the committed dev key. Non-demo: FATAL if it's *carrying* the
    dev key (anyone could decrypt stored TOTP secrets) **or** if unset — unlike VAPID there is no
    "MFA disabled" mode (the admin-required-TOTP policy means MFA must work), so a real key
    (`openssl rand -base64 32`) is **mandatory in production**.
  - **VAPID** — demo with neither key set → the committed dev pair. Non-demo: FATAL if *either* dev key is
    configured (the private key is public — anyone could forge pushes). Unset simply disables push.
  - **`MAIL_MODE`** — FATAL on `SEED_DEMO=1` + `MAIL_MODE=live` + `MAIL_PRODUCTION=1` (a seeded stack
    sending unfiltered mail to real recipients — exactly the combination N9 forbids). WARN (loud,
    non-fatal) on non-demo + `capture`: outgoing mail is recorded to CapturedEmail but never sent, so the
    operator knows silence is configured, not broken.
  - **`MAIL_UNSUB_SECRET`** — demo with no secret → the committed dev fallback. `MAIL_PRODUCTION=1`: FATAL
    without a real secret (the dev value is public — anyone could forge a one-click unsubscribe token for
    any user; the same secret also roots the deep-link key, §9).
- **docker-compose.yml:** images still live at `/data/images` on the data volume — but the mount is now
  **`${COOP_DATA:-coop-data}:/data`**: the named volume by default (safe for macOS dev/e2e — no bind-mount
  SQLite WAL flakiness), `COOP_DATA=./data` on a Linux production host for a host-visible bind mount
  (easier backups/inspection). Host publishing is overridable the same way:
  **`"${APP_BIND:-0.0.0.0}:${APP_PORT:-3000}:3000"`** — `APP_BIND` pins the published port to one
  interface (e.g. a Tailscale IP, so :3000 never reaches the LAN/public), `APP_PORT` moves the host port;
  the container always listens on 3000. `restart: unless-stopped` (the healthcheck only *marks* unhealthy;
  restart policy is what acts on a crash). Healthcheck unchanged; volume/DB names kept deliberately — see
  the rebrand preamble. All Phase-3 env vars pass through with safe defaults (block below).
- **Bootstrap (Round 1, 2026-07-04):** `scripts/bootstrap.ts` (the first-account path, run once on an empty
  DB — everyone else joins by invite) now creates the **InstanceSettings** singleton, the first household
  **+ its slug**, the first user **+ username + argon2id hash + `isInstanceAdmin`**, and the user's **Owner-preset
  Membership** — the user + membership in **one transaction** so a half-created membership-less admin can't
  exist. `docker-entrypoint.sh` runs `prisma migrate deploy` first.
- **Migrations:** all hand-timestamped, all additive. After the Round-1 pair —
  **`20260703100000_network_core`** (Membership, Connection, username/slug, `Product.householdId`,
  instance settings + admin flag, attribution snapshots — a data-preserving rebuild) and
  **`20260703120000_household_invites`** — the list grew: **`20260704090000_shares`** /
  **`20260704110000_recipes`** / **`20260704130000_planner`** (Rounds 2–4: SharePost/ShareClaim +
  `Take.shareClaimId`, Recipe/IngredientLink, PlanEntry/ShoppingItem/CategoryAssignment);
  **`20260704150000_circles`** (Phase 2 — rebuilds Connection/Pantry/Item for circle-scoped `visibility`;
  proven by `scripts/verify-circles-migration.mjs`); **`20260704170000_contact`** (profiles, household
  address + pickup notes); **`20260705100000_mail`** (CapturedEmail + MailSuppression, §6);
  **`20260705140000_auth`** (EmailVerificationToken/PasswordResetToken/MfaBackupCode/EmailMfaCode + the
  User MFA columns, §7); **`20260705180000_notifications`** (NotificationPreference + User
  timezone/showDetails/lastDigestAt/notifyOnboardedAt, §8); **`20260705200000_digest_cadence`** (per-user
  `digestCadence`/`digestHour`/`digestWeekday`); **`20260706120000_plan_shopping_tracking`**
  (`PlanEntry.addedToShoppingAt`, a plain `ADD COLUMN`). Round D (deep links) added none — the token is
  stateless.
- **Backups** (SPEC §6): one `tar` of `/data` covers DB + images together; document at slice 4.

`.env.example` (current shape — every var passes through compose with a safe default):

```bash
DATABASE_URL="file:./data/coop.db"   # compose pins file:/data/coop.db
SEED_DEMO=0                      # 1 = demo households/users on startup (dev + e2e only)
IMAGES_DIR=./data/images         # /data/images in Docker
COOP_DATA=                       # compose /data mount: unset = coop-data named volume; ./data = bind mount
APP_BIND=                        # host interface for the published port (default 0.0.0.0)
APP_PORT=                        # host port (default 3000; container always listens on 3000)

EXTRACTION_MODE=off              # off | fixture | live (§3)
EXTRACTION_MODEL=claude-opus-4-8
ANTHROPIC_API_KEY=               # required only when EXTRACTION_MODE=live

VAPID_PUBLIC_KEY=                # npx web-push generate-vapid-keys; empty = push disabled (§4)
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@example.com

MFA_ENC_KEY=                     # base64 32 bytes (openssl rand -base64 32); MANDATORY in prod (§7)

EMAIL_FROM=no-reply@potluckmutualaid.app     # SMTP transport creds (§6); empty = live send disabled
EMAIL_USERNAME=no-reply@potluckmutualaid.app
EMAIL_PASSWORD=
EMAIL_SMTP_SERVER=smtp.dreamhost.com
EMAIL_SMTP_PORT=587              # STARTTLS
EMAIL_IMAP_SERVER=imap.dreamhost.com         # opt-in real-send e2e receipt-verify only
EMAIL_IMAP_PORT=993

MAIL_MODE=capture                # capture = record to CapturedEmail, never touch SMTP | live
MAIL_PRODUCTION=                 # 1 = explicit prod opt-in, disables the dev filter (§6)
MAIL_DEV_ALLOWLIST=              # comma-separated regexes delivered as-is (dev filter, §6)
MAIL_DEV_REDIRECT=               # non-allowlisted mail goes here; empty = capture-only (fail closed)
MAIL_DEV_SUBJECT_PREFIX=[Potluck Dev]
MAIL_PUBLIC_URL=https://potluckmutualaid.app # base for unsubscribe/deep-link URLs in mail
MAIL_UNSUB_SECRET=               # HMAC secret for /unsub + deep-link tokens; MANDATORY when MAIL_PRODUCTION=1

DIGEST_SCHEDULER=                # unset = in-process ~10-min scheduler ON; off = external cron (§8)
```

## 6. Mail substrate (Phase 3 Rounds A/C)

**Transport — DECISION: swappable nodemailer driver; DreamHost authenticated SMTP through the family
pilot** (REWORK N1). `smtp.dreamhost.com:587` is STARTTLS (`secure: false` + `requireTLS: true` in the
lazy transport singleton, `src/server/mail/index.ts`); sending must go through *authenticated* SMTP or
DreamHost's auto-DKIM won't sign. Resend/SES is a config-swap when widening past the pilot — DreamHost's
100-recipients/hour cap is unadjustable and repeat offenders get blocked permanently. Sender identity is
`no-reply@potluckmutualaid.app`; `MAIL_PUBLIC_URL` builds the absolute links mail carries. An SMTP failure
is **logged and swallowed** (mirroring push): mail must never break the caller's request path.

**Two deliberately separate pipelines** (N3), so the two classes of mail can never be confused at a call
site:

- **`sendTransactional`** — account-critical mail the user asked for by acting (verify, password reset,
  MFA code). **No `List-Unsubscribe` header, never consults preferences or the suppression list** — you
  cannot unsubscribe from the reset email you just requested (CAN-SPAM/RFC-8058 both scope unsubscribe to
  bulk mail).
- **`sendSubscription`** — bulk/opt-in mail (digests, notification emails). Carries **RFC-8058 one-click
  `List-Unsubscribe` headers** (§9) and is gated behind the **MailSuppression** list and the per-user
  preference check *before* delivery; a skip writes no audit row (the message was never attempted).

**Capture mode** (N9, fail-closed): `MAIL_MODE=capture` is the default — every message either pipeline
tries to send is written to the **CapturedEmail** audit table (the single source of truth for "what did
the app try to send"; the e2e/dev flows read it back), and SMTP is never touched. `live` additionally
hands mail to SMTP — but only the recipients the **dev filter** approves: addresses matching a
`MAIL_DEV_ALLOWLIST` regex are delivered as-is; everything else is redirected to `MAIL_DEV_REDIRECT`, or
**captured-only when the redirect is empty** (nobody gets real mail — fail closed), with
`MAIL_DEV_SUBJECT_PREFIX` prepended as courtesy, not safety. Only the explicit `MAIL_PRODUCTION=1` opt-in
disables the filter — and the entrypoint refuses the seeded+live+production combination outright (§5).
Both pipelines expose a `Partial<MailDeps>` test seam (inject a spy `send`, force suppression) so unit
tests can prove, e.g., that transactional still sends when suppression says "true".

## 7. Auth flows + MFA crypto (Phase 3 Round B)

**Email verification + password reset** (N8): single-use, short-TTL link tokens, **sha256-hashed at rest**
(`hashToken` in `src/server/auth.ts` — only the hash is stored, so a DB read can't yield a usable link;
same scheme as session tokens). Both flows are **enumeration-safe** ("if an account exists, we've sent…"),
a successful reset **revokes existing sessions**, and a reset does **not** bypass enrolled TOTP.

**TOTP secrets are AES-256-GCM-encrypted at rest** under `MFA_ENC_KEY` (`src/server/mfa/crypto.ts`): the
secret is the long-lived shared key behind every code, so a DB read must not yield it — it's decrypted
only in memory to verify. Stored form is self-describing `base64(iv).base64(tag).base64(ciphertext)` (the
algorithm can rotate without a schema change). `mfaEncKey()` returns null on unset/wrong-length (treated
as absent, **fail closed** — MFA features refuse to operate rather than store a secret they can't
encrypt); the entrypoint makes a real key mandatory outside demo mode (§5). Rotating the key invalidates
every stored secret (members re-enroll; the emailed-code factor still works). Verification allows ±1 step
skew and rejects replays (`totpLastStep`).

**Backup codes**: 8–10 human-typeable one-time codes, hashed with the **password hasher (argon2id, random
salt)** — checked by *verifying* input against each stored row, never hash-and-equals. Shown once at
enrollment, ack required.

**Emailed codes** (the labeled *convenience* factor — email is also the reset channel, circular trust):
6-digit, **HMAC-hashed at rest keyed by the MFA key** (a bare sha256 of a 10^6 space is a lookup table;
the keyed pepper makes a leaked hash useless without the server secret), 10-min TTL, 5-attempt cap,
single-use, rate-limited in both directions. Sent via `sendTransactional`, naturally.

**Policy plumbing**: login returns a discriminated `mfaRequired` union (the challenge rides a signed
pending token, `mintPendingToken` — same inline-exp HMAC shape as §9's deep links); **TOTP is required for
the instance-admin account**; the instance admin can reset a member's MFA (audited, admin's own MFA
required) as the small-community recovery path. Demo fixtures boot **already enrolled** with committed dev
TOTP secrets (N10 — same demo-only class as the dev VAPID pair; `scripts/dump-demo-creds` emits
`otpauth://` URIs for 1Password, and e2e computes live codes from the fixture secret via otplib).

## 8. Notifications, digest, and the in-process scheduler (Round C + digest-cadence round)

**The preference matrix** (N5): three stored opt-out **categories** — `pickups` (needs-your-hands),
`circle` (ambient neighborhood activity), `ledger` (money) — each with per-user **push + email** toggles
(`NotificationPreference`; `src/server/notify/defaults.ts` is the pure spine). An **absent row means the
category default**, so a fresh account carries zero rows and still behaves conservatively: pickups
push+email ON; circle push ON / email OFF (a share should reach connections while the leftovers are still
good, but the digest is circle's email home — per-share email would bury the email-native "Walt" users);
ledger both OFF (money noise is opt-in; it still surfaces in-app + in the digest). Account/security mail
is transactional (§6) — always on, never stored here. First-run consent screen presents these defaults
explicitly (no silent firehose).

**The generalized `notify()` fan-out** (`src/server/push.ts`): called post-commit, fire-and-forget
(`void notify(...)` — it never throws). Resolves the recipient households' members, **excludes the
actor**, dedupes a two-household member to one notification, then per user sends to whichever channels
their preference (or the default) has ON — push via the §4 sender, email via `sendSubscription` (which
re-checks the same email pref + suppression). **Content rule (N4): category only** — the title/body carry
the recipient's *own* household name (`{household}` stamp), **never a counterparty name, dollar amount,
address, or item specifics** (lock screens and mail providers leak the intimate graph). An optional
counterparty-name `detail` is appended only for users who flipped the default-off **`showDetails`**
toggle. **Wired events**: order requested → pantry-owner household; order ready → requesting household;
share posted → visible connections (circle); share claimed → the post's owner; connection request → the
addressee household — plus ledger settle/adjust via `notifyLedgerEvent` (category `ledger`).

**The digest** (N6 + the digest-cadence round, `src/server/digest.ts`): the home for all
ambient/nice-to-know mail. Per-user **cadence `off`/`daily`/`weekly`** with a per-user **local send hour**
(+ weekday for weekly) in the user's IANA timezone (UTC fallback); **idempotent per user per cadence
window** via `User.lastDigestAt` — a restart, a scheduler tick, or a double-run in the same window never
double-sends. Assembled from existing state only (balances, open loops needing action, new shares — the
lookback follows the cadence, 24h/7d) with a subject that front-loads the point ("you're owed $12, 1
pickup waiting"); sent through the subscription pipeline (one-click unsubscribe + suppression + cadence
honored before send).

**The scheduler — DECISION: in-process, not cron** (`src/instrumentation.ts` `register()`, nodejs runtime
only). The self-hosted default needs zero external moving parts: a **~10-minute `setInterval`** drives
`runDigest(now)` (a cheap off-window no-op). Deliberately defensive so it can never take the server down:
no immediate boot tick (a restart storm would each fire a sweep), an in-flight guard so a slow sweep never
overlaps the next tick, per-tick try/catch, `unref()` so the timer never holds the process open, and quiet
unless it actually sends. **`DIGEST_SCHEDULER=off`** disables it in favor of an external cron running
`scripts/run-digest.ts`. `register()` also runs a boot-time **`sweepOrphanImages()`** (best-effort GC of
image files no DB row references — logged, never blocks startup).

## 9. Deep links (`/go`) and one-click unsubscribe (`/unsub`) (Rounds C/D)

**Deep-link tokens — DECISION: navigation-only, stateless** (N7; `src/server/deeplink.ts`). Every
notification (push *and* email) carries a `/go?t=<token>` link; the token is an **HMAC over
`{path, householdId, exp}`** (base64url payload + signature, `timingSafeEqual` verify, **24h TTL, no DB
row** — cheap, restart-proof). It is **never accepted as authentication** and can perform no action or
elevation: `/go` verifies, switches the acting household **only to one of the viewer's own memberships**
(re-checked against live memberships — the token is a hint, not an authorization), and redirects. A
logged-out click lands on a normal **login with `next=`** that re-hits `/go` once authed, so the
household-switch survives sign-in — login is the only thing that authenticates (magic-link-as-login held
off deliberately: iOS opens email links in Safari's *separate storage jar*, signed out, while a push tap
lands inside the installed PWA authenticated — so push is the primary deep-link channel and email
routes-then-logs-in-to-act). Because it's nav-only, replay is harmless (same screen, same idempotent
own-household switch). **Open-redirect defense**: `isSafePath` rejects `//`, `/\`, backslashes, `@`
userinfo tricks, and control chars — enforced at **both mint and verify** (fail closed; a tampered payload
can't sneak a bad path past mint); any invalid/expired token falls back to `/`, never an error. The key is
**domain-separated** from `MAIL_UNSUB_SECRET` (HMAC of the root secret with `deeplink-v1`), so the
deep-link key can never verify an unsub token or vice versa. `notify()` mints the link per-recipient, so
tapping also switches a two-household member to the household the notification is stamped with.

**`/unsub` — RFC-8058 one-click** (`src/app/unsub/route.ts`): honors the HMAC token minted into every
subscription message's `List-Unsubscribe` header. **No session required — the signed token *is* the
authorization** (constant-time verify), and it can only ever turn a preference **off**, so a leaked or
guessed token can't harm an account. `POST` (with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) is
the machine one-click a mail client fires; `GET` is the human landing, same idempotent effect plus a plain
confirmation page. Per category: `digest` → `User.digestCadence = 'off'`; `pickups`/`circle`/`ledger` →
that category's email flag off (push untouched). Transactional mail carries no token by design (§6).
