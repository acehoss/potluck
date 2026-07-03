# Private Coop

A self-hosted web app (PWA) for a small circle of trusted households to share pantry goods and equipment at cost, with a netted per-household-pair ledger.

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

Demo logins (only when seeded): `aaron@demo.coop` / `dana@demo.coop`, password `demo-password`.

## Receipt extraction (VLM)

The receiving wizard can prefill receipt lines from the photos via Claude.
Controlled by `EXTRACTION_MODE` (default `off` — manual entry only):

- `off` — the UI never offers extraction.
- `fixture` — deterministic committed fixtures for e2e; no network, no key.
- `live` — the Anthropic API. Requires `ANTHROPIC_API_KEY` in the container
  environment (`ANTHROPIC_API_KEY=… EXTRACTION_MODE=live docker compose up -d`).
  **Never bake the key into the image or commit it** — compose passes it
  through from the host environment at runtime. `EXTRACTION_MODEL` overrides
  the default model (`claude-opus-4-8`).

Extraction is advisory: proposed lines land on the review screen for per-line
confirm/edit/dismiss, and any failure degrades to manual entry.

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
