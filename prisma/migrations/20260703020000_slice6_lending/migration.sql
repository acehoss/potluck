-- Slice 6: lending (blueprint 01 slice6_lending). Item = durable equipment
-- owned by a household; Loan = item + borrower + out/due/returned + condition
-- note, with the fee snapshotted at checkout (edits to Item.feeCents affect
-- future loans only).

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "photoPath" TEXT,
    "notes" TEXT,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Item_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "itemId" TEXT NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "outAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" DATETIME,
    "returnedAt" DATETIME,
    "conditionReturned" TEXT,
    CONSTRAINT "Loan_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Loan_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Item_clientKey_key" ON "Item"("clientKey");

-- CreateIndex
CREATE INDEX "Item_householdId_idx" ON "Item"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_clientKey_key" ON "Loan"("clientKey");

-- CreateIndex
CREATE INDEX "Loan_itemId_idx" ON "Loan"("itemId");

-- One active loan per item, enforced MECHANICALLY as well as in the checkout
-- transaction (blueprint critique B9). SQLite supports partial indexes;
-- Prisma's schema language cannot express them, so this lives here as raw SQL
-- (and is why the schema's @@index([itemId]) comment points at this file).
-- A second concurrent checkout that somehow slipped past the transaction
-- guard dies on this index (P2002), which the router maps to CONFLICT.
CREATE UNIQUE INDEX "Loan_one_active_per_item" ON "Loan"("itemId") WHERE "returnedAt" IS NULL;
