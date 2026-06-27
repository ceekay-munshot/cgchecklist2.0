import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseScreenerPage, extractDocumentLinks } from "./parse";

const html = fs.readFileSync(
  path.join(import.meta.dirname, "__fixtures__", "screener-sample.html"),
  "utf8",
);

const ctx = {
  ticker: "ACME",
  url: "https://www.screener.in/company/ACME/consolidated/",
  capturedAt: "2024-01-01T00:00:00.000Z",
};

describe("parseScreenerPage", () => {
  const data = parseScreenerPage(html, ctx);

  it("captures identity + top ratios", () => {
    expect(data.name).toBe("Acme Industries Ltd");
    expect(data.about).toContain("widgets");
    expect(data.ratios["Market Cap"]).toContain("1,23,456");
    expect(data.ratios["Debt to equity"]).toBe("0.18");
    expect(data.ratios["ROE"]).toContain("19.7");
  });

  it("captures the P&L period table with labelled series", () => {
    expect(data.profitLoss?.periods).toEqual(["Mar 2021", "Mar 2022", "Mar 2023", "TTM"]);
    const sales = data.profitLoss?.rows.find((r) => r.label === "Sales");
    expect(sales?.values).toEqual(["10,000", "12,500", "15,000", "16,200"]);
    // the "+" expander suffix is stripped from labels
    expect(data.profitLoss?.rows.some((r) => r.label === "Net Profit")).toBe(true);
  });

  it("captures cash flow + ratios tables", () => {
    expect(data.cashFlow?.rows.some((r) => /Operating Activity/.test(r.label))).toBe(true);
    expect(data.ratiosTable?.rows.some((r) => r.label === "Working Capital Days")).toBe(true);
  });

  it("captures shareholding incl. promoter + pledged series", () => {
    expect(data.shareholding?.periods).toEqual(["Dec 2022", "Mar 2023", "Jun 2023", "Sep 2023"]);
    expect(data.shareholding?.promoters).toEqual(["55.10%", "55.10%", "54.80%", "54.80%"]);
    expect(data.shareholding?.pledged).toEqual(["2.00%", "1.50%", "1.50%", "0.00%"]);
  });

  it("captures peers + pros/cons", () => {
    expect(data.peers?.columns).toContain("P/E");
    expect(data.peers?.rows.length).toBe(2);
    expect(data.pros).toContain("Company is almost debt free.");
    expect(data.cons.length).toBe(2);
  });
});

describe("extractDocumentLinks", () => {
  const links = extractDocumentLinks(html);

  it("discovers annual reports, concalls, credit ratings, announcements", () => {
    const byCat = (c: string) => links.filter((l) => l.category === c);
    expect(byCat("annual_report").length).toBe(4); // orchestrator caps to 3
    expect(byCat("annual_report")[0].type).toBe("ANNUAL_REPORT");
    expect(byCat("concall").some((l) => /Transcript/.test(l.name))).toBe(true);
    expect(byCat("concall").every((l) => l.type === "EARNINGS_PDF")).toBe(true);
    expect(byCat("credit_rating").length).toBe(1);
    expect(byCat("announcement").some((l) => /Resignation/.test(l.name))).toBe(true);
  });

  it("dates concall links and yields absolute urls", () => {
    const t = links.find((l) => l.category === "concall" && /Transcript/.test(l.name));
    expect(t?.name).toContain("Aug 2023");
    expect(t?.url.startsWith("https://")).toBe(true);
  });
});
