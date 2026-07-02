# Private Coop — Build Plan

Tracks slice status and progress notes. The scope contract is [SPEC.md](./SPEC.md) §7.

**Definition of done for a slice:** feature demonstrated working in a real browser against the real compose stack, Playwright e2e passing, progress notes updated here. A slice is never "complete" on the strength of unit tests alone.

| # | Slice | Status |
| --- | ----- | ------ |
| 1 | Skeleton — compose, invite-only auth, households/pantries | ✅ done 2026-07-02 |
| 2 | Receiving — receipt capture, review/receive flow, lots, unit photos, inventory view | ✅ done 2026-07-02 |
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

**2026-07-02 — code-review fixes (behavior changes).** A review pass on the uncommitted slice confirmed one critical and several major findings; all fixed and re-proven end-to-end:

- **DB serialization (critical):** the better-sqlite3 driver adapter takes its mutex only for transactions, so a concurrent plain query could execute *inside* another request's open interactive transaction and vanish with its rollback (finalize rolls back by design on the D6 seq retry). `src/server/db.ts` now serializes every operation through one app-level lock; interactive transactions go through the new `dbTransaction()` helper, which holds the lock for their whole duration (never call `db.$transaction` directly). Verified with a live reproduction: a concurrent write now survives a rolled-back transaction.
- **Check-then-act on DRAFT status:** `updateDraft`/`saveLine`/`deleteLine`/`removeImage`/`deleteDraft` now do their status check and write inside one `dbTransaction`, so a concurrent finalize can no longer let them mutate/destroy a FINALIZED restock (posted credit vs. deleted lots, null-unit-cost lots, unlinked permanent receipt files). Position assignment (images, lots) and inline product creation moved into the same transactions — no more P2002 races or orphan `Product` rows.
- **Image path forgery:** `addImage`/`setUnitPhoto` accepted any string and deleted whatever the old path pointed at — any member could destroy another restock's permanent receipt files. Attach mutations now require a fresh, server-named upload of the right kind (`isStoredImagePath`), present on disk and referenced by no other row; file unlinks happen only after DB commit and only when unreferenced. `removeImage` is now gated like `deleteDraft` (creator or purchaser household).
- **D7 consent gate:** the client no longer auto-sends the acknowledgment. Finalize outside the auto-pass window is a real two-tap confirm ("Finalize" → "Finalize anyway — receipt differs by $X"), and the client *echoes the variance it displayed*; the server rejects a missing or stale echo (`acknowledgedVarianceCents` must equal the recomputed variance), so nobody can "acknowledge" a number they never saw.
- **Header now editable after step 1:** `updateDraft` was dead code; an "Edit details" affordance (retailer/date/purchaser/receipt total) is visible on every draft step, so a typoed total or date no longer forces finalize-wrong-or-abandon.
- **Misc:** start-sheet date defaults to the *local* calendar date (was UTC — evening sessions got tomorrow's D6 code); resume banner only shows drafts the viewer can finalize, and a failed abandon now surfaces its error; upload route enforces Content-Length before buffering, plus a per-user rate limit (120/15 min); `dateOnly` rejects impossible dates and cents inputs are capped at $1M; RESTOCK_CREDIT display reads go through `getActiveRestockCredit` (ignores reversed credits, ready for the slice-4 correct-credit op); orphaned image files are swept at server boot (`src/instrumentation.ts`, 24 h grace); successful logins reset the per-IP budget too, so only failures count toward spraying limits.
- **e2e:** suite grew 13 → 26 (× chromium/webkit): server-side variance-guard rejection (412), finalize/abandon authz (403 for an unrelated member), unauthenticated image/upload access (401), traversal (400), non-JPEG and bad-kind uploads (415/400), forged attach path (400), line edit/delete, receipt-photo removal (file provably gone from disk), removeImage-after-finalize (412), and the edit-details flow. Test data now carries a per-run token, and the suite is green run twice against the same live stack (previously required a `down -v` reseed).

**2026-07-02 — done.** Shipped the receiving vertical per blueprint 01/02/03/04: `slice2_receiving` migration (Product, Restock, RestockImage, Lot — line = lot, D4), image pipeline (client canvas downscale → multipart upload route → authenticated `/api/images` serving, files under `IMAGES_DIR` on the existing volume), the full wizard (start sheet → receipt photos → line review with inline product create, hold-backs, running reconcile banner → unit photos → reconcile/finalize → big-code done screen), pantry inventory grouped by product with FIFO-ordered lot rows and best-by amber/red badges, restock detail (`/restocks/[id]`), the 4-tab shell (Ledger/Items greyed), and the design-system token migration (blueprint 03 `globals.css` verbatim; all slice-1 screens retargeted; `git grep` palette guard is clean). Finalize is one transaction: half-up unit costs frozen (D1), `remainingCount` set, variance stored (D7, explicit acknowledge outside the 2¢/line window), purchaser credit posted for cross-household restocks, code assigned race-safely via `@@unique([dateCode, seq])` + P2002 retry (D6).

Verified: 18 Playwright tests green (9 × chromium-light / webkit-dark) against a fresh `docker compose down -v && build && SEED_DEMO=1 up --wait` stack — full wizard incl. hold-back line, image upload round-trip, cross-household credit at `count × unitCost` ($10.00 line / 3 units → $9.99 credit, proving D1), draft resume after reload + abandon, plus the retrofitted slice-1 suite. Dark mode spot-checked via webkit screenshots.

Deviations from blueprint, with reasons:

- **`LedgerEntry` pulled into the slice-2 migration** (planned for slice 3): finalize must post the purchaser credit (01 D1/invariant 5, 02 step 5); deferring the table would have finalized cross-household restocks with no credit to backfill. Takes still arrive in slice 3; the model is relation-free exactly as 01 specs it.
- **Step-4 "existing product photo beside the card" comparison omitted** — no prior photos exist until products recur; the card shows the lot's own photo/placeholder. Revisit when a real repeat-purchase happens.
- **Best-by input is a native `<input type="date">`** rather than the sketched `mm/yy` field — free mobile pickers, no parsing code.
- Recent-retailer chips (step 1) skipped for now — plain text field; cheap to add once there's history to chip.
- e2e uses 1×1 JPEG fixtures rather than 50–100KB photos — the pipeline (magic-byte check, downscale, round-trip) is what's under test.

Field bug found by e2e: the slice-1 login helper's `getByText('your household')` also matches the login footer ("…a member of your household…"), so a follow-up `goto()` raced and aborted the in-flight login mutation. Helpers now wait for the URL + tab bar. Also fixed a pre-existing `react-hooks/purity` lint error on the invite page (`Date.now()` during render → moved into a loader).

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
