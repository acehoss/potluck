-- Potluck Round 2 — needs & surpluses (REWORK F). Additive only: three new
-- tables (SharePost / SharePostLot / ShareClaim) plus one nullable column on
-- Take. Shares are GIFTS (C1) and NEVER touch the ledger — a confirmed SURPLUS
-- handoff records $0 Takes carrying shareClaimId for the audit trail (amends
-- blueprint-01 invariant 4: a share-claim take is cross-household with no
-- LedgerEntry). Reshare chain (origin/parent/hopsRemaining) lands from day one
-- (E3). No rebuild, no backfill — plain ADD COLUMN + CREATE TABLE/INDEX.

-- AlterTable
ALTER TABLE "Take" ADD COLUMN "shareClaimId" TEXT;

-- CreateTable
CREATE TABLE "SharePost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "type" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "photoPath" TEXT,
    "quantity" INTEGER,
    "unit" TEXT,
    "remaining" INTEGER,
    "expiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "originPostId" TEXT,
    "parentPostId" TEXT,
    "hopsRemaining" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SharePost_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SharePostLot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    CONSTRAINT "SharePostLot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SharePost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SharePostLot_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShareClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientKey" TEXT,
    "postId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "quantity" INTEGER,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "ShareClaim_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SharePost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SharePost_clientKey_key" ON "SharePost"("clientKey");

-- CreateIndex
CREATE INDEX "SharePost_householdId_idx" ON "SharePost"("householdId");

-- CreateIndex
CREATE INDEX "SharePost_originPostId_idx" ON "SharePost"("originPostId");

-- CreateIndex
CREATE INDEX "SharePost_parentPostId_idx" ON "SharePost"("parentPostId");

-- CreateIndex
CREATE UNIQUE INDEX "SharePostLot_postId_lotId_key" ON "SharePostLot"("postId", "lotId");

-- CreateIndex
CREATE UNIQUE INDEX "ShareClaim_clientKey_key" ON "ShareClaim"("clientKey");

-- CreateIndex
CREATE INDEX "ShareClaim_postId_idx" ON "ShareClaim"("postId");

-- CreateIndex
CREATE INDEX "ShareClaim_householdId_idx" ON "ShareClaim"("householdId");

-- CreateIndex
CREATE INDEX "Take_shareClaimId_idx" ON "Take"("shareClaimId");
