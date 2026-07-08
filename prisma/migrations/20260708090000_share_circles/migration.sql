ALTER TABLE "SharePost" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'ALL';

CREATE TABLE "SharePostCircle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sharePostId" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    CONSTRAINT "SharePostCircle_sharePostId_fkey" FOREIGN KEY ("sharePostId") REFERENCES "SharePost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SharePostCircle_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SharePostCircle_sharePostId_circleId_key" ON "SharePostCircle"("sharePostId", "circleId");
CREATE INDEX "SharePostCircle_circleId_idx" ON "SharePostCircle"("circleId");
