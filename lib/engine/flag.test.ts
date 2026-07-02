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

import { assignFlag } from "./flag";
import { resetQuotaState } from "./quota";
import { llm } from "@/lib/llm";
import type { Analysis, EngineItem } from "./types";

const asMock = (fn: unknown) => fn as unknown as Mock;

function item(p: Partial<EngineItem> & { id: string }): EngineItem {
  return {
    sectionCode: p.id.split("-")[0],
    item: p.item ?? "Item",
    description: null,
    outputFormat: p.outputFormat ?? null,
    greenFlag: p.greenFlag ?? null,
    redFlag: p.redFlag ?? null,
    sourceHint: null,
    isNonNegotiable: p.isNonNegotiable ?? false,
    ...p,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQuotaState();
});

describe("assignFlag", () => {
  it("numeric: classifies deterministically with NO LLM call", async () => {
    const a: Analysis = { value: "0.09", confidence: "high" };
    const r = await assignFlag(
      item({ id: "A14-01", outputFormat: "D/E ratio", greenFlag: "<0.5–1.0", redFlag: ">2 / rising" }),
      a,
    );
    expect(r.flag).toBe("GREEN");
    expect(asMock(llm.reasoning.completeJSON)).not.toHaveBeenCalled();
  });

  it("numeric item with an unparseable value falls through to the judge (no 'could not parse' dead-end)", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({
      flag: "GREEN",
      reason: "Every director attended all board meetings.",
    });
    const r = await assignFlag(
      item({ id: "A99-01", outputFormat: "Count", greenFlag: "100%", redFlag: "<75%" }),
      { value: "Full attendance", confidence: "medium" },
    );
    expect(r.flag).toBe("GREEN");
    expect(r.reason).not.toMatch(/could not parse/i);
    expect(asMock(llm.reasoning.completeJSON)).toHaveBeenCalled();
  });

  it("maps a 'not available' value to NOT_AVAILABLE", async () => {
    const r = await assignFlag(item({ id: "A4-01", outputFormat: "Yes/No" }), { value: "not available", confidence: "low" });
    expect(r.flag).toBe("NOT_AVAILABLE");
    expect(asMock(llm.reasoning.completeJSON)).not.toHaveBeenCalled();
  });

  it("never fires a RED from web-sourced evidence (downgrades to NEUTRAL)", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ flag: "RED", reason: "A news snippet alleges a problem." });
    const r = await assignFlag(
      item({ id: "A13-09", outputFormat: "Text", greenFlag: "None", redFlag: "Strong political ties" }),
      { value: "largest political donor", confidence: "low" },
      { web: true },
    );
    expect(r.flag).toBe("NEUTRAL");
    expect(r.reason).toMatch(/web-sourced/i);
  });

  it("allows a filing RED when a different model CONFIRMS it on cross-check", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ flag: "RED", reason: "Qualified opinion in the audit report." });
    asMock(llm.bulkClassify.completeJSON).mockResolvedValueOnce({ flag: "RED", reason: "Cross-check agrees — qualified." });
    const r = await assignFlag(
      item({ id: "A7-09", outputFormat: "Text", greenFlag: "Clean", redFlag: "Adverse" }),
      { value: "something material", confidence: "high" },
      { web: false },
    );
    expect(r.flag).toBe("RED");
    expect(asMock(llm.bulkClassify.completeJSON)).toHaveBeenCalledTimes(1); // cross-checked
  });

  it("downgrades a one-off filing RED to NEUTRAL when the cross-check model disagrees", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ flag: "RED", reason: "Misread 'restatement' as adverse." });
    asMock(llm.bulkClassify.completeJSON).mockResolvedValueOnce({ flag: "GREEN", reason: "Restatement is for comparability — fine." });
    const r = await assignFlag(
      item({ id: "A7-05", outputFormat: "Text", greenFlag: "Consistent", redFlag: "Contradictory" }),
      { value: "restatement for consistency and comparability", confidence: "medium" },
      { web: false },
    );
    expect(r.flag).toBe("NEUTRAL");
    expect(r.needsReview).toBe(true);
  });

  it("qualitative: an LLM judge decides the flag", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ flag: "GREEN", reason: "Reputed Big Four auditor." });
    const r = await assignFlag(
      item({ id: "A4-01", outputFormat: "Yes/No", greenFlag: "Reputed firm, compliant", redFlag: "Obscure firm / rotation avoidance" }),
      { value: "Audited by Deloitte (Big Four)", confidence: "medium" },
    );
    expect(r.flag).toBe("GREEN");
    expect(r.providerUsed).toBe("mistral");
  });

  it("NUMERIC SANITY: A14-02 debt level is GREEN from Tier-1 D/E (deterministic, no LLM, never a false red)", async () => {
    // "Text" by output_format, but anchored on Tier-1 D/E so it can't contradict A14-01.
    const r = await assignFlag(
      item({ id: "A14-02", outputFormat: "Text", greenFlag: "Modest", redFlag: "High debt + large advances out" }),
      { value: "0.11", confidence: "high" },
    );
    expect(r.flag).toBe("GREEN");
    expect(asMock(llm.reasoning.completeJSON)).not.toHaveBeenCalled();
  });

  it("amount item (A7a-03): classified by MATERIALITY vs company size, no LLM", async () => {
    const r = await assignFlag(
      item({ id: "A7a-03", outputFormat: "₹ / % NW", greenFlag: "Small, mostly winnable", redFlag: "Large / repeated losses" }),
      { value: "Income-tax disputes ~Rs 1,234 cr", confidence: "medium" },
      { scale: { netWorth: 95_000, revenue: 240_000, pat: 49_000 } },
    );
    expect(r.flag).toBe("GREEN"); // ₹1,234cr ≈ 1.3% of net worth → immaterial
    expect(asMock(llm.reasoning.completeJSON)).not.toHaveBeenCalled();
  });
});

const TCS_SCALE = { netWorth: 95_000, revenue: 240_000, pat: 49_000 };

describe("materiality — amount-based reds fire only when material (Phase 8)", () => {
  it("A7a-06: an immaterial ₹226cr subsidiary guarantee is GREEN, not RED — no LLM", async () => {
    const r = await assignFlag(
      item({ id: "A7a-06", outputFormat: "% net worth", greenFlag: "Nil/minimal", redFlag: "Large guarantees" }),
      { value: "Corporate guarantees given: $25 million (equivalent to Rs 226 crore)", confidence: "medium" },
      { scale: TCS_SCALE },
    );
    expect(r.flag).toBe("GREEN"); // 226 / 95,000 ≈ 0.24%
    expect(asMock(llm.reasoning.completeJSON)).not.toHaveBeenCalled();
  });

  it("A5-02: royalty at ~0.15% of revenue is GREEN, not RED", async () => {
    const r = await assignFlag(
      item({ id: "A5-02", outputFormat: "% of sales", greenFlag: "Nil or <1%", redFlag: ">2–3% sales" }),
      { value: "Royalty/brand fees of Rs 368 crore for FY2026", confidence: "medium" },
      { scale: TCS_SCALE },
    );
    expect(r.flag).toBe("GREEN"); // 368 / 240,000 ≈ 0.15%
  });

  it("A7a-06: a genuinely MATERIAL guarantee (>25% NW) still fires RED", async () => {
    const r = await assignFlag(
      item({ id: "A7a-06", outputFormat: "% net worth", greenFlag: "Nil/minimal", redFlag: "Large guarantees" }),
      { value: "Corporate guarantees given: Rs 40,000 crore", confidence: "medium" },
      { scale: TCS_SCALE },
    );
    expect(r.flag).toBe("RED"); // 40,000 / 95,000 ≈ 42% ≥ 25%
  });

  it("A5-04 SANITY: an implausibly large RPT figure is distrusted → NEUTRAL, never a red", async () => {
    const r = await assignFlag(
      item({ id: "A5-04", outputFormat: "%", greenFlag: "Minimal", redFlag: "Significant promoter routing" }),
      { value: "Promoter-vendor purchases of Rs 500,000 crore", confidence: "medium" },
      { scale: TCS_SCALE },
    );
    expect(r.flag).toBe("NEUTRAL"); // 500,000cr > 1.5× revenue → mis-extraction
  });

  it("without company scale, an amount item cannot confirm materiality → NEUTRAL (never a confident red)", async () => {
    const r = await assignFlag(
      item({ id: "A7a-06", outputFormat: "% net worth", greenFlag: "Nil/minimal", redFlag: "Large guarantees" }),
      { value: "Corporate guarantees given: Rs 226 crore", confidence: "medium" },
    );
    expect(r.flag).toBe("NEUTRAL");
  });

  it("guard: a trend item (A7a-13) judged RED on an immaterial figure is downgraded to NEUTRAL", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ flag: "RED", reason: "Rising additions." });
    const r = await assignFlag(
      item({ id: "A7a-13", outputFormat: "Trend", greenFlag: "Reversed/favourable", redFlag: "Rising additions" }),
      { value: "A corporate guarantee of Rs 226 crore was added", confidence: "medium" },
      { scale: TCS_SCALE },
    );
    expect(r.flag).toBe("NEUTRAL"); // 226cr ≈ 0.24% NW → immaterial → not a material movement
  });
});

describe("categorical compliance — A2-01 audit committee (Phase 8)", () => {
  it("a SEBI-compliant committee (75% independent, 3 of 4) is GREEN, not RED — no LLM", async () => {
    const r = await assignFlag(
      item({ id: "A2-01", outputFormat: "Yes/No + count", greenFlag: "100% independent, ≥4 meetings", redFlag: "Non-independent members / <4 meetings" }),
      { value: "Audit Committee independence: 75% (3 out of 4 members)", confidence: "medium" },
    );
    expect(r.flag).toBe("GREEN"); // ≥2/3 independent
    expect(asMock(llm.reasoning.completeJSON)).not.toHaveBeenCalled();
  });

  it("a non-compliant committee (1 of 4 independent) is RED", async () => {
    const r = await assignFlag(
      item({ id: "A2-01", outputFormat: "Yes/No + count", greenFlag: "100% independent", redFlag: "Non-independent members" }),
      { value: "Audit committee has 1 of 4 independent members", confidence: "medium" },
    );
    expect(r.flag).toBe("RED"); // not majority-independent
  });
});

describe("non-negotiable gate", () => {
  const nn = (over: Partial<EngineItem> = {}) =>
    item({ id: "X1-01", outputFormat: "Yes/No", greenFlag: "clean", redFlag: "linked to fraud", isNonNegotiable: true, ...over });

  it("sets gatePass=true on a GREEN, with no cross-check", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ flag: "GREEN", reason: "Clean record." });
    const r = await assignFlag(nn(), { value: "clean record", confidence: "high" });
    expect(r.flag).toBe("GREEN");
    expect(r.gatePass).toBe(true);
    expect(asMock(llm.bulkClassify.completeJSON)).not.toHaveBeenCalled();
  });

  it("confirms RED only when the cross-check agrees (gatePass=false)", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ flag: "RED", reason: "Linked to a past fraud." });
    asMock(llm.bulkClassify.completeJSON).mockResolvedValueOnce({ flag: "RED", reason: "Agreed — fraud link." });
    const r = await assignFlag(nn(), { value: "Promoter linked to a past default", confidence: "medium" });
    expect(r.flag).toBe("RED");
    expect(r.gatePass).toBe(false);
    expect(r.needsReview).toBe(false);
    expect(asMock(llm.bulkClassify.completeJSON)).toHaveBeenCalledTimes(1);
  });

  it("downgrades a non-negotiable RED to NEUTRAL + needs review when models disagree", async () => {
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ flag: "RED", reason: "Possible fraud link." });
    asMock(llm.bulkClassify.completeJSON).mockResolvedValueOnce({ flag: "NEUTRAL", reason: "Evidence insufficient." });
    const r = await assignFlag(nn(), { value: "ambiguous", confidence: "low" });
    expect(r.flag).toBe("NEUTRAL");
    expect(r.needsReview).toBe(true);
    expect(r.gatePass).toBeNull();
  });
});
