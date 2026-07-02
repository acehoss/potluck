# Private Coop v2 — Specification

**Status:** Living spec. v1 scope agreed 2026-07-02.
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

Multi-tenancy · native apps · offline mode · Bluetooth printers and scales · classic OCR (receipt extraction is VLM-based, §5; manual entry is the always-available fallback) · FIFO *enforcement* · reservations/order picking · meal planning, recipes, shopping lists · forecasting/analytics · the cost-sharing offer engine · minimum-balance thresholds · GDPR/compliance apparatus · SKU merging & generic SKUs.

Doors deliberately left open (schema/design should not preclude): shared write-off offers (one offer/accept screen), reservations, label printing (Android Web Bluetooth or companion tool — iOS Safari will never get Web Bluetooth), SKU merging, multi-tenancy, native app (the PWA acts as its spec).

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
  - The receipt total is checked against the sum of lines — the fairness/typo guard.
  - **If the purchaser is not the pantry owner, the purchaser's household is credited at cost — for received units only.** (This is how "settling a positive balance in goods" works, and how "I grabbed you a flat of tomatoes at Costco" works.)
- **Take** — a user removes N units from a lot (identified by product + restock code; UI pre-selects the oldest lot as the FIFO suggestion). Cross-household → taker debited at unit cost. Own pantry → inventory decrement only. **All takes are logged, including own-household**, so counts, low-stock, and expiry views stay true. Takes can be edited/undone (covers returns).
- **Ledger** — append-only entries from takes, restock credits, loan fees, settlements, and manual adjustments (with notification). Balances are per household pair, displayed net.
- **Settlement** — a manual record: "cash/Venmo $X from us to them." No payment integration.
- **Adjustment** — recount (set a lot's remaining count) or write-off (expired/damaged; owner household eats the cost in v1).
- **Item** (durable) — equipment owned by a household: name, photo, notes, optional per-loan fee (default $0, for maintenance-heavy or partially consumable gear).
- **Loan** — item + borrower + out date + optional due date + returned date + condition notes. Fee posts to the ledger on checkout.

## 5. Key flows

**Restock (the make-or-break UX):** snap the receipt (multiple pages fine) → VLM proposes lines → review and correct → set received units per line (default all) → snap one unit photo per new lot → reconcile against receipt total → done. The restock code is displayed big at the end for physical labeling. Target: a full Costco receipt in ~2 minutes of active attention. Manual line entry works standalone whenever extraction fails or isn't worth it.

**Take:** open pantry → find product (search/scan) → app suggests oldest lot → confirm count → done. Two taps for the common case.

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

Post-v1 candidates, in rough order of likely want: shared write-off offers · reservations · label printing · SKU merging/generics · low-stock nudges.
