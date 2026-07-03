-- Slice 5: VLM extraction (blueprint 01 slice5_extraction + 04 §3).
-- Advisory extraction metadata on Restock; fixture-mode key on RestockImage.
ALTER TABLE "Restock" ADD COLUMN "extractedAt" DATETIME;
ALTER TABLE "Restock" ADD COLUMN "extractionModel" TEXT;
ALTER TABLE "Restock" ADD COLUMN "extractionJson" TEXT;
-- JSON array of resolved (confirmed/dismissed) extraction line indices; keeps
-- proposal state server-side so it survives refresh/tab-kill (blueprint 02).
ALTER TABLE "Restock" ADD COLUMN "extractionResolved" TEXT;
ALTER TABLE "RestockImage" ADD COLUMN "originalSha256" TEXT;
