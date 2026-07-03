# CLAUDE.md

Private Coop: a self-hosted web app (PWA) for a small circle of trusted households to share pantry goods and equipment at cost, with a netted per-household-pair ledger.

## Current state (2026-07-03)

**v1 is built, committed, and green.** All seven slices (skeleton → receiving → takes/ledger → settlements/adjustments → VLM extraction → lending → PWA) plus a pre-handoff hardening pass are on `main`. ~9,900 lines of app code, 16 Prisma models across 9 migrations, 133 Playwright e2e passing (+3 documented skips) on both Chromium-light and WebKit-dark against the real container.

**Phase now: iterating on tweaks with Aaron in the loop** — not autonomous slice-building. The build is done. A first polish round shipped 2026-07-03 (see PLAN.md → "Polish round — receiving tweaks"): lot code shown up front (reverses D6), tax/fees as explicit amounts folded into a **tax-inclusive** at-cost unit price (opens D7's allocation door), excluded non-coop lines, auto-extraction on the review screen, and a restock-history list with **auditable** finalized corrections (correct received counts / void) that preview the exact ledger change before committing — never a raw reopen (that would rewrite frozen costs takes already used). Migration `20260703060000_tax_fees_receipt_text`. Do not start large autonomous workflows without an explicit ask.

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
