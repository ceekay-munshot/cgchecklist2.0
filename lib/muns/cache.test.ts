import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    munsAnswer: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import {
  planMunsResearch,
  munsCacheEnabled,
  cacheTtlDays,
  getCachedAnswers,
  putCachedAnswers,
  type MunsCacheEntry,
} from "./cache";
import { prisma } from "@/lib/db";

const findMany = prisma.munsAnswer.findMany as unknown as Mock;
const upsert = prisma.munsAnswer.upsert as unknown as Mock;

const OLD_ENV = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MUNS_CACHE;
  delete process.env.MUNS_CACHE_TTL_DAYS;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe("planMunsResearch (pure partition)", () => {
  it("splits targets into cache-reuse vs research-live, preserving order", () => {
    const { reuse, live } = planMunsResearch(["A1-05", "A9-04", "A13-01"], new Set(["A9-04"]));
    expect(reuse).toEqual(["A9-04"]);
    expect(live).toEqual(["A1-05", "A13-01"]);
  });
  it("all live when nothing is cached; all reuse when everything is", () => {
    expect(planMunsResearch(["x", "y"], new Set()).live).toEqual(["x", "y"]);
    expect(planMunsResearch(["x", "y"], new Set(["x", "y"])).reuse).toEqual(["x", "y"]);
  });
});

describe("cache config", () => {
  it("enabled by default; disabled by MUNS_CACHE=0/false/off", () => {
    expect(munsCacheEnabled()).toBe(true);
    for (const v of ["0", "false", "off"]) {
      process.env.MUNS_CACHE = v;
      expect(munsCacheEnabled()).toBe(false);
    }
  });
  it("TTL defaults to 90 days; honours a positive override only", () => {
    expect(cacheTtlDays()).toBe(90);
    process.env.MUNS_CACHE_TTL_DAYS = "30";
    expect(cacheTtlDays()).toBe(30);
    process.env.MUNS_CACHE_TTL_DAYS = "-5";
    expect(cacheTtlDays()).toBe(90);
  });
});

describe("getCachedAnswers", () => {
  it("returns nothing (and does not hit the DB) when disabled or given no ids", async () => {
    process.env.MUNS_CACHE = "0";
    expect((await getCachedAnswers("c1", ["A1-05"])).size).toBe(0);
    process.env.MUNS_CACHE = "1";
    expect((await getCachedAnswers("c1", [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("queries within the TTL window and maps rows, parsing sources", async () => {
    findMany.mockResolvedValueOnce([
      { itemId: "A1-05", answer: "Clean board", sources: '["https://x.com/a"]' },
      { itemId: "A9-04", answer: "No adverse record", sources: null },
    ]);
    const now = new Date("2026-07-16T00:00:00Z");
    const map = await getCachedAnswers("c1", ["A1-05", "A9-04"], now);

    expect(map.get("A1-05")).toEqual({ answer: "Clean board", sources: ["https://x.com/a"] });
    expect(map.get("A9-04")).toEqual({ answer: "No adverse record", sources: [] });

    const where = findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe("c1");
    expect(where.itemId).toEqual({ in: ["A1-05", "A9-04"] });
    // 90-day cutoff before `now`.
    const cutoff = where.updatedAt.gte as Date;
    expect(cutoff.getTime()).toBe(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  });

  it("skips prior error answers", async () => {
    findMany.mockResolvedValueOnce([
      { itemId: "A1-05", answer: "[Error] MUNS HTTP 500", sources: null },
      { itemId: "A9-04", answer: "Real answer", sources: "not-json" },
    ]);
    const map = await getCachedAnswers("c1", ["A1-05", "A9-04"]);
    expect(map.has("A1-05")).toBe(false);
    expect(map.get("A9-04")).toEqual({ answer: "Real answer", sources: [] }); // bad JSON → []
  });

  it("degrades to no-cache when the table is missing / DB throws", async () => {
    findMany.mockRejectedValueOnce(new Error("no such table: MunsAnswer"));
    const map = await getCachedAnswers("c1", ["A1-05"]);
    expect(map.size).toBe(0);
  });
});

describe("putCachedAnswers", () => {
  const entry = (over: Partial<MunsCacheEntry> = {}): MunsCacheEntry => ({
    itemId: "A1-05",
    question: "Director reputation",
    answer: "Clean board",
    sources: ["https://x.com/a"],
    fromDate: "2001-07-16",
    toDate: "2026-07-16",
    ...over,
  });

  it("upserts valid entries and returns the count written", async () => {
    upsert.mockResolvedValue({});
    const n = await putCachedAnswers("c1", [entry(), entry({ itemId: "A9-04" })]);
    expect(n).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ companyId_itemId: { companyId: "c1", itemId: "A1-05" } });
    expect(arg.create.sources).toBe('["https://x.com/a"]'); // JSON-encoded
  });

  it("skips error/empty answers", async () => {
    upsert.mockResolvedValue({});
    const n = await putCachedAnswers("c1", [entry({ answer: "[Error] boom" }), entry({ answer: "" })]);
    expect(n).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is best-effort: a failing write is swallowed, others still count", async () => {
    upsert.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({});
    const n = await putCachedAnswers("c1", [entry(), entry({ itemId: "A9-04" })]);
    expect(n).toBe(1);
  });

  it("writes nothing when disabled", async () => {
    process.env.MUNS_CACHE = "0";
    const n = await putCachedAnswers("c1", [entry()]);
    expect(n).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});
