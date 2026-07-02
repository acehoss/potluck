# Private Coop — Build Plan

Tracks slice status and progress notes. The scope contract is [SPEC.md](./SPEC.md) §7.

**Definition of done for a slice:** feature demonstrated working in a real browser against the real compose stack, Playwright e2e passing, progress notes updated here. A slice is never "complete" on the strength of unit tests alone.

| # | Slice | Status |
| --- | ----- | ------ |
| 1 | Skeleton — compose, invite-only auth, households/pantries | ✅ done 2026-07-02 |
| 2 | Receiving — receipt capture, review/receive flow, lots, unit photos, inventory view | ⏳ not started |
| 3 | Takes & ledger — take flow, FIFO suggestion, net position | ⏳ not started |
| 4 | Settlements & adjustments — payments, recounts, write-offs | ⏳ not started |
| 5 | VLM extraction — receipt images prefill the receiving screen | ⏳ not started |
| 6 | Lending — items, loans, returns, fees | ⏳ not started |
| 7 | PWA polish — install, camera scanning, push | ⏳ not started |

## Progress notes

Append dated notes per slice as work happens: decisions made, deviations from spec (with why), what was demonstrated and how. Newest at the top of each slice's section.

### Slice 1 — Skeleton

**2026-07-02 — field bug fixed.** Aaron couldn't log in from his own browser: the session cookie was marked `Secure` whenever `NODE_ENV=production`, and Safari refuses `Secure` cookies over plain http — localhost included (Chromium exempts localhost, which is why e2e and the manual drive missed it; any browser hitting a LAN IP over http drops it too). Fix: the cookie's `Secure` flag now follows the actual request protocol (`x-forwarded-proto` first hop, else the request URL scheme), so it hardens automatically once TLS is in front. Regression coverage: a `webkit` project joined the Playwright matrix (12 tests = 6 × chromium/webkit); reproduced the failure on WebKit before the fix, green after. Lesson for future slices: verify on both engines — the families use iPhones and Androids.

**2026-07-02 — done.** Next.js 16 (Turbopack) + tRPC 11 (`@trpc/tanstack-react-query`) + Prisma 7 + SQLite, single `node:22-slim` container; entrypoint runs `prisma migrate deploy` and seeds demo fixtures when `SEED_DEMO=1`. Auth is hand-rolled per SPEC §6: argon2id (OWASP params), 30-day sliding sessions stored as sha256 hashes with the raw token only in an httpOnly cookie, in-memory login rate limiting (10/email, 30/IP per 15 min), timing-equalized login errors, and single-use 7-day invite tokens (hashed at rest, raw only in the shared link). Dashboard is a server component reading Prisma directly; mutations go through tRPC.

Verified: 6 Playwright tests green against the freshly-seeded compose stack (`SEED_DEMO=1 docker compose up -d --wait && npm run e2e`), plus a manual browser drive with probes: wrong password, tampered invite token, invite reuse, already-signed-in invite guard, sign-out. Prisma 7 notes for future slices: no `url` in schema datasource (lives in `prisma.config.ts`), driver adapter required (`@prisma/adapter-better-sqlite3`), `prisma generate` is manual, Dockerfile needs a build-time `DATABASE_URL`.

Deferred deliberately: production deployment (reverse proxy + TLS) until we actually host it; password reset (invite a re-registration or reset via CLI for now — revisit before friends join); household/pantry management UI (seeded via fixtures; real households get created at deploy time).

### Slice 2 — Receiving

*(none yet)*

### Slice 3 — Takes & ledger

*(none yet)*

### Slice 4 — Settlements & adjustments

*(none yet)*

### Slice 5 — VLM extraction

*(none yet)*

### Slice 6 — Lending

*(none yet)*

### Slice 7 — PWA polish

*(none yet)*
