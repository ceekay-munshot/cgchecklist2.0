import { describe, it, expect } from "vitest";
import { serializeTable, parseTable, type DataTable } from "./types";

describe("DataTable serialize/parse (rides in the evidenceQuote text column)", () => {
  const table: DataTable = {
    columns: ["Director", "Other boards", "Status"],
    rows: [
      ["A. Sharma", "9", "Overboarded"],
      ["B. Rao", "3", "OK"],
    ],
  };

  it("round-trips a table", () => {
    const s = serializeTable(table);
    expect(parseTable(s)).toEqual(table);
  });

  it("leaves a normal quote untouched (returns null)", () => {
    expect(parseTable("The board comprises 8 directors.")).toBeNull();
    expect(parseTable(null)).toBeNull();
    expect(parseTable("")).toBeNull();
  });

  it("does not misfire on text that merely starts with letters", () => {
    expect(parseTable("TBLisnotmarkerplusjson")).toBeNull();
  });
});
