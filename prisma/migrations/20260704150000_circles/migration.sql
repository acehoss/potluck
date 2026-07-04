-- Potluck Phase-2 Round B — circles (docs/REWORK.md P4):
--   Circle (a household's named grant bundle — the six directional grants that
--   used to live per-connection) + PantryCircle/ItemCircle/MembershipCircle
--   SELECT-scope joins. Connection drops its 12 aGrants*/bGrants* columns for
--   aCircleId/bCircleId (the circle each side placed the other into). Pantry and
--   Item drop `shared` for a three-mode `visibility` (ALL/SELECT/PRIVATE);
--   Membership gains the same visibility for the Round C contact layer.
-- Data-preserving (behavior-equivalent grants after migration): every household
-- gets the three preset circles (Neighbors / Friends / Family, mirroring
-- authz.ts GRANT_PRESETS); each connection side's outgoing grant tuple maps to
-- the matching preset circle, or — for a non-preset tuple — a custom circle
-- named after the counterparty household (all-false ACTIVE/SEVERED → a "No
-- access" circle so ACTIVE keeps both sides non-null; all-false PENDING → the
-- addressee's side stays unassigned/NULL). shared=1 → visibility 'ALL',
-- shared=0 → 'PRIVATE'. Proven against a synthetic pathological world by
-- scripts/verify-circles-migration.mjs.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- === 1. Circle ===============================================================
CREATE TABLE "Circle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "grantsPantry" BOOLEAN NOT NULL DEFAULT false,
    "grantsLending" BOOLEAN NOT NULL DEFAULT false,
    "grantsRecipes" BOOLEAN NOT NULL DEFAULT false,
    "grantsShareTo" BOOLEAN NOT NULL DEFAULT false,
    "grantsShareFrom" BOOLEAN NOT NULL DEFAULT false,
    "grantsReshare" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Circle_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Circle_householdId_name_key" ON "Circle"("householdId", "name");
CREATE INDEX "Circle_householdId_idx" ON "Circle"("householdId");

-- === 2. Preset circles per household (positions 0/1/2) ========================
-- Bundles mirror authz.ts GRANT_PRESETS so a pre-circles tuple that matched a
-- "level" maps back to the same name. Deterministic ids keep the backfill
-- idempotent and let the assignment step (step 6) reference them by name.
INSERT INTO "Circle" ("id","householdId","name","position",
    "grantsPantry","grantsLending","grantsRecipes","grantsShareTo","grantsShareFrom","grantsReshare")
SELECT 'circ-neighbors-' || h."id", h."id", 'Neighbors', 0,
    false, false, false, true, true, false FROM "Household" h;
INSERT INTO "Circle" ("id","householdId","name","position",
    "grantsPantry","grantsLending","grantsRecipes","grantsShareTo","grantsShareFrom","grantsReshare")
SELECT 'circ-friends-' || h."id", h."id", 'Friends', 1,
    true, true, true, true, true, false FROM "Household" h;
INSERT INTO "Circle" ("id","householdId","name","position",
    "grantsPantry","grantsLending","grantsRecipes","grantsShareTo","grantsShareFrom","grantsReshare")
SELECT 'circ-family-' || h."id", h."id", 'Family', 2,
    true, true, true, true, true, true FROM "Household" h;

-- === 3. Materialize each connection side's outgoing grant tuple ===============
-- One row per (connection, side): ownerHh's outgoing grants toward counterHh.
CREATE TEMP TABLE "_grant_src" AS
SELECT c."id" AS "connectionId", 'a' AS "side",
    c."householdAId" AS "ownerHh", c."householdBId" AS "counterHh", c."status" AS "status",
    c."aGrantsPantry" AS "gp", c."aGrantsLending" AS "gl", c."aGrantsRecipes" AS "gr",
    c."aGrantsShareTo" AS "gst", c."aGrantsShareFrom" AS "gsf", c."aGrantsReshare" AS "grs"
FROM "Connection" c
UNION ALL
SELECT c."id", 'b',
    c."householdBId", c."householdAId", c."status",
    c."bGrantsPantry", c."bGrantsLending", c."bGrantsRecipes",
    c."bGrantsShareTo", c."bGrantsShareFrom", c."bGrantsReshare"
FROM "Connection" c;

-- Classify each source: which preset it matches (if any), and all-false.
CREATE TEMP TABLE "_src_class" AS
SELECT s.*,
    (s."gp" AND s."gl" AND s."gr" AND s."gst" AND s."gsf" AND s."grs") AS "isFamily",
    (s."gp" AND s."gl" AND s."gr" AND s."gst" AND s."gsf" AND NOT s."grs") AS "isFriends",
    (NOT s."gp" AND NOT s."gl" AND NOT s."gr" AND s."gst" AND s."gsf" AND NOT s."grs") AS "isNeighbors",
    (NOT s."gp" AND NOT s."gl" AND NOT s."gr" AND NOT s."gst" AND NOT s."gsf" AND NOT s."grs") AS "isAllFalse"
FROM "_grant_src" s;

-- === 4. Custom circles: one per distinct (household, non-preset tuple) ========
-- All-false PENDING sides get NO circle (the addressee hasn't granted yet →
-- NULL). Everything else non-preset needs a custom circle; the representative
-- source (min connectionId) names it. Materialized first (network_core pattern)
-- so naming/numbering never re-evaluates against mid-statement state.
CREATE TEMP TABLE "_custom_groups" AS
SELECT "ownerHh", "gp","gl","gr","gst","gsf","grs",
    MIN("connectionId") AS "repConn",
    MAX("isAllFalse") AS "isAllFalse"
FROM "_src_class"
WHERE NOT "isFamily" AND NOT "isFriends" AND NOT "isNeighbors"
  AND NOT ("status" = 'PENDING' AND "isAllFalse")
GROUP BY "ownerHh", "gp","gl","gr","gst","gsf","grs";

-- Base display name: "No access" for all-false, else the representative
-- counterparty's household name.
CREATE TEMP TABLE "_custom_circles" AS
SELECT g."ownerHh", g."gp",g."gl",g."gr",g."gst",g."gsf",g."grs", g."repConn", g."isAllFalse",
    'circ-cust-' || g."repConn" AS "circleId",
    CASE WHEN g."isAllFalse" THEN 'No access'
         ELSE (SELECT h."name" FROM "_src_class" sc JOIN "Household" h ON h."id" = sc."counterHh"
               WHERE sc."ownerHh" = g."ownerHh" AND sc."connectionId" = g."repConn")
    END AS "baseName"
FROM "_custom_groups" g;

-- Suffix a base name when it collides with a preset name or with another custom
-- circle of the same household; rn is a per-household ordinal (unique), so the
-- suffixed names never re-collide.
CREATE TEMP TABLE "_custom_final" AS
SELECT cc."ownerHh", cc."gp",cc."gl",cc."gr",cc."gst",cc."gsf",cc."grs", cc."circleId",
    CASE WHEN "needsSuffix" THEN cc."baseName" || ' (' || "rn" || ')' ELSE cc."baseName" END AS "finalName",
    2 + "rn" AS "position"
FROM (
    SELECT c2.*,
        ROW_NUMBER() OVER (PARTITION BY c2."ownerHh" ORDER BY c2."repConn") AS "rn",
        ( c2."baseName" IN ('Neighbors','Friends','Family')
          OR (SELECT COUNT(*) FROM "_custom_circles" c3
              WHERE c3."ownerHh" = c2."ownerHh" AND c3."baseName" = c2."baseName") > 1
        ) AS "needsSuffix"
    FROM "_custom_circles" c2
) cc;

-- === 5. Insert the custom circles ============================================
INSERT INTO "Circle" ("id","householdId","name","position",
    "grantsPantry","grantsLending","grantsRecipes","grantsShareTo","grantsShareFrom","grantsReshare")
SELECT "circleId","ownerHh","finalName","position","gp","gl","gr","gst","gsf","grs"
FROM "_custom_final";

-- === 6. Resolve each side's assigned circle id ===============================
CREATE TEMP TABLE "_assign" AS
SELECT sc."connectionId", sc."side",
    CASE
        WHEN sc."status" = 'PENDING' AND sc."isAllFalse" THEN NULL
        WHEN sc."isFamily" THEN 'circ-family-' || sc."ownerHh"
        WHEN sc."isFriends" THEN 'circ-friends-' || sc."ownerHh"
        WHEN sc."isNeighbors" THEN 'circ-neighbors-' || sc."ownerHh"
        ELSE (SELECT cf."circleId" FROM "_custom_final" cf
              WHERE cf."ownerHh" = sc."ownerHh"
                AND cf."gp" = sc."gp" AND cf."gl" = sc."gl" AND cf."gr" = sc."gr"
                AND cf."gst" = sc."gst" AND cf."gsf" = sc."gsf" AND cf."grs" = sc."grs")
    END AS "circleId"
FROM "_src_class" sc;

-- === 7. Rebuild Connection (drop 12 grant columns, add circle FKs) ===========
CREATE TABLE "new_Connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdAId" TEXT NOT NULL,
    "householdBId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedByHouseholdId" TEXT,
    "aCircleId" TEXT,
    "bCircleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME,
    "severedAt" DATETIME,
    CONSTRAINT "Connection_householdAId_fkey" FOREIGN KEY ("householdAId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Connection_householdBId_fkey" FOREIGN KEY ("householdBId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Connection_aCircleId_fkey" FOREIGN KEY ("aCircleId") REFERENCES "Circle" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Connection_bCircleId_fkey" FOREIGN KEY ("bCircleId") REFERENCES "Circle" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Connection" ("id","householdAId","householdBId","status","requestedByHouseholdId","aCircleId","bCircleId","createdAt","activatedAt","severedAt")
SELECT c."id", c."householdAId", c."householdBId", c."status", c."requestedByHouseholdId",
    (SELECT a."circleId" FROM "_assign" a WHERE a."connectionId" = c."id" AND a."side" = 'a'),
    (SELECT a."circleId" FROM "_assign" a WHERE a."connectionId" = c."id" AND a."side" = 'b'),
    c."createdAt", c."activatedAt", c."severedAt"
FROM "Connection" c;
DROP TABLE "Connection";
ALTER TABLE "new_Connection" RENAME TO "Connection";
CREATE UNIQUE INDEX "Connection_householdAId_householdBId_key" ON "Connection"("householdAId", "householdBId");
CREATE INDEX "Connection_householdBId_idx" ON "Connection"("householdBId");
CREATE INDEX "Connection_aCircleId_idx" ON "Connection"("aCircleId");
CREATE INDEX "Connection_bCircleId_idx" ON "Connection"("bCircleId");

-- === 8. Rebuild Pantry (shared → visibility) =================================
CREATE TABLE "new_Pantry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Pantry_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Pantry" ("id","householdId","name","visibility","createdAt")
SELECT "id","householdId","name", CASE WHEN "shared" THEN 'ALL' ELSE 'PRIVATE' END, "createdAt"
FROM "Pantry";
DROP TABLE "Pantry";
ALTER TABLE "new_Pantry" RENAME TO "Pantry";

-- === 9. Rebuild Item (shared → visibility) ===================================
CREATE TABLE "new_Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "photoPath" TEXT,
    "notes" TEXT,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "visibility" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Item_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Item" ("id","clientKey","householdId","name","photoPath","notes","feeCents","visibility","createdAt")
SELECT "id","clientKey","householdId","name","photoPath","notes","feeCents",
    CASE WHEN "shared" THEN 'ALL' ELSE 'PRIVATE' END, "createdAt"
FROM "Item";
DROP TABLE "Item";
ALTER TABLE "new_Item" RENAME TO "Item";
CREATE UNIQUE INDEX "Item_clientKey_key" ON "Item"("clientKey");
CREATE INDEX "Item_householdId_idx" ON "Item"("householdId");

-- === 10. Membership.visibility (Round C contact layer; additive) =============
ALTER TABLE "Membership" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'ALL';

-- === 11. SELECT-scope join tables (created empty; no scope rows migrated) =====
CREATE TABLE "PantryCircle" (
    "pantryId" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    CONSTRAINT "PantryCircle_pantryId_fkey" FOREIGN KEY ("pantryId") REFERENCES "Pantry" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PantryCircle_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY ("pantryId", "circleId")
);
CREATE INDEX "PantryCircle_circleId_idx" ON "PantryCircle"("circleId");

CREATE TABLE "ItemCircle" (
    "itemId" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    CONSTRAINT "ItemCircle_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ItemCircle_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY ("itemId", "circleId")
);
CREATE INDEX "ItemCircle_circleId_idx" ON "ItemCircle"("circleId");

CREATE TABLE "MembershipCircle" (
    "membershipId" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    CONSTRAINT "MembershipCircle_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MembershipCircle_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY ("membershipId", "circleId")
);
CREATE INDEX "MembershipCircle_circleId_idx" ON "MembershipCircle"("circleId");

-- === 12. Cleanup =============================================================
DROP TABLE "_assign";
DROP TABLE "_custom_final";
DROP TABLE "_custom_circles";
DROP TABLE "_custom_groups";
DROP TABLE "_src_class";
DROP TABLE "_grant_src";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
