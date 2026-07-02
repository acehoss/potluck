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

# End-to-end tests (against the seeded compose stack)
npm run e2e
```

Demo logins (only when seeded): `aaron@demo.coop` / `dana@demo.coop`, password `demo-password`.

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
