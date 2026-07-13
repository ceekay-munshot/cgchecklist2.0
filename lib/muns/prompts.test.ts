import { describe, it, expect } from "vitest";
import { MEGA_PROMPT, SUFFIX, letterFor, formatQuestion, parseAnswer, extractSourceUrls } from "@/lib/muns/prompts";
import { binPackSections, type LaneSection } from "@/lib/muns/lanes";

describe("prompts", () => {
  it("mega prompt ends with the suffix", () => {
    expect(MEGA_PROMPT.endsWith(SUFFIX)).toBe(true);
    expect(SUFFIX.startsWith(" ")).toBe(true); // literal leading space
  });

  it("letters go a..z then aa, ab", () => {
    expect(letterFor(0)).toBe("a");
    expect(letterFor(25)).toBe("z");
    expect(letterFor(26)).toBe("aa");
    expect(letterFor(27)).toBe("ab");
  });

  it("formats the first item with the section header (literal tabs/newlines)", () => {
    const msg = formatQuestion({ sectionNumber: 9, sectionTitle: "Regulatory, Legal & Integrity", indexInSection: 0, text: "SEBI actions/consent orders" });
    expect(msg).toBe("9\tRegulatory, Legal & Integrity\n\n\ta)SEBI actions/consent orders" + SUFFIX);
  });

  it("formats later items with the compact tabbed form", () => {
    const msg = formatQuestion({ sectionNumber: 9, sectionTitle: "X", indexInSection: 1, text: "Litigation" });
    expect(msg).toBe("\tb)\tLitigation" + SUFFIX);
  });
});

describe("parseAnswer", () => {
  it("joins <ans> blocks, strips doc_source + tags, unescapes entities", () => {
    const body = "<task><tool>noise</tool><ans>Revenue &amp; profit up<doc_source>AR p.12</doc_source></ans><ans>CEO is <b>K. Krithivasan</b></ans></task>";
    expect(parseAnswer(body)).toBe("Revenue & profit up\n\nCEO is K. Krithivasan");
  });

  it("falls back to JSON fields when no <ans>", () => {
    expect(parseAnswer(JSON.stringify({ response: "hello" }))).toBe("hello");
  });

  it("falls back to SSE data frames", () => {
    const body = 'data: {"content":"foo "}\ndata: {"content":"bar"}\ndata: [DONE]';
    expect(parseAnswer(body)).toBe("foo bar");
  });

  it("returns empty string when nothing parseable", () => {
    expect(parseAnswer("<task>only tools</task>")).toBe("");
  });
});

describe("extractSourceUrls — harvest citations before cleanup() drops them", () => {
  it("pulls http(s) URLs from doc_source tags and inline text, de-duped", () => {
    const body =
      "<ans>Promoter's prior firm wound up amid defaults" +
      "<doc_source>https://www.valuepickr.com/t/afcom/123</doc_source></ans>" +
      "<ans>See also https://www.moneycontrol.com/news/afcom and https://www.valuepickr.com/t/afcom/123.</ans>";
    expect(extractSourceUrls(body)).toEqual([
      "https://www.valuepickr.com/t/afcom/123",
      "https://www.moneycontrol.com/news/afcom",
    ]);
  });

  it("trims trailing sentence punctuation from a URL", () => {
    expect(extractSourceUrls("source: https://example.com/a/b).")).toEqual(["https://example.com/a/b"]);
  });

  it("returns [] for a filing-style doc_source with no URL (no regression)", () => {
    expect(extractSourceUrls("<ans>Clean<doc_source>Annual Report p.12</doc_source></ans>")).toEqual([]);
    expect(extractSourceUrls("")).toEqual([]);
  });
});

describe("binPackSections", () => {
  const mk = (code: string, n: number): LaneSection => ({
    code,
    number: 1,
    title: code,
    params: Array.from({ length: n }, (_, i) => ({ id: `${code}-${i}`, sectionCode: code, sectionNumber: 1, sectionTitle: code, text: "q" })),
  });

  it("never splits a section and balances load largest-first", () => {
    const secs = [mk("A", 15), mk("B", 10), mk("C", 9), mk("D", 9), mk("E", 8), mk("F", 1)];
    const lanes = binPackSections(secs, 4);
    // every section lands intact in exactly one lane
    const placed = lanes.flat().map((s) => s.code).sort();
    expect(placed).toEqual(["A", "B", "C", "D", "E", "F"]);
    // biggest lane's item count is reasonably balanced — far under the naive
    // worst case (everything in one lane = 52); greedy packs it to 17 here.
    const loads = lanes.map((l) => l.reduce((n, s) => n + s.params.length, 0));
    expect(Math.max(...loads)).toBeLessThanOrEqual(18);
  });

  it("drops empty lanes when K exceeds section count", () => {
    const lanes = binPackSections([mk("A", 3)], 5);
    expect(lanes.length).toBe(1);
  });
});
