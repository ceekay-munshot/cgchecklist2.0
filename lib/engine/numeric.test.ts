import { describe, it, expect } from "vitest";
import type { ScreenerStructuredData } from "@/lib/harvest/types";
import { computeNumeric, CUSTOM_NUMERIC, CUSTOM_SERIES, findSeriesRow, reconcileDebtWithTier1 } from "./numeric";

const DATA = {
  ticker: "X",
  url: "",
  ratios: {},
  pros: [],
  cons: [],
  capturedAt: "",
  profitLoss: {
    periods: ["FY23", "FY24", "TTM"],
    rows: [
      { label: "Net Profit", values: ["100", "120", "130"] },
      { label: "Operating Profit", values: ["150", "180", "190"] },
      { label: "Depreciation", values: ["10", "12", "13"] },
      { label: "Tax %", values: ["24", "25", "25"] },
    ],
  },
  cashFlow: {
    periods: ["FY23", "FY24"],
    rows: [{ label: "Cash from Operating Activity", values: ["90", "110"] }],
  },
  ratiosTable: {
    periods: ["FY23", "FY24"],
    rows: [{ label: "Debtor Days", values: ["60", "70"] }],
  },
  shareholding: {
    periods: ["Q1", "Q2"],
    rows: [{ label: "Promoters", values: ["72.00", "72.30"] }],
    promoters: ["72.00", "72.30"],
  },
  balanceSheet: {
    periods: ["FY24"],
    rows: [
      { label: "Borrowings", values: ["50"] },
      { label: "Equity Capital", values: ["10"] },
      { label: "Reserves", values: ["490"] },
    ],
  },
} as unknown as ScreenerStructuredData;

describe("computeNumeric — deterministic Tier-1 computations", () => {
  it("CFO/PAT cumulative (A8-01)", () => {
    // (90+110) / (100+120+130) = 200/350
    expect(computeNumeric(DATA, "cfoToPat")?.value).toBe("0.57");
  });
  it("CFO/EBITDA latest (A8-12)", () => {
    expect(computeNumeric(DATA, "cfoToEbitda")?.value).toBe("0.58"); // 110/190
  });
  it("effective tax rate (A8-10)", () => {
    expect(computeNumeric(DATA, "taxRate")?.value).toBe("25%");
  });
  it("debtor days proxy (A8-03)", () => {
    expect(computeNumeric(DATA, "receivableDaysProxy")?.value).toBe("70 days");
  });
  it("cash EPS / accounting EPS (A8-11)", () => {
    expect(computeNumeric(DATA, "cashEpsRatio")?.value).toBe("1.10"); // (130+13)/130
  });
  it("free float = 100 - promoter% (A3-06)", () => {
    expect(computeNumeric(DATA, "freeFloat")?.value).toBe("27.70%");
  });
  it("debt to equity from balance sheet (A14-01)", () => {
    expect(computeNumeric(DATA, "debtToEquity")?.value).toBe("0.10"); // 50/(10+490)
  });
  it("returns null when the series is genuinely absent", () => {
    const empty = { ...DATA, cashFlow: undefined, profitLoss: undefined } as unknown as ScreenerStructuredData;
    expect(computeNumeric(empty, "cfoToPat")).toBeNull();
  });
});

describe("CUSTOM_NUMERIC — classifiers for textual-band items", () => {
  it("A8-10 tax rate: near statutory green, extreme red", () => {
    expect(CUSTOM_NUMERIC["A8-10"](25).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A8-10"](8).flag).toBe("RED");
    expect(CUSTOM_NUMERIC["A8-10"](50).flag).toBe("RED");
    expect(CUSTOM_NUMERIC["A8-10"](40).flag).toBe("NEUTRAL");
  });
  it("A8-03 debtor days proxy: fast green, slow red", () => {
    expect(CUSTOM_NUMERIC["A8-03"](30).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A8-03"](70).flag).toBe("NEUTRAL");
    expect(CUSTOM_NUMERIC["A8-03"](200).flag).toBe("RED");
  });
  it("A8-11 cash-vs-accounting EPS: close green, wide red", () => {
    expect(CUSTOM_NUMERIC["A8-11"](1.1).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A8-11"](1.6).flag).toBe("NEUTRAL");
    expect(CUSTOM_NUMERIC["A8-11"](2.5).flag).toBe("RED");
  });
  it("A6-05 CEO-to-median pay: reasonable green, only extreme red", () => {
    expect(CUSTOM_NUMERIC["A6-05"](20).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A6-05"](80).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A6-05"](150).flag).toBe("NEUTRAL");
    expect(CUSTOM_NUMERIC["A6-05"](250).flag).toBe("RED");
  });
  it("A8-05 other income % of PBT: small green, large red, lenient middle", () => {
    expect(CUSTOM_NUMERIC["A8-05"](10).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A8-05"](30).flag).toBe("NEUTRAL");
    expect(CUSTOM_NUMERIC["A8-05"](50).flag).toBe("RED");
  });
  it("A1-04 independence concerns: none green, one neutral, several red", () => {
    expect(CUSTOM_NUMERIC["A1-04"](0).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A1-04"](1).flag).toBe("NEUTRAL");
    expect(CUSTOM_NUMERIC["A1-04"](3).flag).toBe("RED");
  });
  it("A1-08 skills matrix: clean green, one gap neutral, boilerplate/gaps red", () => {
    expect(CUSTOM_NUMERIC["A1-08"](0).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A1-08"](1).flag).toBe("NEUTRAL");
    expect(CUSTOM_NUMERIC["A1-08"](2).flag).toBe("RED");
  });
});

const SDATA = {
  ticker: "X", url: "", ratios: {}, pros: [], cons: [], capturedAt: "",
  profitLoss: {
    periods: ["FY23", "FY24"],
    rows: [
      { label: "Other Income", values: ["8", "12"] },
      { label: "Profit before tax", values: ["100", "120"] },
    ],
  },
  ratiosTable: {
    periods: ["FY22", "FY23", "FY24"],
    rows: [
      { label: "Working Capital Days", values: ["40", "45", "62"] },
      { label: "Dividend Payout %", values: ["30", "32", "0"] },
    ],
  },
} as unknown as ScreenerStructuredData;

describe("Screener wins — other income, series rows, trend classifiers", () => {
  it("otherIncomePctPbt (A8-05): latest OI ÷ PBT", () => {
    expect(computeNumeric(SDATA, "otherIncomePctPbt")?.value).toContain("10%"); // 12/120
  });
  it("findSeriesRow scans the period tables", () => {
    expect(findSeriesRow(SDATA, /working capital days/i)?.values).toEqual(["40", "45", "62"]);
    expect(findSeriesRow(SDATA, /dividend payout/i)?.values).toEqual(["30", "32", "0"]);
    expect(findSeriesRow(SDATA, /nonexistent row/i)).toBeNull();
  });
  it("A8-02 working-capital days trend: sharp rise red, stable green", () => {
    expect(CUSTOM_SERIES["A8-02"]({ periods: [], values: ["40", "45", "62"] }).flag).toBe("RED"); // +55%
    expect(CUSTOM_SERIES["A8-02"]({ periods: [], values: ["45", "46", "47"] }).flag).toBe("GREEN"); // ~+4%
    expect(CUSTOM_SERIES["A8-02"]({ periods: [], values: ["40", "50", "55"] }).flag).toBe("NEUTRAL"); // +37%
    expect(CUSTOM_SERIES["A8-02"]({ periods: [], values: ["60", "50", "40"] }).flag).toBe("GREEN"); // improving
  });
  it("A10-01 dividend consistency: consistent green, erratic/nil neutral (never a false red)", () => {
    expect(CUSTOM_SERIES["A10-01"]({ periods: [], values: ["30", "32", "35"] }).flag).toBe("GREEN");
    expect(CUSTOM_SERIES["A10-01"]({ periods: [], values: ["30", "32", "0"] }).flag).toBe("NEUTRAL"); // erratic
    expect(CUSTOM_SERIES["A10-01"]({ periods: [], values: ["0", "0", "0"] }).flag).toBe("NEUTRAL"); // nil
    expect(CUSTOM_SERIES["A10-01"]({ periods: [], values: [] }).flag).toBe("NEUTRAL");
    // Guarantee: this rule can never produce a RED.
    for (const vals of [["0", "0"], ["30", "0", "0"], ["10", "20", "0", "5"]]) {
      expect(CUSTOM_SERIES["A10-01"]({ periods: [], values: vals }).flag).not.toBe("RED");
    }
  });
  it("A14-02 debt level anchored on Tier-1 D/E: never red when debt-free", () => {
    // D/E 0.11 (TCS) -> GREEN, never RED — can't contradict A14-01.
    expect(CUSTOM_NUMERIC["A14-02"](0.11).flag).toBe("GREEN");
    expect(CUSTOM_NUMERIC["A14-02"](1.5).flag).toBe("NEUTRAL");
    expect(CUSTOM_NUMERIC["A14-02"](3).flag).toBe("RED");
  });
});

describe("reconcileDebtWithTier1 — numeric sanity cross-check", () => {
  it("distrusts a high-debt document figure when Tier-1 D/E says debt-free", () => {
    expect(reconcileDebtWithTier1(true, 0.11)).toBe("use_tier1");
  });
  it("trusts the document when Tier-1 agrees (or is unknown)", () => {
    expect(reconcileDebtWithTier1(true, 3)).toBe("trust_doc");
    expect(reconcileDebtWithTier1(false, 0.11)).toBe("trust_doc");
    expect(reconcileDebtWithTier1(true, null)).toBe("trust_doc");
  });
});
