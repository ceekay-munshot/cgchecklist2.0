-- AlterEnum
ALTER TYPE "SourceDocType" ADD VALUE 'SCREENER_PAGE';

-- AlterTable
ALTER TABLE "SourceDoc" ADD COLUMN     "extractedText" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "structuredData" JSONB,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "SourceDoc_fetchStatus_idx" ON "SourceDoc"("fetchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDoc_runId_sourceUrl_key" ON "SourceDoc"("runId", "sourceUrl");

