-- Potluck Phase-2 Round C — contact layer (docs/REWORK.md P5):
--   User gains the person's card fields (photoPath "avatars" image · phone ·
--   bio); Household gains its pickup logistics (address · pickupNotes). All
--   nullable — a plain additive migration, no table rebuild. Member visibility
--   on a household card rides Membership.visibility + circles (landed in Round
--   B); the household's address/pickupNotes are gated by the connection itself.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "photoPath" TEXT;
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "bio" TEXT;

-- AlterTable
ALTER TABLE "Household" ADD COLUMN "address" TEXT;
ALTER TABLE "Household" ADD COLUMN "pickupNotes" TEXT;
