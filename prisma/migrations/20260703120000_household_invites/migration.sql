-- Potluck Round 1 slice 4 — onboarding (REWORK A1): invites grow a KIND.
--   member    joins the invite's household (the only pre-rework behavior)
--   household founds a NEW household whose first connection edge is the
--             inviter's household (the invite IS the edge)
-- grantsJson carries the household-invite's initial grant set (both sides
-- start symmetric; each side tunes unilaterally afterwards). Plain ADD
-- COLUMNs — no rebuild.
ALTER TABLE "Invite" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'member';
ALTER TABLE "Invite" ADD COLUMN "grantsJson" TEXT;
