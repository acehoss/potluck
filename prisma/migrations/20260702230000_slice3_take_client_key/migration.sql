-- AlterTable
ALTER TABLE "Take" ADD COLUMN "clientKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Take_clientKey_key" ON "Take"("clientKey");
