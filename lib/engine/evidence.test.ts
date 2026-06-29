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
  it("routes computed-numeric items to the Screener page with the right field", () => {
    const s = evidenceStrategyFor(item({ id: "A8-01", outputFormat: "Ratio (cumulative)" }));
    expect(s.from).toBe("screener");
    expect(s.screenerFields?.[0]).toMatchObject({ kind: "cfoToPat" });
  });
  it("gives section-profiled document items note headings to locate", () => {
    const s = evidenceStrategyFor(item({ id: "A7a-13", outputFormat: "Trend" }));
    expect(s.from).toBe("document");
    expect(s.sections).toContain("contingent liabilities and commitments");
  });
  it("marks table-heavy notes (A7a, A5) for Gemini note reading", () => {
    expect(evidenceStrategyFor(item({ id: "A7a-03", outputFormat: "₹ / % NW" })).useGeminiNote).toBe(true);
    expect(evidenceStrategyFor(item({ id: "A5-02", outputFormat: "% of sales" })).useGeminiNote).toBe(true);
    // a non-note document item is NOT flagged for Gemini note reading
    expect(evidenceStrategyFor(item({ id: "A4-01", outputFormat: "Yes/No" })).useGeminiNote).toBeFalsy();
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

  it("computes a Tier-1 numeric (CFO/PAT) from structuredData (no LLM)", async () => {
    vi.mocked(prisma.sourceDoc.findFirst).mockResolvedValue(
      sd({
        id: "sp1",
        type: "SCREENER_PAGE",
        sourceUrl: "u",
        name: "Screener page",
        structuredData: {
          profitLoss: { periods: ["FY23", "FY24"], rows: [{ label: "Net Profit", values: ["100", "120"] }] },
          cashFlow: { periods: ["FY23", "FY24"], rows: [{ label: "Cash from Operating Activity", values: ["90", "110"] }] },
        } as unknown as SourceDoc["structuredData"],
      }),
    );
    const ev = await getEvidence(item({ id: "A8-01", outputFormat: "Ratio (cumulative)" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.structured?.["CFO/PAT (cumulative)"]).toBe("0.91"); // 200/220
  });

  it("extracts a whole NOTE by heading (section-aware retrieval) with its page", async () => {
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([
      sd({
        id: "ar1",
        type: "ANNUAL_REPORT",
        sourceUrl: "u",
        name: "AR 2026",
        extractedText:
          "===== PAGE 210 =====\n" +
          "Note 38. Contingent liabilities and commitments\n" +
          "(a) Claims against the Company not acknowledged as debt: Rs 1,234 crore (PY Rs 1,100 crore).\n" +
          "(b) Capital commitments: Rs 567 crore. Bank guarantees Rs 89 crore.\n",
      }),
    ]);
    const ev = await getEvidence(item({ id: "A7a-13", outputFormat: "Trend" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.from).toBe("document");
    expect(ev.mode).toBe("note"); // routed to Gemini note reading
    expect(ev.passages?.[0].citation.page).toBe(210);
    expect(ev.passages?.[0].text).toContain("Claims against the Company");
  });
});
