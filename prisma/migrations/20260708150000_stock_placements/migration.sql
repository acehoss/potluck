-- Potluck Phase-4 Round 1 — stock placements (docs/archive/mutual-aid-rework-2026-07.md S1/S2 + Round-0 A-series):
--   Lot stops implying location. New Stock table = the units of one lot currently
--   in one pantry (count + the soft order-hold reservedCount, both moved off Lot).
--   Lot keeps receipt lineage + frozen cost; Restock.pantryId becomes the default
--   destination. History re-anchors to placements: OrderLine.stockId (the row the
--   reservation lives on), Adjustment.stockId, SharePostLot.stockId (which shelf a
--   gift draws from), Take.pantryId (relation-free where-it-happened snapshot).
-- Data-preserving backfill: exactly one placement per non-excluded lot of a
-- FINALIZED restock, at the restock's pantry, carrying the lot's remainingCount/
-- reservedCount. Deterministic ids ('stk-' || lotId) key every FK backfill and
-- keep the migration idempotent. Draft-restock lots get NO placement (finalize
-- materializes placements from now on); excluded lines never become inventory.
-- Proven by scripts/verify-stock-migration.mjs.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- === 0. Preflight ============================================================
-- The FK backfills below assume every history row (OrderLine / Adjustment /
-- SharePostLot) references a finalized, non-excluded lot — the only lots that
-- get placements. App code has always enforced that, but this migration runs
-- on deployments whose data we can't see, and FK checks are OFF during the
-- rebuild — a violation would land as a silently dangling stockId. Abort
-- instead: the CHECK(ok = 1) fails the INSERT (and the whole migration) when
-- any offending row exists.
CREATE TABLE "_preflight" ("what" TEXT NOT NULL, "ok" INTEGER NOT NULL CHECK ("ok" = 1));
INSERT INTO "_preflight"
SELECT 'OrderLine on a draft/excluded lot', CASE WHEN EXISTS (
  SELECT 1 FROM "OrderLine" ol JOIN "Lot" l ON l."id" = ol."lotId"
  JOIN "Restock" r ON r."id" = l."restockId"
  WHERE r."status" <> 'FINALIZED' OR l."excluded" = 1
) THEN 0 ELSE 1 END;
INSERT INTO "_preflight"
SELECT 'Adjustment on a draft/excluded lot', CASE WHEN EXISTS (
  SELECT 1 FROM "Adjustment" a JOIN "Lot" l ON l."id" = a."lotId"
  JOIN "Restock" r ON r."id" = l."restockId"
  WHERE r."status" <> 'FINALIZED' OR l."excluded" = 1
) THEN 0 ELSE 1 END;
INSERT INTO "_preflight"
SELECT 'SharePostLot on a draft/excluded lot', CASE WHEN EXISTS (
  SELECT 1 FROM "SharePostLot" spl JOIN "Lot" l ON l."id" = spl."lotId"
  JOIN "Restock" r ON r."id" = l."restockId"
  WHERE r."status" <> 'FINALIZED' OR l."excluded" = 1
) THEN 0 ELSE 1 END;
DROP TABLE "_preflight";

-- === 1. Stock ================================================================
CREATE TABLE "Stock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "pantryId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Stock_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Stock_pantryId_fkey" FOREIGN KEY ("pantryId") REFERENCES "Pantry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Stock_lotId_pantryId_key" ON "Stock"("lotId", "pantryId");
CREATE INDEX "Stock_pantryId_idx" ON "Stock"("pantryId");
CREATE INDEX "Stock_lotId_idx" ON "Stock"("lotId");

-- === 2. Backfill: one placement per finalized non-excluded lot ================
INSERT INTO "Stock" ("id", "lotId", "pantryId", "count", "reservedCount")
SELECT 'stk-' || l."id", l."id", r."pantryId", l."remainingCount", l."reservedCount"
FROM "Lot" l
JOIN "Restock" r ON r."id" = l."restockId"
WHERE r."status" = 'FINALIZED' AND l."excluded" = 0;

-- === 3. Rebuild Lot without remainingCount/reservedCount ======================
CREATE TABLE "new_Lot" (
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
    "bestBy" DATETIME,
    "unitPhotoPath" TEXT,
    CONSTRAINT "Lot_restockId_fkey" FOREIGN KEY ("restockId") REFERENCES "Restock" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Lot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Lot" ("id", "restockId", "productId", "position", "purchasedCount",
    "receivedCount", "lineTotalCents", "taxable", "excluded", "receiptText",
    "unitCostCents", "taxCentsAllocated", "feeCentsAllocated", "bestBy", "unitPhotoPath")
SELECT "id", "restockId", "productId", "position", "purchasedCount",
    "receivedCount", "lineTotalCents", "taxable", "excluded", "receiptText",
    "unitCostCents", "taxCentsAllocated", "feeCentsAllocated", "bestBy", "unitPhotoPath"
FROM "Lot";
DROP TABLE "Lot";
ALTER TABLE "new_Lot" RENAME TO "Lot";
CREATE INDEX "Lot_productId_idx" ON "Lot"("productId");
CREATE UNIQUE INDEX "Lot_restockId_position_key" ON "Lot"("restockId", "position");

-- === 4. Rebuild OrderLine with stockId =======================================
CREATE TABLE "new_OrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "takeId" TEXT,
    CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderLine_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrderLine_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_OrderLine" ("id", "orderId", "lotId", "stockId", "quantity", "takeId")
SELECT "id", "orderId", "lotId", 'stk-' || "lotId", "quantity", "takeId"
FROM "OrderLine";
DROP TABLE "OrderLine";
ALTER TABLE "new_OrderLine" RENAME TO "OrderLine";
CREATE UNIQUE INDEX "OrderLine_takeId_key" ON "OrderLine"("takeId");
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");
CREATE INDEX "OrderLine_lotId_idx" ON "OrderLine"("lotId");
CREATE INDEX "OrderLine_stockId_idx" ON "OrderLine"("stockId");

-- === 5. Rebuild Adjustment with stockId ======================================
CREATE TABLE "new_Adjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "lotId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "countBefore" INTEGER NOT NULL,
    "countAfter" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Adjustment_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Adjustment_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Adjustment" ("id", "clientKey", "lotId", "stockId", "type",
    "countBefore", "countAfter", "note", "createdById", "createdAt")
SELECT "id", "clientKey", "lotId", 'stk-' || "lotId", "type",
    "countBefore", "countAfter", "note", "createdById", "createdAt"
FROM "Adjustment";
DROP TABLE "Adjustment";
ALTER TABLE "new_Adjustment" RENAME TO "Adjustment";
CREATE UNIQUE INDEX "Adjustment_clientKey_key" ON "Adjustment"("clientKey");
CREATE INDEX "Adjustment_lotId_idx" ON "Adjustment"("lotId");
CREATE INDEX "Adjustment_stockId_idx" ON "Adjustment"("stockId");

-- === 6. Rebuild Take with pantryId snapshot ===================================
-- Where the units left. Every historical take predates transfers, so the lot's
-- restock pantry IS where it happened.
CREATE TABLE "new_Take" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "lotId" TEXT NOT NULL,
    "takerId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL,
    "shareClaimId" TEXT,
    "pantryId" TEXT NOT NULL,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" DATETIME,
    "reversedById" TEXT,
    CONSTRAINT "Take_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Take_takerId_fkey" FOREIGN KEY ("takerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Take" ("id", "clientKey", "lotId", "takerId", "householdId",
    "quantity", "costCents", "shareClaimId", "pantryId", "takenAt", "reversedAt", "reversedById")
SELECT t."id", t."clientKey", t."lotId", t."takerId", t."householdId",
    t."quantity", t."costCents", t."shareClaimId", r."pantryId", t."takenAt", t."reversedAt", t."reversedById"
FROM "Take" t
JOIN "Lot" l ON l."id" = t."lotId"
JOIN "Restock" r ON r."id" = l."restockId";
DROP TABLE "Take";
ALTER TABLE "new_Take" RENAME TO "Take";
CREATE UNIQUE INDEX "Take_clientKey_key" ON "Take"("clientKey");
CREATE INDEX "Take_lotId_idx" ON "Take"("lotId");
CREATE INDEX "Take_shareClaimId_idx" ON "Take"("shareClaimId");

-- === 7. Rebuild SharePostLot with stockId =====================================
CREATE TABLE "new_SharePostLot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    CONSTRAINT "SharePostLot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SharePost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SharePostLot_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SharePostLot_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SharePostLot" ("id", "postId", "lotId", "stockId")
SELECT "id", "postId", "lotId", 'stk-' || "lotId"
FROM "SharePostLot";
DROP TABLE "SharePostLot";
ALTER TABLE "new_SharePostLot" RENAME TO "SharePostLot";
-- Unique per (post, PLACEMENT): once a lot sits in two pantries, a post may
-- legitimately offer both shelves as separate links.
CREATE UNIQUE INDEX "SharePostLot_postId_stockId_key" ON "SharePostLot"("postId", "stockId");
CREATE INDEX "SharePostLot_lotId_idx" ON "SharePostLot"("lotId");
CREATE INDEX "SharePostLot_stockId_idx" ON "SharePostLot"("stockId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
