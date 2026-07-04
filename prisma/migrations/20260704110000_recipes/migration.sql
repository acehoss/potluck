-- Potluck Round 3 — recipes (REWORK G). Additive only: three new tables
-- (Recipe / RecipeIngredient / IngredientLink) plus back-relations. Recipes
-- touch NO money and NO ledger. PTE-shaped structured ingredient lines + section
-- headings; only title is required (G1). Cross-household browsing rides the
-- `recipes` grant + the per-recipe `private` flag (G3); saving a foreign recipe
-- FORKS it (browse-live, fork-on-save). IngredientLink is the learned
-- per-household ingredient-name → product mapping (G2), written only on explicit
-- user confirmation. No rebuild, no backfill — plain CREATE TABLE/INDEX.

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "householdId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "directions" TEXT,
    "prepMinutes" INTEGER,
    "cookMinutes" INTEGER,
    "servings" INTEGER,
    "yieldText" TEXT,
    "course" TEXT,
    "cuisine" TEXT,
    "tags" TEXT,
    "photoPath" TEXT,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "sourceUrl" TEXT,
    "forkedFromTitle" TEXT,
    "forkedFromHouseholdName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Recipe_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'item',
    "amount" TEXT,
    "unit" TEXT,
    "text" TEXT NOT NULL,
    "note" TEXT,
    CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngredientLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    CONSTRAINT "IngredientLink_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IngredientLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_clientKey_key" ON "Recipe"("clientKey");

-- CreateIndex
CREATE INDEX "Recipe_householdId_idx" ON "Recipe"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeIngredient_recipeId_position_key" ON "RecipeIngredient"("recipeId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "IngredientLink_householdId_normalizedName_key" ON "IngredientLink"("householdId", "normalizedName");
