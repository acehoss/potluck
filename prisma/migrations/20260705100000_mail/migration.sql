-- Phase 3 Round A — mail substrate (docs/archive/mutual-aid-rework-2026-07.md N1–N11). Additive only:
-- two new tables, no changes to any existing table, so every money invariant
-- and the append-only ledger are untouched.
--
-- CapturedEmail: audit of every message either pipeline TRIED to send (the
-- only record on a capture-mode stack; read back by dev/e2e). toAddress is the
-- ACTUAL recipient after the dev-filter (redirect applied); originalTo is the
-- intended recipient before redirect; delivered is true only when a real SMTP
-- send also happened.
-- MailSuppression: hard-suppression list for SUBSCRIPTION mail only. The table
-- exists now; population + the /unsub route land in Round C.

-- CreateTable
CREATE TABLE "CapturedEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pipeline" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "originalTo" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT,
    "headersJson" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CapturedEmail_originalTo_idx" ON "CapturedEmail"("originalTo");

-- CreateIndex
CREATE INDEX "CapturedEmail_createdAt_idx" ON "CapturedEmail"("createdAt");

-- CreateTable
CREATE TABLE "MailSuppression" (
    "email" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
