import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

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

import { runAnalysis, summarize, isCommitted } from "./run";
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
  // A listed-style run (has a ticker) → the unlisted Tier-1 pre-step is a no-op.
  asMock(prisma.analysisRun.findUnique).mockResolvedValue({
    id: "run1",
    company: { ticker: "TCS", name: "TCS" },
  });
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

  it("--force re-evaluates ALL items, including DONE ones", async () => {
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
        { itemId: "A1-04", status: "DONE", flag: "GREEN" },
      ]);
    asMock(evaluateItem).mockResolvedValue({});

    const out = await runAnalysis("run1", { force: true });

    expect(asMock(evaluateItem)).toHaveBeenCalledTimes(4); // ALL, despite 2 already DONE
    expect(out.status).toBe("DONE");
  });
});

describe("runAnalysis — targeted scope (per-item / per-section re-run)", () => {
  // Two sections so a section scope is distinguishable from an item scope.
  function mkMixed() {
    return [
      { ...mkItems(1)[0], id: "A1-01", sectionCode: "A1", orderIndex: 0 },
      { ...mkItems(1)[0], id: "A1-02", sectionCode: "A1", orderIndex: 1 },
      { ...mkItems(1)[0], id: "A2-01", sectionCode: "A2", orderIndex: 0 },
    ];
  }
  const allDone = [
    { itemId: "A1-01", status: "DONE", flag: "GREEN" },
    { itemId: "A1-02", status: "DONE", flag: "GREEN" },
    { itemId: "A2-01", status: "DONE", flag: "GREEN" },
  ];

  it("scope.itemIds re-evaluates ONLY that item — even though it is already DONE", async () => {
    asMock(prisma.checklistItem.findMany).mockResolvedValue(mkMixed());
    asMock(prisma.itemResult.findMany)
      .mockResolvedValueOnce(allDone.map((r) => ({ itemId: r.itemId, status: r.status })))
      .mockResolvedValueOnce(allDone);
    asMock(evaluateItem).mockResolvedValue({});

    await runAnalysis("run1", { scope: { itemIds: ["A1-02"] } });

    // A scoped pass ignores prior DONE for the targeted item, and touches no other.
    expect(asMock(evaluateItem)).toHaveBeenCalledTimes(1);
    expect(asMock(evaluateItem).mock.calls[0][0].id).toBe("A1-02");
  });

  it("scope.sectionCodes re-evaluates every item in that section only", async () => {
    asMock(prisma.checklistItem.findMany).mockResolvedValue(mkMixed());
    asMock(prisma.itemResult.findMany)
      .mockResolvedValueOnce(allDone.map((r) => ({ itemId: r.itemId, status: r.status })))
      .mockResolvedValueOnce(allDone);
    asMock(evaluateItem).mockResolvedValue({});

    await runAnalysis("run1", { scope: { sectionCodes: ["A1"] } });

    // Both A1 items, not the A2 one.
    expect(asMock(evaluateItem)).toHaveBeenCalledTimes(2);
    const ids = asMock(evaluateItem).mock.calls.map((c) => c[0].id).sort();
    expect(ids).toEqual(["A1-01", "A1-02"]);
  });

  it("a blank scope degrades to a normal run (empty tokens dropped, not a crash)", async () => {
    asMock(prisma.checklistItem.findMany).mockResolvedValue(mkMixed());
    asMock(prisma.itemResult.findMany)
      .mockResolvedValueOnce(allDone.map((r) => ({ itemId: r.itemId, status: r.status })))
      .mockResolvedValueOnce(allDone);
    asMock(evaluateItem).mockResolvedValue({});

    // All whitespace/empty → no real target → falls back to the default resumable
    // run (which, with every item already DONE, evaluates nothing). The point is
    // it must not throw or wrongly force a full re-eval.
    const out = await runAnalysis("run1", { scope: { itemIds: ["  "], sectionCodes: [""] } });

    expect(asMock(evaluateItem)).not.toHaveBeenCalled();
    expect(out.status).toBe("DONE");
  });
});

describe("runAnalysis — completion + prune", () => {
  const prevPrune = process.env.PRUNE_TEXT;
  afterEach(() => {
    if (prevPrune === undefined) delete process.env.PRUNE_TEXT;
    else process.env.PRUNE_TEXT = prevPrune;
  });

  it("marks DONE, stores summary + gate, and KEEPS text by default (no prune)", async () => {
    delete process.env.PRUNE_TEXT;
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
    // Text is KEPT so a later --force re-eval can re-read it (iterate offline).
    expect(out.pruned).toBe(false);
    expect(asMock(prisma.sourceDoc.updateMany)).not.toHaveBeenCalled();
    const lastUpdate = asMock(prisma.analysisRun.update).mock.calls.at(-1)![0];
    expect(lastUpdate.data.status).toBe("DONE");
    expect(lastUpdate.data.summaryJson.totals.red).toBe(1);
  });

  it("prunes heavy text only when PRUNE_TEXT=true (opt-in storage thrift)", async () => {
    process.env.PRUNE_TEXT = "true";
    asMock(prisma.checklistItem.findMany).mockResolvedValue(mkItems(2));
    asMock(prisma.itemResult.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { itemId: "A1-01", status: "DONE", flag: "GREEN" },
        { itemId: "A1-02", status: "DONE", flag: "GREEN" },
      ]);
    asMock(evaluateItem).mockResolvedValue({});

    const out = await runAnalysis("run1");

    expect(out.status).toBe("DONE");
    expect(out.pruned).toBe(true);
    expect(asMock(prisma.sourceDoc.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { extractedText: null } }),
    );
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

  it("REPORTING HONESTY: a STALE flag on a non-terminal item is NOT counted (buckets or gate)", () => {
    const items = [
      { id: "A1-01", sectionCode: "A1", isNonNegotiable: false }, // fresh DONE GREEN
      { id: "A1-02", sectionCode: "A1", isNonNegotiable: true }, // DEFERRED but carries a stale RED
      { id: "A1-03", sectionCode: "A1", isNonNegotiable: false }, // DEFERRED but carries a stale GREEN
    ];
    const sections = [{ code: "A1", name: "Board" }];
    const results = [
      { itemId: "A1-01", status: "DONE", flag: "GREEN" },
      { itemId: "A1-02", status: "DEFERRED", flag: "RED" }, // left over from a prior pass
      { itemId: "A1-03", status: "DEFERRED", flag: "GREEN" }, // left over from a prior pass
    ];
    const s = summarize(items, sections, results);
    // Only the one DONE item contributes its flag.
    expect(s.totals.green).toBe(1);
    expect(s.totals.red).toBe(0);
    expect(s.totalReds).toBe(0);
    // The stale RED on a non-negotiable item must NOT fail the gate.
    expect(s.nonNegotiable.gatePass).toBe(true);
    expect(s.nonNegotiable.failedItems).toEqual([]);
    // Status counts still reflect reality: 1 done, 2 deferred, run incomplete.
    expect(s.itemsDone).toBe(1);
    expect(s.itemsDeferred).toBe(2);
    expect(s.complete).toBe(false);
  });
});

describe("isCommitted — shared staleness predicate", () => {
  it("is true only for terminal statuses (DONE / NEEDS_REVIEW)", () => {
    expect(isCommitted("DONE")).toBe(true);
    expect(isCommitted("NEEDS_REVIEW")).toBe(true);
  });
  it("is false for non-terminal or missing statuses (so leftover flags stay stale)", () => {
    expect(isCommitted("DEFERRED")).toBe(false);
    expect(isCommitted("ERROR")).toBe(false);
    expect(isCommitted("PENDING")).toBe(false);
    expect(isCommitted("PROCESSING")).toBe(false);
    expect(isCommitted(null)).toBe(false);
    expect(isCommitted(undefined)).toBe(false);
  });
});
