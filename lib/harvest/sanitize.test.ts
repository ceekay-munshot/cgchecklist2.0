import { describe, it, expect } from "vitest";
import { stripNul, stripNulDeep } from "./sanitize";

const NUL = "\u0000";

describe("stripNul", () => {
  it("removes NUL bytes from a string", () => {
    expect(stripNul(`a${NUL}b${NUL}`)).toBe("ab");
    expect(stripNul("clean")).toBe("clean");
  });
});

describe("stripNulDeep", () => {
  it("strips NUL from nested string values, keeping structure", () => {
    const input = { a: `x${NUL}y`, b: [`p${NUL}q`, 1, null, true], c: { d: `m${NUL}` } };
    expect(stripNulDeep(input)).toEqual({
      a: "xy",
      b: ["pq", 1, null, true],
      c: { d: "m" },
    });
  });

  it("yields JSON with no NUL bytes (Postgres-safe)", () => {
    const cleaned = stripNulDeep({ note: `bad${NUL}value`, list: [`${NUL}x`] });
    expect(JSON.stringify(cleaned).includes(NUL)).toBe(false);
  });

  it("passes non-strings through unchanged", () => {
    expect(stripNulDeep([1, false, null])).toEqual([1, false, null]);
  });
});
