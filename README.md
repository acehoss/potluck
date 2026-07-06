# Potluck

A self-hosted web app (PWA) for **mutual aid between households**: each household is a
node, pairwise connections carry per-side grants, and connected households share pantry
goods and equipment **at cost** with a netted per-pair ledger. (Formerly "Private Coop" —
renamed with the Round-1 network rework.)

- **[SPEC.md](./SPEC.md)** — scope, domain model, flows, technical requirements
- **[PLAN.md](./PLAN.md)** — build slices, status, progress notes

## Run it

```bash
# Dev (hot reload on :3000)
npm install
npx prisma migrate dev
npx prisma db seed          # demo households, password: demo-password
npm run dev

# Production-style, in Docker
docker compose up -d --wait                # empty database
SEED_DEMO=1 docker compose up -d --wait    # with demo fixtures

# End-to-end tests (against the seeded compose stack; extraction fixtures on)
SEED_DEMO=1 EXTRACTION_MODE=fixture docker compose up -d --wait
npm run e2e

# Extraction unit tests (live error mapping, stored-JSON parsing; no network)
npm run test:unit

# Off-mode extraction e2e (boots its own EXTRACTION_MODE=off stack, then downs it)
npm run e2e:off
```

Demo logins (only when seeded): usernames `aaron`, `marie`, `dana`, `nia`, `theo`
(emails like `aaron@demo.coop` also work), password `demo-password`. Three seeded
households exercise the network: Heise ↔ In-Laws (full grants), Heise ↔ Neighbors
(share-only), In-Laws ↔ Neighbors (unconnected). Marie belongs to two households
(the acting-household switcher lives on More); Theo is a Teen-preset member.

## Go live (real deployment)

This app faces the public internet with production-grade, invite-only auth
(SPEC §4/§6). A real deployment differs from the demo in three ways: it starts
with an **empty** database (no `SEED_DEMO`), it runs **behind TLS**, and the
first account is created by hand (registration is invite-only, so there's a
chicken-and-egg for user #1). The container already sets `restart:
unless-stopped`, so it survives host reboots and crashes.

### 1. Bootstrap the first household + user

A fresh DB has zero users and no open signup, so no invite can be minted yet.
Create the first household/owner directly against the running container:

```bash
docker compose up -d --wait      # empty DB, no SEED_DEMO
docker compose exec app npx tsx scripts/bootstrap.ts \
  "Heise" "Aaron" "aaron@example.com" "a-strong-password" "Basement Pantry"
```

Bootstrap creates the instance settings, the household (with its `@handle`
slug), a pantry, and the owner — whose username derives from the email
local-part, and who becomes the **instance admin** (the More tab gains an
admin card: per-household usage, plus the toggle for who may invite new
households). From there everything grows in-app:

- **More → Invite a member** adds people to your household (a signed-in
  person accepting one gains a second membership).
- **More → Connections → Invite a NEW household** onboards another family —
  they name their own household and arrive already connected to yours.
- **More → Connections → Connect a household** links two households that are
  already on the server, by the `@handle` shown on their More tab.

Never re-run `bootstrap` for an existing person.

### 2. Reset / recover a password

There is no self-service email reset in v1. To set a password (forgotten, or
initial hand-off), run against the container:

```bash
docker compose exec app npx tsx scripts/set-password.ts aaron@example.com "new-password"
```

It rewrites the argon2 hash in place (existing sessions are not revoked).

### 3. Put TLS in front (reverse proxy)

Camera barcode scanning and web push require a **secure context**, login
credentials must not cross the wire in plaintext, and the session cookie only
gets its `Secure` flag when the app sees an https request — so a TLS-terminating
reverse proxy is mandatory in production. The app reads the real scheme and
client IP from the proxy's `X-Forwarded-Proto` / `X-Forwarded-For` headers,
trusting **one** proxy hop by default (override with `TRUSTED_PROXY_HOPS` if you
chain more). Do **not** publish port 3000 to the internet — bind it to the proxy
only.

**Caddy** (automatic Let's Encrypt certs — simplest). `Caddyfile`:

```
coop.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy sets `X-Forwarded-Proto`/`X-Forwarded-For` correctly out of the box.

**nginx** (bring your own certs / certbot):

```nginx
server {
    listen 443 ssl;
    server_name coop.example.com;
    ssl_certificate     /etc/letsencrypt/live/coop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/coop.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-Proto $scheme;                  # drives the Secure cookie
        proxy_set_header   X-Forwarded-For  $proxy_add_x_forwarded_for; # appends the real peer
    }
}
```

`$proxy_add_x_forwarded_for` **appends** the real client IP to the right, which
is exactly the hop the rate limiter trusts — never let the proxy pass a
client-supplied `X-Forwarded-For` through unmodified.

### 4. Rotate secrets

- **`ANTHROPIC_API_KEY`** — only needed for `EXTRACTION_MODE=live`. `.env` is
  gitignored (never committed); the key currently there was used for local
  extraction testing and has been shared in plaintext, so rotate it in the
  Anthropic console before any public deployment and pass the new key through
  the host env.
- **VAPID keys** — generate your own (below); the committed dev pair is public
  and the entrypoint refuses to start a non-demo stack configured with it.

### 5. Configure email (transactional + notifications)

The app sends email for account flows (verification, password reset, MFA codes)
and — opt-in — notification digests. Outbound goes through any SMTP host via a
swappable driver; the reference setup is **DreamHost** on the domain
`potluckmutualaid.app`. Set these in the host env (or the gitignored `.env`):

```bash
EMAIL_FROM=no-reply@potluckmutualaid.app     # visible From: (keep it on your domain)
EMAIL_USERNAME=no-reply@potluckmutualaid.app # SMTP auth user
EMAIL_PASSWORD=…                             # SMTP auth password (never commit)
EMAIL_SMTP_SERVER=smtp.dreamhost.com
EMAIL_SMTP_PORT=587                          # 587 ⇒ STARTTLS
MAIL_MODE=live                               # 'live' to send; 'capture' (default) records only
MAIL_PRODUCTION=1                            # explicit opt-in: deliver to real recipients unfiltered
```

`MAIL_MODE` defaults to **`capture`** — a safe default that records every message to
the `CapturedEmail` table and sends nothing. A real deployment must set
`MAIL_MODE=live` **and** `MAIL_PRODUCTION=1` (the second is a deliberate second key so a
demo/staging stack can never blast real users — the entrypoint refuses to start a
`SEED_DEMO=1` stack that has both). A production stack left in `capture` mode logs a loud
warning, since mail would silently vanish.

**DNS — do this before real users depend on password resets landing:**

1. **SPF + DKIM are automatic on DreamHost** for a domain whose DNS + email are both
   hosted there — DreamHost publishes the SPF record and signs DKIM (selector
   `dreamhost._domainkey`) for you. Just **verify** both are live in the DNS panel. Note
   DreamHost only DKIM-signs mail sent via *authenticated* SMTP, which this app does.
2. **Add a DMARC record** (DreamHost does not create one). Start in monitor mode and ramp:
   ```
   _dmarc  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@potluckmutualaid.app; adkim=r; aspf=r"
   ```
   Route `rua` to a free aggregator (Postmark DMARC / Valimail) — at low volume this is your
   only deliverability telemetry (Google Postmaster Tools stays empty). Once reports show
   SPF/DKIM passing, tighten to `p=quarantine`, then `p=reject`.
3. All email links are `https://` (the `.app` TLD is HSTS-preloaded — required, not optional).

**Scaling past a small pilot:** DreamHost caps outbound at 100 recipients/hour per mailbox
(unraisable, and repeated overflow blocks the mailbox), on a shared relay pool. That's fine
for a family pilot but switch the transport to a dedicated sender (Resend/SES) before wider
use — the domain reputation you built carries over. When you do, the one DNS gotcha: a custom
SPF record **replaces** DreamHost's auto one, so **merge** the provider's `include:` into a
single SPF record rather than adding a second.

**Notifications:** members set per-category preferences (pickups / neighborhood activity /
money) across push + email on the More → Notifications screen, plus a **digest** with a
per-user cadence — **daily (the default)**, weekly (pick a day), or off — and a per-user
send hour. New shares push to visible connections **immediately** by default (the app wants
leftovers picked up tonight, not next week); the digest is the email channel for that
ambient activity. Operational notes:

- **`MAIL_UNSUB_SECRET`** — an HMAC secret for the one-click `/unsub` links on subscription
  mail (digests). A demo stack injects a dev value; the entrypoint **refuses to start a
  `MAIL_PRODUCTION=1` stack without a real one** (set it to a long random string in the host
  env). Rotating it invalidates outstanding unsubscribe links (they re-issue on the next send).
- **Digest scheduling — automatic.** The app runs an in-process scheduler (a ~10-minute
  tick started at boot) that sends each user's digest at their chosen local hour (and day,
  for weekly), idempotent per window — no cron needed. To use an external cron instead, set
  `DIGEST_SCHEDULER=off` and run **hourly**:
  ```bash
  0 * * * *  cd /path/to/coop && docker compose exec -T app npx tsx scripts/run-digest.ts
  ```
  To **smoke-test** the mail path on a fresh deploy without waiting for the window, force
  one user's digest now (a cadence of "off" is still honored):
  `docker compose exec -T app npx tsx scripts/run-digest.ts you@example.com`.
  (The `SEED_DEMO`-gated `/api/dev/digest-run` route is the e2e/on-demand hook only.)

## Receipt extraction (VLM)

The receiving wizard can prefill receipt lines from the photos via Claude.
Controlled by `EXTRACTION_MODE` (default `off` — manual entry only):

- `off` — the UI never offers extraction.
- `fixture` — deterministic committed fixtures for e2e; no network, no key.
- `live` — the Anthropic API. Requires `ANTHROPIC_API_KEY` in the container
  environment (`ANTHROPIC_API_KEY=… EXTRACTION_MODE=live docker compose up -d`).
  **Never bake the key into the image or commit it** — compose passes it
  through from the host environment at runtime. `EXTRACTION_MODEL` overrides
  the default model (`claude-opus-4-8`). To keep a local stack on live across
  restarts, put `EXTRACTION_MODE=live` in the gitignored `.env` (compose loads
  it automatically) rather than prefixing every `up`.

Extraction is advisory: proposed lines land on the review screen for per-line
confirm/edit/dismiss, and any failure degrades to manual entry. Each line comes
back as a **clean product name** plus the **raw receipt text** (shown for
reconciliation); the printed tax is offered as a one-tap add, never applied
silently (it feeds the tax-inclusive unit cost).

## Install & notifications (PWA)

The app is installable (manifest + icons + service worker; guidance lives on
the **More** tab — Android offers a native install prompt, iOS shows the
Share → Add to Home Screen steps). Camera barcode scanning and web push both
need a **secure context**: HTTPS in production (localhost is exempt for dev).
On iOS, push requires the *installed* app (iOS 16.4+) and the permission
prompt only ever follows an explicit tap on the More tab's toggle.

Web push needs a VAPID keypair in the container environment:

```bash
npx web-push generate-vapid-keys
# then set in the host env (or a .env file next to docker-compose.yml):
#   VAPID_PUBLIC_KEY=…  VAPID_PRIVATE_KEY=…  VAPID_SUBJECT=mailto:you@example.com
```

Leave them empty to disable push (the More tab says it's not configured).
Demo/e2e stacks (`SEED_DEMO=1`) get a **publicly known dev keypair** injected
by the entrypoint so the test suite works out of the box; the entrypoint
**refuses to start** a non-demo stack configured with that dev pair — its
private key is committed to this repo. Subscription endpoints are validated
as public HTTPS push-service hosts (the server POSTs notifications to them,
so anything else would be an SSRF hole). Exactly two events notify: a
settlement recorded and a manual ledger adjustment posted — members of both
involved households, except whoever recorded it.

## Backups

One tar covers everything (SPEC §6): the SQLite database plus the images tree,
both on the `coop-data` volume. The backup is safe to take while the app is
running — it snapshots the DB through SQLite's online backup API, never a raw
copy of a live WAL file.

```bash
# Back up (stack must be running) → backups/coop-YYYYMMDD-HHMMSS.tar
scripts/backup.sh            # or: scripts/backup.sh /path/to/dir

# Restore (DESTRUCTIVE — replaces DB and images; stops the app first)
scripts/restore.sh backups/coop-20260702-153000.tar
docker compose up -d --wait
```

Put `scripts/backup.sh` on a cron and ship the tars off-box; the restore path
is exercised as part of each release's verification.

## Stack

Next.js + tRPC + Prisma + SQLite in a single container. TypeScript end to end. See SPEC §6.
