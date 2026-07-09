-- Potluck Phase-4 Round 4 — transactional notification outbox (additive).
CREATE TABLE "NotifyOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME
);
CREATE INDEX "NotifyOutbox_sentAt_idx" ON "NotifyOutbox"("sentAt");
