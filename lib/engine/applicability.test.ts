import { describe, it, expect } from "vitest";
import { isListedOnlyItem, LISTED_ONLY_ITEMS } from "./applicability";

describe("applicability — listed-only vs universal items", () => {
  it("marks SEBI/market/stock-specific items as listed-only", () => {
    for (const id of [
      "A1-01", // board independence ratio
      "A1-06", // overboarding (listed boards)
      "A1-08", // skills matrix (SEBI chart)
      "A2-01", // audit committee
      "A3-02", // pledging (exchange disclosure)
      "A3-06", // free float / MPS
      "A6-05", // CEO-to-median ratio
      "A9-01", // SEBI actions
      "A15-01", // stock volatility
      "A15-03", // analyst coverage
    ]) {
      expect(isListedOnlyItem(id)).toBe(true);
    }
  });

  it("keeps universal governance traits answerable for private companies", () => {
    // These apply to ANY company and are answered from files / notes / web.
    for (const id of [
      "A4-05", // audit qualification (private cos have audited FS)
      "A5-01", // related-party transactions
      "A7a-01", // contingent liabilities
      "A8-01", // CFO vs PAT (from the derived financials)
      "A8-10", // effective tax rate
      "A11-01", // group structure complexity
      "A13-03", // promoter vintage (web)
      "A14-01", // leverage level
      "A3-03", // cross-holdings / pyramiding
    ]) {
      expect(isListedOnlyItem(id)).toBe(false);
    }
  });

  it("is a conservative set — only structurally-inapplicable items (≈20% of the list)", () => {
    expect(LISTED_ONLY_ITEMS.size).toBeGreaterThanOrEqual(15);
    expect(LISTED_ONLY_ITEMS.size).toBeLessThanOrEqual(30);
  });
});
