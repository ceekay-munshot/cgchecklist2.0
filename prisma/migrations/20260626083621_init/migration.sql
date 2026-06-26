-- CreateEnum
CREATE TYPE "Flag" AS ENUM ('GREEN', 'RED', 'NEUTRAL', 'NOT_AVAILABLE');

-- CreateEnum
CREATE TYPE "Exchange" AS ENUM ('NSE', 'BSE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'HARVESTING', 'PROCESSING', 'PARTIAL', 'DONE', 'ERROR');

-- CreateEnum
CREATE TYPE "SourceDocType" AS ENUM ('ANNUAL_REPORT', 'EARNINGS_PDF', 'ANNOUNCEMENT', 'WEB', 'MANUAL_UPLOAD');

-- CreateEnum
CREATE TYPE "FetchedVia" AS ENUM ('SCREENER', 'FIRECRAWL', 'SCRAPEDO', 'DIRECT', 'MANUAL');

-- CreateEnum
CREATE TYPE "FetchStatus" AS ENUM ('OK', 'EMPTY', 'FAILED');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'ERROR', 'DEFERRED', 'NEEDS_REVIEW');

-- CreateTable
CREATE TABLE "ChecklistSection" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ChecklistSection_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "sectionCode" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "description" TEXT,
    "outputFormat" TEXT,
    "greenFlag" TEXT,
    "redFlag" TEXT,
    "sourceHint" TEXT,
    "isNonNegotiable" BOOLEAN NOT NULL DEFAULT false,
    "thresholdLogic" TEXT,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ticker" TEXT,
    "exchange" "Exchange",
    "sector" TEXT,
    "cin" TEXT,
    "screenerUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastProcessedAt" TIMESTAMP(3),
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "itemsDone" INTEGER NOT NULL DEFAULT 0,
    "itemsError" INTEGER NOT NULL DEFAULT 0,
    "summaryJson" JSONB,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceDoc" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "SourceDocType" NOT NULL,
    "name" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fetchedVia" "FetchedVia" NOT NULL,
    "fetchStatus" "FetchStatus" NOT NULL DEFAULT 'OK',
    "storageRef" TEXT,
    "pages" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "flag" "Flag",
    "verdict" TEXT,
    "value" TEXT,
    "evidenceQuote" TEXT,
    "sourceDocId" TEXT,
    "confidence" DOUBLE PRECISION,
    "isNonNegotiable" BOOLEAN NOT NULL DEFAULT false,
    "gatePass" BOOLEAN,
    "providerUsed" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "analystOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderUsage" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChecklistItem_sectionCode_idx" ON "ChecklistItem"("sectionCode");

-- CreateIndex
CREATE UNIQUE INDEX "Company_cin_key" ON "Company"("cin");

-- CreateIndex
CREATE INDEX "Company_name_idx" ON "Company"("name");

-- CreateIndex
CREATE INDEX "Company_ticker_idx" ON "Company"("ticker");

-- CreateIndex
CREATE INDEX "AnalysisRun_companyId_idx" ON "AnalysisRun"("companyId");

-- CreateIndex
CREATE INDEX "AnalysisRun_status_idx" ON "AnalysisRun"("status");

-- CreateIndex
CREATE INDEX "SourceDoc_runId_idx" ON "SourceDoc"("runId");

-- CreateIndex
CREATE INDEX "ItemResult_runId_idx" ON "ItemResult"("runId");

-- CreateIndex
CREATE INDEX "ItemResult_status_idx" ON "ItemResult"("status");

-- CreateIndex
CREATE INDEX "ItemResult_flag_idx" ON "ItemResult"("flag");

-- CreateIndex
CREATE UNIQUE INDEX "ItemResult_runId_itemId_key" ON "ItemResult"("runId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderUsage_provider_date_key" ON "ProviderUsage"("provider", "date");

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_sectionCode_fkey" FOREIGN KEY ("sectionCode") REFERENCES "ChecklistSection"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceDoc" ADD CONSTRAINT "SourceDoc_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemResult" ADD CONSTRAINT "ItemResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemResult" ADD CONSTRAINT "ItemResult_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ChecklistItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemResult" ADD CONSTRAINT "ItemResult_sourceDocId_fkey" FOREIGN KEY ("sourceDocId") REFERENCES "SourceDoc"("id") ON DELETE SET NULL ON UPDATE CASCADE;
