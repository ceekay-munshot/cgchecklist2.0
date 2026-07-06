import { describe, it, expect } from "vitest";
import {
  buildUnlistedScreenerData,
  inferCroreDivisor,
  maxAbsValue,
  type FinancialsExtract,
} from "./unlistedFinancials";
import { computeNumeric, latestRowNumber } from "./numeric";
import { companyScaleFrom } from "./materiality";

const AT = "2026-07-06T00:00:00.000Z";

describe("inferCroreDivisor — scale is inferred from magnitude, not the (lying) label", () => {
  it("treats figures ≥ ₹1cr-in-full as absolute rupees", () => {
    expect(inferCroreDivisor(9_25_330_106, "crores")).toBe(1e7); // header said 'Cr' but it's rupees
    expect(inferCroreDivisor(67_47_50_961, "unknown")).toBe(1e7);
  });
  it("uses the unit hint in the ambiguous mid-range", () => {
    expect(inferCroreDivisor(9200, "lakhs")).toBe(100); // ₹92cr shown in lakhs
    expect(inferCroreDivisor(92, "crores")).toBe(1);
  });
  it("falls back to magnitude when the unit is unknown", () => {
    expect(inferCroreDivisor(50_000, "unknown")).toBe(100); // lakhs range
    expect(inferCroreDivisor(85, "unknown")).toBe(1); // already crore
  });
});

// Vendolite India Pvt Ltd — Schedule III, values in ABSOLUTE RUPEES (header lied "in Cr's").
const VENDOLITE: FinancialsExtract = {
  found: true,
  reportingUnit: "rupees",
  periods: ["FY24-25", "FY25-26"],
  revenue: [34_15_28_009, 92_53_30_106],
  otherIncome: [2_98_538, 2_32_111],
  profitBeforeTax: [4_27_62_451, 23_81_35_399],
  profitAfterTax: [2_98_11_419, 16_87_90_371],
  depreciation: [1_06_89_248, 3_51_19_445],
  financeCost: [1_45_20_348, 4_09_32_726],
  currentTax: [1_15_66_301, 6_93_45_028],
  shareCapital: [11_59_00_000, 25_00_00_000],
  reserves: [3_28_43_933, 20_16_34_304],
  borrowings: [10_52_13_970 + 6_60_31_856, 62_24_26_587 + 12_24_83_827],
  tradeReceivables: [1_23_46_109, 3_91_21_971],
  inventory: [6_58_41_842, 10_24_06_251],
  cashFromOperations: [null, 25_03_25_474],
  totalAssets: [34_71_71_455, 1_36_45_12_942],
};

describe("buildUnlistedScreenerData — Vendolite (Schedule III, absolute ₹ → ₹cr)", () => {
  const data = buildUnlistedScreenerData(VENDOLITE, { name: "Vendolite India Pvt Ltd", capturedAt: AT })!;

  it("normalises absolute rupees to ₹ crore", () => {
    expect(latestRowNumber(data.profitLoss, /sales/i)).toBeCloseTo(92.53, 1); // ₹92.53cr revenue
    expect(latestRowNumber(data.profitLoss, /net profit/i)).toBeCloseTo(16.88, 1);
    expect(latestRowNumber(data.balanceSheet, /borrowing/i)).toBeCloseTo(74.49, 1);
  });
  it("derives net worth / revenue / PAT for materiality scaling", () => {
    const scale = companyScaleFrom(data);
    expect(scale.netWorth).toBeCloseTo(45.16, 1); // 25.00 + 20.16
    expect(scale.revenue).toBeCloseTo(92.53, 1);
    expect(scale.pat).toBeCloseTo(16.88, 1);
  });
  it("derives Operating Profit (EBITDA proxy = PBT + interest + dep)", () => {
    // 23.81 + 4.09 + 3.51 = 31.41
    expect(latestRowNumber(data.profitLoss, /operating profit/i)).toBeCloseTo(31.41, 1);
  });
  it("feeds the deterministic Tier-1 computations", () => {
    expect(computeNumeric(data, "debtToEquity")?.value).toBe("1.65"); // 74.49 / 45.16
    expect(computeNumeric(data, "cfoToPat")?.value).toBeDefined();
    expect(computeNumeric(data, "otherIncomePctPbt")?.value).toContain("%");
  });
  it("computes an effective tax rate near statutory", () => {
    const t = latestRowNumber(data.profitLoss, /tax\s*%/i);
    expect(t).toBeGreaterThan(25); // 6.93 / 23.81 ≈ 29%
    expect(t).toBeLessThan(35);
  });
});

// Nora Enterprises — old T-form, PARTNERSHIP (capital account, no reserves), absolute ₹.
const NORA: FinancialsExtract = {
  found: true,
  reportingUnit: "rupees",
  periods: ["FY24-25", "FY25-26"],
  revenue: [24_94_97_229, 59_09_81_819],
  profitBeforeTax: [2_12_23_805, 20_88_95_334],
  profitAfterTax: [1_37_95_473, 13_59_07_304],
  depreciation: [36_51_625, 2_02_88_033],
  financeCost: [1_26_28_824, 3_12_49_069],
  currentTax: [74_28_332, 7_29_88_030],
  shareCapital: [6_03_43_306, 23_59_07_304], // partners' capital account total
  reserves: [null, null], // partnership — no reserves line
  borrowings: [13_48_22_012 + 5_06_02_387, 13_89_17_869 + 2_65_00_982],
  tradeReceivables: [12_34_85_342, 18_97_26_689],
  inventory: [6_08_33_270, 9_06_07_321],
  cashFromOperations: [null, 25_03_25_474],
  totalAssets: [27_49_68_650, 67_47_50_961],
};

describe("buildUnlistedScreenerData — Nora (T-form partnership, no reserves)", () => {
  const data = buildUnlistedScreenerData(NORA, { name: "Nora Enterprises", capturedAt: AT })!;

  it("maps the partners' capital account as net worth (reserves absent)", () => {
    const scale = companyScaleFrom(data);
    expect(scale.netWorth).toBeCloseTo(23.59, 1); // capital account only
    expect(scale.revenue).toBeCloseTo(59.1, 1);
  });
  it("computes D/E from capital account + total borrowings", () => {
    // (13.89 + 2.65) / 23.59 ≈ 0.70
    expect(computeNumeric(data, "debtToEquity")?.value).toBe("0.7");
  });
  it("returns null when nothing usable was extracted", () => {
    expect(buildUnlistedScreenerData({ found: false }, { capturedAt: AT })).toBeNull();
    expect(buildUnlistedScreenerData({ found: true, periods: [] }, { capturedAt: AT })).toBeNull();
  });
});

describe("maxAbsValue — the scale signal", () => {
  it("finds the largest absolute figure across metrics", () => {
    expect(maxAbsValue(VENDOLITE)).toBe(1_36_45_12_942); // total assets
  });
});
