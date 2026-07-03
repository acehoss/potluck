-- Orders with a request/fulfilment lifecycle + inventory reservation.
-- Lot gains a reservedCount (availability = remainingCount − reservedCount);
-- Order/OrderLine model the DRAFT→REQUESTED→PICKING→READY→PICKED_UP/CANCELED
-- flow. Adding a column and new tables needs no table rebuild (unlike making a
-- column nullable — cf. 20260703060000), so reservedCount is a plain ADD COLUMN
-- rather than the RedefineTables rebuild `prisma migrate diff` emits.

-- AlterTable
ALTER TABLE "Lot" ADD COLUMN "reservedCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "pantryId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "requestedAt" DATETIME,
    "pickingAt" DATETIME,
    "readyAt" DATETIME,
    "pickedUpAt" DATETIME,
    "canceledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_pantryId_fkey" FOREIGN KEY ("pantryId") REFERENCES "Pantry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "takeId" TEXT,
    CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderLine_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientKey_key" ON "Order"("clientKey");

-- CreateIndex
CREATE INDEX "Order_householdId_idx" ON "Order"("householdId");

-- CreateIndex
CREATE INDEX "Order_pantryId_idx" ON "Order"("pantryId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_takeId_key" ON "OrderLine"("takeId");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE INDEX "OrderLine_lotId_idx" ON "OrderLine"("lotId");
