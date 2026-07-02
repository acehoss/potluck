-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN "clientKey" TEXT;

-- CreateTable
CREATE TABLE "Adjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "lotId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "countBefore" INTEGER NOT NULL,
    "countAfter" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Adjustment_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LedgerSeen" (
    "userId" TEXT NOT NULL,
    "counterpartyHouseholdId" TEXT NOT NULL,
    "seenAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "counterpartyHouseholdId"),
    CONSTRAINT "LedgerSeen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_clientKey_key" ON "LedgerEntry"("clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "Adjustment_clientKey_key" ON "Adjustment"("clientKey");

-- CreateIndex
CREATE INDEX "Adjustment_lotId_idx" ON "Adjustment"("lotId");
