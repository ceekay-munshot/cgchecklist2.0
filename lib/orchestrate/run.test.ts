import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    analysisRun: { findUnique: vi.fn(), update: vi.fn() },
    checklistItem: { findMany: vi.fn() },
    checklistSection: { findMany: vi.fn() },
    itemResult: { findMany: vi.fn(), upsert: vi.fn() },
    sourceDoc: { updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/engine/evaluateItem", () => ({ evaluateItem: vi.fn() }));

import { runAnalysis, summarize } from "./run";
import { prisma } from "@/lib/db";
import { evaluateItem } from "@/lib/engine/evaluateItem";
import { QuotaExhaustedError } from "@/lib/engine/quota";

const asMock = (fn: unknown) => fn as unknown as Mock;

function mkItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `A1-${String(i + 1).padStart(2, "0")}`,
    sectionCode: "A1",
    orderIndex: i,
    item: `Item ${i + 1}`,
    description: null,
    outputFormat: "Yes/No",
    greenFlag: null,
    redFlag: null,
    sourceHint: null,
    isNonNegotiable: false,
  }));
}
const SECTIONS = [{ code: "A1", name: "Board", orderIndex: 0 }];

beforeEach(() => {
  vi.clearAllMocks();
  asMock(prisma.analysisRun.findUnique).mockResolvedValue({ id: "run1" });
  asMock(prisma.analysisRun.update).mockResolvedValue({});
  asMock(prisma.checklistSection.findMany).mockResolvedValue(SECTIONS);
  asMock(prisma.itemResult.upsert).mockResolvedValue({});
  asMock(prisma.sourceDoc.updateMany).mockResolvedValue({ count: 3 });
});

describe("runAnalysis — resumable", () => {
  it("skips DONE items and only evaluates the rest", async () => {
    asMock(prisma.checklistItem.findMany).mockResolvedValue(mkItems(4));
    asMock(prisma.itemResult.findMany)
      .mockResolvedValueOnce([
        { itemId: "A1-01", status: "DONE" },
        { itemId: "A1-02", status: "DONE" },
      ])
      .mockResolvedValueOnce([
        { itemId: "A1-01", status: "DONE", flag: "GREEN" },
        { itemId: "A1-02", status: "DONE", flag: "GREEN" },
        { itemId: "A1-03", status: "DONE", flag: "GREEN" },
        { itemId: "A1-04", status: "DONE", flag: "RED" },
      ]);
    asMock(evaluateItem).mockResolvedValue({});

    const out = await runAnalysis("run1");

    expect(asMock(evaluateItem)).toHaveBeenCalledTimes(2); // only the 2 not-DONE
    expect(out.status).toBe("DONE");
  });
});

describe("runAnalysis — completion + prune", () => {
  it("marks DONE, stores summary + gate, and prunes heavy text", async () => {
    asMock(prisma.checklistItem.findMany).mockResolvedValue(mkItems(2));
    asMock(prisma.itemResult.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { itemId: "A1-01", status: "DONE", flag: "GREEN" },
        { itemId: "A1-02", status: "DONE", flag: "RED" },
      ]);
    asMock(evaluateItem).mockResolvedValue({});

    const out = await runAnalysis("run1");

    expect(out.status).toBe("DONE");
    expect(out.pruned).toBe(true);
    expect(asMock(prisma.sourceDoc.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { extractedText: null } }),
    );
    const lastUpdate = asMock(prisma.analysisRun.update).mock.calls.at(-1)![0];
    expect(lastUpdate.data.status).toBe("DONE");
    expect(lastUpdate.data.summaryJson.totals.red).toBe(1);
  });
});

describe("runAnalysis — quota exhaustion", () => {
  it("defers items, sets PARTIAL, and does NOT prune", async () => {
    asMock(prisma.checklistItem.findMany).mockResolvedValue(mkItems(3));
    asMock(prisma.itemResult.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { itemId: "A1-01", status: "DEFERRED", flag: null },
        { itemId: "A1-02", status: "DEFERRED", flag: null },
        { itemId: "A1-03", status: "DEFERRED", flag: null },
      ]);
    asMock(evaluateItem).mockRejectedValue(new QuotaExhaustedError("all exhausted"));

    const out = await runAnalysis("run1");

    expect(out.status).toBe("PARTIAL");
    expect(out.deferred).toBe(3);
    expect(out.pruned).toBe(false);
    expect(asMock(prisma.itemResult.upsert)).toHaveBeenCalledTimes(3); // DEFERRED markers
    expect(asMock(prisma.sourceDoc.updateMany)).not.toHaveBeenCalled();
  });
});

describe("summarize + non-negotiable gate", () => {
  it("rolls up section counts, total reds, and fails the gate on a non-negotiable RED", () => {
    const items = [
      { id: "A1-01", sectionCode: "A1", isNonNegotiable: false },
      { id: "A1-02", sectionCode: "A1", isNonNegotiable: true },
      { id: "A2-01", sectionCode: "A2", isNonNegotiable: false },
    ];
    const sections = [
      { code: "A1", name: "Board" },
      { code: "A2", name: "Committees" },
    ];
    const results = [
      { itemId: "A1-01", status: "DONE", flag: "GREEN" },
      { itemId: "A1-02", status: "DONE", flag: "RED" },
      { itemId: "A2-01", status: "DONE", flag: "NEUTRAL" },
    ];
    const s = summarize(items, sections, results);
    expect(s.complete).toBe(true);
    expect(s.totalReds).toBe(1);
    expect(s.nonNegotiable.gatePass).toBe(false);
    expect(s.nonNegotiable.failedItems).toEqual(["A1-02"]);
    expect(s.bySection.find((x) => x.code === "A1")).toMatchObject({ green: 1, red: 1, total: 2 });
  });

  it("is incomplete while items are pending / deferred", () => {
    const items = [{ id: "A1-01", sectionCode: "A1", isNonNegotiable: false }];
    const results = [{ itemId: "A1-01", status: "DEFERRED", flag: null }];
    const s = summarize(items, [{ code: "A1", name: "Board" }], results);
    expect(s.complete).toBe(false);
    expect(s.itemsDeferred).toBe(1);
    expect(s.nonNegotiable.gatePass).toBe(true); // no reds → gate passes (vacuously)
  });
});
