-- CreateTable
CREATE TABLE IF NOT EXISTS "ChecklistSection" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChecklistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    CONSTRAINT "ChecklistItem_sectionCode_fkey" FOREIGN KEY ("sectionCode") REFERENCES "ChecklistSection" ("code") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "ticker" TEXT,
    "exchange" TEXT,
    "sector" TEXT,
    "cin" TEXT,
    "screenerUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AnalysisRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastProcessedAt" DATETIME,
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "itemsDone" INTEGER NOT NULL DEFAULT 0,
    "itemsError" INTEGER NOT NULL DEFAULT 0,
    "summaryJson" JSONB,
    CONSTRAINT "AnalysisRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SourceDoc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fetchedVia" TEXT NOT NULL,
    "fetchStatus" TEXT NOT NULL DEFAULT 'OK',
    "storageRef" TEXT,
    "pages" INTEGER,
    "structuredData" JSONB,
    "extractedText" TEXT,
    "contentHash" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SourceDoc_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ItemResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "flag" TEXT,
    "verdict" TEXT,
    "value" TEXT,
    "evidenceQuote" TEXT,
    "sourceDocId" TEXT,
    "sourcePage" INTEGER,
    "sourceUrl" TEXT,
    "confidence" REAL,
    "isNonNegotiable" BOOLEAN NOT NULL DEFAULT false,
    "gatePass" BOOLEAN,
    "providerUsed" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" DATETIME,
    "analystOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ItemResult_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ChecklistItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ItemResult_sourceDocId_fkey" FOREIGN KEY ("sourceDocId") REFERENCES "SourceDoc" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProviderUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChecklistItem_sectionCode_idx" ON "ChecklistItem"("sectionCode");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Company_cin_key" ON "Company"("cin");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Company_name_idx" ON "Company"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Company_ticker_idx" ON "Company"("ticker");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AnalysisRun_companyId_idx" ON "AnalysisRun"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AnalysisRun_status_idx" ON "AnalysisRun"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourceDoc_runId_idx" ON "SourceDoc"("runId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourceDoc_fetchStatus_idx" ON "SourceDoc"("fetchStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourceDoc_runId_contentHash_idx" ON "SourceDoc"("runId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SourceDoc_runId_sourceUrl_key" ON "SourceDoc"("runId", "sourceUrl");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ItemResult_runId_idx" ON "ItemResult"("runId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ItemResult_status_idx" ON "ItemResult"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ItemResult_flag_idx" ON "ItemResult"("flag");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ItemResult_runId_itemId_key" ON "ItemResult"("runId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderUsage_provider_date_key" ON "ProviderUsage"("provider", "date");

