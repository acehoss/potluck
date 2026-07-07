-- Media round: product galleries, item galleries, and PDF attachments.
-- Creates the new media tables first, backfills the old single Item.photoPath
-- into ItemImage(position=0), then rebuilds Item without photoPath using the
-- same SQLite drop-column dance as the circles/digest migrations.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "label" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductImage_productId_position_key" ON "ProductImage"("productId", "position");
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

CREATE TABLE "ItemImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "label" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemImage_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ItemImage_itemId_position_key" ON "ItemImage"("itemId", "position");
CREATE INDEX "ItemImage_itemId_idx" ON "ItemImage"("itemId");

CREATE TABLE "ItemAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemAttachment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ItemAttachment_itemId_position_key" ON "ItemAttachment"("itemId", "position");
CREATE INDEX "ItemAttachment_itemId_idx" ON "ItemAttachment"("itemId");

INSERT INTO "ItemImage" ("id","itemId","path","position","createdAt")
SELECT lower(hex(randomblob(16))), "id", "photoPath", 0, "createdAt"
FROM "Item"
WHERE "photoPath" IS NOT NULL;

CREATE TABLE "new_Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "visibility" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Item_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Item" ("id","clientKey","householdId","name","notes","feeCents","visibility","createdAt")
SELECT "id","clientKey","householdId","name","notes","feeCents","visibility","createdAt"
FROM "Item";
DROP TABLE "Item";
ALTER TABLE "new_Item" RENAME TO "Item";
CREATE UNIQUE INDEX "Item_clientKey_key" ON "Item"("clientKey");
CREATE INDEX "Item_householdId_idx" ON "Item"("householdId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
