# CLAUDE.md

Potluck (formerly "Private Coop"): a self-hosted web app (PWA) for mutual aid between households — nodes in a network of pairwise connections sharing pantry goods and equipment at cost, with a netted per-household-pair ledger.

## Current state (2026-07-04)

**v1 shipped (all seven slices + hardening + two iteration rounds), and the "Potluck"
mutual-aid rework's Round 1 (network core) is COMPLETE** — an overnight autonomous
session (2026-07-03→04) shipped all five slices: R1S1 network-core schema + data
migration, R1S2 capability/grant authz + acting-household switcher + username login, R1S3
connection management UI + shared flags, R1S4 onboarding + instance admin, R1S5 rebrand →
Potluck + SPEC/blueprint rewrite. Each committed and green on both engines against the
real container. **Next: Rounds 2–4 (needs & surpluses → recipes → planner/shopping)** —
design locked in docs/REWORK.md, not built. See PLAN.md's Round-1 notes (newest first)
for the full record.

What the rework changed structurally (read PLAN.md + docs/REWORK.md before touching):
- **Membership replaces `User.householdId`** — a user belongs to N households, each with
  11 capability flags (`src/server/capabilities.ts`); `getSessionUser()` resolves the
  sticky **acting household** (`potluck_household` cookie) behind the legacy `householdId`
  shape, so every consumer still reads `ctx.user.householdId` (now = acting household).
- **`Connection`** (pairwise, two directional grant sets, PENDING/ACTIVE/SEVERED) is the
  visibility+reach primitive; **`src/server/authz.ts`** is the choke point
  (`requireCapability`, `hasActiveGrant`, `activeConnectionsOf`, `loadAccessiblePantry`).
  Error convention: missing capability = 403, missing visibility = 404 (never leak
  existence). Money reach is re-checked at the money moment (pickup/finalize).
- **Per-household `Product`**, `Pantry.shared`/`Item.shared`, `Take.householdId` /
  `Loan.borrowerHouseholdId` attribution snapshots, instance-settings + `isInstanceAdmin`.
- Identity is username-or-email; demo seed grew to **three households** (Heise, In-Laws,
  Neighbors) with Teen/multi-membership fixtures — see `prisma/seed.ts`.

Migrations added this rework: `20260703100000_network_core` (the big data-preserving one),
`20260703120000_household_invites`. **Every money invariant and the append-only ledger
survived untouched** — the migrations are additive/data-preserving and proven against the
real accumulated dev volume as well as a fresh stack.

Do not start large autonomous workflows without an explicit ask. Rounds 2–4 are still
"design locked, not built" — resume from PLAN.md + docs/REWORK.md.

**SPEC.md was rewritten and the blueprints amended for Round 1 (R1S5)** — they describe
the running app again. Rebrand notes: cookies are `potluck_session`/`potluck_household`
and the manifest is "Potluck", but `/data/coop.db`, the `coop-data` volume, and the repo
directory deliberately keep their names (renaming would orphan existing deployments'
data; repo rename is Aaron's call). Demo seed emails stay `@demo.coop` (fixtures, keyed
by upsert). The jar brand mark stayed — a new mark can ride the domain hunt.

## Read first

- **[SPEC.md](./SPEC.md)** — the scope contract: domain model, flows, money invariants, out-of-scope guardrails. Deliberately small; keep it that way.
- **[PLAN.md](./PLAN.md)** — per-slice progress notes, deliberate deferrals, and the outstanding-work list. Append dated notes for any change.
- **[README.md](./README.md)** — how to run it, and the "Go live" deploy runbook (bootstrap the first household, TLS reverse proxy, secrets).
- **[docs/blueprint/](./docs/blueprint/)** — 00 overview, 01 data model + money invariants, 02 UX flows, 03 design system, 04 infra. Authoritative for money/lifecycle questions.

## Run it

```bash
SEED_DEMO=1 EXTRACTION_MODE=fixture docker compose up -d --wait   # then localhost:3000
npm run e2e                                                        # full suite, both engines
```

Demo logins (seeded only): usernames `aaron` / `marie` / `dana` / `nia` / `theo` (or
their `@demo.coop` emails), password `demo-password`. Marie is the multi-membership
switcher fixture; Theo is Teen-preset; Neighbors is share-only-connected to Heise and
unconnected to In-Laws.

## Working rules (still in force)

1. **Nothing is done until it demonstrably works** in a real browser against the real compose stack, with Playwright e2e passing on both engines (chromium-light + webkit-dark). Unit-test coverage is not a goal and never a substitute for a browser demo.
2. **Money is integer cents.** Every multi-write money operation goes through `dbTransaction` (the app-level lock in `src/server/db.ts` — never call `db.$transaction` directly), and every money-writing mutation carries a `clientKey` for idempotency. The ledger is append-only; corrections are swapped-party REVERSAL entries, never edits.
3. **Colors are semantic tokens only** — the default Tailwind palette is deleted, so `bg-white`/`text-stone-*` etc. silently fail. `npm run lint:tokens` enforces this. Dark mode is a token swap via `prefers-color-scheme` (no `dark:` variants). Verify new UI in both schemes.
4. TypeScript end to end, types generated from one Prisma schema. Use `docker compose` (space-separated), never `docker-compose`. Port 3000 is exclusive.
5. Prisma 7 gotchas: datasource url lives in `prisma.config.ts` (not the schema); driver adapter required; `prisma generate` is manual after schema changes; migrations are hand-timestamped to preserve order.

## History warning

Branches `archive/2025-main` and `archive/2025-take2` hold the abandoned 2025 attempts: ~155 files of overengineered AI-generated design docs and an implementation whose "Phase 1 Complete" status was never real (frontend unwired, integration tests fully mocked). Reference them only deliberately — do not import their docs, patterns, or tests. The one trustworthy ancestral document is `local_only/design_discussions/RAW_REQUIREMENTS.md` (on the archive branches); SPEC.md already distills it.
