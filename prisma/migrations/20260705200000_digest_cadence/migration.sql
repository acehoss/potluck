-- Digest cadence (docs/REWORK.md, digest-cadence round). Replace the boolean
-- `User.digestOptOut` with a three-way `digestCadence` ('off'|'daily'|'weekly')
-- plus a per-user send time (`digestHour` 0–23 local, `digestWeekday` 0=Sun..6=
-- Sat for the weekly cadence). Data-preserving: existing opted-OUT users become
-- 'off', everyone else moves to the new default 'daily' cadence (timely beats
-- batched for perishable shares — weekly stays a valid option, just not the
-- default), and the send hour/weekday default to 09:00 / Sunday (9/0).
--
-- SQLite has no DROP COLUMN in older engines, so `digestOptOut` is removed with
-- the Prisma table-rebuild dance (mirrors 20260703100000_network_core /
-- 20260704150000_circles): add the new columns + backfill FIRST (so the rebuild
-- can read digestOptOut), then rebuild `User` without it. No money/ledger
-- structure is touched; every money invariant and the append-only ledger survive.

-- === 1. Add the new columns (defaults reproduce today's send behavior) ========
ALTER TABLE "User" ADD COLUMN "digestCadence" TEXT NOT NULL DEFAULT 'daily';
ALTER TABLE "User" ADD COLUMN "digestHour" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "User" ADD COLUMN "digestWeekday" INTEGER NOT NULL DEFAULT 0;

-- === 2. Backfill cadence from the old opt-out flag ============================
-- A user who had opted out of the weekly digest maps to cadence 'off'; everyone
-- else keeps the 'weekly' default. (Sunday 09:00 local — the prior hardcoded
-- window — is exactly digestWeekday=0 / digestHour=9, already the defaults.)
UPDATE "User" SET "digestCadence" = 'off' WHERE "digestOptOut" = true;

-- === 3. Rebuild User without digestOptOut (SQLite drop-column dance) ==========
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isInstanceAdmin" BOOLEAN NOT NULL DEFAULT false,
    "photoPath" TEXT,
    "phone" TEXT,
    "bio" TEXT,
    "emailVerifiedAt" DATETIME,
    "totpSecret" TEXT,
    "totpEnabledAt" DATETIME,
    "totpLastStep" INTEGER,
    "mfaEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT,
    "digestCadence" TEXT NOT NULL DEFAULT 'daily',
    "digestHour" INTEGER NOT NULL DEFAULT 9,
    "digestWeekday" INTEGER NOT NULL DEFAULT 0,
    "showDetails" BOOLEAN NOT NULL DEFAULT false,
    "lastDigestAt" DATETIME,
    "notifyOnboardedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" (
    "id", "username", "name", "email", "passwordHash", "isInstanceAdmin",
    "photoPath", "phone", "bio", "emailVerifiedAt", "totpSecret", "totpEnabledAt",
    "totpLastStep", "mfaEmailEnabled", "timezone", "digestCadence", "digestHour",
    "digestWeekday", "showDetails", "lastDigestAt", "notifyOnboardedAt", "createdAt")
SELECT
    "id", "username", "name", "email", "passwordHash", "isInstanceAdmin",
    "photoPath", "phone", "bio", "emailVerifiedAt", "totpSecret", "totpEnabledAt",
    "totpLastStep", "mfaEmailEnabled", "timezone", "digestCadence", "digestHour",
    "digestWeekday", "showDetails", "lastDigestAt", "notifyOnboardedAt", "createdAt"
FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
