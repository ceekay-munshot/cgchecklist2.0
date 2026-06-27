import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/usage", () => ({ recordProviderUsage: vi.fn() }));
vi.mock("@/lib/llm", () => {
  const mk = (id: string) => ({ id, complete: vi.fn(), completeJSON: vi.fn() });
  return {
    llm: { reasoning: mk("mistral"), bulkClassify: mk("groq"), longContext: mk("gemini"), fallback: mk("nvidia") },
  };
});

import { analyzeItem } from "./analyzeItem";
import { llm } from "@/lib/llm";
import type { EngineItem, Evidence } from "./types";

const asMock = (fn: unknown) => fn as unknown as Mock;

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

beforeEach(() => vi.clearAllMocks());

describe("analyzeItem", () => {
  it("returns 'not available' without an LLM call when evidence is missing", async () => {
    const ev: Evidence = { status: "not_available", from: "document", kind: "QUALITATIVE" };
    const a = await analyzeItem(item({ id: "A4-01", outputFormat: "Yes/No" }), ev);
    expect(a.value).toBe("not available");
    expect(a.confidence).toBe("low");
    expect(asMock(llm.reasoning.completeJSON)).not.toHaveBeenCalled();
    expect(asMock(llm.bulkClassify.completeJSON)).not.toHaveBeenCalled();
  });

  it("direct-maps a Tier-1 numeric value (no LLM call)", async () => {
    const ev: Evidence = {
      status: "found",
      from: "screener",
      kind: "NUMERIC",
      structured: { "Debt to equity": "0.09" },
      note: "from Screener ratios",
      citation: { sourceDocId: "sd1", docType: "SCREENER_PAGE" },
    };
    const a = await analyzeItem(item({ id: "A14-01", outputFormat: "D/E ratio" }), ev);
    expect(a.value).toBe("0.09");
    expect(a.providerUsed).toBe("deterministic");
    expect(a.confidence).toBe("high");
    expect(asMock(llm.bulkClassify.completeJSON)).not.toHaveBeenCalled();
  });

  it("annotates a Tier-1 series with its latest value + trend", async () => {
    const ev: Evidence = {
      status: "found",
      from: "screener",
      kind: "NUMERIC",
      structured: { "Promoter holding %": "72.30%" },
      series: { label: "Promoter holding %", periods: ["Dec22", "Mar23", "Jun23"], values: ["72.30%", "72.30%", "72.30%"] },
      citation: { sourceDocId: "sd1", docType: "SCREENER_PAGE" },
    };
    const a = await analyzeItem(item({ id: "A3-01", outputFormat: "% + trend" }), ev);
    expect(a.value).toContain("72.30%");
    expect(a.value).toContain("stable");
    expect(a.providerUsed).toBe("deterministic");
  });

  it("extracts board independence as a numeric value via Groq", async () => {
    asMock(llm.bulkClassify.completeJSON).mockResolvedValueOnce({
      found: true,
      independentDirectors: 6,
      totalDirectors: 11,
      percentIndependent: null,
      evidenceQuote: "6 of 11 directors are independent",
      page: 42,
    });
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "NUMERIC",
      passages: [{ text: "board composition ...", citation: { sourceDocId: "ar1", page: 42, docType: "ANNUAL_REPORT", docName: "AR" } }],
    };
    const a = await analyzeItem(item({ id: "A1-01", outputFormat: "% independent" }), ev);
    expect(a.value).toContain("54.5% independent");
    expect(a.value).toContain("(6 of 11)");
    expect(a.providerUsed).toBe("groq");
    expect(a.citation?.page).toBe(42);
  });

  it("extracts a qualitative fact via the reasoning model", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({
      found: true,
      value: "Audited by B S R & Co. LLP (KPMG network) — a Big Four affiliate",
      evidenceQuote: "M/s B S R & Co. LLP, Chartered Accountants",
      page: 120,
    });
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "QUALITATIVE",
      passages: [{ text: "statutory auditor ...", citation: { sourceDocId: "ar1", page: 120, docType: "ANNUAL_REPORT", docName: "AR" } }],
      citation: { sourceDocId: "ar1", page: 120 },
    };
    const a = await analyzeItem(item({ id: "A4-01", outputFormat: "Yes/No" }), ev);
    expect(a.value).toContain("B S R & Co");
    expect(a.providerUsed).toBe("mistral");
    expect(a.citation?.page).toBe(120);
  });
});
