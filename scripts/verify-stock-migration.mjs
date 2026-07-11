/**
 * Proof harness for the 20260708150000_stock_placements migration
 * (docs/archive/mutual-aid-rework-2026-07.md Phase 4 S1/S2).
 *
 * Builds a synthetic pre-placement world with the cases the data-preserving
 * migration must survive — a finalized lot with units and an open-order
 * reservation, an excluded receipt line, a zero-remaining lot, a DRAFT-restock
 * lot, a voided (FINALIZED, zeroed) restock's lot, plus history rows
 * (OrderLine/Adjustment/Take/SharePostLot) hanging off them — applies the EXACT
 * migration SQL, then asserts:
 *   1. placements exist for exactly the finalized non-excluded lots, at the
 *      restock's pantry, carrying remainingCount/reservedCount verbatim;
 *   2. deterministic ids ('stk-' || lotId) so every FK backfill resolves —
 *      OrderLine/Adjustment/SharePostLot stockIds point at a Stock row of the
 *      SAME lot; Take.pantryId equals the lot's restock pantry;
 *   3. rebuilt tables preserve row counts and column values, Lot loses its
 *      count columns, and PRAGMA foreign_key_check comes back clean.
 *
 * Run: node scripts/verify-stock-migration.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, '../prisma/migrations/20260708150000_stock_placements/migration.sql');

const db = new Database(':memory:');
db.pragma('foreign_keys = OFF');

// --- minimal pre-migration world (only the tables/columns the migration and
// --- the closing foreign_key_check touch) -----------------------------------
db.exec(`
CREATE TABLE "Household" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "Pantry" ("id" TEXT NOT NULL PRIMARY KEY, "householdId" TEXT NOT NULL, "name" TEXT NOT NULL);
CREATE TABLE "Product" ("id" TEXT NOT NULL PRIMARY KEY, "householdId" TEXT NOT NULL, "name" TEXT NOT NULL);
CREATE TABLE "Restock" (
  "id" TEXT NOT NULL PRIMARY KEY, "pantryId" TEXT NOT NULL, "status" TEXT NOT NULL,
  "voidedAt" DATETIME
);
CREATE TABLE "Order" ("id" TEXT NOT NULL PRIMARY KEY, "pantryId" TEXT NOT NULL, "status" TEXT NOT NULL);
CREATE TABLE "SharePost" ("id" TEXT NOT NULL PRIMARY KEY, "type" TEXT NOT NULL);
CREATE TABLE "Lot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restockId" TEXT NOT NULL,
  "productId" TEXT,
  "position" INTEGER NOT NULL,
  "purchasedCount" INTEGER NOT NULL,
  "receivedCount" INTEGER NOT NULL,
  "lineTotalCents" INTEGER NOT NULL,
  "taxable" BOOLEAN NOT NULL DEFAULT false,
  "excluded" BOOLEAN NOT NULL DEFAULT false,
  "receiptText" TEXT,
  "unitCostCents" INTEGER,
  "taxCentsAllocated" INTEGER,
  "feeCentsAllocated" INTEGER,
  "remainingCount" INTEGER NOT NULL DEFAULT 0,
  "bestBy" DATETIME,
  "unitPhotoPath" TEXT, "reservedCount" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "Lot_productId_idx" ON "Lot"("productId");
CREATE UNIQUE INDEX "Lot_restockId_position_key" ON "Lot"("restockId", "position");
CREATE TABLE "OrderLine" (
  "id" TEXT NOT NULL PRIMARY KEY, "orderId" TEXT NOT NULL, "lotId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL, "takeId" TEXT
);
CREATE UNIQUE INDEX "OrderLine_takeId_key" ON "OrderLine"("takeId");
CREATE TABLE "Adjustment" (
  "id" TEXT NOT NULL PRIMARY KEY, "clientKey" TEXT, "lotId" TEXT NOT NULL,
  "type" TEXT NOT NULL, "countBefore" INTEGER NOT NULL, "countAfter" INTEGER NOT NULL,
  "note" TEXT, "createdById" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Adjustment_clientKey_key" ON "Adjustment"("clientKey");
CREATE TABLE "Take" (
  "id" TEXT NOT NULL PRIMARY KEY, "clientKey" TEXT, "lotId" TEXT NOT NULL,
  "takerId" TEXT NOT NULL, "householdId" TEXT NOT NULL, "quantity" INTEGER NOT NULL,
  "costCents" INTEGER NOT NULL,
  "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedAt" DATETIME, "reversedById" TEXT, "shareClaimId" TEXT
);
CREATE UNIQUE INDEX "Take_clientKey_key" ON "Take"("clientKey");
CREATE TABLE "SharePostLot" (
  "id" TEXT NOT NULL PRIMARY KEY, "postId" TEXT NOT NULL, "lotId" TEXT NOT NULL
);
CREATE UNIQUE INDEX "SharePostLot_postId_lotId_key" ON "SharePostLot"("postId", "lotId");
`);

// Households / pantries / products / restocks.
db.exec(`
INSERT INTO "Household" VALUES ('hA','Alpha'),('hB','Beta');
INSERT INTO "User" VALUES ('u1','Uma');
INSERT INTO "Pantry" VALUES ('p1','hA','Kitchen'),('p2','hA','Garage');
INSERT INTO "Product" VALUES ('prod1','hA','Beans'),('prod2','hA','Rice');
INSERT INTO "Restock" VALUES
  ('rA','p1','FINALIZED',NULL),
  ('rB','p1','DRAFT',NULL),
  ('rC','p2','FINALIZED','2026-07-01T00:00:00Z');
INSERT INTO "Order" VALUES ('o1','p1','REQUESTED');
INSERT INTO "SharePost" VALUES ('sp1','SURPLUS');
`);

// Lots: the pathological spread.
//  lotA1 — finalized, live units + reservation (the normal case)
//  lotA2 — excluded receipt line (never inventory → NO placement)
//  lotA3 — finalized, fully consumed (0/0 → placement with count 0, FK anchor)
//  lotB1 — DRAFT restock (finalize hasn't run → NO placement)
//  lotC1 — voided restock's lot (FINALIZED + zeroed → placement with count 0)
db.exec(`
INSERT INTO "Lot" ("id","restockId","productId","position","purchasedCount","receivedCount",
  "lineTotalCents","taxable","excluded","receiptText","unitCostCents","taxCentsAllocated",
  "feeCentsAllocated","remainingCount","bestBy","unitPhotoPath","reservedCount") VALUES
  ('lotA1','rA','prod1',0,12,12,1200,1,0,'BEANS 12CT',107,7,0,10,'2027-01-01T00:00:00Z','/img/a1.jpg',3),
  ('lotA2','rA',NULL,1,0,0,499,1,1,'BOTTLE DEPOSIT',NULL,NULL,NULL,0,NULL,NULL,0),
  ('lotA3','rA','prod2',2,5,5,500,0,0,NULL,100,NULL,NULL,0,NULL,NULL,0),
  ('lotB1','rB','prod1',0,6,6,600,0,0,NULL,NULL,NULL,NULL,0,NULL,NULL,0),
  ('lotC1','rC','prod2',0,4,4,400,0,0,NULL,100,NULL,NULL,0,NULL,NULL,0);
`);

// History hanging off the lots.
db.exec(`
INSERT INTO "OrderLine" VALUES ('ol1','o1','lotA1',3,NULL);
INSERT INTO "Adjustment" VALUES ('adj1','ck-adj1','lotA1','RECOUNT',12,10,NULL,'u1','2026-07-05T00:00:00Z');
INSERT INTO "Take" VALUES
  ('t1','ck-t1','lotA1','u1','hB',2,214,'2026-07-04T00:00:00Z',NULL,NULL,NULL),
  ('t2',NULL,'lotC1','u1','hA',4,0,'2026-07-03T00:00:00Z',NULL,NULL,'claim1');
INSERT INTO "SharePostLot" VALUES ('spl1','sp1','lotA1');
`);

const before = {
  lots: db.prepare('SELECT COUNT(*) n FROM "Lot"').get().n,
  orderLines: db.prepare('SELECT COUNT(*) n FROM "OrderLine"').get().n,
  adjustments: db.prepare('SELECT COUNT(*) n FROM "Adjustment"').get().n,
  takes: db.prepare('SELECT COUNT(*) n FROM "Take"').get().n,
  sharePostLots: db.prepare('SELECT COUNT(*) n FROM "SharePostLot"').get().n,
};

// --- apply the exact migration ------------------------------------------------
db.exec(readFileSync(MIGRATION, 'utf8'));

// --- assertions ----------------------------------------------------------------
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 1. Placement backfill: exactly the finalized non-excluded lots.
const stocks = db.prepare('SELECT * FROM "Stock" ORDER BY "id"').all();
check('placements for exactly {lotA1, lotA3, lotC1}',
  JSON.stringify(stocks.map((s) => s.lotId).sort()) === JSON.stringify(['lotA1', 'lotA3', 'lotC1']),
  JSON.stringify(stocks.map((s) => s.lotId)));
const sA1 = db.prepare('SELECT * FROM "Stock" WHERE "lotId" = ?').get('lotA1');
check('lotA1 placement carries counts + pantry',
  sA1 && sA1.id === 'stk-lotA1' && sA1.pantryId === 'p1' && sA1.count === 10 && sA1.reservedCount === 3,
  JSON.stringify(sA1));
const sC1 = db.prepare('SELECT * FROM "Stock" WHERE "lotId" = ?').get('lotC1');
check('voided-restock lot gets a zero placement at its pantry',
  sC1 && sC1.pantryId === 'p2' && sC1.count === 0 && sC1.reservedCount === 0,
  JSON.stringify(sC1));

// 2. Lot rebuild: columns gone, values preserved.
const lotCols = db.prepare('PRAGMA table_info("Lot")').all().map((c) => c.name);
check('Lot.remainingCount/reservedCount dropped',
  !lotCols.includes('remainingCount') && !lotCols.includes('reservedCount'));
const lotA1 = db.prepare('SELECT * FROM "Lot" WHERE "id" = ?').get('lotA1');
check('Lot values preserved through rebuild',
  lotA1.unitCostCents === 107 && lotA1.taxCentsAllocated === 7 && lotA1.receiptText === 'BEANS 12CT'
  && lotA1.unitPhotoPath === '/img/a1.jpg' && lotA1.purchasedCount === 12,
  JSON.stringify(lotA1));

// 3. FK backfills resolve to a Stock row of the SAME lot.
const olJoin = db.prepare(`
  SELECT COUNT(*) n FROM "OrderLine" ol
  LEFT JOIN "Stock" s ON s."id" = ol."stockId" AND s."lotId" = ol."lotId"
  WHERE s."id" IS NULL`).get().n;
check('every OrderLine.stockId resolves to its own lot’s placement', olJoin === 0);
const adjJoin = db.prepare(`
  SELECT COUNT(*) n FROM "Adjustment" a
  LEFT JOIN "Stock" s ON s."id" = a."stockId" AND s."lotId" = a."lotId"
  WHERE s."id" IS NULL`).get().n;
check('every Adjustment.stockId resolves to its own lot’s placement', adjJoin === 0);
const splJoin = db.prepare(`
  SELECT COUNT(*) n FROM "SharePostLot" spl
  LEFT JOIN "Stock" s ON s."id" = spl."stockId" AND s."lotId" = spl."lotId"
  WHERE s."id" IS NULL`).get().n;
check('every SharePostLot.stockId resolves to its own lot’s placement', splJoin === 0);

// 4. Take.pantryId snapshots the lot's restock pantry.
const takeBad = db.prepare(`
  SELECT COUNT(*) n FROM "Take" t
  JOIN "Lot" l ON l."id" = t."lotId"
  JOIN "Restock" r ON r."id" = l."restockId"
  WHERE t."pantryId" <> r."pantryId"`).get().n;
check('Take.pantryId == lot.restock.pantryId for all takes', takeBad === 0);
const t1 = db.prepare('SELECT * FROM "Take" WHERE "id" = ?').get('t1');
check('Take values preserved (clientKey, cost, shareClaim)',
  t1.clientKey === 'ck-t1' && t1.costCents === 214 && t1.pantryId === 'p1' && t1.shareClaimId === null,
  JSON.stringify(t1));

// 5. Row counts preserved.
const after = {
  lots: db.prepare('SELECT COUNT(*) n FROM "Lot"').get().n,
  orderLines: db.prepare('SELECT COUNT(*) n FROM "OrderLine"').get().n,
  adjustments: db.prepare('SELECT COUNT(*) n FROM "Adjustment"').get().n,
  takes: db.prepare('SELECT COUNT(*) n FROM "Take"').get().n,
  sharePostLots: db.prepare('SELECT COUNT(*) n FROM "SharePostLot"').get().n,
};
check('row counts preserved across rebuilds', JSON.stringify(before) === JSON.stringify(after),
  `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

// 6. Referential integrity.
db.pragma('foreign_keys = ON');
const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
check('PRAGMA foreign_key_check clean', fkViolations.length === 0, JSON.stringify(fkViolations));

// 7. Preflight abort: a history row on a lot that gets NO placement (here an
// OrderLine against a DRAFT-restock lot) must fail the migration outright —
// never a silently dangling stockId on someone else's deployment.
{
  const bad = new Database(':memory:');
  bad.pragma('foreign_keys = OFF');
  // Re-create the minimal pre-migration world by replaying this script's own
  // DDL is overkill; the preflight only touches OrderLine/Adjustment/
  // SharePostLot ⋈ Lot ⋈ Restock, so a skeleton suffices.
  bad.exec(`
    CREATE TABLE "Restock" ("id" TEXT PRIMARY KEY, "pantryId" TEXT NOT NULL, "status" TEXT NOT NULL, "voidedAt" DATETIME);
    CREATE TABLE "Lot" ("id" TEXT PRIMARY KEY, "restockId" TEXT NOT NULL, "productId" TEXT, "position" INTEGER NOT NULL,
      "purchasedCount" INTEGER NOT NULL, "receivedCount" INTEGER NOT NULL, "lineTotalCents" INTEGER NOT NULL,
      "taxable" BOOLEAN NOT NULL DEFAULT false, "excluded" BOOLEAN NOT NULL DEFAULT false, "receiptText" TEXT,
      "unitCostCents" INTEGER, "taxCentsAllocated" INTEGER, "feeCentsAllocated" INTEGER,
      "remainingCount" INTEGER NOT NULL DEFAULT 0, "bestBy" DATETIME, "unitPhotoPath" TEXT,
      "reservedCount" INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE "OrderLine" ("id" TEXT PRIMARY KEY, "orderId" TEXT NOT NULL, "lotId" TEXT NOT NULL,
      "quantity" INTEGER NOT NULL, "takeId" TEXT);
    CREATE TABLE "Adjustment" ("id" TEXT PRIMARY KEY, "clientKey" TEXT, "lotId" TEXT NOT NULL, "type" TEXT NOT NULL,
      "countBefore" INTEGER NOT NULL, "countAfter" INTEGER NOT NULL, "note" TEXT, "createdById" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "SharePostLot" ("id" TEXT PRIMARY KEY, "postId" TEXT NOT NULL, "lotId" TEXT NOT NULL);
    INSERT INTO "Restock" VALUES ('rDraft','p1','DRAFT',NULL);
    INSERT INTO "Lot" ("id","restockId","productId","position","purchasedCount","receivedCount","lineTotalCents")
      VALUES ('lotDraft','rDraft','prod1',0,5,5,500);
    INSERT INTO "OrderLine" VALUES ('olBad','o1','lotDraft',1,NULL);
  `);
  let aborted = false;
  try {
    bad.exec(readFileSync(MIGRATION, 'utf8'));
  } catch (e) {
    aborted = /CHECK constraint failed/i.test(String(e.message));
  }
  check('preflight aborts on an OrderLine referencing a placement-less lot', aborted);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nstock-placements migration: all invariants hold');
