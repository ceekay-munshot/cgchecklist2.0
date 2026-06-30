import { describe, it, expect } from "vitest";
import { isStale, daysSince, computeProgress, STALE_AFTER_DAYS, CHECKLIST_TOTAL } from "@/lib/analyze/progress";

const NOW = new Date("2026-06-30T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("isStale", () => {
  it("treats a missing/invalid date as stale", () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(undefined, NOW)).toBe(true);
    expect(isStale("not-a-date", NOW)).toBe(true);
  });

  it("fresh just inside the window, stale just outside", () => {
    expect(isStale(daysAgo(STALE_AFTER_DAYS - 1), NOW)).toBe(false);
    expect(isStale(daysAgo(STALE_AFTER_DAYS + 1), NOW)).toBe(true);
  });

  it("accepts ISO strings and Date objects alike", () => {
    expect(isStale(daysAgo(10).toISOString(), NOW)).toBe(false);
    expect(isStale(daysAgo(120).toISOString(), NOW)).toBe(true);
  });
});

describe("daysSince", () => {
  it("counts whole days, floors to 0 for missing", () => {
    expect(daysSince(daysAgo(3), NOW)).toBe(3);
    expect(daysSince(null, NOW)).toBe(0);
  });
});

describe("computeProgress", () => {
  it("ramps harvest → processing → done monotonically", () => {
    const q = computeProgress("QUEUED", 0, 106);
    const h = computeProgress("HARVESTING", 0, 106);
    const mid = computeProgress("PROCESSING", 53, 106);
    const d = computeProgress("DONE", 106, 106);
    expect(q.percent).toBeLessThan(h.percent);
    expect(h.percent).toBeLessThan(mid.percent);
    expect(mid.percent).toBeLessThan(d.percent);
    expect(d.percent).toBe(100);
  });

  it("processing stays within 15..99 and never falsely completes", () => {
    const almost = computeProgress("PROCESSING", 106, 106);
    expect(almost.percent).toBeLessThanOrEqual(99);
    expect(almost.ready).toBe(false);
    const start = computeProgress("PROCESSING", 0, 106);
    expect(start.percent).toBeGreaterThanOrEqual(15);
  });

  it("falls back to the full checklist when total is unknown", () => {
    const p = computeProgress("PROCESSING", CHECKLIST_TOTAL / 2, 0);
    expect(p.percent).toBeGreaterThan(15);
    expect(p.percent).toBeLessThan(99);
  });

  it("DONE is ready+done; PARTIAL is viewable only with committed items", () => {
    expect(computeProgress("DONE", 106, 106)).toMatchObject({ ready: true, done: true });
    expect(computeProgress("PARTIAL", 0, 106).ready).toBe(false);
    expect(computeProgress("PARTIAL", 40, 106)).toMatchObject({ ready: true, done: true });
    expect(computeProgress("ERROR", 0, 106)).toMatchObject({ ready: false, done: true });
  });
});
