import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getItem,
  getItems,
  getSections,
  itemKind,
  type ItemKind,
} from "./checklist";

// itemKind is a pure function of the output format, so it is fully testable
// without the data file. These cases mirror the five acceptance samples by
// their output formats.
describe("itemKind", () => {
  it("classifies the five reference output formats", () => {
    expect(itemKind({ output_format: "Percentage (%)" })).toBe("NUMERIC"); // A1-01 (%)
    expect(itemKind({ output_format: "Percentage (%)" })).toBe("NUMERIC"); // A3 pledging (%)
    expect(itemKind({ output_format: "Text" })).toBe("QUALITATIVE"); // A13 view on the CEO
    expect(itemKind({ output_format: "Yes/No" })).toBe("QUALITATIVE"); // A2 audit committee
    expect(itemKind({ output_format: "Ratio" })).toBe("NUMERIC"); // A8 CFO-vs-PAT
  });

  it("treats currency / count / ratio / D-E as NUMERIC", () => {
    for (const fmt of ["₹ Crore", "Count", "Number", "D/E ratio", "1.2x multiple", "Percentage"]) {
      expect(itemKind({ output_format: fmt }), fmt).toBe("NUMERIC");
    }
  });

  it("treats text / categorical / yes-no / empty as QUALITATIVE", () => {
    const samples: Array<string | undefined> = [
      "Text",
      "Categorical",
      "Yes / No",
      "Narrative",
      "",
      undefined,
    ];
    for (const fmt of samples) {
      expect(itemKind({ output_format: fmt }), String(fmt)).toBe("QUALITATIVE");
    }
  });
});

// Data-backed checks. Skipped until data/checklist.json is present, then they
// assert the acceptance criteria automatically.
const checklistPresent = fs.existsSync(
  path.join(process.cwd(), "data", "checklist.json"),
);

describe.skipIf(!checklistPresent)("checklist data (requires data/checklist.json)", () => {
  it("loads 106 items across 16 sections", () => {
    expect(getSections().length).toBe(16);
    expect(getItems().length).toBe(106);
  });

  it("has unique item ids", () => {
    const ids = getItems().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies the five sample items by id", () => {
    const cases: Array<[string, ItemKind]> = [
      ["A1-01", "NUMERIC"], // Board independence — "% independent"
      ["A3-02", "NUMERIC"], // Share pledging — "%"
      ["A13-02", "QUALITATIVE"], // View on the CEO — "Text/Score"
      ["A2-01", "QUALITATIVE"], // Audit Committee quality — "Yes/No + count"
      ["A8-01", "NUMERIC"], // CFO vs PAT — "Ratio (cumulative)"
    ];
    for (const [id, expected] of cases) {
      const item = getItem(id);
      expect(item, `item ${id} should exist`).toBeDefined();
      expect(itemKind(item!), id).toBe(expected);
    }
  });
});
