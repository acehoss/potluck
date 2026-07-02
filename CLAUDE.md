# CLAUDE.md

Private Coop: a self-hosted web app (PWA) for a small circle of trusted households to share pantry goods and equipment at cost, with a netted per-household-pair ledger.

## Read first

- **[SPEC.md](./SPEC.md)** — the scope contract: domain model, flows, technical requirements, slice plan. Deliberately small; keep it that way.
- **[PLAN.md](./PLAN.md)** — slice status and progress notes. Update it as you work; append dated notes for decisions and deviations.

## Working rules

1. **A slice is done only when it demonstrably works**: feature exercised in a real browser against the real stack, Playwright e2e passing. Unit-test coverage is not a goal and never a substitute.
2. Work vertical slices in PLAN.md order; don't start the next before the current one is demonstrated.
3. Money is integer cents. TypeScript end to end, types generated from one schema.
4. Use `docker compose` (space-separated), never `docker-compose`.

## History warning

Branches `archive/2025-main` and `archive/2025-take2` hold the abandoned 2025 attempts: ~155 files of overengineered AI-generated design docs and an implementation whose "Phase 1 Complete" status was never real (frontend unwired, integration tests fully mocked). Reference them only deliberately — do not import their docs, patterns, or tests. The one trustworthy ancestral document is `local_only/design_discussions/RAW_REQUIREMENTS.md` (on the archive branches), and SPEC.md already distills it.
