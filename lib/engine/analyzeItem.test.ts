import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/usage", () => ({
  recordProviderUsage: vi.fn(),
  getProviderUsage: vi.fn(async () => ({ requests: 0 })),
}));
vi.mock("@/lib/llm", () => {
  const mk = (id: string) => ({ id, complete: vi.fn(), completeJSON: vi.fn(), isConfigured: () => true });
  return {
    llm: { reasoning: mk("mistral"), bulkClassify: mk("groq"), longContext: mk("gemini"), fallback: mk("nvidia") },
  };
});

import { analyzeItem } from "./analyzeItem";
import { resetQuotaState, QuotaExhaustedError } from "./quota";
import { llm } from "@/lib/llm";
import { getProviderUsage } from "@/lib/usage";
import type { EngineItem, Evidence } from "./types";

const asMock = (fn: unknown) => fn as unknown as Mock;
const ALL_PROVIDERS = [llm.reasoning, llm.bulkClassify, llm.longContext, llm.fallback];

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

beforeEach(() => {
  vi.clearAllMocks();
  resetQuotaState();
});

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

  it("labels a near-flat percentage series 'stable' (within tolerance)", async () => {
    const ev: Evidence = {
      status: "found",
      from: "screener",
      kind: "NUMERIC",
      structured: { "Promoter holding %": "71.77%" },
      series: { label: "Promoter holding %", periods: ["a", "b"], values: ["72.30%", "71.77%"] },
      citation: { sourceDocId: "sd1", docType: "SCREENER_PAGE" },
    };
    const a = await analyzeItem(item({ id: "A3-01", outputFormat: "% + trend" }), ev);
    expect(a.value).toContain("stable"); // 0.53pp drift is NOT "declining"
  });

  it("labels a clearly declining series 'declining'", async () => {
    const ev: Evidence = {
      status: "found",
      from: "screener",
      kind: "NUMERIC",
      structured: { "Promoter holding %": "60.00%" },
      series: { label: "Promoter holding %", periods: ["a", "b"], values: ["72.00%", "60.00%"] },
      citation: { sourceDocId: "sd1", docType: "SCREENER_PAGE" },
    };
    const a = await analyzeItem(item({ id: "A3-01", outputFormat: "% + trend" }), ev);
    expect(a.value).toContain("declining");
  });

  it("extracts board independence as a numeric value via Groq", async () => {
    asMock(llm.bulkClassify.completeJSON).mockResolvedValueOnce({
      relevant: true,
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
      relevant: true,
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

  it("anchors the extractor to the subject company + forbids importing other companies", async () => {
    // The anti-hallucination fix: a private company ("Nora Enterprises") must not be
    // answered with facts about a same-named listed company or invented peers.
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ relevant: true, found: true, value: "Nil" });
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "QUALITATIVE",
      companyName: "Nora Enterprises",
      passages: [{ text: "some governance text", citation: { sourceUrl: "x" } }],
    };
    await analyzeItem(item({ id: "A1-05", outputFormat: "Text" }), ev);
    const prompt = asMock(llm.reasoning.completeJSON).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Nora Enterprises");
    expect(prompt).toMatch(/GROUNDING/);
    expect(prompt).toMatch(/other\s+company/i);
  });

  it("SUBJECT GROUNDING: warns against attributing a deck's PEER/comps company to the subject (Sigachi guard)", async () => {
    // The MetalBook→Sigachi leak: a pitch deck names a listed comparable, and the
    // extractor must be told not to report that peer's facts as the subject's.
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ relevant: true, found: true, value: "Nil" });
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "QUALITATIVE",
      companyName: "Metalbook",
      passages: [{ text: "Comparable listed peers include Sigachi Industries ...", citation: { sourceUrl: "x" } }],
    };
    await analyzeItem(item({ id: "A1-05", outputFormat: "Text" }), ev);
    const prompt = asMock(llm.reasoning.completeJSON).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Metalbook");
    expect(prompt).toMatch(/peer|comparable|competitor|benchmark/i);
    expect(prompt).toMatch(/comps table|benchmarking/i); // relevance gate mentions decks
  });

  it("CROSS-ENTITY: relaxes grounding so a promoter-elsewhere item (A9-04) can report a DIFFERENT company's facts", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({
      relevant: true,
      found: true,
      value: "Promoter's earlier firm Zenith Infra wound up amid loan defaults",
    });
    const ev: Evidence = {
      status: "found",
      from: "web",
      kind: "QUALITATIVE",
      companyName: "Afcom Holdings",
      crossEntity: true,
      passages: [{ text: "The promoter earlier ran Zenith Infra, which collapsed amid defaults ...", citation: { sourceUrl: "https://news.example/x" } }],
    };
    const a = await analyzeItem(item({ id: "A9-04", sectionCode: "A9", outputFormat: "Text" }), ev);
    expect(a.value).toContain("Zenith Infra");
    expect(a.confidence).toBe("low"); // web-sourced
    const prompt = asMock(llm.reasoning.completeJSON).mock.calls[0][0].prompt as string;
    expect(prompt).toMatch(/cross-entity/i);
    expect(prompt).toMatch(/other ventures/i);
    // the relevance gate must NOT tell it to reject a differently-named company here
    expect(prompt).not.toMatch(/comps table in a deck/i);
  });

  it("RELEVANCE GATE: returns 'not available' for an off-topic passage instead of judging it", async () => {
    // The model decides the excerpt isn't actually about this item (shares a word only).
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({
      relevant: false,
      found: false,
      value: "Revenue from operations grew 5%",
    });
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "QUALITATIVE",
      passages: [{ text: "Revenue from operations ...", citation: { sourceDocId: "ar1", page: 7, docType: "ANNUAL_REPORT", docName: "AR" } }],
    };
    // e.g. A7a-13 (contingent-liability movement) handed a revenue passage → NA, not a wrong flag.
    const a = await analyzeItem(item({ id: "A7a-13", outputFormat: "Trend" }), ev);
    expect(a.value).toBe("not available");
    expect(a.confidence).toBe("low");
  });

  it("GATE LENIENCY: keeps an on-topic-but-thin passage as a LOW-confidence verdict (not NA)", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({
      relevant: true,
      found: true,
      confident: false, // on-topic but thin
      value: "Equity shares carry one vote each (one-share-one-vote)",
    });
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "QUALITATIVE",
      passages: [{ text: "The Company has one class of equity shares ...", citation: { sourceDocId: "ar1", page: 90, docType: "ANNUAL_REPORT", docName: "AR" } }],
    };
    const a = await analyzeItem(item({ id: "A3-04", outputFormat: "Yes/No" }), ev);
    expect(a.value).toContain("one-share-one-vote");
    expect(a.confidence).toBe("low"); // kept, not discarded
  });

  it("NOTE MODE: Gemini reads the located note's figures", async () => {
    asMock(llm.longContext.completeJSON).mockResolvedValueOnce({
      relevant: true,
      found: true,
      value: "Contingent liabilities ~Rs 1,234 cr (tax disputes); capital commitments Rs 567 cr",
      evidenceQuote: "Claims not acknowledged as debt: Rs 1,234 crore",
      page: 210,
    });
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "NUMERIC",
      mode: "note",
      passages: [{ text: "Note 38. Contingent liabilities ... Rs 1,234 crore ...", citation: { sourceDocId: "ar1", page: 210, docType: "ANNUAL_REPORT", docName: "AR" } }],
    };
    const a = await analyzeItem(item({ id: "A7a-03", outputFormat: "₹ / % NW" }), ev);
    expect(a.value).toContain("1,234");
    expect(a.providerUsed).toBe("gemini");
    expect(a.citation?.page).toBe(210);
  });

  it("TASK 6: a genuine provider error during extraction degrades to NA, not a throw", async () => {
    // Every provider fails with a non-rate-limit error (e.g. a 5xx or persistently
    // bad JSON) — the item must return a clean NA, not become a hard ERROR.
    for (const c of ALL_PROVIDERS) asMock(c.completeJSON).mockRejectedValue(new Error("upstream 500"));
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "QUALITATIVE",
      passages: [{ text: "Cross-holdings and group structure ...", citation: { sourceDocId: "ar1", page: 12, docType: "ANNUAL_REPORT", docName: "AR" } }],
    };
    const a = await analyzeItem(item({ id: "A3-03", outputFormat: "Text" }), ev);
    expect(a.value).toBe("not available"); // honest NA — what fixes A3-03 / A3-07 erroring
    expect(a.confidence).toBe("low");
  });

  it("TASK 6: a QuotaExhaustedError during extraction still propagates (so the run DEFERS)", async () => {
    asMock(getProviderUsage).mockResolvedValue({ requests: 999_999 }); // every provider over its daily cap
    const ev: Evidence = {
      status: "found",
      from: "document",
      kind: "QUALITATIVE",
      passages: [{ text: "Cross-holdings and group structure ...", citation: { sourceDocId: "ar1", page: 12, docType: "ANNUAL_REPORT", docName: "AR" } }],
    };
    await expect(analyzeItem(item({ id: "A3-03", outputFormat: "Text" }), ev)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });
});
