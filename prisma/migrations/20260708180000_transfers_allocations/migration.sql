-- Potluck Phase-4 Round 2 — transfers + receive allocations (REWORK S3/S4).
-- Purely additive: Transfer/TransferLine (immutable A→B move audit; lines pin
-- the exact source/destination placements) and LotAllocation (DRAFT-time
-- receive-split state, deleted at finalize once placements materialize).

CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "householdId" TEXT NOT NULL,
    "fromPantryId" TEXT NOT NULL,
    "toPantryId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transfer_fromPantryId_fkey" FOREIGN KEY ("fromPantryId") REFERENCES "Pantry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transfer_toPantryId_fkey" FOREIGN KEY ("toPantryId") REFERENCES "Pantry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transfer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Transfer_clientKey_key" ON "Transfer"("clientKey");
CREATE INDEX "Transfer_householdId_createdAt_idx" ON "Transfer"("householdId", "createdAt");
CREATE INDEX "Transfer_fromPantryId_idx" ON "Transfer"("fromPantryId");
CREATE INDEX "Transfer_toPantryId_idx" ON "Transfer"("toPantryId");

CREATE TABLE "TransferLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transferId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "fromStockId" TEXT NOT NULL,
    "toStockId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    CONSTRAINT "TransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TransferLine_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransferLine_fromStockId_fkey" FOREIGN KEY ("fromStockId") REFERENCES "Stock" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransferLine_toStockId_fkey" FOREIGN KEY ("toStockId") REFERENCES "Stock" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TransferLine_transferId_idx" ON "TransferLine"("transferId");
CREATE INDEX "TransferLine_lotId_idx" ON "TransferLine"("lotId");

CREATE TABLE "LotAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "pantryId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    CONSTRAINT "LotAllocation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LotAllocation_pantryId_fkey" FOREIGN KEY ("pantryId") REFERENCES "Pantry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LotAllocation_lotId_pantryId_key" ON "LotAllocation"("lotId", "pantryId");
CREATE INDEX "LotAllocation_pantryId_idx" ON "LotAllocation"("pantryId");
