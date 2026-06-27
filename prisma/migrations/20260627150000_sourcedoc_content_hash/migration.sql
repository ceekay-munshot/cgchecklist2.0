-- AlterTable
ALTER TABLE "SourceDoc" ADD COLUMN     "contentHash" TEXT;

-- CreateIndex
CREATE INDEX "SourceDoc_runId_contentHash_idx" ON "SourceDoc"("runId", "contentHash");
