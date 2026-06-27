import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SourceDoc } from "@prisma/client";

vi.mock("@/lib/db", () => ({
  prisma: {
    sourceDoc: { findFirst: vi.fn(), findMany: vi.fn() },
    analysisRun: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/scrape", () => ({
  webResearcher: { search: vi.fn(), fetchUrl: vi.fn() },
}));

import { evidenceStrategyFor, getEvidence } from "./evidence";
import { prisma } from "@/lib/db";
import type { EngineItem } from "./types";

function item(p: Partial<EngineItem> & { id: string }): EngineItem {
  return {
    sectionCode: p.id.split("-")[0],
    item: p.item ?? "Item",
    description: null,
    outputFormat: p.outputFormat ?? null,
    greenFlag: null,
    redFlag: null,
    sourceHint: null,
    isNonNegotiable: false,
    ...p,
  };
}

const sd = (p: Partial<SourceDoc>): SourceDoc => p as unknown as SourceDoc;

describe("evidenceStrategyFor — routing per item", () => {
  it("routes Tier-1 numeric items to the Screener page", () => {
    expect(evidenceStrategyFor(item({ id: "A14-01", outputFormat: "D/E ratio" })).from).toBe("screener");
    expect(evidenceStrategyFor(item({ id: "A3-02", outputFormat: "%" })).from).toBe("screener");
    expect(evidenceStrategyFor(item({ id: "A3-01", outputFormat: "% + trend" })).from).toBe("screener");
  });
  it("routes numeric-from-document (board independence) to the annual report", () => {
    const s = evidenceStrategyFor(item({ id: "A1-01", outputFormat: "% independent" }));
    expect(s.from).toBe("document");
    expect(s.docTypes).toContain("ANNUAL_REPORT");
  });
  it("routes auditor identity to the annual report", () => {
    expect(evidenceStrategyFor(item({ id: "A4-01", outputFormat: "Yes/No" })).from).toBe("document");
  });
  it("routes the CEO view to documents with a web fallback", () => {
    const s = evidenceStrategyFor(item({ id: "A13-02", outputFormat: "Text/Score" }));
    expect(s.from).toBe("document");
    expect(s.webFallback).toBe(true);
  });
  it("defaults unknown numeric -> screener, unknown qualitative -> document", () => {
    expect(evidenceStrategyFor(item({ id: "A15-99", outputFormat: "%" })).from).toBe("screener");
    expect(evidenceStrategyFor(item({ id: "A5-99", outputFormat: "Yes/No" })).from).toBe("document");
  });
});

describe("getEvidence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads Tier-1 structuredData for a numeric item (D/E), citing the SCREENER_PAGE", async () => {
    vi.mocked(prisma.sourceDoc.findFirst).mockResolvedValue(
      sd({
        id: "sd1",
        sourceUrl: "https://screener.in/x",
        name: "Screener page",
        type: "SCREENER_PAGE",
        structuredData: { ratios: { "Debt to equity": "0.09" } } as unknown as SourceDoc["structuredData"],
      }),
    );
    const ev = await getEvidence(item({ id: "A14-01", outputFormat: "D/E ratio" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.from).toBe("screener");
    expect(ev.structured?.["Debt to equity"]).toBe("0.09");
    expect(ev.citation?.docType).toBe("SCREENER_PAGE");
  });

  it("returns not_available when the Screener page is missing", async () => {
    vi.mocked(prisma.sourceDoc.findFirst).mockResolvedValue(null);
    const ev = await getEvidence(item({ id: "A14-01", outputFormat: "D/E ratio" }), "run1");
    expect(ev.status).toBe("not_available");
  });

  it("returns not_available for a document item when no passages match", async () => {
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([
      sd({ id: "ar1", type: "ANNUAL_REPORT", sourceUrl: "u", name: "AR", extractedText: "nothing relevant here" }),
    ]);
    const ev = await getEvidence(item({ id: "A4-01", outputFormat: "Yes/No" }), "run1");
    expect(ev.status).toBe("not_available");
  });

  it("retrieves matching passages with page citations for a document item", async () => {
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([
      sd({
        id: "ar1",
        type: "ANNUAL_REPORT",
        sourceUrl: "u",
        name: "AR 2026",
        extractedText:
          "===== PAGE 5 =====\nThe statutory auditor is B S R & Co. LLP, Chartered Accountants, appointed as auditors in 2022.\n",
      }),
    ]);
    const ev = await getEvidence(item({ id: "A4-01", outputFormat: "Yes/No" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.from).toBe("document");
    expect(ev.passages?.[0].citation.page).toBe(5);
    expect(ev.passages?.[0].citation.sourceDocId).toBe("ar1");
  });
});
