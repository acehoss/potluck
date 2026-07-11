-- Potluck Round 1 slice 1 — network core (docs/archive/mutual-aid-rework-2026-07.md):
--   Membership (user↔household, capability flags) replaces User.householdId;
--   Connection (pairwise, two directional grant sets); User.username +
--   Household.slug identity; Product.householdId (per-household namespaces);
--   Pantry.shared / Item.shared; InstanceSettings + instance admin;
--   Take.householdId / Loan.borrowerHouseholdId attribution snapshots;
--   LedgerSeen re-keyed with the viewer's own household.
-- Data-preserving (REWORK J2): every existing user becomes a full-capability
-- (Owner-preset) member of their household; every existing household pair gets
-- an ACTIVE full-grant connection; usernames derive from email local-parts and
-- slugs from household names (deduped deterministically); products are assigned
-- to the households whose pantries hold their lots and DUPLICATED where two
-- households share one (each re-pointing its own lots); the first user becomes
-- instance admin; ledger history is untouched (LedgerEntry is relation-free).
-- Ordering matters: every backfill that reads User.householdId (Membership,
-- LedgerSeen, Take, Loan) runs BEFORE the User rebuild drops the column.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- === 1. InstanceSettings (singleton, id='instance') ==========================
CREATE TABLE "InstanceSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "allowMemberHouseholdInvites" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "InstanceSettings" ("id") VALUES ('instance');

-- === 2. Membership (backfill reads User.householdId — precedes User rebuild) =
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "manageHousehold" BOOLEAN NOT NULL DEFAULT false,
    "manageConnections" BOOLEAN NOT NULL DEFAULT false,
    "receiveStock" BOOLEAN NOT NULL DEFAULT false,
    "placeOrders" BOOLEAN NOT NULL DEFAULT false,
    "spend" BOOLEAN NOT NULL DEFAULT false,
    "fulfill" BOOLEAN NOT NULL DEFAULT false,
    "adjustInventory" BOOLEAN NOT NULL DEFAULT false,
    "lendBorrow" BOOLEAN NOT NULL DEFAULT false,
    "postShares" BOOLEAN NOT NULL DEFAULT false,
    "editRecipes" BOOLEAN NOT NULL DEFAULT false,
    "settleMoney" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Membership_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Membership_userId_householdId_key" ON "Membership"("userId", "householdId");
CREATE INDEX "Membership_householdId_idx" ON "Membership"("householdId");
-- Every existing user = Owner preset (all flags) in their pre-rework household.
-- Deterministic ids ('m-'||userId) keep the backfill idempotent and debuggable.
INSERT INTO "Membership" ("id", "userId", "householdId",
    "manageHousehold", "manageConnections", "receiveStock", "placeOrders", "spend",
    "fulfill", "adjustInventory", "lendBorrow", "postShares", "editRecipes", "settleMoney")
SELECT 'm-' || "id", "id", "householdId",
    true, true, true, true, true, true, true, true, true, true, true
FROM "User";

-- === 3. Connection ===========================================================
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdAId" TEXT NOT NULL,
    "householdBId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedByHouseholdId" TEXT,
    "aGrantsPantry" BOOLEAN NOT NULL DEFAULT false,
    "aGrantsLending" BOOLEAN NOT NULL DEFAULT false,
    "aGrantsRecipes" BOOLEAN NOT NULL DEFAULT false,
    "aGrantsShareTo" BOOLEAN NOT NULL DEFAULT false,
    "aGrantsShareFrom" BOOLEAN NOT NULL DEFAULT false,
    "aGrantsReshare" BOOLEAN NOT NULL DEFAULT false,
    "bGrantsPantry" BOOLEAN NOT NULL DEFAULT false,
    "bGrantsLending" BOOLEAN NOT NULL DEFAULT false,
    "bGrantsRecipes" BOOLEAN NOT NULL DEFAULT false,
    "bGrantsShareTo" BOOLEAN NOT NULL DEFAULT false,
    "bGrantsShareFrom" BOOLEAN NOT NULL DEFAULT false,
    "bGrantsReshare" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME,
    "severedAt" DATETIME,
    CONSTRAINT "Connection_householdAId_fkey" FOREIGN KEY ("householdAId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Connection_householdBId_fkey" FOREIGN KEY ("householdBId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Connection_householdAId_householdBId_key" ON "Connection"("householdAId", "householdBId");
CREATE INDEX "Connection_householdBId_idx" ON "Connection"("householdBId");
-- Behavior-preserving backfill: ACTIVE full-grant edge between every existing
-- pair (a live deploy has exactly one pair; a fresh DB has none). Canonical
-- ordering householdAId < householdBId.
INSERT INTO "Connection" ("id", "householdAId", "householdBId", "status",
    "aGrantsPantry", "aGrantsLending", "aGrantsRecipes", "aGrantsShareTo", "aGrantsShareFrom", "aGrantsReshare",
    "bGrantsPantry", "bGrantsLending", "bGrantsRecipes", "bGrantsShareTo", "bGrantsShareFrom", "bGrantsReshare",
    "activatedAt")
SELECT 'c-' || a."id" || '-' || b."id", a."id", b."id", 'ACTIVE',
    true, true, true, true, true, true,
    true, true, true, true, true, true,
    CURRENT_TIMESTAMP
FROM "Household" a JOIN "Household" b ON a."id" < b."id";

-- === 4. LedgerSeen rebuild: add ownHouseholdId to the key ====================
CREATE TABLE "new_LedgerSeen" (
    "userId" TEXT NOT NULL,
    "ownHouseholdId" TEXT NOT NULL,
    "counterpartyHouseholdId" TEXT NOT NULL,
    "seenAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "ownHouseholdId", "counterpartyHouseholdId"),
    CONSTRAINT "LedgerSeen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LedgerSeen" ("userId", "ownHouseholdId", "counterpartyHouseholdId", "seenAt")
SELECT ls."userId", u."householdId", ls."counterpartyHouseholdId", ls."seenAt"
FROM "LedgerSeen" ls JOIN "User" u ON u."id" = ls."userId";
DROP TABLE "LedgerSeen";
ALTER TABLE "new_LedgerSeen" RENAME TO "LedgerSeen";

-- === 5. Take rebuild: householdId snapshot (from the taker's then-only household)
CREATE TABLE "new_Take" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "lotId" TEXT NOT NULL,
    "takerId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" DATETIME,
    "reversedById" TEXT,
    CONSTRAINT "Take_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Take_takerId_fkey" FOREIGN KEY ("takerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Take" ("id", "clientKey", "lotId", "takerId", "householdId", "quantity", "costCents", "takenAt", "reversedAt", "reversedById")
SELECT t."id", t."clientKey", t."lotId", t."takerId", u."householdId", t."quantity", t."costCents", t."takenAt", t."reversedAt", t."reversedById"
FROM "Take" t JOIN "User" u ON u."id" = t."takerId";
DROP TABLE "Take";
ALTER TABLE "new_Take" RENAME TO "Take";
CREATE UNIQUE INDEX "Take_clientKey_key" ON "Take"("clientKey");
CREATE INDEX "Take_lotId_idx" ON "Take"("lotId");

-- === 6. Loan rebuild: borrowerHouseholdId snapshot ===========================
CREATE TABLE "new_Loan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "itemId" TEXT NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "borrowerHouseholdId" TEXT NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "outAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" DATETIME,
    "returnedAt" DATETIME,
    "conditionReturned" TEXT,
    CONSTRAINT "Loan_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Loan_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Loan" ("id", "clientKey", "itemId", "borrowerId", "borrowerHouseholdId", "feeCents", "outAt", "dueAt", "returnedAt", "conditionReturned")
SELECT l."id", l."clientKey", l."itemId", l."borrowerId", u."householdId", l."feeCents", l."outAt", l."dueAt", l."returnedAt", l."conditionReturned"
FROM "Loan" l JOIN "User" u ON u."id" = l."borrowerId";
DROP TABLE "Loan";
ALTER TABLE "new_Loan" RENAME TO "Loan";
CREATE UNIQUE INDEX "Loan_clientKey_key" ON "Loan"("clientKey");
CREATE INDEX "Loan_itemId_idx" ON "Loan"("itemId");
-- Partial unique index: NOT expressible in the Prisma schema — must be
-- recreated by hand on every Loan rebuild (see 20260703020000_slice6_lending).
CREATE UNIQUE INDEX "Loan_one_active_per_item" ON "Loan"("itemId") WHERE "returnedAt" IS NULL;

-- === 7. Household: slug backfill, then rebuild to NOT NULL ===================
ALTER TABLE "Household" ADD COLUMN "slug" TEXT;
-- Best-effort slugify (lower, spaces→'-', strip quotes/dots). Anything still
-- outside [a-z0-9_-] — or empty — falls back to an id-based handle rather
-- than an invalid slug (rename from the app later; migrated handles are
-- provisional per REWORK J2).
UPDATE "Household" SET "slug" = lower(replace(replace(replace("name", ' ', '-'), '''', ''), '.', ''));
UPDATE "Household" SET "slug" = 'household-' || "id"
WHERE "slug" = '' OR "slug" GLOB '*[^a-z0-9_-]*';
-- Dedupe collisions with the row's own id: unique by construction (never
-- collides with another base name the way a rank suffix can), and the
-- ids-to-suffix set is materialized BEFORE the UPDATE — a correlated
-- ROW_NUMBER re-evaluates against mid-statement state and mis-ranks
-- three-way collisions.
CREATE TEMP TABLE "_dupe_slugs" AS
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "slug" ORDER BY "createdAt", "id") rn FROM "Household"
  ) WHERE rn > 1;
UPDATE "Household" SET "slug" = "slug" || '-' || "id"
WHERE "id" IN (SELECT "id" FROM "_dupe_slugs");
DROP TABLE "_dupe_slugs";
CREATE TABLE "new_Household" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Household" ("id", "name", "slug", "createdAt")
SELECT "id", "name", "slug", "createdAt" FROM "Household";
DROP TABLE "Household";
ALTER TABLE "new_Household" RENAME TO "Household";
CREATE UNIQUE INDEX "Household_slug_key" ON "Household"("slug");

-- === 8. User: username backfill, then rebuild (drop householdId, add admin) ==
ALTER TABLE "User" ADD COLUMN "username" TEXT;
-- Email local-part, sanitized toward [a-z0-9_-] (dots/pluses→'-'), capped at
-- 24 chars. Local parts with other charset violations fall back to an
-- id-based handle; sub-3-char locals get a '-user' pad. Provisional handles
-- (REWORK J2) — users confirm/rename later.
UPDATE "User" SET "username" = substr(lower(replace(replace(substr("email", 1, instr("email", '@') - 1), '.', '-'), '+', '-')), 1, 24);
UPDATE "User" SET "username" = 'user-' || "id"
WHERE "username" = '' OR "username" GLOB '*[^a-z0-9_-]*';
UPDATE "User" SET "username" = "username" || '-user' WHERE length("username") < 3;
-- Dedupe with the row's own id (see the slug comment: materialized first,
-- collision-proof by construction).
CREATE TEMP TABLE "_dupe_usernames" AS
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "username" ORDER BY "createdAt", "id") rn FROM "User"
  ) WHERE rn > 1;
UPDATE "User" SET "username" = "username" || '-' || "id"
WHERE "id" IN (SELECT "id" FROM "_dupe_usernames");
DROP TABLE "_dupe_usernames";
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isInstanceAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("id", "username", "name", "email", "passwordHash", "createdAt")
SELECT "id", "username", "name", "email", "passwordHash", "createdAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
-- First user of the instance = instance admin (REWORK A1/A4).
UPDATE "User" SET "isInstanceAdmin" = true
WHERE "id" = (SELECT "id" FROM "User" ORDER BY "createdAt", "id" LIMIT 1);

-- === 9. Product: per-household namespaces (REWORK D1) ========================
ALTER TABLE "Product" ADD COLUMN "householdId" TEXT;
-- 9a. Owner = the household whose pantry holds the product's lots (the pantry
-- owner is the catalog owner — NOT the purchaser). Shared use picks the
-- MIN(householdId) as keeper; the rest get duplicates in 9c.
UPDATE "Product" SET "householdId" = (
  SELECT MIN(p."householdId")
  FROM "Lot" l JOIN "Restock" r ON r."id" = l."restockId" JOIN "Pantry" p ON p."id" = r."pantryId"
  WHERE l."productId" = "Product"."id");
-- 9b. Orphan products (all lots deleted while drafting) reference nothing and
-- are reachable only through search — drop them rather than misassign.
DELETE FROM "Product" WHERE "householdId" IS NULL;
-- 9c. Duplicate the product for every ADDITIONAL household whose lots use it.
INSERT INTO "Product" ("id", "name", "upc", "createdAt", "householdId")
SELECT DISTINCT 'p-' || hh."householdId" || '-' || pr."id", pr."name", pr."upc", pr."createdAt", hh."householdId"
FROM "Product" pr
JOIN (SELECT DISTINCT l."productId" pid, p."householdId"
      FROM "Lot" l JOIN "Restock" r ON r."id" = l."restockId" JOIN "Pantry" p ON p."id" = r."pantryId") hh
  ON hh.pid = pr."id" AND hh."householdId" <> pr."householdId";
-- 9d. Re-point each lot at its own pantry-household's copy (ONLY Lot
-- references productId anywhere in the schema).
UPDATE "Lot" SET "productId" = 'p-' || (
    SELECT p."householdId" FROM "Restock" r JOIN "Pantry" p ON p."id" = r."pantryId" WHERE r."id" = "Lot"."restockId"
  ) || '-' || "productId"
WHERE "productId" IS NOT NULL
  AND (SELECT p."householdId" FROM "Restock" r JOIN "Pantry" p ON p."id" = r."pantryId" WHERE r."id" = "Lot"."restockId")
      <> (SELECT "householdId" FROM "Product" WHERE "id" = "Lot"."productId");
-- 9e. Rebuild Product: householdId NOT NULL + FK + household-scoped indexes
-- (replaces the instance-global Product_upc_idx).
CREATE TABLE "new_Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "upc" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Product_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("id", "householdId", "name", "upc", "createdAt")
SELECT "id", "householdId", "name", "upc", "createdAt" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE INDEX "Product_householdId_upc_idx" ON "Product"("householdId", "upc");
CREATE INDEX "Product_householdId_idx" ON "Product"("householdId");

-- === 10. Shared/private flags (existing rows default shared, REWORK B3) ======
ALTER TABLE "Pantry" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Item" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT true;

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
