-- Potluck Round 4 — meal planner + shopping (REWORK H). Additive only: three
-- new tables (PlanEntry / ShoppingItem / CategoryAssignment) plus back-relations.
-- The planner and shopping list touch NO money and NO ledger — the only route to
-- an order is the existing order.addToCart, handed a lot the list merely
-- SUGGESTS. editRecipes gates writes (A3a); reads are any-member. No rebuild, no
-- backfill — plain CREATE TABLE/INDEX.

-- CreateTable
CREATE TABLE "PlanEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "householdId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "meal" TEXT NOT NULL DEFAULT 'dinner',
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "recipeId" TEXT,
    "servingsOverride" INTEGER,
    "text" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanEntry_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlanEntry_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShoppingItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "householdId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "amounts" TEXT,
    "category" TEXT,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "sourceNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShoppingItem_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CategoryAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    CONSTRAINT "CategoryAssignment_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanEntry_clientKey_key" ON "PlanEntry"("clientKey");

-- CreateIndex
CREATE INDEX "PlanEntry_householdId_date_idx" ON "PlanEntry"("householdId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ShoppingItem_clientKey_key" ON "ShoppingItem"("clientKey");

-- CreateIndex
CREATE INDEX "ShoppingItem_householdId_idx" ON "ShoppingItem"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "ShoppingItem_householdId_normalizedName_unit_key" ON "ShoppingItem"("householdId", "normalizedName", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryAssignment_householdId_normalizedName_key" ON "CategoryAssignment"("householdId", "normalizedName");
