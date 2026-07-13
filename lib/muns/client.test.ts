import { describe, it, expect } from "vitest";
import { defaultDateWindow, dateWindowForItem, isRecencyItem } from "@/lib/muns/client";

const NOW = new Date("2026-07-13T00:00:00Z");
const WIDE_FROM = "2001-07-13"; // 25y back
const SHORT_FROM = "2024-07-13"; // 2y back

describe("MUNS search date window", () => {
  it("defaultDateWindow is a trailing 2-year window ending today", () => {
    const w = defaultDateWindow(NOW);
    expect(w.toDate).toBe("2026-07-13");
    expect(w.fromDate).toBe(SHORT_FROM);
  });

  it("uses the WIDE historical window by DEFAULT — every track-record/history item", () => {
    // The client's rule: anything like the promoter track record must look back
    // far. Wide is the default, so a mixed spread of items all get the long window.
    for (const [id, sec] of [
      ["A9-04", "A9"], // promoter track record elsewhere
      ["A9-01", "A9"], // SEBI actions history
      ["A13-03", "A13"], // promoter vintage & involvement
      ["A13-07", "A13"], // promoter's other material businesses
      ["A1-05", "A1"], // director reputation
      ["A1-09", "A1"], // ID resignation pattern (history)
      ["A4-01", "A4"], // auditor identity & rotation (history)
      ["A4-04", "A4"], // auditor resignation & reasons (history)
      ["A7-02", "A7"], // restatement frequency (history)
      ["A10-02", "A10"], // swap ratios in past group mergers
      ["A5-05", "A5"], // arm's-length assertion
      ["A11-01", "A11"], // holding-structure complexity
      ["A12-01", "A12"], // employee attrition (trend matters)
    ] as const) {
      expect(isRecencyItem(id, sec)).toBe(false);
      const w = dateWindowForItem(id, sec, NOW);
      expect(w.toDate).toBe("2026-07-13"); // still ends today — never loses recent data
      expect(w.fromDate).toBe(WIDE_FROM); // 25y back, not 2y
    }
  });

  it("keeps the SHORT window only for inherently-current market-state items (A15)", () => {
    for (const [id, sec] of [
      ["A15-01", "A15"], // stock volatility
      ["A15-02", "A15"], // volume & liquidity
      ["A15-03", "A15"], // research coverage
    ] as const) {
      expect(isRecencyItem(id, sec)).toBe(true);
      expect(dateWindowForItem(id, sec, NOW).fromDate).toBe(SHORT_FROM);
    }
  });
});
