# 00 — Blueprint overview

Design blueprint for slices 2–7, extending the live slice-1 app (Next 16 + Prisma 7/SQLite +
tRPC). Read the section that owns a question; cross-references are authoritative in the
direction stated below.

## Section index

| File | Owns |
| --- | --- |
| `01-data-model.md` | Prisma models, money math (D1–D8), authz matrix, immutability rules, the 12 money invariants. **Authoritative for all money/lifecycle questions.** |
| `02-ux-flows.md` | Navigation shell, every screen/sheet, tap budgets, per-slice Playwright anchors. Cites 01 for math/lifecycle. |
| `03-design-system.md` | Semantic color tokens (light/dark via `prefers-color-scheme`), Tailwind v4 conventions, component recipes, verified WCAG contrast. |
| `04-infra.md` | Image pipeline, barcode scanning, VLM extraction (modes: off/fixture/live), PWA/push, container/compose changes, env vars. |

## Ten load-bearing decisions

1. **D1 money math (01):** `unitCostCents = roundHalfUp(lineTotal/purchasedCount)` frozen at finalize; *all* ledger movement is `count × unitCostCents`, so credits and take-debits cancel exactly. Drift exists only vs the paper receipt.
2. **Append-only ledger (01):** `LedgerEntry` never updated/deleted; corrections are swapped-party REVERSALs. Wrong restock credits use the linked correct-credit op, never free-form adjustments.
3. **Line = Lot (01 D4):** receipt lines *are* draft Lot rows; finalize (`DRAFT→FINALIZED`, terminal) freezes prices, sets `remainingCount`, posts the credit, assigns the code. No separate RestockLine.
4. **Guarded counters (01 D3):** `remainingCount` mutates only via in-tx conditional `updateMany`; takes guard on stock, undos on `reversedAt: null`, adjustments on server-read `countBefore`.
5. **Settlement is a LedgerEntry (01 D5),** payer = creditor; adjustments (recount/write-off) never touch the ledger in v1 — the owner eats drift.
6. **Semantic tokens only (03):** Tailwind default palette deleted; `bg-surface`/`text-text` etc., dark mode is a token swap (never `dark:`), grep-enforced in CI.
7. **Client-side image pipeline (04 §1):** canvas downscale to ≤2048px JPEG, multipart upload to a route handler (not Server Actions), authenticated image serving. No sharp, no native deps.
8. **Extraction is advisory (04 §3):** Claude structured outputs behind `EXTRACTION_MODE=off|fixture|live`; failures degrade to manual entry, never block. Fixture mode keys on client-computed sha of the *original* file.
9. **Push is minimal (02/04):** exactly two events — settlement recorded, manual ledger adjustment. No schedulers, no background jobs anywhere.
10. **Trust-but-gate authz (01):** everyone sees everything; money-posting writes (finalize, delete-DRAFT, credit correction, recount) are household/creator-gated per the matrix.

## Per-slice pointers

| Slice | Ships | Read |
| --- | --- | --- |
| 2 | Receiving wizard, pantry inventory, tab shell, token migration | 01 (models, D1/D4/D6/D7), 02 (wizard, nav), 03 (all), 04 §1 |
| 3 | Takes, ledger, net position | 01 (Take/LedgerEntry, invariants 1–4), 02 (take flow, ledger) |
| 4 | Settle, recount/write-off, manual adjustment, `ledgerSeenAt`, backups | 01 (Adjustment, D5, authz), 02 (settle/adjust sheets), 04 §5 |
| 5 | VLM receipt extraction | 04 §3, 01 (extraction columns), 02 (step-3 prefill) |
| 6 | Lending (items, loans, fees) | 01 (Item/Loan, invariant 10), 02 (lending) |
| 7 | PWA, push, barcode scan | 04 §2/§4, 02 (PWA section) |

Definition of done per slice: the Playwright anchors at the end of `02-ux-flows.md`, run
against the compose stack on chromium (light) + webkit (dark).
