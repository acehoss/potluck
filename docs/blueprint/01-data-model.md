# 01 — Data model & money invariants (slices 2–6, amended through Phase 3)

Extends the live slice-1 schema (`prisma/schema.prisma`). One migration per slice, additive only.
SQLite via Prisma 7: **no native enums** — enum-ish columns are `String`, validated by zod at the
tRPC boundary with exported string-literal unions in `src/server/domain.ts`.

**Round 1 (network core, shipped 2026-07-04) amendments are folded in below** — see the
"Round 1 deltas" section for the new models and the attribution rule, the rewritten authz
matrix, and the amended invariants 3/4/5/10. **Later delta sections (updated 2026-07-07)
carry Rounds 2–4 (shares · recipes · planner), Phase 2 (circles · contact — which REPLACED
Round 1's per-connection grant sets and shared flags), and Phase 3 (mail · auth · MFA ·
notifications).** The v1 model snippets are kept as history; `prisma/schema.prisma` is the
source of truth.

## Decisions (rationale inline below)

- **D1 Pricing:** `lineTotalCents` (as printed) is entered; `unitCostCents = roundHalfUp(lineTotalCents / purchasedCount)` is frozen at finalize. All money movement is `count × unitCostCents` — never the raw line total — so credits and take-debits match exactly; rounding drift exists only vs the paper receipt (≤ ⌈n/2⌉¢ per lot, borne by the pantry owner).
- **D2 Takes:** append-only. A Take row is immutable; undo sets `reversedAt` and posts a swapped-party REVERSAL ledger entry; "edit" = undo + new take in one transaction.
- **D3 Lot remaining:** stored counter `remainingCount`, mutated only inside the same interactive transaction as the take/reversal/adjustment, guarded by a conditional `updateMany`. SQLite is single-writer; no version column.
- **D4 Line = Lot:** one model `Lot` per receipt line (a line received at 0 is a pure hold-back and never shows in inventory). No separate RestockLine table.
- **D5 Settlement:** no table — it is a `LedgerEntry` of type `SETTLEMENT` (payer = creditor) with a `note` ("Venmo 7/2"). Adjustment (recount/write-off) never touches the ledger in v1.
- **D6 Restock code:** ~~assigned at finalize (drafts don't burn numbers)~~ **assigned at draft START** (amended 2026-07-03, polish round) from the receipt date, race-safe via `@@unique([dateCode, seq])` + insert-retry (`assignRestockCode`), re-derived if the date is edited. The physical flow — label each item as it hits the shelf, in bag order — needs the code up front. Tradeoff: abandoned drafts now leave gaps in a day's numbering — acceptable.
- **D7 Reconciliation:** `varianceCents = receiptTotalCents − (Σ lineTotalCents + taxCents + feesCents)` stored at finalize. Auto-pass if `|variance| ≤ 2¢ × lineCount`; otherwise the UI requires an explicit acknowledgment. **Tax/fee allocation is now implemented (amended 2026-07-03):** `taxCents` is apportioned across taxable lines and `feesCents` across all lines (when `feesDistributed`) by largest-remainder (`apportionCents`/`allocateReceipt`), folded into each lot's frozen `unitCostCents` — so takes and the purchaser credit are tax-inclusive/at-cost. Fees are the purchaser's cost unless shared. Entering tax/fees also removes the false "receipt short" variance a taxed receipt used to always show.
- **D8 Product photo:** derived — newest lot of the product with a `unitPhotoPath`. No photo column.
- **D9 Orders & reservation (added 2026-07-03):** units leave a pantry only through an **Order** — there is no instant take. `Order`/`OrderLine` (lot-specific) run `DRAFT → REQUESTED → PICKING → READY → PICKED_UP | CANCELED`. A new `Lot.reservedCount` holds units for open orders; **availability everywhere = `remainingCount − reservedCount`** (reserve = guarded read-then-`updateMany` on that difference, mirroring the recount guard; the app lock makes it race-free). Reservation never touches the ledger. **Money posts at PICKED_UP only:** each line becomes a `Take` (decrementing `remainingCount` *and* `reservedCount`) and, cross-household, a TAKE `LedgerEntry` — exactly the old take mechanics (D1/D2), now at pickup, under one `dbTransaction` with a `clientKey` + a `READY→PICKED_UP` fire-once guard. **Cancel posts nothing** (only DRAFT/REQUESTED; releases the hold). Consequence for the pre-order inventory ops: they must respect `reservedCount` — `take.create` was **removed** (guarded only on `remainingCount`, it would oversell reserved units), `adjustment.recount/writeOff` reject dropping stock below `reservedCount`, and `restock.voidInError` blocks while any open order reserves its lots. `take.undo` stays as the append-only return path.

## Prisma models

```prisma
// ---- slice 2: receiving -----------------------------------------------
model Product {
  id        String   @id @default(cuid())
  name      String
  upc       String?  // no unique: SKU merging is out of scope; UI warns on dupes. @@index([upc])
  createdAt DateTime @default(now())
  lots      Lot[]
}
model Restock {
  id                   String    @id @default(cuid())
  pantryId             String
  purchaserHouseholdId String
  createdById          String    // user who ran the receiving flow
  retailer             String
  purchasedAt          DateTime  // receipt date; drives dateCode
  status               String    @default("DRAFT") // "DRAFT" | "FINALIZED"
  dateCode             String?   // "260702", set at finalize
  seq                  Int?      // NN, 1-based; display code = `${dateCode}-${pad2(seq)}`
  receiptTotalCents    Int?
  varianceCents        Int?      // set at finalize (D7)
  // slice 5 adds: extractedAt DateTime?, extractionModel String?, extractionJson String?
  finalizedAt          DateTime?
  createdAt            DateTime  @default(now())
  pantry             Pantry    @relation(fields: [pantryId], references: [id])
  purchaserHousehold Household @relation("purchases", fields: [purchaserHouseholdId], references: [id])
  createdBy          User      @relation(fields: [createdById], references: [id])
  images             RestockImage[]
  lots               Lot[]
  @@unique([dateCode, seq])
  @@index([pantryId])
}
model RestockImage {
  id        String @id @default(cuid())
  restockId String
  path      String // under IMAGES_DIR volume; retained permanently (SPEC §4)
  position  Int
  restock   Restock @relation(fields: [restockId], references: [id], onDelete: Cascade)
  @@unique([restockId, position])
}
model Lot {
  id             String    @id @default(cuid())
  restockId      String
  productId      String
  position       Int       // line order on the receipt
  purchasedCount Int       // eaches bought (bulk packs pre-broken at entry)
  receivedCount  Int       // eaches into the pantry; 0..purchasedCount (hold-backs = difference)
  lineTotalCents Int       // as printed, covers all purchasedCount units
  unitCostCents  Int?      // frozen at finalize (D1); null while DRAFT
  remainingCount Int       @default(0) // set to receivedCount at finalize; see D3
  bestBy         DateTime?
  unitPhotoPath  String?
  restock Restock @relation(fields: [restockId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [productId], references: [id])
  takes       Take[]
  adjustments Adjustment[]
  @@unique([restockId, position])
  @@index([productId])
}
// ---- slice 3: takes & ledger ------------------------------------------
model Take {
  id           String    @id @default(cuid())
  lotId        String
  takerId      String    // user; household derived via taker
  quantity     Int       // > 0
  costCents    Int       // quantity × lot.unitCostCents; 0 when own-household
  takenAt      DateTime  @default(now())
  reversedAt   DateTime?
  reversedById String?
  lot   Lot  @relation(fields: [lotId], references: [id])
  taker User @relation(fields: [takerId], references: [id])
  @@index([lotId])
}
model LedgerEntry {
  id                  String   @id @default(cuid())
  type                String   // "TAKE" | "RESTOCK_CREDIT" | "LOAN_FEE" | "SETTLEMENT" | "WRITE_OFF" | "ADJUSTMENT" | "REVERSAL"
  creditorHouseholdId String   // is owed amountCents…
  debtorHouseholdId   String   // …by this household. Always creditor ≠ debtor, amount > 0.
  amountCents         Int
  note                String?
  createdById         String
  createdAt           DateTime @default(now())
  takeId     String? @unique   // set for TAKE
  restockId  String?           // set for RESTOCK_CREDIT and its correction entries (see Immutability)
  loanId     String? @unique   // set for LOAN_FEE (slice 6)
  reversesId String? @unique   // set for REVERSAL → the entry it cancels
  @@index([creditorHouseholdId, debtorHouseholdId])
  @@index([restockId])
}
// ---- slice 4: adjustments (settlement is a LedgerEntry, D5) -----------
// slice 4 also adds the `LedgerSeen` table — the per-user, per-pair "new since
// viewed" watermark (shipped as a table, not the once-planned User.ledgerSeenAt
// column; Round 1 re-keyed it (userId, ownHouseholdId, counterpartyHouseholdId))
model Adjustment {
  id          String   @id @default(cuid())
  lotId       String
  type        String   // "RECOUNT" | "WRITE_OFF"
  countBefore Int      // read by the SERVER inside the tx — never client-supplied (see logic below)
  countAfter  Int      // RECOUNT: the physical count (≥ 0); WRITE_OFF: before − writtenOff
  note        String?
  createdById String
  createdAt   DateTime @default(now())
  lot Lot @relation(fields: [lotId], references: [id])
}
// ---- slice 6: lending ---------------------------------------------------
model Item {
  id          String   @id @default(cuid())
  householdId String
  name        String
  photoPath   String?
  notes       String?
  feeCents    Int      @default(0)
  createdAt   DateTime @default(now())
  household   Household @relation(fields: [householdId], references: [id])
  loans       Loan[]
}
model Loan {
  id                String    @id @default(cuid())
  itemId            String
  borrowerId        String    // user
  feeCents          Int       // snapshot of item.feeCents at checkout
  outAt             DateTime  @default(now())
  dueAt             DateTime?
  returnedAt        DateTime?
  conditionOut      String?
  conditionReturned String?
  item     Item @relation(fields: [itemId], references: [id])
  borrower User @relation(fields: [borrowerId], references: [id])
  @@index([itemId]) // "one active loan per item" enforced in the checkout transaction
}
```

**Snippet drift (noted 2026-07-07):** beyond the deltas below, the live schema differs from the
historical snippets above in small ways — `Lot.productId` is now **nullable** (null only for
`excluded` non-inventory receipt lines from the tax/fees round), `Lot` grew
`taxable`/`excluded`/`receiptText`/`taxCentsAllocated`/`feeCentsAllocated`/`reservedCount`, the
money-writing models carry `clientKey` idempotency columns (rule #2), and the `Loan.conditionOut`
column shown above **never actually shipped** — only `conditionReturned` exists.

Migrations: `slice2_receiving` (Product, Restock, RestockImage, Lot) · `slice3_ledger` (Take, LedgerEntry) · `slice4_adjustments` (Adjustment, `LedgerSeen`) · `slice5_extraction` (3 nullable columns on Restock + `RestockImage.originalSha256 String?` for fixture-mode extraction, 04 §3) · `slice6_lending` (Item, Loan) · `slice7_push` (PushSubscription) · `tax_fees_receipt_text` (2026-07-03 polish: tax/fee/excluded columns) · `orders_reserved` (2026-07-03: `Lot.reservedCount`, `Order`, `OrderLine`; D9) · `20260703100000_network_core` (Round 1: Membership/Connection/InstanceSettings, username/slug, per-household Product with duplication backfill, shared flags, attribution snapshots, LedgerSeen re-key — data-preserving, proven against a live volume) · `20260703120000_household_invites` (`Invite.kind` + `grantsJson`) · `20260704090000_shares` (Round 2: SharePost/SharePostLot/ShareClaim + `Take.shareClaimId` — the gift-take marker; see invariant 4) · `20260704110000_recipes` (Round 3: Recipe/RecipeIngredient/IngredientLink) · `20260704130000_planner` (Round 4: PlanEntry/ShoppingItem/CategoryAssignment) · `20260704150000_circles` (Phase 2 Round B: **rebuilds Connection/Pantry/Item** — Circle + PantryCircle/ItemCircle/MembershipCircle replace the per-connection `aGrants*`/`bGrants*` columns and the `shared` booleans; data-preserving, behavior-equivalent grants proven by `scripts/verify-circles-migration.mjs`) · `20260704170000_contact` (Phase 2 Round C: `User.photoPath/phone/bio`, `Household.address/pickupNotes` — plain additive) · `20260705100000_mail` (Phase 3 Round A: CapturedEmail, MailSuppression) · `20260705140000_auth` (Round B: EmailVerificationToken/PasswordResetToken/MfaBackupCode/EmailMfaCode + the User security columns) · `20260705180000_notifications` (Round C: NotificationPreference + the User notification columns) · `20260705200000_digest_cadence` (User rebuild: boolean `digestOptOut` → `digestCadence`/`digestHour`/`digestWeekday`, data-preserving) · `20260706120000_plan_shopping_tracking` (Round S: `PlanEntry.addedToShoppingAt`). Phase 3 Round D (deep links) added **no migration** — nav tokens are stateless HMAC. Back-relations on Household/User/Pantry added in the same migration that needs them.

## Round 1 deltas (network core, 2026-07-04)

New models — see `prisma/schema.prisma` for full definitions; docs/archive/mutual-aid-rework-2026-07.md for rationale:

- **`Membership`** (user↔household, `@@unique([userId, householdId])`) replaces
  `User.householdId`. Eleven boolean capability flags (`src/server/capabilities.ts`;
  REWORK's `order` flag ships as `placeOrders` — SQL-keyword collision); Owner/Adult/
  Teen/Child are presets, not schema. Requests resolve a sticky ACTING household
  (cookie, validated against live memberships) behind the legacy `ctx.user.householdId`
  shape.
- **`Connection`** (canonical pair `householdAId < householdBId`, unique; status
  `PENDING | ACTIVE | SEVERED`) ~~with two directional grant sets (`aGrants*`/`bGrants*`:
  pantry, lending, recipes, shareTo, shareFrom, reshare)~~ — **amended 2026-07-04 (Phase 2
  Round B):** grants no longer live on the edge. Each side assigns the OTHER household
  into one of ITS OWN **circles** (`aCircleId`/`bCircleId`, nullable — the nullability
  carries PENDING; ACTIVE ⇒ both non-null, enforced in the accept handler), and that
  circle's six grant booleans ARE the directional grant set — same six grants, same
  directionality, re-assigned unilaterally. See the Phase 2 deltas below. The
  grant/capability choke point is still `src/server/authz.ts` (`grantsFrom` resolves the
  circle behind the unchanged GrantSet shape). Severing auto-cancels open orders across
  the pair and releases reservations in the same transaction (B6); ledger history and
  net survive.
- **`InstanceSettings`** (singleton `id='instance'`) + `User.isInstanceAdmin` +
  `User.username` / `Household.slug` (unique, `[a-z0-9_-]`) + `Invite.kind`/`grantsJson`
  (member vs found-a-household invites) + ~~`Pantry.shared`/`Item.shared`~~ (both became
  circle-scoped three-mode `visibility` columns in Phase 2 — see below) +
  `Product.householdId` (catalog owner = the household whose pantry holds its lots).

**The attribution rule (supersedes the "household derived via taker/borrower" comments
in the v1 snippets below):** a user may hold N memberships, so money-bearing rows
snapshot their household at the money moment and NEVER re-derive it from the user —
`Take.householdId` (stamped at pickup from `Order.householdId`, which is also the TAKE
entry's debtor), `Loan.borrowerHouseholdId` (stamped at checkout = the LOAN_FEE debtor),
`Restock.purchaserHouseholdId` (already explicit), `Order.householdId` (already
explicit). `LedgerSeen` is keyed `(userId, ownHouseholdId, counterpartyHouseholdId)`.
Undo/return authz reads the snapshots.

**Reach is re-verified at the money moment**, not only at draft/submit time: order
pickup asserts the pantry grant still holds (post-Phase-2: the connection is ACTIVE and
the owner's circle for the requester still carries `grantsPantry`); restock finalize
asserts the purchaser connection is still ACTIVE before posting the credit; settle/adjust
require a connection edge in ANY status (severed pairs stay settleable per B6;
never-connected households are unreachable and read as 404).

## Rounds 2–4 deltas (shares · recipes · planner, 2026-07-04)

Three connection-scoped feature families, all riding the same authz choke point,
**all adding zero money paths** — see `prisma/schema.prisma` for full definitions,
docs/archive/mutual-aid-rework-2026-07.md §§F/G/H for rationale.

**Shares (Round 2, REWORK F).** A post is a NEED or a SURPLUS; **shares are gifts (C1)
and never touch the ledger** — a tracked SURPLUS handoff records $0 Takes for the audit
trail only (invariant 4's carve-out). ValueFlows correspondence (E3, names only): post ≈
Intent/Proposal, claim ≈ Commitment, gift take ≈ EconomicEvent.

```prisma
model SharePost {
  id            String    @id @default(cuid())
  clientKey     String?   @unique
  type          String    // "NEED" | "SURPLUS"
  householdId   String    // the POSTING household — for a reshare copy, the RESHARER
  title         String
  quantity      Int?      // null = whole-thing/unspecified; unit is free text
  remaining     Int?      // ticks down as claims CONFIRM; stored ONLY on origin posts
  expiresAt     DateTime  // required; defaults SURPLUS +3d, NEED +14d
  status        String    @default("OPEN") // OPEN | CLAIMED | FULFILLED | WITHDRAWN (expiry derived, never stored)
  originPostId  String?   // reshare chain: root id; null = this IS the origin
  parentPostId  String?   // the post this copy reshared
  hopsRemaining Int       @default(1) // poster-set 0..3; copies get parent−1
  // + createdById, description, photoPath (kind "shares"), unit, createdAt
}
model ShareClaim {
  id          String  @id @default(cuid())
  clientKey   String? @unique
  postId      String
  householdId String  // the CLAIMING household — snapshot, never re-derived
  quantity    Int?    // required iff the post carries a quantity
  status      String  @default("PENDING") // PENDING | CONFIRMED | RELEASED | CANCELED
  // + createdById, note, createdAt, resolvedAt
}
```

`SharePostLot` (unique `[postId, lotId]`) is the provenance link: which tracked lots a
SURPLUS origin offers (own-household, FINALIZED, non-excluded). Confirming a claim (the
poster's `fulfill` moment) draws the $0 gift takes from those lots — one confirm can gift
from several lots, so `Take.shareClaimId` is indexed, **not** unique. Gift takes honor
`reservedCount` (invariant 4). Reshares copy the post under the resharer's household with
the origin **anonymized** beyond the direct edge; `remaining` lives only on the origin
and mirrors down at read time (F4, single source of truth).

**Recipes (Round 3, REWORK G).** `Recipe` (PTE-shaped: only `title` required; free-vocab
course/cuisine/tags; `private` flag, default visible-to-granted) + `RecipeIngredient`
(positioned lines, `kind` "item" | "heading"; **`amount` is raw text, never parsed
server-side** — scaling is a display concern) + `IngredientLink` (the LEARNED
per-household `normalizedName → productId` map, unique per pair; written only on explicit
user confirmation, resolved at read time for every recipe; quantities NEVER convert
across the link). Cross-household browsing rides the `recipes` circle grant over an
ACTIVE edge; saving a foreign recipe **forks** it (browse-live, fork-on-save) — fork
attribution (`forkedFromTitle`/`forkedFromHouseholdName`) is a **snapshot, deliberately
not FKs**: the source may be deleted/unshared/severed later and the copy stands alone.
NO money, NO ledger anywhere in this family.

**Planner + shopping (Round 4, REWORK H; amended Round S 2026-07-06).** `PlanEntry`
(household calendar: local `date` "YYYY-MM-DD", `meal` breakfast|lunch|dinner|snack,
`kind` "recipe" | "item" | "note", `servingsOverride` per instance). `recipeId` is
**`onDelete: SetNull`** — deleting a recipe leaves a "(deleted recipe)" tombstone entry,
never a silently emptied slot. Round S added `addedToShoppingAt`: stamped when the
entry's ingredients were sent to the list (`shopping.generate` / `shopping.addFromEntry`);
a deliberate "was sent" marker, NOT a live link. `ShoppingItem` is the one persistent
per-household list: rows are **never silently removed** (H2) — generation UPSERTS on the
merge key `[householdId, normalizedName, unit]` (unit ''-normalized so the unique is
real; NO cross-unit math — same-unit numeric amounts sum, unparseable ones join), only
explicit user actions delete. `CategoryAssignment` mirrors IngredientLink's
learned-on-explicit-action pattern for aisle categories. The list's add-to-order hands a
suggested lot to the EXISTING order flow (`order.addToCart`) — the planner itself posts
no money.

## Phase 2 deltas (circles + contact layer, 2026-07-04/05)

**Circles (Round B, REWORK P4 — the big one).** Named per-household visibility/grant
groups REPLACE per-connection grant editing entirely (no per-connection override; a
bespoke connection gets a circle of one). **A circle IS a grant bundle** — the six
directional grants that used to live on the Connection edge:

```prisma
model Circle {
  id          String @id @default(cuid())
  householdId String
  name        String              // unique per household; seeded: Neighbors / Friends / Family
  position    Int    @default(0)  // display order

  grantsPantry    Boolean @default(false)
  grantsLending   Boolean @default(false)
  grantsRecipes   Boolean @default(false)
  grantsShareTo   Boolean @default(false)
  grantsShareFrom Boolean @default(false)
  grantsReshare   Boolean @default(false)
}
```

Each side of a connection assigns the OTHER household into one of ITS OWN circles
(`Connection.aCircleId` = the circle A placed B into = A's outgoing grants toward B;
`bCircleId` the mirror). Directionality is preserved; either side re-assigns unilaterally
("resource owner is authoritative"). Resource scoping targets circles too:
`Pantry.visibility` and `Item.visibility` (which replaced the `shared` booleans) and
`Membership.visibility` are `"ALL" | "SELECT" | "PRIVATE"` — SELECT consults the
`PantryCircle` / `ItemCircle` / `MembershipCircle` join rows (ignored under ALL/PRIVATE;
circle and resource always belong to the SAME household). A connection still needs its
circle's grant flag on top of visibility, and `authz.ts` (`grantsFrom`,
`visibleUnderCircle`) resolves all of it behind the unchanged GrantSet API — grant loss
uniformly reads **404**. The `20260704150000_circles` migration was data-preserving:
preset circles seeded per household, each connection side's grant tuple mapped to a
matching preset or a custom circle, `shared=1 → 'ALL'` / `shared=0 → 'PRIVATE'`
(behavior-equivalent, proven by `scripts/verify-circles-migration.mjs`).

**Contact layer (Round C, REWORK P5).** Plain additive columns, no new tables:
`User.photoPath` ("avatars"-kind image) / `phone` (free text; UI renders tel:/sms:) /
`bio` — the person's card, all optional; visibility on a household card is governed by
`Membership.visibility` + circles, never by field presence. `Household.address`
(free-text multiline) + `pickupNotes` ("side door, text when 5 min out" — the
focus-group's top-ranked field) — visible to any ACTIVE-connected household; **the
connection itself is the gate** (P5).

## Phase 3 deltas (mail · auth · MFA · notifications, 2026-07-05; digest cadence 2026-07-06)

Account-plumbing only — **no model in this phase touches money or the ledger**. See
docs/archive/mutual-aid-rework-2026-07.md "Phase 3" (N1–N11) for the decision record.

**Mail (Round A, N1/N3/N9).** Two pipelines behind one swappable transport:
`sendTransactional` (never consults prefs/suppression, no unsubscribe, always sends) vs
`sendSubscription` (prefs + suppression + RFC-8058 one-click unsub). `CapturedEmail`
audits **every message either pipeline TRIED to send** — written whether or not SMTP was
touched (on a capture-mode stack it is the only record; dev/e2e read it back):
`toAddress` = the ACTUAL recipient after the fail-closed dev filter, `originalTo` = the
intended recipient, `delivered` = true only when a real SMTP send happened.
`MailSuppression` (email PK, reason) is the hard-suppression list for **subscription mail
only** — a bounced digest must never block a password reset.

**Auth + MFA (Round B, N8/N10).** New `User` columns: `emailVerifiedAt` (null =
unverified; banners, never blocks login), `totpSecret` (**AES-256-GCM-encrypted** at
rest) / `totpEnabledAt` (set only after a live code confirms enrollment) / `totpLastStep`
(highest consumed time-step — replay-reject watermark), `mfaEmailEnabled` (emailed codes
= a labeled *convenience* factor; email is also the reset channel, circular trust). Four
token tables, all `onDelete: Cascade` with the user: `EmailVerificationToken` and
`PasswordResetToken` (sha256 **hash** of the token stored — the raw value lives solely in
the emailed link; single-use `usedAt`, short-TTL; consuming a reset revokes sessions and,
if TOTP is enrolled, ALSO requires a live TOTP/backup code — a reset is not a TOTP
bypass), `MfaBackupCode` (8–10 per user, argon2id-hashed, shown once, single-use),
`EmailMfaCode` (6-digit, hashed, short-TTL, attempt-capped; at most one live row per
user). TOTP is required for the instance-admin account (enforced in the router, not
schema).

**Notifications (Rounds C/D, N4–N7; cadence round 2026-07-06).** Per-category channel
choices are one row per category the user has TUNED — **an absent row means the
conservative category default** (pickups push+email ON; circle OFF/OFF; ledger OFF/OFF),
so a fresh account carries zero rows and still behaves correctly:

```prisma
model NotificationPreference {
  userId   String
  category String  // "pickups" | "circle" | "ledger" — "account"/transactional is never stored, never unsubscribable
  push     Boolean
  email    Boolean
  @@id([userId, category])
}
```

Single-valued prefs live on `User`: `timezone` (IANA; null → instance default/UTC),
`digestCadence` `'off'|'daily'|'weekly'` + `digestHour` (0–23 local) + `digestWeekday`
(0=Sun; weekly only) — the cadence round replaced the boolean `digestOptOut`, defaulting
to **daily** (timely beats batched for perishable shares); `showDetails` (default **off**
— opt in to the counterparty household NAME in a notification body; still never
dollars/addresses, N4); `lastDigestAt` (per-user digest idempotency watermark);
`notifyOnboardedAt` (first-run "how should Potluck reach you?" consent seen). The
`notify()` layer enforces N4's category-only content rule; every notification is stamped
with its household and tapping switches the acting household. Round D's deep links are
**navigation-only stateless HMAC tokens — no table, no migration**: they route +
mark-read; acting always requires a live session (N7).

## Key server logic (canonical snippets)

```ts
// finalize (one interactive tx): freeze prices, post credit, assign code
const unitCostCents = Math.round(lot.lineTotalCents / lot.purchasedCount); // D1, half-up
// per lot: { unitCostCents, remainingCount: lot.receivedCount }
const creditCents = lots.reduce((s, l) => s + l.receivedCount * l.unitCostCents!, 0);
if (purchaserHouseholdId !== pantry.householdId && creditCents > 0)
  await tx.ledgerEntry.create({ data: { type: 'RESTOCK_CREDIT', restockId,
    creditorHouseholdId: purchaserHouseholdId, debtorHouseholdId: pantry.householdId,
    amountCents: creditCents, createdById } });

// code assignment (D6): compute max(seq)+1 for dateCode, insert; on P2002 unique
// violation retry (max 3). dateCode = format(purchasedAt, 'yyMMdd') in coop-local TZ.

// take (one tx, D2/D3): conditional decrement is the stock guard
const hit = await tx.lot.updateMany({
  where: { id: lotId, remainingCount: { gte: qty }, restock: { status: 'FINALIZED' } },
  data: { remainingCount: { decrement: qty } } });
if (hit.count === 0) throw new TRPCError({ code: 'CONFLICT', message: 'Not enough left' });
const cross = takerHouseholdId !== ownerHouseholdId;
const costCents = cross ? qty * lot.unitCostCents : 0;
// create Take; if cross: LedgerEntry { type:'TAKE', creditor: owner, debtor: taker, amountCents: costCents, takeId }

// undo take (one tx): the reversedAt guard makes double-submits fail closed even for
// own-household takes (which have no ledger entry, hence no reversesId-unique backstop)
const undone = await tx.take.updateMany({
  where: { id: takeId, reversedAt: null }, data: { reversedAt: new Date(), reversedById } });
if (undone.count === 0) throw new TRPCError({ code: 'CONFLICT', message: 'Already undone' });
// then: increment remainingCount by quantity; if a TAKE entry exists, post REVERSAL
// with creditor/debtor swapped, same amount, reversesId.

// adjustment (one tx, D3): client sends countAfter ONLY. Server reads remainingCount
// in-tx as countBefore, then writes via
//   tx.lot.updateMany({ where: { id, remainingCount: countBefore },
//                       data: { remainingCount: countAfter } })
// retrying read+write on a miss — a take interleaved during user think-time can
// never make invariant 9 false.

// net position: what `them` owes `me` (positive = they owe you)
const [{ net }] = await db.$queryRaw<[{ net: number | null }]>`
  SELECT SUM(CASE WHEN creditorHouseholdId = ${me} THEN amountCents ELSE -amountCents END) AS net
  FROM LedgerEntry
  WHERE (creditorHouseholdId = ${me} AND debtorHouseholdId = ${them})
     OR (creditorHouseholdId = ${them} AND debtorHouseholdId = ${me})`;
```

## Authz matrix (rewritten for Round 1: capability × grant × visibility — grant mechanics re-based on circles in Phase 2)

The v1 premise "everyone sees everything" is gone (REWORK B4). **Reads** are
connection-scoped: your households' data, plus what ACTIVE connections grant (their
visible pantries/items under the pantry/lending grants; a pair's ledger visible only to
its two households). Since Phase 2 a "grant" below means: the counterparty household's
**circle for you** carries the flag AND the resource's `visibility` admits you (`ALL`, or
`SELECT` with a scope row for that circle; `PRIVATE` never crosses). Visibility failures
read as **404** (existence never leaks); capability failures on visible things are
**403**. **Writes** ("acting" = the acting household's membership flags):

| Operation | Capability (acting membership) | Cross-household reach |
| --- | --- | --- |
| Create/edit/finalize/abandon a DRAFT restock; removeImage; setUnitPhoto | `receiveStock`, **acting household must own the pantry** (a connected purchaser is credited via `purchaserHouseholdId`, not by driving the wizard) | purchaser must be the acting household or an ACTIVELY connected one; re-verified at finalize |
| Correct a RESTOCK_CREDIT / void-in-error | `settleMoney`, member of purchaser **or** pantry-owner household | — |
| Order draft/edit/cancel | `placeOrders` | pantry circle grant + pantry visibility (via `loadOrderableLot`) |
| Order submit, and any edit to a SUBMITTED cross-household order | `spend` (own-pantry: `placeOrders`) | pantry grant, re-verified at pickup |
| Order startPicking / markReady / decline | `fulfill`, pantry-owner household | — |
| Order pickup (THE money event) | requester side: `spend` (cross) / `placeOrders` (own); owner side: `fulfill` | pantry grant re-asserted before posting |
| Undo a take | `placeOrders`, acting household = `Take.householdId` snapshot | — |
| Recount / write-off | `adjustInventory`, pantry-owner household only | — |
| Manual ADJUSTMENT / SETTLEMENT | `settleMoney`, own household one of the pair | connection edge in ANY status (severed pairs settleable, B6) |
| Create/edit Item | `lendBorrow`, owner household; fee > 0 / fee changes add `settleMoney`; visibility changes add `manageHousehold` | — |
| Loan checkout (borrower = acting user) | `lendBorrow`; + `spend` when a fee posts cross-household | lending circle grant + item visibility |
| Loan return / undo checkout | `lendBorrow`, borrower-snapshot or owner household | works across a severed edge (loans run to return) |
| Share post/withdraw/reshare · claim/cancel-claim | `postShares` | shareTo/shareFrom circle grants pick the audience; reshare adds the `grantsReshare` flag + `hopsRemaining > 0` |
| Share respond — confirm (posts the $0 gift takes) or release | `fulfill`, posting-household side | — (the gift is the sanctioned no-money cross-household take; invariant 4) |
| Recipe / planner / shopping-list writes | `editRecipes`, own household | browsing a connected book = recipes circle grant + per-recipe `private` flag; saving forks |
| Circle create/edit/delete · connection circle assignment | `manageConnections`; own circles only, edited unilaterally | — |
| Member invites | `manageHousehold` | — |
| Household invites (found a new household) | `manageConnections` + the instance-admin growth toggle | accepted invite mints the ACTIVE first edge |
| Connection request/respond/assign/sever | `manageConnections`; each side assigns its own circle unilaterally | — |
| Pantry create / visibility | `manageHousehold`, own household | — |
| Profile card, notification prefs, MFA enrollment | the user themself (account-scoped, no capability) | — |
| Instance settings (growth toggle) / admin usage view | instance admin (`User.isInstanceAdmin`) | sees operational usage only, never content |

## Immutability once referenced

- `LedgerEntry`: never updated or deleted. Corrections are REVERSAL or ADJUSTMENT entries.
- `Take`: immutable except the one-way `reversedAt`/`reversedById`.
- `Lot` after finalize: `productId/purchasedCount/receivedCount/lineTotalCents/unitCostCents` frozen; `remainingCount` moves only via take/reversal/adjustment; `unitPhotoPath`/`bestBy` stay editable (re-snap, relabel).
- `Restock` after finalize: frozen except the slice-5 extraction columns. FINALIZED is terminal (no un-finalize; fix count mistakes with recounts/adjustments). Only DRAFT restocks are deletable (cascades lots/images; image files removed too).
- **Wrong RESTOCK_CREDIT** (e.g. `receivedCount` typo caught after finalize): the *correct-credit* op — one tx posting a REVERSAL of the old credit (`reversesId`, same `restockId`) plus a new RESTOCK_CREDIT with the corrected amount, both linked to the restock. Gated per the authz matrix. Free-form manual ADJUSTMENT is **not** the fix path (it would break restock↔ledger auditability).
- `Adjustment` rows and `Loan.feeCents` snapshot: immutable. `RestockImage`: append-only once finalized.

## Money invariants (mechanically checkable)

1. Every `LedgerEntry.amountCents` is a positive integer; `creditorHouseholdId ≠ debtorHouseholdId`. No floats anywhere; all `*Cents` are `Int`.
2. Antisymmetry is by construction: net(A,B) from the query above equals −net(B,A) (single table, symmetric predicate).
3. For every TAKE entry: `amountCents = take.quantity × lot.unitCostCents` exactly, and the take's **snapshot** household (`Take.householdId`, = the order's requester household = the entry's debtor) ≠ lot's pantry-owner household. Cross-household takes additionally required an ACTIVE pantry grant at pickup time (Round 1).
4. A take posts **no** ledger entry and has `costCents = 0` in exactly two cases: own-household takes (snapshot household = pantry owner), and **gift takes** (`shareClaimId` set — Round 2's C1 audit trail for a confirmed needs-&-surpluses handoff of tracked lots; cross-household and free by design, "orders are at-cost, shares are gifts"). Every other cross-household take posts per invariant 3. Gift takes honor `reservedCount` (the guard is `remainingCount ≥ reservedCount + quantity`), so invariant 9 and open-order reservations hold.
5. Exactly one **unreversed** RESTOCK_CREDIT per finalized restock where purchaser ≠ pantry owner, with `amountCents = Σ(receivedCount × unitCostCents)` over its lots; none otherwise. Reversed credits from the correct-credit op keep their `restockId` for the audit trail. Held-back units never appear in any ledger amount. The purchaser's connection must be ACTIVE at finalize (Round 1).
6. Every REVERSAL has a unique `reversesId`, identical `amountCents`, swapped creditor/debtor; when it reverses a TAKE, the take's `quantity` was returned to `lot.remainingCount` in the same tx.
7. `unitCostCents = Math.round(lineTotalCents / purchasedCount)`; per-lot paper drift `|lineTotalCents − purchasedCount × unitCostCents| ≤ ⌈purchasedCount / 2⌉` cents.
8. Recounts and write-offs never create ledger entries in v1 (owner eats the cost); the `WRITE_OFF` ledger type is reserved for the post-v1 shared write-off door.
9. For every lot: `remainingCount = receivedCount − Σ(active take quantities) + Σ(adjustment countAfter − countBefore)`, and `remainingCount ≥ 0` at all times (guarded by the conditional decrement).
10. LOAN_FEE posts at checkout iff `loan.feeCents > 0` **and** the borrower **snapshot** household (`Loan.borrowerHouseholdId`, stamped at checkout) ≠ item household, with `amountCents = loan.feeCents` (creditor = item owner). Cross-household checkouts additionally required the lending grant + `Item.shared` (Round 1).
11. SETTLEMENT: creditor = payer, debtor = payee — recording "$X from A to B" moves net(A,B) up by X (reduces A's debt).
12. `restock.varianceCents = receiptTotalCents − Σ lineTotalCents`, informational only: it never enters the ledger (purchaser bears it in v1).
