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

## Stack

Next.js + tRPC + Prisma + SQLite in a single container. TypeScript end to end. See SPEC §6.
