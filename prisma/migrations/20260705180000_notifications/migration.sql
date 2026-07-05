-- Phase 3 Round C — notification preferences + weekly digest (docs/REWORK.md
-- N4/N5/N6). Additive only: five new User columns (all nullable or defaulted)
-- plus one new table (NotificationPreference). No existing table is rewritten
-- and no money/ledger structure is touched, so every money invariant and the
-- append-only ledger survive unchanged.
--
-- User columns:
--   timezone           IANA zone driving the digest send window (null = default)
--   digestOptOut       suppress the weekly digest entirely
--   showDetails        opt in to the counterparty household NAME in a
--                      notification body (still never $/address — N4); default off
--   lastDigestAt       per-user digest idempotency watermark (no double-send)
--   notifyOnboardedAt  first-run "how should Potluck reach you?" consent seen
--
-- NotificationPreference: one row per (user, category) the user has TUNED. An
-- ABSENT row means the conservative category default (pickups push+email ON;
-- circle OFF/OFF; ledger OFF/OFF), so a fresh account carries zero rows.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "timezone" TEXT;
ALTER TABLE "User" ADD COLUMN "digestOptOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "showDetails" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "lastDigestAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "notifyOnboardedAt" DATETIME;

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "push" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,

    PRIMARY KEY ("userId", "category"),
    CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
