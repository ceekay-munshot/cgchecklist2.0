import { describe, it, expect } from "vitest";
import type { ScreenerStructuredData } from "@/lib/harvest/types";
import {
  auditCommitteeFlag,
  auditOpinionFlag,
  CATEGORICAL_RULES,
  chairmanMdSeparationFlag,
  cheapInsiderEquityFlag,
  classifyAmount,
  companyScaleFrom,
  extractAmountCr,
  guardAmount,
  isPlausibleAmount,
  parseIndependenceRatio,
  statesNil,
  type CompanyScale,
} from "./materiality";

const SCALE: CompanyScale = { netWorth: 95_000, revenue: 240_000, pat: 49_000 };

describe("extractAmountCr", () => {
  it("reads ₹-crore amounts regardless of the currency symbol", () => {
    expect(extractAmountCr("Rs 226 crore")).toBe(226);
    expect(extractAmountCr("₹1,000 crore")).toBe(1000);
    expect(extractAmountCr("H3,566 crore")).toBe(3566); // rupee symbol captured as H
    expect(extractAmountCr("capital commitments: 1,012 crore")).toBe(1012);
  });
  it("ignores non-crore numbers and prefers crore even when other units appear", () => {
    expect(extractAmountCr("$25 million (equivalent to Rs 226 crore)")).toBe(226);
    expect(extractAmountCr("3 out of 4 members")).toBeNull();
  });
  it("returns the LARGEST amount mentioned (conservative)", () => {
    expect(extractAmountCr("Rs 26 crore in FY2026 (down from Rs 7,508 crore in FY2025)")).toBe(7508);
  });
  it("returns null when there is no crore amount", () => {
    expect(extractAmountCr("benchmarked, performance-linked")).toBeNull();
    expect(extractAmountCr(null)).toBeNull();
  });
});

describe("companyScaleFrom", () => {
  it("derives net worth (capital+reserves), revenue and PAT from the financials", () => {
    const data = {
      ratios: {},
      profitLoss: {
        periods: ["FY25", "FY26"],
        rows: [
          { label: "Sales", values: ["230000", "240000"] },
          { label: "Net Profit", values: ["46000", "49000"] },
        ],
      },
      balanceSheet: {
        periods: ["FY25", "FY26"],
        rows: [
          { label: "Equity Share Capital", values: ["360", "362"] },
          { label: "Reserves", values: ["90000", "94638"] },
        ],
      },
    } as unknown as ScreenerStructuredData;
    const scale = companyScaleFrom(data);
    expect(scale.revenue).toBe(240000);
    expect(scale.pat).toBe(49000);
    expect(scale.netWorth).toBe(362 + 94638); // 95,000
  });
});

describe("isPlausibleAmount", () => {
  it("accepts amounts within ~1.5× the largest scale metric", () => {
    expect(isPlausibleAmount(7508, SCALE)).toBe(true); // < revenue
    expect(isPlausibleAmount(226, SCALE)).toBe(true);
  });
  it("rejects an amount larger than ~1.5× revenue/net worth (likely a misread)", () => {
    expect(isPlausibleAmount(500_000, SCALE)).toBe(false);
  });
});

describe("classifyAmount — materiality bands", () => {
  it("A7a-06: ₹226cr guarantee ≈ 0.24% of net worth → GREEN", () => {
    expect(classifyAmount("A7a-06", "Corporate guarantees given: Rs 226 crore", null, SCALE)?.flag).toBe("GREEN");
  });
  it("A5-02: ₹368cr royalty ≈ 0.15% of revenue → GREEN", () => {
    expect(classifyAmount("A5-02", "Royalty of Rs 368 crore", null, SCALE)?.flag).toBe("GREEN");
  });
  it("A7a-06: ₹40,000cr ≈ 42% of net worth → RED (material)", () => {
    expect(classifyAmount("A7a-06", "Guarantees of Rs 40,000 crore", null, SCALE)?.flag).toBe("RED");
  });
  it("distrusts an implausibly large figure → NEUTRAL (never a red)", () => {
    expect(classifyAmount("A5-04", "Purchases of Rs 500,000 crore", null, SCALE)?.flag).toBe("NEUTRAL");
  });
  it("returns NEUTRAL (materiality unverified) when scale is missing", () => {
    expect(classifyAmount("A7a-06", "Rs 226 crore", null, null)?.flag).toBe("NEUTRAL");
  });
  it("returns null for an item with no materiality rule", () => {
    expect(classifyAmount("A1-01", "Rs 226 crore", null, SCALE)).toBeNull();
  });
});

describe("statesNil — a real zero, not a data gap", () => {
  it("recognises explicit nil / none / no-exposure", () => {
    expect(statesNil("No related party transactions during the year")).toBe(true);
    expect(statesNil("Nil contingent liabilities")).toBe(true);
    expect(statesNil("No promoter pledge")).toBe(true);
    expect(statesNil("₹0 crore")).toBe(true);
    expect(statesNil("Not applicable")).toBe(true);
  });
  it("does NOT treat a data gap as nil", () => {
    expect(statesNil("not available")).toBe(false);
    expect(statesNil("not disclosed in the filings")).toBe(false);
    expect(statesNil("could not determine")).toBe(false);
  });
});

describe("classifyAmount — a genuine nil is GREEN, not neutral", () => {
  it("greens an explicit nil/none finding (the client's zero-should-be-green fix)", () => {
    expect(classifyAmount("A5-01", "No related party transactions (FY2025-26)", null, SCALE)?.flag).toBe("GREEN");
    expect(classifyAmount("A7a-06", "Nil corporate guarantees given", null, SCALE)?.flag).toBe("GREEN");
    expect(classifyAmount("A5-03", "No loans or advances to group companies", null, SCALE)?.flag).toBe("GREEN");
  });
  it("still neutrals a true data gap (no nil language, no amount)", () => {
    expect(classifyAmount("A7a-06", "Amount not disclosed in the filings", null, SCALE)?.flag).toBe("NEUTRAL");
  });
});

describe("auditOpinionFlag (A4-05) — a clean report defaults to GREEN", () => {
  it("greens when audit evidence shows no modification (no explicit 'unmodified' keyword needed)", () => {
    expect(
      auditOpinionFlag("The auditor issued their report on the financial statements with no qualification.", null).flag,
    ).toBe("GREEN");
  });
});

describe("guardAmount — downgrade an immaterial RED on a trend/quality item", () => {
  it("downgrades a RED whose only figure is immaterial", () => {
    const g = guardAmount("A7a-13", "RED", "A guarantee of Rs 226 crore was added", null, SCALE);
    expect(g?.flag).toBe("NEUTRAL");
  });
  it("leaves a RED alone when the figure is material", () => {
    expect(guardAmount("A7a-13", "RED", "Additions of Rs 40,000 crore", null, SCALE)).toBeNull();
  });
  it("never touches a non-RED flag, or a non-guarded item", () => {
    expect(guardAmount("A7a-13", "GREEN", "Rs 226 crore", null, SCALE)).toBeNull();
    expect(guardAmount("A4-01", "RED", "Rs 1 crore", null, SCALE)).toBeNull();
  });
});

describe("auditCommitteeFlag (A2-01) — compliant ≠ red", () => {
  it("parses independence ratios from counts or percentages", () => {
    expect(parseIndependenceRatio("3 out of 4 members")).toBeCloseTo(0.75);
    expect(parseIndependenceRatio("independence: 75%")).toBeCloseTo(0.75);
    expect(parseIndependenceRatio("no numbers here")).toBeNull();
  });
  it("GREENs a SEBI-compliant committee (≥2/3 independent)", () => {
    expect(auditCommitteeFlag("75% (3 out of 4 members)", null).flag).toBe("GREEN");
    expect(auditCommitteeFlag("100% independent, met 6 times", null).flag).toBe("GREEN");
  });
  it("REDs a non-majority-independent committee", () => {
    expect(auditCommitteeFlag("1 of 4 independent", null).flag).toBe("RED");
  });
  it("REDs a compliant-composition committee that met < 4 times", () => {
    expect(auditCommitteeFlag("3 of 4 independent, met 3 times", null).flag).toBe("RED");
  });
  it("is NEUTRAL (not a false red) when composition can't be quantified", () => {
    expect(auditCommitteeFlag("audit committee is active and effective", null).flag).toBe("NEUTRAL");
  });
});

describe("cheapInsiderEquityFlag (A3-05) — only a real promoter discount is a red", () => {
  it("is registered as the deterministic A3-05 categorical rule", () => {
    expect(CATEGORICAL_RULES["A3-05"]).toBe(cheapInsiderEquityFlag);
  });
  it("does NOT red on a bare preference-share mention (the TCS false positive)", () => {
    // Class-B CCPS in the consolidated notes is not a discounted promoter issue.
    expect(cheapInsiderEquityFlag("Class B compulsorily convertible preference shares issued", null).flag).toBe(
      "NEUTRAL",
    );
  });
  it("REDs only when insiders/promoters got preferential or discounted equity", () => {
    expect(cheapInsiderEquityFlag("Warrants allotted to promoters at a discount", null).flag).toBe("RED");
    expect(cheapInsiderEquityFlag("Preferential allotment to a promoter group entity", null).flag).toBe("RED");
  });
  it("GREENs a clean 'none / at-market' disclosure", () => {
    expect(cheapInsiderEquityFlag("No preferential allotment or warrants to promoters", null).flag).toBe("GREEN");
  });
});

describe("auditOpinionFlag (A4-05) — boilerplate going-concern is not a qualification", () => {
  it("is registered as the deterministic A4-05 categorical rule", () => {
    expect(CATEGORICAL_RULES["A4-05"]).toBe(auditOpinionFlag);
  });
  it("does NOT red on standard auditor-responsibilities boilerplate (the TCS false positive)", () => {
    expect(auditOpinionFlag("material uncertainty regarding going concern", null).flag).not.toBe("RED");
    expect(
      auditOpinionFlag(
        "going concern",
        "we conclude on the appropriateness of the going concern basis of accounting and, if a material uncertainty exists, we are required to draw attention",
      ).flag,
    ).toBe("NEUTRAL");
  });
  it("REDs an explicitly modified opinion", () => {
    expect(auditOpinionFlag("Qualified opinion issued by the auditor", null).flag).toBe("RED");
    expect(auditOpinionFlag("Adverse opinion", null).flag).toBe("RED");
  });
  it("REDs a genuine going-concern emphasis (not boilerplate)", () => {
    expect(
      auditOpinionFlag("We draw attention to Note 5; a material uncertainty related to going concern exists", null).flag,
    ).toBe("RED");
  });
  it("GREENs a clean/unmodified opinion", () => {
    expect(auditOpinionFlag("Unmodified opinion; true and fair view", null).flag).toBe("GREEN");
  });
});

describe("chairmanMdSeparationFlag (A1-02) — split roles ≠ red", () => {
  it("is registered as the deterministic A1-02 categorical rule", () => {
    expect(CATEGORICAL_RULES["A1-02"]).toBe(chairmanMdSeparationFlag);
  });
  it("does NOT red when roles are split, even if the chairman is a promoter (TCS false positive)", () => {
    expect(chairmanMdSeparationFlag("Roles split, chairman is a promoter", null).flag).toBe("GREEN");
  });
  it("REDs genuine Chairman–MD duality", () => {
    expect(chairmanMdSeparationFlag("The same person is Chairman and Managing Director", null).flag).toBe("RED");
  });
});
