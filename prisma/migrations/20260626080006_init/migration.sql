-- CreateEnum
CREATE TYPE "Flag" AS ENUM ('GREEN', 'RED', 'NEUTRAL', 'NOT_AVAILABLE');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('ANNUAL_REPORT', 'FILING', 'PRESS_RELEASE', 'WEBPAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cin" TEXT,
    "nseSymbol" TEXT,
    "bseCode" TEXT,
    "sector" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL DEFAULT 'OTHER',
    "title" TEXT,
    "url" TEXT,
    "fiscalYear" TEXT,
    "sourcePath" TEXT,
    "contentText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "regReference" TEXT,
    "guidance" TEXT,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "fiscalYear" TEXT,
    "notes" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "checklistItemId" TEXT NOT NULL,
    "flag" "Flag" NOT NULL DEFAULT 'NOT_AVAILABLE',
    "verdict" TEXT,
    "evidence" TEXT,
    "source" TEXT,
    "documentId" TEXT,
    "llmProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_cin_key" ON "Company"("cin");

-- CreateIndex
CREATE INDEX "Company_name_idx" ON "Company"("name");

-- CreateIndex
CREATE INDEX "Document_companyId_idx" ON "Document"("companyId");

-- CreateIndex
CREATE INDEX "Document_companyId_fiscalYear_idx" ON "Document"("companyId", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistItem_code_key" ON "ChecklistItem"("code");

-- CreateIndex
CREATE INDEX "ChecklistItem_category_idx" ON "ChecklistItem"("category");

-- CreateIndex
CREATE INDEX "AnalysisRun_companyId_idx" ON "AnalysisRun"("companyId");

-- CreateIndex
CREATE INDEX "AnalysisRun_status_idx" ON "AnalysisRun"("status");

-- CreateIndex
CREATE INDEX "ItemResult_runId_idx" ON "ItemResult"("runId");

-- CreateIndex
CREATE INDEX "ItemResult_flag_idx" ON "ItemResult"("flag");

-- CreateIndex
CREATE UNIQUE INDEX "ItemResult_runId_checklistItemId_key" ON "ItemResult"("runId", "checklistItemId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemResult" ADD CONSTRAINT "ItemResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemResult" ADD CONSTRAINT "ItemResult_checklistItemId_fkey" FOREIGN KEY ("checklistItemId") REFERENCES "ChecklistItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemResult" ADD CONSTRAINT "ItemResult_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
