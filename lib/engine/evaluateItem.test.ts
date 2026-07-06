import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { itemResult: { upsert: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("./evidence", () => ({
  getEvidence: vi.fn(),
  evidenceStrategyFor: vi.fn().mockReturnValue({}),
  loadCompanyScale: vi.fn().mockResolvedValue(null),
  isUnlistedRun: vi.fn(),
}));
vi.mock("./analyzeItem", () => ({ analyzeItem: vi.fn() }));
vi.mock("./flag", () => ({ assignFlag: vi.fn() }));

import { evaluateItem, buildVerdict } from "./evaluateItem";
import { getEvidence, isUnlistedRun } from "./evidence";
import { analyzeItem } from "./analyzeItem";
import { assignFlag } from "./flag";
import type { Analysis, EngineItem, FlagResult } from "./types";

const asMock = (fn: unknown) => fn as unknown as Mock;

const item = (id: string): EngineItem => ({
  id,
  sectionCode: id.split("-")[0],
  item: `Item ${id}`,
  description: null,
  outputFormat: "Text",
  greenFlag: null,
  redFlag: null,
  sourceHint: null,
  isNonNegotiable: false,
});

beforeEach(() => vi.clearAllMocks());

describe("evaluateItem — unlisted applicability gate", () => {
  it("short-circuits a LISTED-ONLY item on an unlisted run to an explicit N/A (no evidence/LLM)", async () => {
    asMock(isUnlistedRun).mockResolvedValue(true);

    const r = await evaluateItem(item("A15-03"), "run1"); // analyst coverage — listed-only

    expect(r.flag).toBe("NOT_AVAILABLE");
    expect(r.status).toBe("DONE");
    expect(r.verdict).toMatch(/not applicable/i);
    // The expensive path is skipped entirely.
    expect(asMock(getEvidence)).not.toHaveBeenCalled();
    expect(asMock(analyzeItem)).not.toHaveBeenCalled();
    expect(asMock(assignFlag)).not.toHaveBeenCalled();
  });

  it("still evaluates a UNIVERSAL item on an unlisted run (private cos have this data)", async () => {
    asMock(isUnlistedRun).mockResolvedValue(true);
    asMock(getEvidence).mockResolvedValue({ status: "found", from: "screener", kind: "NUMERIC" });
    asMock(analyzeItem).mockResolvedValue({ value: "0.70", confidence: "high" });
    asMock(assignFlag).mockResolvedValue({ flag: "GREEN", reason: "Modest leverage", gatePass: null });

    const r = await evaluateItem(item("A14-01"), "run1"); // leverage — universal

    expect(asMock(getEvidence)).toHaveBeenCalledTimes(1);
    expect(r.flag).toBe("GREEN");
  });

  it("does NOT gate a listed-only item on a LISTED run (the gate is unlisted-only)", async () => {
    asMock(isUnlistedRun).mockResolvedValue(false);
    asMock(getEvidence).mockResolvedValue({ status: "found", from: "document", kind: "QUALITATIVE" });
    asMock(analyzeItem).mockResolvedValue({ value: "covered", confidence: "medium" });
    asMock(assignFlag).mockResolvedValue({ flag: "GREEN", reason: "ok", gatePass: null });

    await evaluateItem(item("A15-03"), "run1");

    expect(asMock(getEvidence)).toHaveBeenCalledTimes(1); // normal evaluation
  });
});

describe("buildVerdict — amount-distrust override", () => {
  const it2 = item("A5-04");
  it("leads with the clean deterministic reason, not the LLM's misread figure", () => {
    const analysis = {
      value: "₹2,049.55 crore promoter-vendor transactions",
      rationale: "In FY2025-26, sales to Vendolite amounted to ₹2,049.55 crore, a significant related-party exposure.",
      confidence: "medium",
    } as Analysis;
    const flagRes = {
      flag: "NEUTRAL",
      reason: "₹2,050cr is implausibly large vs revenue — extraction distrusted (likely a misread); not flagged.",
    } as FlagResult;
    const v = buildVerdict(it2, analysis, flagRes);
    expect(v).toMatch(/implausibly large/);
    expect(v).not.toMatch(/2,049\.55 crore/); // the bogus figure is suppressed
  });
});
