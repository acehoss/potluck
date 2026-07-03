# 01 — Data model & money invariants (slices 2–6)

Extends the live slice-1 schema (`prisma/schema.prisma`). One migration per slice, additive only.
SQLite via Prisma 7: **no native enums** — enum-ish columns are `String`, validated by zod at the
tRPC boundary with exported string-literal unions in `src/server/domain.ts`.

## Decisions (rationale inline below)

- **D1 Pricing:** `lineTotalCents` (as printed) is entered; `unitCostCents = roundHalfUp(lineTotalCents / purchasedCount)` is frozen at finalize. All money movement is `count × unitCostCents` — never the raw line total — so credits and take-debits match exactly; rounding drift exists only vs the paper receipt (≤ ⌈n/2⌉¢ per lot, borne by the pantry owner).
- **D2 Takes:** append-only. A Take row is immutable; undo sets `reversedAt` and posts a swapped-party REVERSAL ledger entry; "edit" = undo + new take in one transaction.
- **D3 Lot remaining:** stored counter `remainingCount`, mutated only inside the same interactive transaction as the take/reversal/adjustment, guarded by a conditional `updateMany`. SQLite is single-writer; no version column.
- **D4 Line = Lot:** one model `Lot` per receipt line (a line received at 0 is a pure hold-back and never shows in inventory). No separate RestockLine table.
- **D5 Settlement:** no table — it is a `LedgerEntry` of type `SETTLEMENT` (payer = creditor) with a `note` ("Venmo 7/2"). Adjustment (recount/write-off) never touches the ledger in v1.
- **D6 Restock code:** ~~assigned at finalize (drafts don't burn numbers)~~ **assigned at draft START** (amended 2026-07-03, polish round) from the receipt date, race-safe via `@@unique([dateCode, seq])` + insert-retry (`assignRestockCode`), re-derived if the date is edited. The physical flow — label each item as it hits the shelf, in bag order — needs the code up front. Tradeoff: abandoned drafts now leave gaps in a day's numbering — acceptable.
- **D7 Reconciliation:** `varianceCents = receiptTotalCents − (Σ lineTotalCents + taxCents + feesCents)` stored at finalize. Auto-pass if `|variance| ≤ 2¢ × lineCount`; otherwise the UI requires an explicit acknowledgment. **Tax/fee allocation is now implemented (amended 2026-07-03):** `taxCents` is apportioned across taxable lines and `feesCents` across all lines (when `feesDistributed`) by largest-remainder (`apportionCents`/`allocateReceipt`), folded into each lot's frozen `unitCostCents` — so takes and the purchaser credit are tax-inclusive/at-cost. Fees are the purchaser's cost unless shared. Entering tax/fees also removes the false "receipt short" variance a taxed receipt used to always show.
- **D8 Product photo:** derived — newest lot of the product with a `unitPhotoPath`. No photo column.

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

Migrations: `slice2_receiving` (Product, Restock, RestockImage, Lot) · `slice3_ledger` (Take, LedgerEntry) · `slice4_adjustments` (Adjustment, `User.ledgerSeenAt DateTime?`) · `slice5_extraction` (3 nullable columns on Restock + `RestockImage.originalSha256 String?` for fixture-mode extraction, 04 §3) · `slice6_lending` (Item, Loan). Back-relations on Household/User/Pantry added in the same migration that needs them.

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

## Authz matrix (everyone sees everything; writes below)

| Operation | Allowed |
| --- | --- |
| Create/edit a DRAFT restock | any coop member (trust assumed; purchaser may differ from owner) |
| Finalize / delete a DRAFT restock | restock `createdBy`, or member of the purchaser household (finalize posts money and delete destroys receipt images — not open to everyone) |
| Correct a RESTOCK_CREDIT | member of purchaser **or** pantry-owner household (see Immutability) |
| Take from any lot | any coop member |
| Undo/edit a take | member of the taking household |
| Recount / write-off | member of the **pantry-owning household only** (ancestral spec) |
| Manual ADJUSTMENT entry | any member, but own household must be creditor or debtor; creation **notifies the counterparty household** (SPEC §4) — in-app "new" flag at slice 4, push at slice 7 |
| Record SETTLEMENT | member of payer or payee household |
| Create/edit Item, edit feeCents | member of owning household |
| Loan checkout (borrower = self) / return | checkout: any member; return: borrower's or owner's household |

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
3. For every TAKE entry: `amountCents = take.quantity × lot.unitCostCents` exactly, and taker household ≠ lot's pantry-owner household.
4. Own-household takes have `costCents = 0` and **no** ledger entry.
5. Exactly one **unreversed** RESTOCK_CREDIT per finalized restock where purchaser ≠ pantry owner, with `amountCents = Σ(receivedCount × unitCostCents)` over its lots; none otherwise. Reversed credits from the correct-credit op keep their `restockId` for the audit trail. Held-back units never appear in any ledger amount.
6. Every REVERSAL has a unique `reversesId`, identical `amountCents`, swapped creditor/debtor; when it reverses a TAKE, the take's `quantity` was returned to `lot.remainingCount` in the same tx.
7. `unitCostCents = Math.round(lineTotalCents / purchasedCount)`; per-lot paper drift `|lineTotalCents − purchasedCount × unitCostCents| ≤ ⌈purchasedCount / 2⌉` cents.
8. Recounts and write-offs never create ledger entries in v1 (owner eats the cost); the `WRITE_OFF` ledger type is reserved for the post-v1 shared write-off door.
9. For every lot: `remainingCount = receivedCount − Σ(active take quantities) + Σ(adjustment countAfter − countBefore)`, and `remainingCount ≥ 0` at all times (guarded by the conditional decrement).
10. LOAN_FEE posts at checkout iff `loan.feeCents > 0` **and** borrower household ≠ item household, with `amountCents = loan.feeCents` (creditor = item owner).
11. SETTLEMENT: creditor = payer, debtor = payee — recording "$X from A to B" moves net(A,B) up by X (reduces A's debt).
12. `restock.varianceCents = receiptTotalCents − Σ lineTotalCents`, informational only: it never enters the ledger (purchaser bears it in v1).
