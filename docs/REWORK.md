# Mutual-aid rework — vision & decision log

**Status:** design locked 2026-07-03 (grilling complete). This doc is the implementation
seed: a fresh session starts here. Every decision below is either **DECIDED** (Aaron
answered) or **ASSUMED (veto-able)** (recommended default recorded for veto — treat as
decided unless Aaron objects). SPEC.md gets rewritten as part of Round 1; until then SPEC
describes the pre-rework app.

## The pitch (Aaron, 2026-07-03)

Rebrand and reorganize the app around **mutual aid**:

- **Household as node.** An instance no longer hosts one closed circle; each household is
  a node, and people connect to link their households. Networks are emergent islands of
  pairwise connections, with degrees of separation.
- **Per-connection capabilities.** A connection carries attributes/levels that enable
  pantry access, lending, needs/surplus sharing, etc. per counterparty.
- **Sovereignty + future federation.** Open source (already GPLv3). Nobody should have to
  join Aaron's instance to build a network — instances will eventually federate. Don't
  build federation now; don't preclude it either. Identity moves toward
  username-on-instance rather than email-as-ID; one human may hold accounts on multiple
  instances. Existing protocol if one fits; custom is fine — no contortions.
- **Needs & surpluses.** Advertise a surplus ("made too much dinner") or a need ("need a
  hedge trimmer") to your network. Expiration dates; a claim mechanism so everyone can see
  when it's met/gone. Connections can **reshare** (anonymized) to *their* network with a
  TTL/hop limit; the resharer brokers the handoff. Per-connection flag controls whether
  sharing flows to/from that connection.
- **Recipe book.** Recipes with some smart linkage to pantry items; shareable (which makes
  the linking tricky).
- **Shopping lists + calendar.** Recipes get scheduled; schedules build shopping lists;
  list items link to pantry stock across the network (becoming orders) and the remainder
  is shopped at stores. Model these three features closely on
  [Plan to Eat](https://www.plantoeat.com) — Aaron uses and likes it — plus the
  pantry-ordering integration.

## Grounding facts (from the codebase, 2026-07-03)

- Identity: `User.email` is `@unique` and is the login ID. `User.householdId` — exactly
  one household per user. No roles/admin concept anywhere; `scripts/bootstrap.ts` creates
  the first household.
- `Product` is **instance-global** (no `householdId`) — all households share one product
  namespace and UPC index. Fine for two trusted families; a real decision once strangers
  share an instance.
- `LedgerEntry` is already **pairwise** (`creditorHouseholdId`/`debtorHouseholdId`,
  relation-free, append-only, integer cents) — the network model mostly doesn't disturb it.
- IDs are `cuid()` strings throughout — no auto-increment IDs to haunt federation.
- License: GPLv3 (committed `LICENSE`).
- VLM receipt extraction spends the **instance operator's** Anthropic API key; images
  consume the operator's disk. Multi-household instances make these shared-resource
  questions (budgets/quotas/BYO-key).
- SPEC principle 2 today: "Fully transparent — every member can see every pantry, lot,
  take, loan, and balance." A connection-scoped network breaks this principle as written;
  it needs a deliberate rewrite, not a silent one.

## Decision log

Statuses: **OPEN** (not yet discussed) · **DECIDED** (answer recorded) · **DEFERRED**
(explicitly punted with a door left open). Recommendations are Claude's, recorded before
Aaron answers so the reasoning trail survives.

### A. Foundation & identity

- **A1. Instance growth / registration — DECIDED (2026-07-03).** Growth along trust
  edges: any member can invite a NEW household; accepting the invite creates the household
  AND an initial connection to the inviter's household (the invite is the first edge). An
  instance-admin role (first user) can restrict new-household invites to admin-only. No
  open/public registration, ever. (Implies A4: an admin role now exists.)
- **A2. Username identity — DECIDED (2026-07-03).** Login/identity = username, unique per
  instance, conservative charset (final: `[a-z0-9_-]`, 3–30) so `user@instance` addressing
  works at federation time. Email stays REQUIRED and unique — recovery, notifications,
  admin contact — but is no longer the identity. Existing users get usernames assigned at
  migration.
- **A3. User ↔ household — DECIDED (2026-07-03).** **Full multi-membership with
  per-household roles/permissions.** A user can belong to N households; each membership
  carries its own role/permission set — accounts are never second-class, but not every
  member holds every permission. Motivating cases: children's accounts (and a future
  chore-tracking avenue), caretaker/partial-access relationships. Aaron accepts this means
  RBAC-or-similar — a deliberately big lift. Consequences: a `Membership` join entity
  replaces `User.householdId`; mutations gain an "acting household" context (household can
  no longer be derived user→household — Take/Order/Loan/Restock attribution all touch
  this); authz reworks from "member of household" to "membership with capability X".
  - **A3a. Permission-system shape — DECIDED (2026-07-03).** Capability flags + role
    presets: `Membership` carries app-defined capability flags (manage-household,
    manage-connections, order/spend, receive-stock, lend/borrow, post-shares,
    settle-money, …); named roles (Owner/Adult/Teen/Child) are UI presets that set flags;
    every authz check in code is a typed capability test. No user-defined permission
    vocabulary. Exact flag vocabulary to be drafted at synthesis (note: order/spend may
    split own-pantry vs cross-household since only the latter moves money).
  - **A3b. Acting-household context UX — DECIDED (2026-07-03).** Sticky switcher: one
    active household at a time, set via a switcher (header/More), persisted across
    sessions. Browsing scope, carts, restocks, and ledger attribution all follow the
    active household. Single-membership users never see the switcher. Per-action override
    is a door, not a feature.
  - **A3c. Invariants — ASSUMED (veto-able).** Every household keeps ≥1 membership with
    manage-household; manage-household holders grant/revoke memberships and roles; the
    last owner can't demote/remove themselves; instance-admin CLI is break-glass.
- **A4. Instance-admin role — DECIDED via A1 (2026-07-03).** An instance-admin role
  exists (first user = admin). Controls at least: the new-household-invite toggle;
  presumably quotas/budgets (D2) and future instance settings. Exact admin surface TBD
  under D2/D3.

### B. Connections

- **B1. Connection primitive — ASSUMED (veto-able).** Pairwise household↔household row;
  members with manage-connections initiate/accept for their household; lifecycle
  `PENDING → ACTIVE → SEVERED` (severing unilateral). New-household invites create an
  ACTIVE connection automatically (A1); same-instance connections use in-app
  request/accept.
- **B2. Per-connection capabilities — DECIDED (2026-07-03).** **Directional grants +
  presets.** One Connection row, two grant sets: each household unilaterally controls
  what the OTHER may do with its resources (browse/order pantry, borrow items, send
  needs/surpluses, see recipes, …) and may tighten/revoke at any time without the other's
  consent. Asymmetric generosity is expressible. "Levels" are named presets over the
  flags (mirrors A3a). Aligns with the federation report's "resource owner is
  authoritative" principle. Exact grant vocabulary drafted at synthesis alongside the
  A3a capability list.
- **B3. Grant granularity — DECIDED (2026-07-03).** Per-pantry (and per-item)
  household-wide **shared/private flag**, gated by the connection grant: a connection with
  the pantry grant sees exactly the shared set, identically for every connection. Two
  switches ("is it shared at all" × "is this connection granted"); per-connection
  pantry/item lists remain a door. Migration: existing pantries/items default to shared.
- **B4. Visibility rewrite — ASSUMED (veto-able).** Between households: you see only what
  your connections grant; a pair's ledger/balance is visible only to its two households;
  no third-party balances or activity, ever. Within a household: members see all
  household-scoped data by default (capability flags may later gate money views for
  children). Instance admin sees operational data (usage, quotas), not other households'
  content — sovereignty applies inside the instance too.
- **B5. Degrees of connection — ASSUMED (veto-able).** No degree-based features beyond
  needs/surplus resharing. No friend-of-friend discovery, no network browsing, no
  browsable instance directory: connection requests target an exact household handle you
  got out-of-band (or ride a new-household invite, A1).
- **B6. Severing — ASSUMED (veto-able).** Severing blocks new activity immediately; open
  orders auto-cancel (reservations release); active loans survive until returned (return/
  undo flows still work across a severed edge); ledger history and the net balance survive
  forever and settlement can still be recorded; posts shared via the severed edge stop
  propagating and disappear from the severed side.

### C. Money & ledger under mutual aid

- **C1. Do needs/surpluses touch the ledger? — DECIDED (2026-07-03).** **Always gifts.**
  Needs/surplus transfers never post to the ledger. Claiming tracked pantry surplus
  records a $0 transfer (inventory decrements with a full audit trail, no money). At-cost
  transfer remains what orders are for. Moral line: **orders = at-cost, shares = free.**
  The rest of the money model (at-cost orders, loan fees, settlements, append-only
  ledger) is unchanged by the rebrand.
- **C2. Ledger stays pairwise/net — ASSUMED (veto-able).** Per-pair netting untouched;
  isolation = a pair's entries visible only to its two households (B4).
- **C3. Cross-instance money — DEFERRED by design.** Federation-era question; note
  groundwork only (signed/attributable entries?).

### D. Multi-tenant consequences

- **D1. Product namespace — DECIDED (2026-07-03).** **Per-household products.** `Product`
  gains `householdId`; search/UPC matching scoped to the acting household; browsing a
  connected pantry shows the owner's product names. Cross-household duplicates are by
  design (each household curates its own catalog). Migration assigns existing products to
  the households whose lots use them (shared usage → duplicate rows). Matches "owner is
  authoritative"; the recipe branch's per-household ingredient→product mapping (G2) was
  coming anyway.
- **D2. Shared-resource budgets — DECIDED (2026-07-03).** **Trust + visibility.** No
  quota machinery. Per-user rate limits stay; add an admin usage view (extraction calls /
  estimated spend / storage per household) so the operator can see and then talk to
  people. Admin caps and BYO-key remain doors.
- **D3. Seed/bootstrap/demo — ASSUMED (veto-able).** `scripts/bootstrap.ts` grows to:
  create instance settings + first household + first user (= instance admin). Demo seed
  gains a third household + connections to exercise network scoping in e2e. Live-data
  migration details live under J2.

### E. Federation groundwork (build nothing, preclude nothing)

- **E1. Protocol direction — DECIDED (2026-07-03).** **Custom minimal Coop↔Coop protocol
  as the declared target** (built only when federation is actually wanted): WebFinger
  identity, RFC 9421 signed HTTP, JCS/ed25519 signed events with content-hash IDs,
  Credit-Commons-style per-connection hashchain for money agreement (mismatch freezes
  money on that edge pending human reconciliation), ValueFlows naming for event payloads.
  Not AP/Matrix/ATProto/Nostr as substrate — see
  [research/federation.md](./research/federation.md). A read-only AP surface (e.g. public
  surplus feed followable from Mastodon) stays a door.
- **E2. Identity addressing — DECIDED via A2/E1.** `user@instance` and
  `household@instance` (WebFinger `acct:`); requires `User.username` + `Household.slug`,
  unique, URL-safe, from day one. Canonical URI rule documented in SPEC:
  `https://<instance>/<type>/<cuid>`; raw cuids never leave the instance unqualified.
- **E3. Now-work checklist — DECIDED (2026-07-03).** Adopt the report's list: username/
  slug columns (A2); canonical-URI rule (E2); first-class `Connection` table (B); ledger
  stays append-only/relation-free/deterministically serializable; preserve
  "resource owner is authoritative" asymmetry in every new feature; share posts carry
  `origin` + `hopsRemaining` from day one; ValueFlows-compatible naming where natural.
  Explicitly NOT now: keys/signatures, JSON-LD, AP endpoints, outbox/delivery queues,
  local ledger hashchains.

### F. Needs & surpluses

- **F1. Post model — ASSUMED (veto-able).** Type (NEED/SURPLUS), title, description,
  optional photo, optional linked lots (surplus of tracked inventory), **optional
  quantity** (unit-less count or free-text unit; absent = whole-thing), required expiry
  (defaults: surplus ~3 days, need ~14 days; poster-editable), status derived from
  claims/expiry.
- **F2. Audience — ASSUMED (veto-able).** A post goes to all connections whose grant
  allows receiving your shares (B2 directional); per-post audience narrowing is a door.
- **F3. Claim flow — DECIDED (2026-07-03).** **Signal + confirm, with optional
  quantity.** Baseline: claiming flips the post CLAIMED, poster confirms FULFILLED or
  releases to OPEN. When the post carries a quantity (farmer with 100 tomatoes), multiple
  concurrent claims each take a quantity; remaining availability tracks down and the post
  stays OPEN until 0 or expiry. No hard reservations — claims are commitments between
  people, confirmed by the poster.
- **F4. Reshare mechanics — DECIDED shape (2026-07-03) + ASSUMED parameters.**
  **People only interact with their direct connections — claims chain hop-by-hop.** A
  reshare creates an anonymized copy attributed to the resharer; available quantity
  continues to track on downstream hops (origin's remaining mirrors down). A downstream
  claim requires the resharer to place their own claim upstream and broker the physical
  transfer; statuses propagate link-by-link. Origin identity is never revealed downstream
  by the app (introductions are the broker's human choice). *Assumed parameters
  (veto-able):* posts carry `origin` + `hopsRemaining` (E3); poster sets reshare allowance
  — default 1 additional hop, hard max 3, 0 = no resharing; per-connection share grant
  (B2) gates both receiving and resharing.
- **F5. Money — DECIDED via C1.** Never. Shares are gifts; $0 transfer recorded when
  tracked lots hand off.
- **F6. Abuse/hygiene — ASSUMED (veto-able).** Auto-expiry hides stale posts; expired/
  fulfilled posts prune from feeds (rows kept); no reporting/moderation machinery in a
  trust network — severing the connection is the remedy.

### G. Recipes

- **G1. Recipe model — ASSUMED (veto-able).** PTE-shaped per Aaron's "as close as
  possible": structured ingredient lines (amount / unit / item / note) + section headings;
  directions; prep/cook time; course/cuisine/tags (user-editable lists); photo; servings
  (+ separate yield) with proportional scaling; paste-recipe-text parser assist; only
  title required. Recipes belong to a household. Nutrition is OUT (door). See
  [research/plan-to-eat.md](./research/plan-to-eat.md).
- **G2. Ingredient ↔ product linking — DECIDED (2026-07-03).** **Per-household name
  mapping.** Ingredient lines stay text; an `IngredientLink` table (household, normalized
  ingredient name → productId) is learned each time a user confirms a match and then
  resolves EVERY recipe (own/shared/imported) at plan/shopping time. Fuzzy suggestions,
  never silent auto-links (mirrors PTE's learned category map). **Quantities never
  convert across the link** — "2 cups flour" vs "3 units of King Arthur 5 lb" is shown
  side-by-side as information; humans decide sufficiency (recipe units and pantry eaches
  are incommensurable in general).
- **G3. Sharing semantics — DECIDED (2026-07-03).** **Browse live, fork on save.** The
  recipe grant (B2) lets a connection browse your household's non-private recipes live;
  saving copies into their book with attribution + source link; author edits never
  propagate to saved copies. Forks default to not-reshared (no transitive sharing, PTE's
  rule). Per-recipe private flag; default = visible to recipe-granted connections.
- **G4. Import — ASSUMED (veto-able).** Round 1: manual entry + paste-to-parse + URL
  import (schema.org/Recipe extraction with heuristic fallback). Browser-extension
  clipper: out (door). Photo-of-recipe import via the existing VLM pipeline: natural
  later door, the infra exists.

### H. Meal planning + shopping lists

- **H1. Calendar model — ASSUMED (veto-able).** PTE-shaped: week/month planner, mealtime
  sections, drag/tap recipes onto days, per-instance scaling; plannable types = recipe /
  ingredient / note. Menus (date-relative bundles), queue, leftovers, freezer: scope-cut
  candidates decided in J3. Planner belongs to a household (any member with the
  capability edits).
- **H2. List generation — ASSUMED (veto-able).** Date-range → aggregate ingredient lines
  (PTE-conservative merging: exact title+unit combine, same-root grouping, NO cross-unit
  math) → each item resolves via the G2 mapping and shows **availability badges** (own
  pantries first, then connected pantries whose grant allows ordering, availability =
  remaining − reserved). Explicit per-item actions: check off "have at home" / "add to
  order from pantry X" (accumulates into the existing one-DRAFT-order-per-pantry) / leave
  on the store list. **Nothing is ever silently removed** — PTE's pantry lesson, kept.
  Store list groups by category with learned per-household category assignment.
- **H3. Staples & manual items — ASSUMED (veto-able).** Manual items: yes, round 1
  (PTE's planner-"ingredient" + direct list adds). Staples list: cheap, include if J3
  scope allows, else first follow-up.
- **H4. Stores/categories — ASSUMED (veto-able).** Categories with learned assignment:
  yes. Multiple named stores: keep PTE's model (item → store memory, favorite store
  default) but fine to land one release behind categories if scope demands.

### I. Rebrand

- **I1. Name — DECIDED (2026-07-03).** **Potluck.** Everyone brings a dish; instantly
  legible mutual aid. Domain/handle hunting is Aaron's; the app rename covers PWA manifest
  (name/short_name), brand mark, README/SPEC, docker image + compose service, seed data
  copy. Repo rename optional/later.
- **I2. Principles rewrite — ASSUMED (veto-able; drafted at synthesis).** SPEC §2 becomes:
  at-cost always (unchanged) · **transparency within your connections' granted scope**
  (replaces "fully transparent"; third-party pairs invisible) · low ceremony / trust
  assumed (unchanged) · the net number is the product (unchanged) · **sovereignty** (your
  household's data is yours; instances are peers; nobody must join anyone's server) ·
  **orders are at-cost, shares are gifts** · demonstrably-works rule (unchanged).
- **I3. Copy/UI pass — ASSUMED (veto-able).** Rename sweep + de-"coop" the copy;
  mutual-aid tone (warm, not institutional); no full redesign — the design system stays.

### J. Sequencing & migration

- **J1. Evolve in place vs fresh — DECIDED (2026-07-03).** **Evolve in place.** Vertical
  slices on the green v1 base; migrations transform the schema; the e2e suite keeps
  money/order invariants honest throughout; deployable at every slice boundary.
- **J2. Existing deployment migration — ASSUMED (veto-able).** Data-preserving
  migrations: existing users get usernames (derived from email local-part, confirm at
  first login); the two households get slugs and become two connected nodes with full
  mutual grants; existing products assigned per D1; pantries/items default shared;
  first user (or a chosen one) becomes instance admin; real ledger history preserved
  untouched. Migration proven by e2e against a seeded pre-rework snapshot.
- **J3. Round ordering — DECIDED (2026-07-03).** **Network → shares → recipes →
  planner.** See "Round plan" below. Each round (and each slice within Round 1) ends
  demonstrably working in a real browser with e2e green on both engines — the house rule
  is unchanged.

## Round plan (J3, decided 2026-07-03)

**Progress (2026-07-04): ALL FOUR ROUNDS ARE BUILT, committed, and green on both
engines.** Round 1 (five slices) shipped in the overnight autonomous session; Rounds 2–4
shipped the following day as coordinated teammate rounds (server → UI ∥ e2e per round).
Full per-round records — decisions, deviations, gates — are in PLAN.md (newest first).
Scope cuts taken in Round 4 per H3/H4's "if scope allows": menus/queue/leftovers/freezer,
staples list, and multiple named stores are follow-ups, not shipped; categories with
learned assignment shipped.

**Round 1 — Network core** (the big migration; internally sliced, app works identically
for the existing two households at every step):

1. ✅ **Schema + data migration** — `Membership` (capability flags) replaces
   `User.householdId`; `Connection` (pairwise, two directional grant sets);
   `User.username` + `Household.slug`; `Product.householdId`; `Pantry.shared` /
   `Item.shared`; instance-settings + admin flag. Shipped as migration
   `20260703100000_network_core` (data-preserving; proven against the real dev volume).
   `Take.householdId` / `Loan.borrowerHouseholdId` attribution snapshots added too.
2. ✅ **Authz/capability layer + acting household** — `src/server/authz.ts`
   (`requireCapability` × `hasActiveGrant`); sticky `coop_household` switcher; username-
   or-email login. Read-scoping (B4) replaced "everyone sees everything." Money reach
   re-verified at the money moment.
3. ✅ **Connection management UI** — request/accept/sever by handle, unilateral grant
   editing with Neighbor/Friend/Family presets, `Pantry.shared`/`Item.shared` toggles.
   Sever runs B6 fallout (auto-cancel open orders, release reservations) in one tx.
4. ✅ **Onboarding + admin** — household invites (invite = ACTIVE first edge, A1),
   signed-in multi-membership acceptance (A3), `/admin` usage view + growth toggle (D2),
   `AddPantry` for founded households. Migration `20260703120000_household_invites`.
   **Bootstrap rework (D3) already landed in slice 1** (`scripts/bootstrap.ts` creates
   instance-settings + slug + username + Owner membership + first-user admin).
5. ✅ **Rebrand → Potluck** — manifest, cookies, seams, copy sweep (I1/I3), SPEC rewrite
   with the I2 principles, blueprint amendments. Deliberate non-renames (data safety):
   /data/coop.db, the coop-data volume, the repo dir, @demo.coop seed emails; the jar
   mark stayed.

**Round 2 — Needs & surpluses ✅ (shipped 2026-07-04)** (F): posts (need/surplus, optional quantity, expiry,
linked lots), claim flow (signal + confirm, quantity claims), reshare chain (anonymized,
hop-limited, broker claims upstream), $0 transfers for tracked lots, feeds scoped by
grants. Exercises the network end-to-end.

**Round 3 — Recipes ✅ (shipped 2026-07-04)** (G): PTE-shaped book + editor, paste-to-parse, URL import,
per-household ingredient→product mapping, browse-live/fork-on-save sharing over the
recipe grant.

**Round 4 — Planner + shopping ✅ (shipped 2026-07-04)** (H): week/month planner (recipe/ingredient/note),
per-instance scaling, date-range list generation with PTE-conservative merging, learned
categories, availability badges from own + connected pantries, add-to-order integration,
store list. Menus/queue/staples/stores land here if scope allows, else immediately after.

**Deferred (unchanged or newly noted):** notifications round (now also covering order
lifecycle, share/claim, and connection-request events — the event list keeps growing;
design it once); federation build-out (E1 target recorded; only the E3 checklist ships
now, inside Round 1); label printing; SKU merging; low-stock nudges; chore tracking
(door opened by A3's roles); shared write-off offers.

**Scale note:** design target moves from "2–10 households, one circle" to "tens of
households per instance." SQLite + the app-level write lock remain fine at that scale;
revisit only if a real instance outgrows it (extend a working system, don't pre-build).

## Drafted vocabularies (Round-1 refinement expected)

**Membership capabilities (A3a)** — flags on `Membership`; roles are presets:

- `manageHousehold` — rename, pantries, memberships/roles, shared flags
- `manageConnections` — initiate/accept/sever, edit grants
- `receiveStock` — run receiving (restocks)
- `order` — build/submit orders (own-pantry and cross-household browsing/drafting)
- `spend` — submit money-moving actions: cross-household order submission, fee-bearing
  loan checkout (a member with `order` but not `spend` can draft; submission needs a
  `spend`-holder)
- `fulfill` — pick/ready/hand off incoming orders; confirm share handoffs
- `adjustInventory` — recount, write-off
- `lendBorrow` — check out/return loans
- `postShares` — create/claim/reshare needs-surpluses posts
- `editRecipes` — recipe book, planner, shopping list writes (reads are any-member)
- `settleMoney` — settlements, manual adjustments, correct-credit, void-in-error

Presets: **Owner** = all · **Adult** = all except `manageHousehold` · **Teen** =
`receiveStock, order, lendBorrow, postShares, editRecipes` · **Child** = `editRecipes`
(view-mostly). Presets are starting points; flags are individually tunable per membership.

**Connection grants (B2)** — each side stores what it grants the other, revocable
unilaterally:

- `pantry` — browse my shared pantries, place orders against them
- `lending` — browse my shared items, borrow them
- `recipes` — browse my non-private recipes (fork-on-save)
- `shareTo` — include them in my needs/surpluses audience
- `shareFrom` — show me their needs/surpluses posts
- `reshare` — they may reshare my posts onward (post-level hop limit still applies)

Presets over grants ("levels") named at build time — e.g. Neighbor (shareTo/shareFrom),
Friend (+pantry, lending, recipes), Family (everything + reshare).

## Research notes

- **Plan to Eat deep dive** — done, see [research/plan-to-eat.md](./research/plan-to-eat.md).
  Headlines: structured ingredient lines (amount/unit/item/note) are the load-bearing
  model choice; shopping-list merging is conservative (same title+unit only, no cross-unit
  math) with a learned per-user ingredient→category/store map; menus are date-relative
  event bundles; planner events are recipe/ingredient/note (+leftover/freezer variants
  that skip the list); sharing is browse-live + fork-on-edit, binary privacy, no
  transitive sharing; PTE deliberately KILLED their decrementing-pantry feature ("removing
  items from someone's shopping list without them knowing is never a good idea") in favor
  of a static Staples list + shop-at-home-first check-offs.
- **Federation protocol survey** — done, see [research/federation.md](./research/federation.md).
  Headlines: no existing protocol fits as substrate. ActivityPub = right identity parts
  (WebFinger, signed HTTP), wrong interaction model (async, receipt-less, no real access
  control) — and Forgejo's multi-year experimental slog is the cost datapoint. Matrix =
  closest semantics, rejected on ops weight (second stateful server per node). ATProto is
  public-by-default; Nostr has no instances or server state. ValueFlows is a *vocabulary*
  (Intent/Proposal/Commitment/EconomicEvent map 1:1 onto needs-surpluses/orders/takes) —
  adopt the names, not the software. Credit Commons validates the pairwise-hashchain
  ledger-integrity design. Recommendation: minimal custom Coop-to-Coop protocol later
  (WebFinger identity + RFC 9421 signed HTTP + JCS/ed25519 events + per-connection
  hashchain for money), and a concrete do-now checklist: username/slug columns, canonical
  URI rule for cuids, first-class `Connection` table, keep ledger relation-free/append-only,
  keep "resource owner is authoritative" asymmetry, `origin`+`hopsRemaining` on shares
  from day one, and do NOT build keys/JSON-LD/outboxes yet.
