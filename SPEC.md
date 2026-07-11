# Potluck — Specification

**Status:** Living spec. v1 scope agreed 2026-07-02 (as "Private Coop"); the mutual-aid
network rework ("Potluck") was designed 2026-07-03 — see the
[archived rework record](./docs/archive/mutual-aid-rework-2026-07.md)
for the historical decision log. Everything below is **built and shipped**: Round 1 (network
core) and Rounds 2–4 (needs & surpluses · recipes · planner/shopping) 2026-07-04, Phase 2
(workflow IA · circles · contact layer) 2026-07-04/05, Phase 3 (email · notifications ·
auth flows · deep links) 2026-07-05, and Rounds Q–T (navigation model, recipe read/Cook
views, plan→shopping tracking, circle-picker invites) 2026-07-06. Media galleries,
share-level circle scoping, and Phase 4 (stock placements · transfers · reconcile) shipped
2026-07-07/08. This document describes the running app. Historical build records live
under [docs/archive/](./docs/archive/);
unshipped work lives only in [ROADMAP.md](./ROADMAP.md). Last synced 2026-07-11.
**History:** The 2025 attempts live in branches `archive/2025-main` and `archive/2025-take2` — reference only. Their `local_only/design_discussions/RAW_REQUIREMENTS.md` is the ancestral spec; this document is its deliberate reduction. Do not import design docs or code patterns from the archive branches without scrutiny.

## 1. What this is

A self-hosted web app (PWA) for **mutual aid between households**. Each household is a
node; people link their households with pairwise **connections** and share pantry goods
and equipment **at cost**, with a ledger that keeps things fair without creating socially
complicated debt. Networks are emergent islands of connections — there is no "the coop,"
no public directory, and no open registration; growth happens along trust edges.

Initial users: two households (ours and the in-laws down the street). Design target:
**tens of households per instance**, most of them connected to only a few others. Not
1,000. SQLite and the app-level write lock are fine at this scale; if a real instance
outgrows it, we'll extend a working system rather than pre-build for scale.

## 2. Principles

1. **At cost, always.** No markup, no fees except explicit loan fees (which default to $0).
2. **Orders are at-cost; shares are gifts.** Money moves only through the order/loan/
   settlement machinery. Needs-and-surpluses sharing never touches the ledger — a tracked
   handoff records a $0 transfer for the audit trail, nothing more.
3. **Transparent within your connections' granted scope.** Each household unilaterally
   controls what every connection may see and do with *its* resources (the resource owner
   is authoritative). A pair's ledger and balance are visible only to its two households —
   never to third parties, never to the instance admin. Within a household, members see
   household data; capability flags gate what they can *do*.
4. **Sovereignty.** Your household's data is yours. Instances are peers — nobody should
   have to join someone else's server to build a network (federation is a declared later
   target, deliberately not precluded: username/slug identity, canonical URIs, and the
   relation-free append-only ledger are the groundwork already in place).
5. **Low ceremony over precision.** FIFO is suggested, never enforced. Recounts fix
   drift. Trust is assumed inside the granted scope; the app provides *visibility*, not
   enforcement.
6. **The net number is the product.** The UI leads with one figure per household pair:
   "You're up $12.40 with the Smiths." Reciprocal use drifts it toward zero naturally.
7. **It's not done until it demonstrably works.** Every slice ends with the feature
   working in a real browser against the real stack, e2e green on both engines. No mocked
   "integration" tests, no coverage targets as goals.

## 3. Explicitly out of scope

Native apps · offline mode · Bluetooth printers and scales · classic OCR (receipt
extraction is VLM-based; manual entry is the always-available fallback) · FIFO
*enforcement* · forecasting/analytics · the cost-sharing offer engine · minimum-balance
thresholds · GDPR/compliance apparatus · SKU merging & generic SKUs · open/public
registration (ever) · friend-of-friend discovery or network browsing (connection requests
target an exact household handle exchanged out-of-band) · quota machinery for shared
operator resources (trust + the admin usage view instead).

**Designed but not yet built:** federation build-out (custom Coop↔Coop protocol target
recorded in docs/research/federation.md) · minors and the waiting-on-an-adult handoff
state. The active deferred backlog lives in [ROADMAP.md](./ROADMAP.md); the original
decision context is archived under [docs/archive/](./docs/archive/).

Doors deliberately left open (schema/design should not preclude): per-action
acting-household override · shared write-off offers · label printing · SKU merging ·
BYO extraction key and admin caps · a read-only ActivityPub surface for public surplus
feeds. (Two earlier doors have since shipped: circle-scoped pantry/item lists arrived
with Phase 2's SELECT visibility, and per-invite grant presets arrived with Round T's
circle-picker household invite.)

## 4. Domain model

**The network:**

- **Household** — a family; the node of the network. Has members (via Membership),
  pantries, items, a product catalog, and a URL-safe unique **slug** (`@heise`) — the
  handle other households use to connect, and the future `household@instance` address.
- **User** — a person, identified by a unique **username** (login: username or email;
  email stays required for recovery/contact). A user holds **N memberships** — children's
  accounts, caretakers, and people who genuinely belong to two households are all real.
  One **acting household** at a time (sticky switcher; single-membership users never see
  it): browsing scope, carts, restocks, and ledger attribution all follow it. The first
  user of an instance is the **instance admin** (growth toggle + operational usage view —
  never other households' content).
- **Membership** — user ↔ household with 11 **capability flags** (manageHousehold,
  manageConnections, receiveStock, placeOrders, spend, fulfill, adjustInventory,
  lendBorrow, postShares, editRecipes, settleMoney). Named roles (Owner/Adult/Teen/Child)
  are UI presets over the flags, individually tunable. Every authz check in code is a
  typed capability test. Every household keeps ≥1 manageHousehold holder.
- **Circle** — a household's named grant bundle (Phase 2; replaces per-connection grant
  sets). A circle carries the six directional grant flags — pantry, lending, recipes,
  shareTo, shareFrom, reshare. Three preset circles are seeded per household — Neighbors
  (shares only), Friends (+pantry/lending/recipes), Family (everything, incl. onward
  resharing) — renameable, tunable, and extendable. Circles also scope visibility:
  pantries, items, and member cards are `ALL` / `SELECT[circles]` / `PRIVATE`.
- **Connection** — a pairwise household↔household edge, `PENDING → ACTIVE → SEVERED`
  (severing is unilateral). Grants do **not** live on the edge: each side assigns the
  *other* household into one of **its own circles**, and that circle's flags are what the
  other may do with its resources — re-assignable at any time without consent (the
  resource owner is authoritative). Severing blocks new activity immediately (open orders
  auto-cancel, reservations release); active loans run to return; ledger history and the
  net **survive forever** and settlement still works. Missing visibility reads as 404 —
  existence never leaks; missing capability on a visible thing is 403.
- **Invite** — single-use, 7-day. Two kinds: **member** (join my household; a signed-in
  user accepting one gains an additional membership) and **household** (found a NEW
  household whose first connection edge is the inviter's — how instances grow; the
  inviter picks the circle the newcomer lands in, grants snapshotted at mint). The
  instance admin may restrict household invites to admin-only.

**Goods and money (blueprint 01 is authoritative for money invariants):**

- **Pantry** — a storage location owned by a household, with circle-scoped
  **visibility** (`ALL` / `SELECT[circles]` / `PRIVATE`): private is invisible to every
  connection; SELECT is visible only to connections sitting in the chosen circles; a
  visible pantry still requires the viewer's circle to carry the pantry grant. Inventory
  location is represented by Stock placements, not inferred from the receiving pantry.
- **Product** — **per-household catalog** (name, optional UPC, image gallery with one
  main image). Search and UPC matching are scoped to the acting household; browsing a
  connected pantry shows the *owner's* names. Cross-household duplicates are by design.
- **Lot / Stock** — a Lot is immutable receipt lineage and frozen unit cost; a Stock row
  is the count and reserved count for one lot in one pantry. One lot may have placements
  in several pantries. All availability and mutations go through the stock choke point;
  availability = `count - reservedCount`.
- **Restock** — one shopping trip received into a pantry. Receiving is a
  **pantry-owner-household action** (receiveStock); the **purchaser** may be the acting
  household or any actively connected one — a cross-household purchaser is credited at
  tax-inclusive cost for received units at finalize (re-verified against the live
  connection at the money moment). Receipt images are first-class and retained; VLM
  extraction is advisory; hold-backs never touch inventory or the ledger. Each received
  line may allocate units across several destination pantries before finalize. Code
  `YYMMDD-NN` is shown up front for labeling.
- **Order** — the at-cost cross-household request path: `DRAFT → REQUESTED (reserve) → PICKING
  (lock) → READY → PICKED_UP / CANCELED`. Requires placeOrders; cross-household
  submission (and any edit to a submitted cross-household order) requires **spend**; the
  owner side requires **fulfill**; browsing/ordering a connected pantry requires its
  owner's circle-granted pantry access + the pantry being visible to you — re-verified at
  pickup, where the money posts. Each order line reserves a specific Stock placement.
- **Take** — the immutable inventory-handoff record created for an order pickup or
  tracked share gift, carrying the receiving household and source pantry as snapshots
  (never re-derived from mutable membership/location state). An order handoff across
  households → TAKE ledger entry at
  `quantity × frozen unit cost`; own-pantry → inventory decrement only. Undo restores
  the original placement and posts a swapped-party REVERSAL where money moved.
- **Ledger** — append-only, pairwise, relation-free entries; balances displayed net per
  pair. Settlements and manual adjustments require **settleMoney** and a connection edge
  in any status (severed pairs stay settleable; unconnected households are unreachable).
- **Item / Loan** — durable equipment with the same circle-scoped visibility as pantries;
  borrowing a connected household's visible item rides the lending grant (+spend when a
  fee posts). The loan snapshots the borrowing household. Fee posts at checkout, at the
  snapshot amount.
- **Adjustment** — recount / write-off (adjustInventory, owner household only); never
  touches the ledger. Adjustments are anchored to Stock placements.
- **Transfer** — immutable same-household movement between pantry placements. A
  multi-line transfer is atomic and client-key-idempotent; reserved units cannot move.
- **ReconcileSession** — an opt-in, multi-user pantry/house stock-take. Draft scope
  freezes free-stock mutations while already-reserved pickups continue. Blind counts
  autosave; commit derives placement transfers and acknowledged variances, resolves any
  order shortage explicitly, and applies everything in one transaction. Drafts lazily
  abandon after 24 hours so a forgotten device cannot strand inventory.
- **InstanceSettings** — singleton: the household-invite growth toggle (more later).

**Sharing, recipes, planning (Rounds 2–4 — connection-scoped, zero new money paths):**

- **SharePost / ShareClaim** — needs & surpluses. A post may target all sharing circles
  or selected circles; circle-limited posts cannot be reshared. Claiming a surplus hands off as a
  **$0 gift take** (`Take.shareClaimId`; no ledger entry — the one sanctioned
  cross-household no-money take, blueprint-01 invariant 4). Reshares are anonymized and
  hop-limited, riding the reshare grant.
- **Recipe / RecipeIngredient / IngredientLink** — browse-live/fork-on-save over the
  recipes grant; paste-to-parse and SSRF-guarded URL import (with server-side photo
  download); a read view plus a step-by-step **Cook view** (scaling, wake-lock); a
  learned ingredient→product link map.
- **PlanEntry / ShoppingItem / CategoryAssignment** — week planner plus a persistent
  shopping list that is never silently pruned; conservative merging; "Add from Plan"
  (idempotent, per-entry or whole-week); learned categories; cross-pantry availability
  badges feed the existing order flow.

**Contact & notifications (Phases 2–3):**

- **Contact layer** — member profiles (photo/phone/bio) and household address + pickup
  notes, shown per `Membership.visibility` circles; member cards offer tel:/sms: and
  "Save contact to device" (vCard). An active connection is the gate.
- **NotificationPreference** — a per-user matrix: categories pickups/circle/ledger ×
  push+email, digest cadence (daily default / weekly / off), show-details toggle.
  Content rule: category-only — a notification stamps your own household, never a
  counterparty name/amount/address. Email splits into **transactional** (never carries
  unsubscribe) and **subscription** (RFC-8058 one-click `/unsub`). Deep links are
  navigation-only HMAC tokens: `/go` switches the acting household and routes; email
  links route-then-login-to-act, never authenticate.

## 5. Key flows

**Connect:** get a household's handle out-of-band → More → Connections → request, picking
which of **your** circles they sit in → they accept, picking theirs → either side
re-assigns the circle (or severs) unilaterally, any time.

**Onboard:** a member invite adds a person to your household (new account, or a second
membership for an existing one). A household invite founds a new household — named by the
newcomer — already connected to yours. New households add their first pantry from the
Home tab.

**Restock:** snap the receipt → VLM proposes lines → review/correct (Process / Ignore) →
set received units, unit photos, and optional per-line pantry
allocations → reconcile against the receipt total (tax folds into at-cost unit prices) →
done. Target: a full Costco receipt in ~2 minutes of active attention.

**Order:** browse an accessible pantry → add to your household's cart → request (reserves
stock) → owner picks and readies it → either side marks picked up — money posts exactly
there. Own-pantry orders run the same flow at $0.

**Lend/return:** browse shared items → check out (fee posts now, if any) → return with
optional condition note.

**Transfer:** open a source pantry → stage products/lot quantities → choose another
pantry in the same household → confirm one atomic move with an immutable audit record.

**Reconcile:** choose one or more pantries → counters claim pantry walks and enter blind
counts → review inferred moves, variances, and order shortages → acknowledge/resolve →
commit atomically or abandon without changing stock.

**Settle:** view the pair's net → record "cash/Venmo $X" → both households see it.

**Switch households** (multi-membership only): More → Acting as → switch; everything on
screen re-scopes.

## 6. Technical requirements

- **Stack:** Next.js + tRPC + Prisma + **SQLite**, single container, Docker Compose.
  TypeScript end to end; types generated from one Prisma schema.
- **Deployment:** self-hosted behind a reverse proxy with real TLS, publicly reachable
  over HTTPS. `scripts/bootstrap.ts` creates the instance settings, first household, and
  first user (= instance admin); everyone else arrives by invite.
- **Auth:** argon2id, HTTPS-only session cookies, rate-limited login (per-identifier,
  per-account, and per-IP), invite-token registration. Identity is
  username-per-instance (`[a-z0-9_-]{3,30}`); email required but not identity. The
  acting household rides its own long-lived cookie, validated against live memberships
  on every request. Phase 3 added email verification, enumeration-safe session-revoking
  password reset (no TOTP bypass), and MFA: TOTP (AES-256-GCM-encrypted secret + backup
  codes) and rate-limited emailed codes; instance admins must hold TOTP.
- **Email:** swappable SMTP transport behind two pipelines (transactional vs
  subscription); `MAIL_MODE=capture` is the default outside production — a fail-closed
  dev filter and a `CapturedEmail` audit table keep dev sends off the wire.
- **Money:** USD, integer cents, no floats. Every multi-write money operation goes
  through `dbTransaction` (the app-level lock — never raw `$transaction`); every
  money-writing mutation carries a `clientKey` for idempotency; the ledger is
  append-only. Blueprint 01's twelve invariants are the contract.
- **Media:** receipt/unit/share photos, product/item galleries, and supported attachments
  live on a disk volume referenced from the DB; backups cover DB **and** media
  (`scripts/backup.sh` / `restore.sh`). Reads must honor the owning resource's visibility.
- **Receipt extraction:** multimodal LLM API, operator's key, advisory only, degrades to
  manual entry. The admin usage view keeps per-household consumption visible (trust +
  conversation, not quotas).
- **PWA:** installable, mobile-first, camera barcode scanning, web push behind the
  per-user notification matrix (pickups/circle/ledger categories), plus email and a
  daily/weekly digest driven by an in-process scheduler.
- **Testing:** Playwright e2e against the real compose stack, both engines
  (chromium-light + webkit-dark), is the definition of done. Gates surface playwright's
  real exit code. GitHub CI runs static checks, unit tests, migration verifiers, a
  production build, the full fixture-mode e2e suite, and the extraction-off case on
  pushes and pull requests to `main`. Real devices and opt-in live SMTP/IMAP remain
  manual external checks. Unit tests exist where logic warrants them — no coverage quotas.

## 7. Build history

v1 shipped 2026-07-02 in seven vertical slices (skeleton → receiving → takes/ledger →
settlements/adjustments → VLM extraction → lending → PWA), then two iteration rounds
(receiving tweaks; orders & reservations). The Potluck rework ran in four rounds
([the archived rework record](./docs/archive/mutual-aid-rework-2026-07.md) §Round plan),
all shipped 2026-07-03/04: network
core → needs & surpluses → recipes → planner/shopping. Then **Phase 2** (2026-07-04/05:
workflow IA with Neighbors·Plan·Home·More tabs, circles, contact layer; archived rework
record P1–P7),
**Phase 3** (2026-07-05: mail, auth flows + MFA, notification matrix + digest, deep
links; archived rework record N1–N11), and **Rounds Q–T** (2026-07-06: navigation model, recipe
read/Cook views, plan→shopping tracking, circle-picker invites). Media and per-share
circle scoping followed, then **Phase 4** (2026-07-08: stock placements, transfers,
per-line receive allocation, reconcile sessions, and hardening). Build records are frozen
under [docs/archive/](./docs/archive/); active work lives in [ROADMAP.md](./ROADMAP.md).
