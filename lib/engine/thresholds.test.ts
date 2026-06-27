import { describe, it, expect } from "vitest";
import { classifyNumeric, parseBand, parseNumericValue, valueInBand } from "./thresholds";

describe("parseNumericValue", () => {
  it("extracts the first number from a value string", () => {
    expect(parseNumericValue("0.09")).toBe(0.09);
    expect(parseNumericValue("33%")).toBe(33);
    expect(parseNumericValue("1.2x")).toBe(1.2);
    expect(parseNumericValue("72.36% (stable)")).toBe(72.36);
    expect(parseNumericValue("1,234")).toBe(1234);
    expect(parseNumericValue("not available")).toBeNull();
    expect(parseNumericValue(null)).toBeNull();
  });
});

describe("parseBand", () => {
  it("parses a range under '<' as an inclusive upper bound", () => {
    const b = parseBand("<0.5–1.0");
    expect(b.thresholds).toEqual([{ op: "lte", value: 1.0 }]);
    expect(b.unit).toBe("number"); // the band text alone carries no %/ratio marker
  });
  it("parses '>' bands and ignores trailing prose", () => {
    expect(parseBand(">2 / rising").thresholds).toEqual([{ op: "gt", value: 2 }]);
  });
  it("ignores bare numbers, keeping the operator-led threshold", () => {
    expect(parseBand("0% (or <10%)").thresholds).toEqual([{ op: "lt", value: 10 }]);
  });
  it("normalises ≥ and ignores the non-operator board-size range", () => {
    const b = parseBand("≥50% independent; board 8–12");
    expect(b.thresholds).toEqual([{ op: "gte", value: 50 }]);
    expect(b.unit).toBe("percent");
  });
  it("returns no thresholds for empty / prose-only bands", () => {
    expect(parseBand("").thresholds).toEqual([]);
    expect(parseBand("Clean, well-regarded").thresholds).toEqual([]);
    expect(valueInBand(parseBand(""), 5)).toBe(false);
  });
});

// The real green/red bands from the seeded checklist items the engine validates.
describe("classifyNumeric on real checklist bands", () => {
  const cases = [
    // A14-01 Leverage: green "<0.5–1.0", red ">2 / rising"
    { g: "<0.5–1.0", r: ">2 / rising", v: 0.09, want: "GREEN" },
    { g: "<0.5–1.0", r: ">2 / rising", v: 1.5, want: "NEUTRAL" },
    { g: "<0.5–1.0", r: ">2 / rising", v: 2.5, want: "RED" },
    // A3-02 Share pledging: green "0% (or <10%)", red ">25% or rising"
    { g: "0% (or <10%)", r: ">25% or rising", v: 0, want: "GREEN" },
    { g: "0% (or <10%)", r: ">25% or rising", v: 15, want: "NEUTRAL" },
    { g: "0% (or <10%)", r: ">25% or rising", v: 30, want: "RED" },
    // A3-01 Promoter holding: green "Stable/rising, >50%", red "… <26%"
    { g: "Stable/rising, >50%", r: "Steady decline / sharp drops / <26%", v: 72, want: "GREEN" },
    { g: "Stable/rising, >50%", r: "Steady decline / sharp drops / <26%", v: 40, want: "NEUTRAL" },
    { g: "Stable/rising, >50%", r: "Steady decline / sharp drops / <26%", v: 20, want: "RED" },
    // A1-01 Board independence: green "≥50%…", red "<50%…"
    { g: "≥50% independent; board 8–12", r: "<50% / only meets bare minimum", v: 55, want: "GREEN" },
    { g: "≥50% independent; board 8–12", r: "<50% / only meets bare minimum", v: 50, want: "GREEN" },
    { g: "≥50% independent; board 8–12", r: "<50% / only meets bare minimum", v: 45, want: "RED" },
  ] as const;

  for (const c of cases) {
    it(`${c.v} vs green "${c.g}" / red "${c.r}" -> ${c.want}`, () => {
      expect(classifyNumeric(c.v, c.g, c.r).flag).toBe(c.want);
    });
  }
});
