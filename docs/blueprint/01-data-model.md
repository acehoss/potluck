# 01 — Data model & money invariants (slices 2–6, amended for Potluck Round 1)

Extends the live slice-1 schema (`prisma/schema.prisma`). One migration per slice, additive only.
SQLite via Prisma 7: **no native enums** — enum-ish columns are `String`, validated by zod at the
tRPC boundary with exported string-literal unions in `src/server/domain.ts`.

**Round 1 (network core, shipped 2026-07-04) amendments are folded in below** — see the
"Round 1 deltas" section for the new models and the attribution rule, the rewritten authz
matrix, and the amended invariants 3/4/5/10. The v1 model snippets are kept as history;
`prisma/schema.prisma` is the source of truth.

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
// slice 4 also adds `User.ledgerSeenAt DateTime?` — powers the ledger "new since viewed" flag
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

Migrations: `slice2_receiving` (Product, Restock, RestockImage, Lot) · `slice3_ledger` (Take, LedgerEntry) · `slice4_adjustments` (Adjustment, `User.ledgerSeenAt DateTime?`) · `slice5_extraction` (3 nullable columns on Restock + `RestockImage.originalSha256 String?` for fixture-mode extraction, 04 §3) · `slice6_lending` (Item, Loan) · `slice7_push` (PushSubscription) · `tax_fees_receipt_text` (2026-07-03 polish: tax/fee/excluded columns) · `orders_reserved` (2026-07-03: `Lot.reservedCount`, `Order`, `OrderLine`; D9) · `20260703100000_network_core` (Round 1: Membership/Connection/InstanceSettings, username/slug, per-household Product with duplication backfill, shared flags, attribution snapshots, LedgerSeen re-key — data-preserving, proven against a live volume) · `20260703120000_household_invites` (`Invite.kind` + `grantsJson`). Back-relations on Household/User/Pantry added in the same migration that needs them.

## Round 1 deltas (network core, 2026-07-04)

New models — see `prisma/schema.prisma` for full definitions; REWORK.md for rationale:

- **`Membership`** (user↔household, `@@unique([userId, householdId])`) replaces
  `User.householdId`. Eleven boolean capability flags (`src/server/capabilities.ts`;
  REWORK's `order` flag ships as `placeOrders` — SQL-keyword collision); Owner/Adult/
  Teen/Child are presets, not schema. Requests resolve a sticky ACTING household
  (cookie, validated against live memberships) behind the legacy `ctx.user.householdId`
  shape.
- **`Connection`** (canonical pair `householdAId < householdBId`, unique; status
  `PENDING | ACTIVE | SEVERED`) with two directional grant sets (`aGrants*`/`bGrants*`:
  pantry, lending, recipes, shareTo, shareFrom, reshare). The grant/capability choke
  point is `src/server/authz.ts`. Severing auto-cancels open orders across the pair and
  releases reservations in the same transaction (B6); ledger history and net survive.
- **`InstanceSettings`** (singleton `id='instance'`) + `User.isInstanceAdmin` +
  `User.username` / `Household.slug` (unique, `[a-z0-9_-]`) + `Invite.kind`/`grantsJson`
  (member vs found-a-household invites) + `Pantry.shared`/`Item.shared` +
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
pickup asserts the pantry grant is still ACTIVE; restock finalize asserts the purchaser
connection is still ACTIVE before posting the credit; settle/adjust require a connection
edge in ANY status (severed pairs stay settleable per B6; never-connected households are
unreachable and read as 404).

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

## Authz matrix (rewritten for Round 1: capability × grant × shared flag)

The v1 premise "everyone sees everything" is gone (REWORK B4). **Reads** are
connection-scoped: your households' data, plus what ACTIVE connections grant (their
SHARED pantries/items under the pantry/lending grants; a pair's ledger visible only to
its two households). Visibility failures read as **404** (existence never leaks);
capability failures on visible things are **403**. **Writes** ("acting" = the acting
household's membership flags):

| Operation | Capability (acting membership) | Cross-household reach |
| --- | --- | --- |
| Create/edit/finalize/abandon a DRAFT restock; removeImage; setUnitPhoto | `receiveStock`, **acting household must own the pantry** (a connected purchaser is credited via `purchaserHouseholdId`, not by driving the wizard) | purchaser must be the acting household or an ACTIVELY connected one; re-verified at finalize |
| Correct a RESTOCK_CREDIT / void-in-error | `settleMoney`, member of purchaser **or** pantry-owner household | — |
| Order draft/edit/cancel | `placeOrders` | pantry grant + `Pantry.shared` (via `loadOrderableLot`) |
| Order submit, and any edit to a SUBMITTED cross-household order | `spend` (own-pantry: `placeOrders`) | pantry grant, re-verified at pickup |
| Order startPicking / markReady / decline | `fulfill`, pantry-owner household | — |
| Order pickup (THE money event) | requester side: `spend` (cross) / `placeOrders` (own); owner side: `fulfill` | pantry grant re-asserted before posting |
| Undo a take | `placeOrders`, acting household = `Take.householdId` snapshot | — |
| Recount / write-off | `adjustInventory`, pantry-owner household only | — |
| Manual ADJUSTMENT / SETTLEMENT | `settleMoney`, own household one of the pair | connection edge in ANY status (severed pairs settleable, B6) |
| Create/edit Item | `lendBorrow`, owner household; fee > 0 / fee changes add `settleMoney`; shared-flag changes add `manageHousehold` | — |
| Loan checkout (borrower = acting user) | `lendBorrow`; + `spend` when a fee posts cross-household | lending grant + `Item.shared` |
| Loan return / undo checkout | `lendBorrow`, borrower-snapshot or owner household | works across a severed edge (loans run to return) |
| Member invites | `manageHousehold` | — |
| Household invites (found a new household) | `manageConnections` + the instance-admin growth toggle | accepted invite mints the ACTIVE first edge |
| Connection request/respond/setGrants/sever | `manageConnections`; grants edited unilaterally, own side only | — |
| Pantry create / shared flag | `manageHousehold`, own household | — |
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
4. Own-household takes (snapshot household = pantry owner) have `costCents = 0` and **no** ledger entry.
5. Exactly one **unreversed** RESTOCK_CREDIT per finalized restock where purchaser ≠ pantry owner, with `amountCents = Σ(receivedCount × unitCostCents)` over its lots; none otherwise. Reversed credits from the correct-credit op keep their `restockId` for the audit trail. Held-back units never appear in any ledger amount. The purchaser's connection must be ACTIVE at finalize (Round 1).
6. Every REVERSAL has a unique `reversesId`, identical `amountCents`, swapped creditor/debtor; when it reverses a TAKE, the take's `quantity` was returned to `lot.remainingCount` in the same tx.
7. `unitCostCents = Math.round(lineTotalCents / purchasedCount)`; per-lot paper drift `|lineTotalCents − purchasedCount × unitCostCents| ≤ ⌈purchasedCount / 2⌉` cents.
8. Recounts and write-offs never create ledger entries in v1 (owner eats the cost); the `WRITE_OFF` ledger type is reserved for the post-v1 shared write-off door.
9. For every lot: `remainingCount = receivedCount − Σ(active take quantities) + Σ(adjustment countAfter − countBefore)`, and `remainingCount ≥ 0` at all times (guarded by the conditional decrement).
10. LOAN_FEE posts at checkout iff `loan.feeCents > 0` **and** the borrower **snapshot** household (`Loan.borrowerHouseholdId`, stamped at checkout) ≠ item household, with `amountCents = loan.feeCents` (creditor = item owner). Cross-household checkouts additionally required the lending grant + `Item.shared` (Round 1).
11. SETTLEMENT: creditor = payer, debtor = payee — recording "$X from A to B" moves net(A,B) up by X (reduces A's debt).
12. `restock.varianceCents = receiptTotalCents − Σ lineTotalCents`, informational only: it never enters the ledger (purchaser bears it in v1).
