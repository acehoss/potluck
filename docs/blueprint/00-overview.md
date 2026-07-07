# 00 — Blueprint overview

Design blueprint for slices 2–7, extending the live slice-1 app (Next 16 + Prisma 7/SQLite +
tRPC). Read the section that owns a question; cross-references are authoritative in the
direction stated below.

> **Potluck / Round 1 — network core (shipped 2026-07-04).** The app was reorganized around
> mutual aid and renamed **Potluck**: households are now **nodes** joined by pairwise
> **connections**, each Membership carries capability flags, and reads are connection-scoped
> (the old "everyone sees everything" is gone — a pair's ledger is visible only to its two
> households). SPEC.md was rewritten to match; 01–04 are **amended inline** below (decisions
> 9/10 here; the marked sections in 02/04). Decision log: [../REWORK.md](../REWORK.md);
> as-built behavior + gates: PLAN.md's "Round 1 slice N" sections (pointer at the foot of
> this file).

> **After the Round-1 freeze (dated pointers — PLAN.md/REWORK.md own the detail).**
> **Rework Rounds 2–4 + Phase 2 (2026-07-04/05):** shares · recipes · planner+shopping,
> then the workflow IA flip (tabs Neighbors · Plan · Home · More), **circles** as the
> entire permissions model, and the contact layer — REWORK.md "Phase 2" (P1–P7).
> **Phase 3 (2026-07-05):** mail transport, email verification + password reset + MFA,
> the notification preference matrix + digest, RFC-8058 `/unsub`, nav-only `/go` deep
> links — REWORK.md "Phase 3" (N1–N11); decision 9 below is amended accordingly.
> **Rounds Q–T (2026-07-06):** device-feedback polish — history-aware back navigation,
> recipe read + Cook views, URL-import photo download, plan↔shopping wiring, dvh tab
> bar, contact vCard — PLAN.md's per-round records (newest first).

## Section index

| File | Owns |
| --- | --- |
| `01-data-model.md` | Prisma models, money math (D1–D8), authz matrix, immutability rules, the 12 money invariants. **Authoritative for all money/lifecycle questions.** |
| `02-ux-flows.md` | Navigation shell, every screen/sheet, tap budgets, per-slice Playwright anchors. Cites 01 for math/lifecycle. |
| `03-design-system.md` | Semantic color tokens (light/dark via `prefers-color-scheme`), Tailwind v4 conventions, component recipes, verified WCAG contrast. |
| `04-infra.md` | Image pipeline, barcode scanning, VLM extraction (modes: off/fixture/live), PWA/push, mail transport (+ capture mode), MFA/auth-flow infra, the notification layer + in-process digest scheduler, HMAC deep links, container/compose changes, env vars. |

## Ten load-bearing decisions

1. **D1 money math (01):** `unitCostCents = roundHalfUp(lineTotal/purchasedCount)` frozen at finalize; *all* ledger movement is `count × unitCostCents`, so credits and take-debits cancel exactly. Drift exists only vs the paper receipt.
2. **Append-only ledger (01):** `LedgerEntry` never updated/deleted; corrections are swapped-party REVERSALs. Wrong restock credits use the linked correct-credit op, never free-form adjustments.
3. **Line = Lot (01 D4):** receipt lines *are* draft Lot rows; finalize (`DRAFT→FINALIZED`, terminal) freezes prices, sets `remainingCount`, posts the credit, assigns the code. No separate RestockLine.
4. **Guarded counters (01 D3):** `remainingCount` mutates only via in-tx conditional `updateMany`; takes guard on stock, undos on `reversedAt: null`, adjustments on server-read `countBefore`.
5. **Settlement is a LedgerEntry (01 D5),** payer = creditor; adjustments (recount/write-off) never touch the ledger in v1 — the owner eats drift.
6. **Semantic tokens only (03):** Tailwind default palette deleted; `bg-surface`/`text-text` etc., dark mode is a token swap (never `dark:`), grep-enforced in CI.
7. **Client-side image pipeline (04 §1):** canvas downscale to ≤2048px JPEG, multipart upload to a route handler (not Server Actions), authenticated image serving. No sharp, no native deps.
8. **Extraction is advisory (04 §3):** Claude structured outputs behind `EXTRACTION_MODE=off|fixture|live`; failures degrade to manual entry, never block. Fixture mode keys on client-computed sha of the *original* file.
9. **Notifications are a preference matrix (rewritten 2026-07-05, Phase 3; was "push is
   minimal: exactly two events — settlement recorded, manual ledger adjustment — no
   schedulers, no background jobs anywhere").** `notify()` (`src/server/push.ts` over
   `src/server/notify/`) fans each event out per recipient across **three opt-out
   categories × two channels** — pickups / circle / ledger × push + email (defaults:
   pickups both ON, circle push-only, ledger all-OFF — money noise is opt-in). Content is
   **category-only** (N4): stamped with the recipient's OWN household name, never a
   counterparty name/$/address (the counterparty *name* only behind the per-user
   `showDetails` opt-in). Recipients still resolve via **Membership** rows with per-user
   dedupe + actor exclusion. Notification email rides the RFC-8058 one-click-unsubscribe
   pipeline (`/unsub`). And one background job now exists: `src/instrumentation.ts` arms an
   **in-process digest scheduler** at boot (a ~10-min `setInterval`, `unref`'d,
   `DIGEST_SCHEDULER=off` falls back to the cron `run-digest` script) driving the per-user
   daily/weekly digest, plus a boot-time orphan-image sweep — still no external cron/queue
   infra.
10. **Capability × grant authz (rewritten 2026-07-04; was "trust-but-gate: everyone sees
    everything, money writes household/creator-gated").** Authz is now two independent axes ×
    a visibility flag: **Membership capability flags** (11 — `src/server/capabilities.ts`;
    named roles Owner/Adult/Teen/Child are UI presets, never a schema concept) gate what a
    member may *do*; **directional Connection grants** (6 — `src/server/authz.ts`; the
    resource owner controls its own side unilaterally, **ACTIVE edges only**) × per-pantry/
    item **shared/private** flags gate what a household may *reach*. Reads are
    connection-scoped: a pair's ledger and balance are visible only to its two households,
    never a third party. Error convention — **403** = capability failure on a thing you can
    see; **404** = visibility failure (existence never leaks). Money **reach** is re-verified
    at the money moment (order pickup, restock finalize), not just at draft/build time.

## Per-slice pointers

| Slice | Ships | Read |
| --- | --- | --- |
| 2 | Receiving wizard, pantry inventory, tab shell, token migration | 01 (models, D1/D4/D6/D7), 02 (wizard, nav), 03 (all), 04 §1 |
| 3 | Takes, ledger, net position | 01 (Take/LedgerEntry, invariants 1–4), 02 (take flow, ledger) |
| 4 | Settle, recount/write-off, manual adjustment, `LedgerSeen`, backups | 01 (Adjustment, D5, authz), 02 (settle/adjust sheets), 04 §5 |
| 5 | VLM receipt extraction | 04 §3, 01 (extraction columns), 02 (step-3 prefill) |
| 6 | Lending (items, loans, fees) | 01 (Item/Loan, invariant 10), 02 (lending) |
| 7 | PWA, push, barcode scan | 04 §2/§4, 02 (PWA section) |

**Potluck Round 1 (network core)** ships outside this v1 slice table. Its four network-core
slices — schema/data migration → capability+grant authz & acting household → connection
management UI → onboarding + instance admin — are recorded in **PLAN.md's "Round 1 slice N"
sections** (behavior as built + the e2e gates); SPEC §4 is the current domain contract and
`docs/REWORK.md` the decision log.

Definition of done per slice: the Playwright anchors at the end of `02-ux-flows.md`, run
against the compose stack on chromium (light) + webkit (dark).
