-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "upc" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Restock" (
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
    "varianceCents" INTEGER,
    "finalizedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Restock_pantryId_fkey" FOREIGN KEY ("pantryId") REFERENCES "Pantry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Restock_purchaserHouseholdId_fkey" FOREIGN KEY ("purchaserHouseholdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Restock_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RestockImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restockId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "RestockImage_restockId_fkey" FOREIGN KEY ("restockId") REFERENCES "Restock" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "creditorHouseholdId" TEXT NOT NULL,
    "debtorHouseholdId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takeId" TEXT,
    "restockId" TEXT,
    "loanId" TEXT,
    "reversesId" TEXT
);

-- CreateTable
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restockId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "purchasedCount" INTEGER NOT NULL,
    "receivedCount" INTEGER NOT NULL,
    "lineTotalCents" INTEGER NOT NULL,
    "unitCostCents" INTEGER,
    "remainingCount" INTEGER NOT NULL DEFAULT 0,
    "bestBy" DATETIME,
    "unitPhotoPath" TEXT,
    CONSTRAINT "Lot_restockId_fkey" FOREIGN KEY ("restockId") REFERENCES "Restock" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Lot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Product_upc_idx" ON "Product"("upc");

-- CreateIndex
CREATE INDEX "Restock_pantryId_idx" ON "Restock"("pantryId");

-- CreateIndex
CREATE UNIQUE INDEX "Restock_dateCode_seq_key" ON "Restock"("dateCode", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "RestockImage_restockId_position_key" ON "RestockImage"("restockId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_takeId_key" ON "LedgerEntry"("takeId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_loanId_key" ON "LedgerEntry"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_reversesId_key" ON "LedgerEntry"("reversesId");

-- CreateIndex
CREATE INDEX "LedgerEntry_creditorHouseholdId_debtorHouseholdId_idx" ON "LedgerEntry"("creditorHouseholdId", "debtorHouseholdId");

-- CreateIndex
CREATE INDEX "LedgerEntry_restockId_idx" ON "LedgerEntry"("restockId");

-- CreateIndex
CREATE INDEX "Lot_productId_idx" ON "Lot"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_restockId_position_key" ON "Lot"("restockId", "position");
