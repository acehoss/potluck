-- tax & fee non-inventory amounts + proportional allocation (blueprint 01 D7 door),
-- excluded/taxable lines, receipt line text, and restock void-in-error.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "remainingCount" INTEGER NOT NULL DEFAULT 0,
    "bestBy" DATETIME,
    "unitPhotoPath" TEXT,
    CONSTRAINT "Lot_restockId_fkey" FOREIGN KEY ("restockId") REFERENCES "Restock" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Lot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Lot" ("bestBy", "id", "lineTotalCents", "position", "productId", "purchasedCount", "receivedCount", "remainingCount", "restockId", "unitCostCents", "unitPhotoPath") SELECT "bestBy", "id", "lineTotalCents", "position", "productId", "purchasedCount", "receivedCount", "remainingCount", "restockId", "unitCostCents", "unitPhotoPath" FROM "Lot";
DROP TABLE "Lot";
ALTER TABLE "new_Lot" RENAME TO "Lot";
CREATE INDEX "Lot_productId_idx" ON "Lot"("productId");
CREATE UNIQUE INDEX "Lot_restockId_position_key" ON "Lot"("restockId", "position");
CREATE TABLE "new_Restock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pantryId" TEXT NOT NULL,
    "purchaserHouseholdId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "retailer" TEXT NOT NULL,
    "purchasedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "dateCode" TEXT,
    "seq" INTEGER,
    "receiptTotalCents" INTEGER,
    "taxCents" INTEGER,
    "feesCents" INTEGER,
    "feesDistributed" BOOLEAN NOT NULL DEFAULT false,
    "varianceCents" INTEGER,
    "voidedAt" DATETIME,
    "extractedAt" DATETIME,
    "extractionModel" TEXT,
    "extractionJson" TEXT,
    "extractionResolved" TEXT,
    "finalizedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Restock_pantryId_fkey" FOREIGN KEY ("pantryId") REFERENCES "Pantry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Restock_purchaserHouseholdId_fkey" FOREIGN KEY ("purchaserHouseholdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Restock_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Restock" ("createdAt", "createdById", "dateCode", "extractedAt", "extractionJson", "extractionModel", "extractionResolved", "finalizedAt", "id", "pantryId", "purchasedAt", "purchaserHouseholdId", "receiptTotalCents", "retailer", "seq", "status", "varianceCents") SELECT "createdAt", "createdById", "dateCode", "extractedAt", "extractionJson", "extractionModel", "extractionResolved", "finalizedAt", "id", "pantryId", "purchasedAt", "purchaserHouseholdId", "receiptTotalCents", "retailer", "seq", "status", "varianceCents" FROM "Restock";
DROP TABLE "Restock";
ALTER TABLE "new_Restock" RENAME TO "Restock";
CREATE INDEX "Restock_pantryId_idx" ON "Restock"("pantryId");
CREATE UNIQUE INDEX "Restock_dateCode_seq_key" ON "Restock"("dateCode", "seq");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

