import * as cheerio from "cheerio";
import type { SourceDocType } from "@prisma/client";
import type {
  DocumentLink,
  PeriodTable,
  ScreenerStructuredData,
  ShareholdingTable,
} from "./types";

type Cheerio = cheerio.CheerioAPI;
// A jQuery-like selection (what `$(...)` returns).
type Selection = ReturnType<cheerio.CheerioAPI>;

const SCREENER_BASE = "https://www.screener.in";

function clean(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function absolutize(href: string, base = SCREENER_BASE): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Parse a Screener "data-table" (P&L / Balance Sheet / Cash Flow / Ratios). */
function parseDataTable($: Cheerio, root: Selection): PeriodTable | undefined {
  const table = root.find("table.data-table").first();
  if (!table.length) return undefined;

  // Use native arrays (toArray): cheerio's .map() flattens arrays and drops
  // null returns, which would misalign blank cells.
  const periods = table
    .find("thead th")
    .toArray()
    .slice(1)
    .map((th) => clean($(th).text()));

  const rows = table
    .find("tbody tr")
    .toArray()
    .map((tr) => {
      const cells = $(tr).find("td").toArray();
      if (cells.length < 2) return null;
      const label = clean($(cells[0]).text()).replace(/\s*\+\s*$/, "");
      const values = cells.slice(1).map((td) => {
        const t = clean($(td).text());
        return t === "" ? null : t;
      });
      return label ? { label, values } : null;
    })
    .filter((r): r is { label: string; values: Array<string | null> } => r !== null);

  if (!rows.length) return undefined;
  return { periods, rows };
}

/** Find a section by id, falling back to a heading-text match. */
function section($: Cheerio, id: string, headings: string[]): Selection {
  const byId = $(`#${id}`);
  if (byId.length) return byId;
  for (const h of headings) {
    const heading = $("h1, h2, h3")
      .filter((_, el) => clean($(el).text()).toLowerCase() === h.toLowerCase())
      .first();
    if (heading.length) return heading.closest("section, div");
  }
  return $();
}

function parseTopRatios($: Cheerio): Record<string, string> {
  const ratios: Record<string, string> = {};
  $("#top-ratios li").each((_, li) => {
    const name = clean($(li).find(".name").text());
    const value =
      clean($(li).find(".value").text()) || clean($(li).find(".number").text());
    if (name) ratios[name] = value;
  });
  return ratios;
}

function parseShareholding($: Cheerio): ShareholdingTable | undefined {
  const root = section($, "shareholding", ["Shareholding Pattern", "Shareholding"]);
  if (!root.length) return undefined;
  // Prefer the quarterly tab when present.
  const quarterly = root.find("#quarterly-shp");
  const base = parseDataTable($, quarterly.length ? quarterly : root);
  if (!base) return undefined;

  const find = (re: RegExp) => base.rows.find((r) => re.test(r.label))?.values;
  return {
    ...base,
    promoters: find(/promoter/i),
    pledged: find(/pledge/i),
  };
}

function parsePeers($: Cheerio): ScreenerStructuredData["peers"] {
  const root = section($, "peers", ["Peers", "Peer comparison"]);
  const table = root.find("table").first();
  if (!table.length) return undefined;
  const columns = table
    .find("thead th")
    .toArray()
    .map((th) => clean($(th).text()));
  const rows = table
    .find("tbody tr")
    .toArray()
    .map((tr) => $(tr).find("td").toArray().map((td) => clean($(td).text())))
    .filter((r) => r.some((c) => c !== ""));
  if (!columns.length && !rows.length) return undefined;
  return { columns, rows };
}

function list($: Cheerio, selector: string): string[] {
  return $(selector)
    .map((_, li) => clean($(li).text()))
    .get()
    .filter(Boolean);
}

/**
 * Parse the rendered HTML of a Screener company page into clean structured JSON.
 * Pure + defensive: any missing section is simply omitted (never throws).
 */
export function parseScreenerPage(
  html: string,
  ctx: { ticker: string; url: string; capturedAt: string },
): ScreenerStructuredData {
  const $ = cheerio.load(html);

  return {
    ticker: ctx.ticker,
    url: ctx.url,
    name: clean($("h1").first().text()) || undefined,
    about:
      clean($(".company-profile .about, .company-profile p, #profile p").first().text()) ||
      undefined,
    ratios: parseTopRatios($),
    profitLoss: parseDataTable($, section($, "profit-loss", ["Profit & Loss"])),
    quarters: parseDataTable($, section($, "quarters", ["Quarterly Results"])),
    balanceSheet: parseDataTable($, section($, "balance-sheet", ["Balance Sheet"])),
    cashFlow: parseDataTable($, section($, "cash-flow", ["Cash Flow", "Cash Flows"])),
    ratiosTable: parseDataTable($, section($, "ratios", ["Ratios"])),
    shareholding: parseShareholding($),
    peers: parsePeers($),
    pros: list($, ".pros li"),
    cons: list($, ".cons li"),
    capturedAt: ctx.capturedAt,
  };
}

// ---------------------------------------------------------------------------
// Tier 2: document link discovery
// ---------------------------------------------------------------------------

interface DocSection {
  classSel: string;
  headings: string[];
  type: SourceDocType;
  category: string;
}

const DOC_SECTIONS: DocSection[] = [
  { classSel: ".annual-reports", headings: ["Annual reports"], type: "ANNUAL_REPORT", category: "annual_report" },
  { classSel: ".concalls", headings: ["Concalls"], type: "EARNINGS_PDF", category: "concall" },
  { classSel: ".credit-ratings", headings: ["Credit ratings"], type: "ANNOUNCEMENT", category: "credit_rating" },
  { classSel: ".announcements", headings: ["Announcements"], type: "ANNOUNCEMENT", category: "announcement" },
];

function containerFor($: Cheerio, sec: DocSection): Selection {
  const byClass = $(`.documents${sec.classSel}, ${sec.classSel}`);
  if (byClass.length) return byClass.first();
  for (const h of sec.headings) {
    const heading = $("h2, h3")
      .filter((_, el) => clean($(el).text()).toLowerCase() === h.toLowerCase())
      .first();
    if (heading.length) return heading.closest("div, section");
  }
  return $();
}

/**
 * Discover document links (annual reports, concall transcripts/notes/PPT,
 * credit ratings, announcements) from a Screener company page. De-duplicated by
 * URL; the orchestrator applies per-category caps.
 */
export function extractDocumentLinks(html: string, base = SCREENER_BASE): DocumentLink[] {
  const $ = cheerio.load(html);
  const out: DocumentLink[] = [];
  const seen = new Set<string>();

  const push = (link: DocumentLink) => {
    const key = `${link.category}|${link.url}`;
    if (link.url && !seen.has(key)) {
      seen.add(key);
      out.push(link);
    }
  };

  for (const sec of DOC_SECTIONS) {
    const container = containerFor($, sec);
    if (!container.length) continue;

    if (sec.category === "concall") {
      // Each <li> groups a date with Transcript/Notes/PPT links.
      container.find("li").each((_, li) => {
        const date = clean($(li).find("div").first().text());
        $(li)
          .find("a[href]")
          .each((_, a) => {
            const href = $(a).attr("href");
            if (!href) return;
            const label = clean($(a).text());
            push({
              type: sec.type,
              category: sec.category,
              name: [date, label].filter(Boolean).join(" ").trim() || "Concall",
              url: absolutize(href, base),
            });
          });
      });
    } else {
      container.find("a[href]").each((_, a) => {
        const href = $(a).attr("href");
        if (!href) return;
        const name = clean($(a).text());
        if (!name) return;
        push({
          type: sec.type,
          category: sec.category,
          name,
          url: absolutize(href, base),
        });
      });
    }
  }

  return out;
}
