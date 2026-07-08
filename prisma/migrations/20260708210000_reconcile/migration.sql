-- Potluck Phase-4 Round 3 — reconcile draft sessions (REWORK S5/S6 + A1–A8).
-- Additive: the session/scope/line tables, the Stock.lastCountedAt verify
-- stamp, and the derived-provenance columns on Transfer/Adjustment.

CREATE TABLE "ReconcileSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "blind" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" DATETIME,
    "abandonedAt" DATETIME,
    "commitClientKey" TEXT,
    CONSTRAINT "ReconcileSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReconcileSession_commitClientKey_key" ON "ReconcileSession"("commitClientKey");
CREATE INDEX "ReconcileSession_householdId_status_idx" ON "ReconcileSession"("householdId", "status");

CREATE TABLE "ReconcilePantry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "pantryId" TEXT NOT NULL,
    "claimedById" TEXT,
    CONSTRAINT "ReconcilePantry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ReconcileSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReconcilePantry_pantryId_fkey" FOREIGN KEY ("pantryId") REFERENCES "Pantry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReconcilePantry_sessionId_pantryId_key" ON "ReconcilePantry"("sessionId", "pantryId");

CREATE TABLE "ReconcileLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "expectedCount" INTEGER NOT NULL,
    "expectedReserved" INTEGER NOT NULL,
    "countedCount" INTEGER,
    "countedById" TEXT,
    "countedAt" DATETIME,
    CONSTRAINT "ReconcileLine_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ReconcileSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReconcileLine_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReconcileLine_sessionId_stockId_key" ON "ReconcileLine"("sessionId", "stockId");
CREATE INDEX "ReconcileLine_stockId_idx" ON "ReconcileLine"("stockId");

ALTER TABLE "Stock" ADD COLUMN "lastCountedAt" DATETIME;
ALTER TABLE "Transfer" ADD COLUMN "reconcileSessionId" TEXT;
ALTER TABLE "Adjustment" ADD COLUMN "reconcileSessionId" TEXT;
ALTER TABLE "ReconcileSession" ADD COLUMN "commitSummary" TEXT;
