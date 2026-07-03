# CLAUDE.md

Private Coop: a self-hosted web app (PWA) for a small circle of trusted households to share pantry goods and equipment at cost, with a netted per-household-pair ledger.

## Current state (2026-07-03)

**v1 is built, committed, and green.** All seven slices (skeleton → receiving → takes/ledger → settlements/adjustments → VLM extraction → lending → PWA) plus a pre-handoff hardening pass are on `main`. Two iteration rounds have since shipped on top. 18 Prisma models across 10 migrations; Playwright e2e green on both Chromium-light and WebKit-dark against the real container.

**Phase now: iterating with Aaron in the loop** — not autonomous slice-building. Rounds shipped 2026-07-03 (see PLAN.md):

- **Receiving tweaks** — lot code shown up front (reverses D6), tax/fees folded into a **tax-inclusive** at-cost unit price (opens D7), excluded non-coop lines, auto-extraction, and a restock-history list with **auditable** finalized corrections (preview the exact ledger change; never a raw reopen). Migration `20260703060000_tax_fees_receipt_text`.
- **Orders & requests** — receiving proposals now split Confirm-a-match vs **Process** (unmatched lines must pick/create a real product, no auto-create). The take flow became **orders**: everything is a request with reservation — `DRAFT → REQUESTED (reserve) → PICKING (lock) → READY → PICKED_UP (money posts here) / CANCELED (release)`. `Lot.reservedCount` (availability = `remaining − reserved`), `Order`/`OrderLine`, an `order` router, an **Orders** tab, and `/orders` + `/orders/[id]`. The instant `take.create` was **removed** (it ignored reservations); `take.undo` stays for returns. Money still posts exactly at goods-transfer (now pickup), append-only, via `dbTransaction` + `clientKey`. Migration `20260703080000_orders_reserved`.

Do not start large autonomous workflows without an explicit ask.

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

Demo logins (seeded only): `aaron@demo.coop` / `dana@demo.coop`, password `demo-password`.

## Working rules (still in force)

1. **Nothing is done until it demonstrably works** in a real browser against the real compose stack, with Playwright e2e passing on both engines (chromium-light + webkit-dark). Unit-test coverage is not a goal and never a substitute for a browser demo.
2. **Money is integer cents.** Every multi-write money operation goes through `dbTransaction` (the app-level lock in `src/server/db.ts` — never call `db.$transaction` directly), and every money-writing mutation carries a `clientKey` for idempotency. The ledger is append-only; corrections are swapped-party REVERSAL entries, never edits.
3. **Colors are semantic tokens only** — the default Tailwind palette is deleted, so `bg-white`/`text-stone-*` etc. silently fail. `npm run lint:tokens` enforces this. Dark mode is a token swap via `prefers-color-scheme` (no `dark:` variants). Verify new UI in both schemes.
4. TypeScript end to end, types generated from one Prisma schema. Use `docker compose` (space-separated), never `docker-compose`. Port 3000 is exclusive.
5. Prisma 7 gotchas: datasource url lives in `prisma.config.ts` (not the schema); driver adapter required; `prisma generate` is manual after schema changes; migrations are hand-timestamped to preserve order.

## History warning

Branches `archive/2025-main` and `archive/2025-take2` hold the abandoned 2025 attempts: ~155 files of overengineered AI-generated design docs and an implementation whose "Phase 1 Complete" status was never real (frontend unwired, integration tests fully mocked). Reference them only deliberately — do not import their docs, patterns, or tests. The one trustworthy ancestral document is `local_only/design_discussions/RAW_REQUIREMENTS.md` (on the archive branches); SPEC.md already distills it.
