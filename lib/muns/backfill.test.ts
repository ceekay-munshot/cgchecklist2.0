import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Mock every collaborator so we can drive munsBackfill's cache-reuse wiring in
// isolation (no DB / MUNS / LLM). planMunsResearch stays REAL (the partition we
// want to exercise); only the cache's DB read/write are stubbed.
vi.mock("@/lib/db", () => ({
  prisma: {
    analysisRun: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    checklistItem: { findMany: vi.fn() },
    checklistSection: { findMany: vi.fn() },
    itemResult: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("./lanes", () => ({ runAllLanes: vi.fn() }));
vi.mock("./cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cache")>();
  return { ...actual, getCachedAnswers: vi.fn(), putCachedAnswers: vi.fn().mockResolvedValue(0) };
});
vi.mock("@/lib/engine/analyzeItem", () => ({ analyzeItem: vi.fn() }));
vi.mock("@/lib/engine/flag", () => ({ assignFlag: vi.fn() }));
vi.mock("@/lib/engine/evidence", () => ({ loadCompanyScale: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/engine/evaluateItem", () => ({ buildVerdict: vi.fn().mockReturnValue("verdict") }));
vi.mock("@/lib/orchestrate", () => ({
  summarize: vi.fn().mockReturnValue({ complete: true, itemsDone: 2, itemsError: 0, itemsTotal: 2 }),
}));

import { munsBackfill } from "./backfill";
import { prisma } from "@/lib/db";
import { runAllLanes } from "./lanes";
import { getCachedAnswers, putCachedAnswers } from "./cache";
import { analyzeItem } from "@/lib/engine/analyzeItem";
import { assignFlag } from "@/lib/engine/flag";

const m = (fn: unknown) => fn as unknown as Mock;

const CI = (id: string, sectionCode: string) => ({
  id,
  sectionCode,
  orderIndex: 0,
  item: `${id} item`,
  description: "",
  outputFormat: "Text",
  greenFlag: "Clean",
  redFlag: "Adverse",
  sourceHint: "",
  isNonNegotiable: false,
  thresholdLogic: "",
});

function laneAnswerIds(): string[] {
  // runAllLanes is called with the lane SECTIONS; collect the param ids fed to it.
  const sections = m(runAllLanes).mock.calls[0][0] as Array<{ params: Array<{ id: string }> }>;
  return sections.flatMap((s) => s.params.map((p) => p.id));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MUNS_TOKEN = "test-token";
  m(prisma.analysisRun.findUnique).mockResolvedValue({
    id: "run1",
    companyId: "c1",
    company: { id: "c1", name: "Saregama", ticker: "SAREGAMA" },
  });
  m(prisma.checklistItem.findMany).mockResolvedValue([CI("A1-05", "A1"), CI("A9-04", "A9")]);
  m(prisma.checklistSection.findMany).mockResolvedValue([
    { code: "A1", name: "Board", orderIndex: 0 },
    { code: "A9", name: "Regulatory", orderIndex: 8 },
  ]);
  // Both items are blank (no committed result) → both are targets.
  m(prisma.itemResult.findMany).mockResolvedValue([]);
  m(analyzeItem).mockResolvedValue({ value: "clean", confidence: "low", providerUsed: "groq" });
  m(assignFlag).mockResolvedValue({ flag: "GREEN", reason: "r", gatePass: null, needsReview: false, providerUsed: "groq" });
  // runAllLanes answers only whatever LIVE items it is handed.
  m(runAllLanes).mockImplementation(async (sections: Array<{ params: Array<{ id: string }> }>) => {
    const map = new Map();
    for (const s of sections) for (const p of s.params) map.set(p.id, { id: p.id, answer: `live ${p.id}`, ok: true, sources: [`u-${p.id}`] });
    return map;
  });
});

describe("munsBackfill — company research cache reuse", () => {
  it("reuses a cached item (no live MUNS call for it) yet still classifies + persists it", async () => {
    m(getCachedAnswers).mockResolvedValue(new Map([["A1-05", { answer: "cached A1-05", sources: ["u-cache"] }]]));

    const out = await munsBackfill("run1", {});

    // A1-05 came from cache → only A9-04 is researched live.
    expect(laneAnswerIds()).toEqual(["A9-04"]);
    // Both items are classified + persisted (cached one treated identically).
    expect(out.filled).toBe(2);
    expect(out.byFlag).toEqual({ GREEN: 2 });
    expect(m(prisma.itemResult.upsert)).toHaveBeenCalledTimes(2);
    // Only the freshly-fetched (live) answer is written back to the cache.
    const [companyId, entries] = m(putCachedAnswers).mock.calls[0];
    expect(companyId).toBe("c1");
    expect(entries.map((e: { itemId: string }) => e.itemId)).toEqual(["A9-04"]);
  });

  it("force bypasses the cache read entirely → every item is researched live", async () => {
    const out = await munsBackfill("run1", { force: true });

    expect(m(getCachedAnswers)).not.toHaveBeenCalled();
    expect(laneAnswerIds().sort()).toEqual(["A1-05", "A9-04"]);
    expect(out.filled).toBe(2);
  });
});
