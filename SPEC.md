# Private Coop v2 — Specification

**Status:** Living spec. v1 scope agreed 2026-07-02. **⚠ A major rework ("Potluck" —
mutual-aid network: multi-household instances, connections with directional grants,
needs/surpluses, recipes, meal planning) was designed 2026-07-03 and supersedes parts of
this document — see [docs/REWORK.md](./docs/REWORK.md). This SPEC gets rewritten during
rework Round 1; until then it accurately describes the running pre-rework app, except
that "fully transparent" (§2.2) and the closed two-household instance model are slated
for replacement.**
**History:** The 2025 attempts live in branches `archive/2025-main` and `archive/2025-take2` — reference only. Their `local_only/design_discussions/RAW_REQUIREMENTS.md` is the ancestral spec; this document is its deliberate reduction. Do not import design docs or code patterns from the archive branches without scrutiny; most of that material is known-overengineered and the implementation was never verified working.

## 1. What this is

A self-hosted web app that lets a small circle of trusted households share their pantries and equipment **at cost**, with a ledger that keeps things fair without creating socially complicated debt.

Initial users: two households (ours and the in-laws down the street), each with a basement pantry stocked from Costco. Design target: 2–10 households. Not 1,000. If the coop ever outgrows this, we'll extend a working system rather than pre-build for scale.

## 2. Principles

1. **At cost, always.** No markup, no fees except explicit loan fees (which default to $0).
2. **Fully transparent.** Every member can see every pantry, lot, take, loan, and balance.
3. **Low ceremony over precision.** FIFO is suggested, never enforced. Recounts fix drift. Trust is assumed; the app provides *visibility*, not enforcement.
4. **The net number is the product.** The UI leads with one figure per household pair: "You're up $12.40 with the Smiths." Reciprocal use drifts it toward zero naturally.
5. **It's not done until it demonstrably works.** Every slice ends with the feature working in a real browser against the real stack. No mocked "integration" tests, no coverage targets as goals.

## 3. Explicitly out of scope (v1)

Multi-tenancy · native apps · offline mode · Bluetooth printers and scales · classic OCR (receipt extraction is VLM-based, §5; manual entry is the always-available fallback) · FIFO *enforcement* · meal planning, recipes, shopping lists · forecasting/analytics · the cost-sharing offer engine · minimum-balance thresholds · GDPR/compliance apparatus · SKU merging & generic SKUs.

Doors deliberately left open (schema/design should not preclude): shared write-off offers (one offer/accept screen), label printing (Android Web Bluetooth or companion tool — iOS Safari will never get Web Bluetooth), SKU merging, multi-tenancy, native app (the PWA acts as its spec). *(Orders/reservations were an open door; they shipped 2026-07-03 — see the Order model below.)*

## 4. Domain model

- **Household** — a family. Has members (Users) and pantries. v1 ships with two.
- **User** — belongs to exactly one household. Invite-only registration (no open signup — this app faces the public internet).
- **Pantry** — a storage location owned by a household (basement shelves, chest freezer). The owner household owns every lot in it, regardless of who stocked it.
- **Product** — name, optional UPC/PLU, display photo (sourced from the newest lot's unit photo). Created on the fly during receiving. (No merging or generic rollups in v1.)
- **Restock** — one shopping trip's receipt processed into a pantry: receipt image(s), retailer, date, purchaser household, line items, receipt total. Auto-assigned code **`YYMMDD-NN`** (NN = nth restock that day). Physical lot marking is the store owner's business — crate label, masking tape, price gun; the app only needs the code to be findable.
  - **Receipt images are first-class and retained permanently.** They drive the receiving flow, serve as the audit artifact, and can be re-processed later as extraction improves. Multiple photos per restock (multi-page receipts, multiple receipts per trip).
  - **Extraction:** receipt images go to a multimodal LLM, which proposes structured lines (description, unit count, unit price, line total). The user reviews and corrects everything in the receiving screen; extraction is advisory, user confirmation is the source of truth.
  - **Hold-backs:** per line, the user sets how many units actually go into the pantry (default: all). Held-back units are the purchaser's private goods — they never touch inventory or the ledger. A line can be received at 0 (personal items on a mixed receipt).
  - Each received line becomes a **Lot**: product, unit count (bulk packs broken into eaches at entry), unit cost, optional best-by date.
  - **Unit photo per lot:** the user photographs one unit at receiving. This documents what that lot's packaging looks like (designs change over time) and the newest one doubles as the product's display photo.
  - The receipt total is checked against the sum of lines **plus entered tax and fees** — the fairness/typo guard. Tax is distributed pro-rata across taxable lines and (optionally) fees across all lines, folded into each lot's at-cost unit price so takes and credits are tax-inclusive. Whole non-inventory receipt lines can be marked *excluded* (counted for reconcile/fee weight, not stocked). The `YYMMDD-NN` code is shown up front for labeling as items are shelved.
  - **If the purchaser is not the pantry owner, the purchaser's household is credited at cost — for received units only.** (This is how "settling a positive balance in goods" works, and how "I grabbed you a flat of tomatoes at Costco" works.)
- **Order** — the way units leave a pantry. A household builds a cart against one pantry, then requests it; **everything is a request — there is no instant take.** Lifecycle: **DRAFT** (building the cart) → **REQUESTED** (units reserved, so availability = stock − reserved) → **PICKING** (owner is fulfilling; edits lock) → **READY** → **PICKED_UP**, or **CANCELED** (only before picking; releases the reservation). Lot-specific lines (oldest lot is the FIFO suggestion). Own-pantry orders run the same flow (you fulfill your own).
- **Take** — the immutable record created **at pickup**, one per order line: cross-household → requester debited at unit cost; own pantry → inventory decrement only. **All takes are logged, including own-household**, so counts, low-stock, and expiry views stay true. Money posts *only* at pickup — a canceled order never touches the ledger. Takes are undoable (covers returns) via a swapped-party reversal.
- **Ledger** — append-only entries from takes, restock credits, loan fees, settlements, and manual adjustments (with notification). Balances are per household pair, displayed net.
- **Settlement** — a manual record: "cash/Venmo $X from us to them." No payment integration.
- **Adjustment** — recount (set a lot's remaining count) or write-off (expired/damaged; owner household eats the cost in v1).
- **Item** (durable) — equipment owned by a household: name, photo, notes, optional per-loan fee (default $0, for maintenance-heavy or partially consumable gear).
- **Loan** — item + borrower + out date + optional due date + returned date + condition notes. Fee posts to the ledger on checkout.

## 5. Key flows

**Restock (the make-or-break UX):** snap the receipt (multiple pages fine) → VLM proposes lines → review and correct → set received units per line (default all) → snap one unit photo per new lot → reconcile against receipt total → done. The restock code is displayed big at the end for physical labeling. Target: a full Costco receipt in ~2 minutes of active attention. Manual line entry works standalone whenever extraction fails or isn't worth it.

**Order:** open pantry → add items to your order (search/scan; oldest lot suggested) → review the cart → request. The owner sees the request, picks it, marks it ready; either household marks it picked up (money posts then). Own-pantry orders you fulfil yourself.

**Lend/return:** browse items → check out → return with optional condition note.

**Settle:** view net position → record payment → both households notified.

## 6. Technical requirements

- **Stack:** Next.js + tRPC + Prisma + **SQLite**, single container, Docker Compose. TypeScript end to end; types generated from one schema.
- **Deployment:** self-hosted behind a reverse proxy with real TLS, **publicly reachable over HTTPS**.
- **Auth:** production-grade from day one — argon2id password hashing, HTTPS-only session cookies, rate-limited login, invite-token registration. Passkeys are a welcome later addition, not a v1 requirement.
- **Images:** receipt photos and unit/item photos stored on a disk volume, referenced from the DB. Backups cover DB **and** images.
- **Receipt extraction:** multimodal LLM API (Anthropic Claude or similar); needs an API key in config. Volume is a few receipts a week, so cost is negligible. Must degrade gracefully to manual entry when the API is unavailable.
- **PWA:** installable, responsive, mobile-first. Camera barcode scanning via JS/WASM library (no BarcodeDetector on iOS Safari). Web push for installed PWAs (supported on iOS 16.4+) in a later slice.
- **Backups:** SQLite file copy or Litestream plus the images volume; documented, tested restore.
- **Money:** USD, integer cents, no floats.
- **Testing:** Playwright e2e per slice against the real compose stack is the definition of done. Unit tests where logic warrants them — no coverage quotas.

## 7. Build plan — vertical slices

Each slice is **demonstrated working in a browser** before the next begins. Progress is tracked in [PLAN.md](./PLAN.md) — slice status plus dated progress notes. No external ticketing.

1. **Skeleton** — compose stack, auth with invites, both households/users/pantries created and visible.
2. **Receiving** — receipt photo capture, manual line review/receive flow, hold-backs, lots with codes, unit photos, pantry inventory view. (Highest-risk UX goes first; this slice builds the exact review screen the VLM later prefills.)
3. **Takes & ledger** — take flow, FIFO suggestion, ledger entries, net position screen.
4. **Settlements & adjustments** — record payments, recounts, write-offs. *The app is usable for real from here.*
5. **VLM extraction** — receipt images prefill the slice-2 review screen.
6. **Lending** — items, loans, returns, fees.
7. **PWA polish** — installability, camera scanning, push notifications.

Iteration rounds on top of v1 (2026-07-03): receiving tweaks (tax-inclusive costs, corrections) and **orders/requests with reservation** (§4 Order/Take). Still on the post-v1 list, in rough order of likely want: shared write-off offers · a fuller notifications system (push + email + in-app panel + prefs) · label printing · SKU merging/generics · low-stock nudges.
