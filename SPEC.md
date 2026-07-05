# Potluck — Specification

**Status:** Living spec. v1 scope agreed 2026-07-02 (as "Private Coop"); the mutual-aid
network rework ("Potluck") was designed 2026-07-03 — see [docs/REWORK.md](./docs/REWORK.md)
for the full decision log — and its **Round 1 (network core) shipped 2026-07-04**. This
document was rewritten then and describes the running app. Rounds 2–4 (needs &
surpluses → recipes → planner/shopping) are designed but not built; their contracts live
in REWORK.md until they ship.
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
   settlement machinery. Needs-and-surpluses sharing (Round 2) never touches the ledger —
   a tracked handoff records a $0 transfer for the audit trail, nothing more.
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

**Designed but not yet built** (contracts in REWORK.md): needs & surpluses with
hop-limited resharing (Round 2) · recipes (Round 3) · meal planner + shopping lists
(Round 4) · the notifications round (push/email/in-app panel/prefs — order lifecycle,
share/claim, and connection events accumulate as triggers until then) · federation
build-out (custom Coop↔Coop protocol target recorded in docs/research/federation.md).

Doors deliberately left open (schema/design should not preclude): per-connection pantry/
item lists · per-invite capability presets · per-action acting-household override ·
shared write-off offers · label printing · SKU merging · BYO extraction key and admin
caps · a read-only ActivityPub surface for public surplus feeds.

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
- **Connection** — a pairwise household↔household edge, `PENDING → ACTIVE → SEVERED`
  (severing is unilateral). Carries **two directional grant sets** (pantry, lending,
  recipes, shareTo, shareFrom, reshare): each side controls what the *other* may do with
  its resources and may tighten at any time without consent. Presets: Neighbor
  (shares only), Friend (+pantry/lending/recipes), Family (everything). Severing blocks
  new activity immediately (open orders auto-cancel, reservations release); active loans
  run to return; ledger history and the net **survive forever** and settlement still
  works. Missing visibility reads as 404 — existence never leaks; missing capability on
  a visible thing is 403.
- **Invite** — single-use, 7-day. Two kinds: **member** (join my household; a signed-in
  user accepting one gains an additional membership) and **household** (found a NEW
  household whose first connection edge is the inviter's — how instances grow). The
  instance admin may restrict household invites to admin-only.

**Goods and money (mechanics unchanged from v1 — blueprint 01 is authoritative):**

- **Pantry** — a storage location owned by a household, with a **shared/private flag**:
  a private pantry is invisible to every connection; a shared one is visible identically
  to every pantry-granted connection. Owner household owns every lot in it.
- **Product** — **per-household catalog** (name, optional UPC, derived photo). Products
  belong to the household whose pantry their lots live in; search and UPC matching are
  scoped to the acting household; browsing a connected pantry shows the *owner's* names.
  Cross-household duplicates are by design.
- **Restock** — one shopping trip received into a pantry. Receiving is a
  **pantry-owner-household action** (receiveStock); the **purchaser** may be the acting
  household or any actively connected one — a cross-household purchaser is credited at
  tax-inclusive cost for received units at finalize (re-verified against the live
  connection at the money moment). Receipt images are first-class and retained; VLM
  extraction is advisory; hold-backs never touch inventory or the ledger. Code `YYMMDD-NN`
  shown up front for labeling.
- **Order** — the only way units leave a pantry: `DRAFT → REQUESTED (reserve) → PICKING
  (lock) → READY → PICKED_UP / CANCELED`. Requires placeOrders; cross-household
  submission (and any edit to a submitted cross-household order) requires **spend**; the
  owner side requires **fulfill**; browsing/ordering a connected pantry requires its
  owner's pantry grant + the pantry being shared — re-verified at pickup, where the money
  posts. Availability everywhere = remaining − reserved.
- **Take** — the immutable record created at pickup, one per order line, carrying the
  requester household as a snapshot (never re-derived from the user, whose memberships
  can change). Cross-household → TAKE ledger entry at `quantity × frozen unit cost`;
  own-pantry → inventory decrement only. Undoable via swapped-party REVERSAL.
- **Ledger** — append-only, pairwise, relation-free entries; balances displayed net per
  pair. Settlements and manual adjustments require **settleMoney** and a connection edge
  in any status (severed pairs stay settleable; unconnected households are unreachable).
- **Item / Loan** — durable equipment with a shared/private flag; borrowing a connected
  household's shared item rides the lending grant (+spend when a fee posts). The loan
  snapshots the borrowing household. Fee posts at checkout, at the snapshot amount.
- **Adjustment** — recount / write-off (adjustInventory, owner household only); never
  touches the ledger in v1.
- **InstanceSettings** — singleton: the household-invite growth toggle (more later).

## 5. Key flows

**Connect:** get a household's handle out-of-band → More → Connections → request with a
grant preset → they accept with their own preset → each side tunes its grants (or severs)
unilaterally, any time.

**Onboard:** a member invite adds a person to your household (new account, or a second
membership for an existing one). A household invite founds a new household — named by the
newcomer — already connected to yours. New households add their first pantry from the
Home tab.

**Restock:** snap the receipt → VLM proposes lines → review/correct (Confirm a match /
Process / Ignore) → set received units and unit photos → reconcile against the receipt
total (tax folds into at-cost unit prices) → done. Target: a full Costco receipt in ~2
minutes of active attention.

**Order:** browse an accessible pantry → add to your household's cart → request (reserves
stock) → owner picks and readies it → either side marks picked up — money posts exactly
there. Own-pantry orders run the same flow at $0.

**Lend/return:** browse shared items → check out (fee posts now, if any) → return with
optional condition note.

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
  on every request.
- **Money:** USD, integer cents, no floats. Every multi-write money operation goes
  through `dbTransaction` (the app-level lock — never raw `$transaction`); every
  money-writing mutation carries a `clientKey` for idempotency; the ledger is
  append-only. Blueprint 01's twelve invariants are the contract.
- **Images:** receipt/unit/item photos on a disk volume, referenced from the DB; backups
  cover DB **and** images (`scripts/backup.sh` / `restore.sh`).
- **Receipt extraction:** multimodal LLM API, operator's key, advisory only, degrades to
  manual entry. The admin usage view keeps per-household consumption visible (trust +
  conversation, not quotas).
- **PWA:** installable, mobile-first, camera barcode scanning, web push (two events in
  v1: settlement recorded, manual adjustment posted).
- **Testing:** Playwright e2e against the real compose stack, both engines
  (chromium-light + webkit-dark), is the definition of done. Gates surface playwright's
  real exit code. Unit tests where logic warrants them — no coverage quotas.

## 7. Build plan

v1 shipped 2026-07-02 in seven vertical slices (skeleton → receiving → takes/ledger →
settlements/adjustments → VLM extraction → lending → PWA), then two iteration rounds
(receiving tweaks; orders & reservations). The Potluck rework runs in four rounds
([docs/REWORK.md](./docs/REWORK.md) §Round plan): **Round 1 — network core — shipped
2026-07-04** (schema/data migration, capability × grant authz, connection management,
onboarding + admin, rebrand). Rounds 2–4: needs & surpluses → recipes → planner/shopping.
Progress notes live in [PLAN.md](./PLAN.md); no external ticketing.
