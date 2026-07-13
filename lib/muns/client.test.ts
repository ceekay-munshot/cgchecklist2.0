import { describe, it, expect } from "vitest";
import { defaultDateWindow, dateWindowForItem, isLifetimeItem } from "@/lib/muns/client";

const NOW = new Date("2026-07-13T00:00:00Z");

describe("MUNS search date window", () => {
  it("defaultDateWindow is a trailing 2-year window ending today", () => {
    const w = defaultDateWindow(NOW);
    expect(w.toDate).toBe("2026-07-13");
    expect(w.fromDate).toBe("2024-07-13");
  });

  it("lifetime-record items (promoter/legal/reputation) get a WIDE historical lookback", () => {
    // The AFCOM miss: a 2-year window hid the promoter's pre-2024 history.
    for (const [id, sec] of [
      ["A9-04", "A9"], // promoter track record elsewhere
      ["A9-01", "A9"], // SEBI actions history
      ["A13-03", "A13"], // promoter vintage & involvement
      ["A13-07", "A13"], // promoter's other material businesses
      ["A1-05", "A1"], // director reputation
      ["A4-02", "A4"], // audit-firm calibre
    ] as const) {
      expect(isLifetimeItem(id, sec)).toBe(true);
      const w = dateWindowForItem(id, sec, NOW);
      expect(w.toDate).toBe("2026-07-13"); // still ends today — never loses recent data
      expect(w.fromDate).toBe("2001-07-13"); // 25y back, not 2y
    }
  });

  it("recent-news items keep the short window", () => {
    for (const [id, sec] of [
      ["A12-01", "A12"], // employee attrition
      ["A15-03", "A15"], // research coverage
    ] as const) {
      expect(isLifetimeItem(id, sec)).toBe(false);
      expect(dateWindowForItem(id, sec, NOW).fromDate).toBe("2024-07-13");
    }
  });
});
