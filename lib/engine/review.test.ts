import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    analysisRun: { findUnique: vi.fn(), update: vi.fn() },
    checklistItem: { findMany: vi.fn() },
    checklistSection: { findMany: vi.fn() },
    itemResult: { findMany: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/orchestrate", () => ({
  isCommitted: (s: string) => s === "DONE",
  summarize: () => ({ itemsTotal: 25, itemsDone: 25 }),
}));
vi.mock("./llm", () => ({ callJSON: vi.fn() }));

import { prisma } from "@/lib/db";
import { callJSON } from "./llm";
import { reviewRun } from "./review";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mock = (f: unknown) => f as any;

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `A1-${String(i).padStart(2, "0")}`,
    sectionCode: "A1",
    isNonNegotiable: false,
    item: "Item",
    greenFlag: "g",
    redFlag: "r",
  }));
}
function committed(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `A1-${String(i).padStart(2, "0")}`,
    status: "DONE",
    flag: "GREEN",
    value: "ok",
    verdict: "fine",
    providerUsed: "groq",
  }));
}

beforeEach(() => vi.clearAllMocks());

describe("reviewRun (QA self-audit)", () => {
  it("applies a clear flag correction and re-summarises", async () => {
    mock(prisma.analysisRun.findUnique).mockResolvedValue({ id: "run1" });
    mock(prisma.checklistItem.findMany).mockResolvedValue(items(25));
    mock(prisma.checklistSection.findMany).mockResolvedValue([{ code: "A1", name: "Board" }]);
    const results = committed(25);
    // A false RED whose finding reads benign — the classic mis-mapped-number bug.
    results[0] = { itemId: "A1-00", status: "DONE", flag: "RED", value: "D/E 4417", verdict: "strong position", providerUsed: "groq" };
    mock(prisma.itemResult.findMany)
      .mockResolvedValueOnce(results)
      .mockResolvedValueOnce(results.map((r) => ({ itemId: r.itemId, status: "DONE", flag: "GREEN" })));
    mock(prisma.itemResult.update).mockResolvedValue({});
    mock(prisma.analysisRun.update).mockResolvedValue({});
    mock(callJSON).mockResolvedValue({
      data: { findings: [{ id: "A1-00", issue: "D/E 4417 impossible", corrected_flag: "GREEN", corrected_note: "conservative leverage" }] },
      provider: "gemini",
    });

    const qa = await reviewRun("run1");

    expect(qa.corrections).toHaveLength(1);
    expect(qa.corrections[0]).toMatchObject({ id: "A1-00", from: "RED", to: "GREEN" });
    expect(prisma.itemResult.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ flag: "GREEN" }) }),
    );
    expect(prisma.analysisRun.update).toHaveBeenCalled(); // re-summarised
  });

  it("ignores a KEEP / same-flag finding (no write)", async () => {
    mock(prisma.analysisRun.findUnique).mockResolvedValue({ id: "run1" });
    mock(prisma.checklistItem.findMany).mockResolvedValue(items(25));
    mock(prisma.checklistSection.findMany).mockResolvedValue([{ code: "A1", name: "Board" }]);
    mock(prisma.itemResult.findMany).mockResolvedValue(committed(25));
    mock(callJSON).mockResolvedValue({
      data: { findings: [{ id: "A1-00", issue: "fine", corrected_flag: "KEEP", corrected_note: "ok" }] },
      provider: "gemini",
    });

    const qa = await reviewRun("run1");

    expect(qa.corrections).toHaveLength(0);
    expect(prisma.itemResult.update).not.toHaveBeenCalled();
  });

  it("skips the LLM entirely when there are too few committed items", async () => {
    mock(prisma.analysisRun.findUnique).mockResolvedValue({ id: "run1" });
    mock(prisma.checklistItem.findMany).mockResolvedValue(items(5));
    mock(prisma.checklistSection.findMany).mockResolvedValue([{ code: "A1", name: "Board" }]);
    mock(prisma.itemResult.findMany).mockResolvedValue(committed(5));

    const qa = await reviewRun("run1");

    expect(qa.skipped).toBeTruthy();
    expect(callJSON).not.toHaveBeenCalled();
  });
});
