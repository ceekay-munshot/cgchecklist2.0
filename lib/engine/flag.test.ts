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

  it("maps a 'not available' value to NOT_AVAILABLE", async () => {
    const r = await assignFlag(item({ id: "A4-01", outputFormat: "Yes/No" }), { value: "not available", confidence: "low" });
    expect(r.flag).toBe("NOT_AVAILABLE");
    expect(asMock(llm.reasoning.completeJSON)).not.toHaveBeenCalled();
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
