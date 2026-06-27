import type { Company, SourceDoc, SourceDocType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { webResearcher } from "@/lib/scrape";
import type {
  PeriodTable,
  ScreenerStructuredData,
  ShareholdingTable,
} from "@/lib/harvest/types";
import {
  kindOf,
  type EngineItem,
  type Evidence,
  type EvidenceCitation,
  type EvidencePassage,
  type EvidenceStrategy,
  type ItemKind,
} from "./types";

// ---------------------------------------------------------------------------
// Routing — which source answers which item
// ---------------------------------------------------------------------------

/**
 * Per-item evidence strategies for the items this phase validates. Routing is by
 * item, not purely by kind, because some NUMERIC items (e.g. board independence)
 * must be read from a document, not from the Tier-1 Screener page.
 */
const STRATEGY_BY_ID: Record<string, EvidenceStrategy> = {
  // Tier-1 numeric (Screener structuredData)
  "A14-01": { from: "screener", screenerFields: [{ kind: "debtToEquity", label: "Debt to equity" }] },
  "A3-02": { from: "screener", screenerFields: [{ kind: "shareholding", series: "pledged", label: "Pledged %" }] },
  "A3-01": { from: "screener", screenerFields: [{ kind: "shareholding", series: "promoters", label: "Promoter holding %" }] },
  // Numeric-from-document
  "A1-01": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    keywords: [
      "independent director",
      "composition of the board",
      "board of directors",
      "non-executive",
      "executive director",
      "woman director",
    ],
  },
  // Qualitative-from-document
  "A4-01": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    keywords: [
      "statutory auditor",
      "auditor's report",
      "chartered accountants",
      "appointed as auditors",
      "re-appointment of auditor",
      "rotation of auditor",
    ],
  },
  // Qualitative; document first, web fallback, else not available
  "A13-02": {
    from: "document",
    docTypes: ["EARNINGS_PDF", "ANNUAL_REPORT"],
    keywords: ["managing director", "chief executive", "capital allocation", "md & ceo", "return on capital"],
    webFallback: true,
    webQuery: "CEO capital allocation track record",
  },
};

function defaultDocTypesForSection(sectionCode: string): SourceDocType[] {
  if (sectionCode === "A13") return ["EARNINGS_PDF", "ANNUAL_REPORT"];
  if (sectionCode === "A7") return ["EARNINGS_PDF", "ANNUAL_REPORT"];
  if (sectionCode === "A9") return ["ANNOUNCEMENT", "ANNUAL_REPORT"];
  return ["ANNUAL_REPORT"];
}

function keywordsFromItem(item: EngineItem): string[] {
  const base = `${item.item} ${item.sourceHint ?? ""}`.toLowerCase();
  const words = base.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  return Array.from(new Set(words)).slice(0, 8);
}

function defaultStrategy(item: EngineItem): EvidenceStrategy {
  if (kindOf(item) === "NUMERIC") {
    const longest = item.item
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0];
    return {
      from: "screener",
      screenerFields: longest
        ? [{ kind: "ratio", match: new RegExp(longest, "i"), label: item.item }]
        : [],
    };
  }
  return {
    from: "document",
    docTypes: defaultDocTypesForSection(item.sectionCode),
    keywords: keywordsFromItem(item),
  };
}

/** Pure routing function — pick where an item's evidence comes from. */
export function evidenceStrategyFor(item: EngineItem): EvidenceStrategy {
  return STRATEGY_BY_ID[item.id] ?? defaultStrategy(item);
}

// ---------------------------------------------------------------------------
// getEvidence
// ---------------------------------------------------------------------------

export async function getEvidence(item: EngineItem, runId: string): Promise<Evidence> {
  const kind = kindOf(item);
  const strategy = evidenceStrategyFor(item);

  if (strategy.from === "screener") {
    return getScreenerEvidence(runId, strategy, kind);
  }

  const doc = await getDocumentEvidence(runId, strategy, kind);
  if (doc.status === "found") return doc;

  if (strategy.webFallback) {
    const company = await loadCompany(runId);
    const web = await getWebEvidence(item, company, strategy, kind);
    if (web.status === "found") return web;
    return { status: "not_available", from: "web", kind, note: web.note ?? doc.note };
  }
  return { status: "not_available", from: strategy.from, kind, note: doc.note };
}

async function loadCompany(runId: string): Promise<Company | null> {
  const run = await prisma.analysisRun.findUnique({
    where: { id: runId },
    include: { company: true },
  });
  return run?.company ?? null;
}

// ---------------------------------------------------------------------------
// Tier-1: structured Screener evidence
// ---------------------------------------------------------------------------

async function getScreenerEvidence(
  runId: string,
  strategy: EvidenceStrategy,
  kind: ItemKind,
): Promise<Evidence> {
  const page = await prisma.sourceDoc.findFirst({
    where: { runId, type: "SCREENER_PAGE", fetchStatus: "OK" },
    orderBy: { updatedAt: "desc" },
  });
  if (!page?.structuredData) {
    return { status: "not_available", from: "screener", kind, note: "no SCREENER_PAGE structuredData" };
  }
  const data = page.structuredData as unknown as ScreenerStructuredData;
  const citation: EvidenceCitation = {
    sourceDocId: page.id,
    sourceUrl: page.sourceUrl,
    docType: "SCREENER_PAGE",
    docName: page.name,
    page: null,
  };

  const structured: Record<string, string> = {};
  let series: Evidence["series"];
  const notes: string[] = [];

  for (const field of strategy.screenerFields ?? []) {
    if (field.kind === "ratio") {
      const v = findRatio(data, field.match);
      if (v != null) structured[field.label] = v;
    } else if (field.kind === "debtToEquity") {
      const de = computeDebtToEquity(data);
      if (de) {
        structured[field.label] = de.value;
        if (de.note) notes.push(de.note);
      }
    } else if (field.kind === "shareholding") {
      const s = getShareholdingSeries(data, field.series);
      if (s) {
        const latest = latestNonNull(s.values);
        if (latest != null) structured[field.label] = latest;
        series = { label: field.label, periods: s.periods, values: s.values };
      }
    }
  }

  if (Object.keys(structured).length === 0) {
    return { status: "not_available", from: "screener", kind, note: "structured field(s) not present on the Screener page" };
  }
  return {
    status: "found",
    from: "screener",
    kind,
    structured,
    series,
    citation,
    note: notes.join("; ") || undefined,
  };
}

function findRatio(data: ScreenerStructuredData, match: RegExp): string | null {
  for (const [k, v] of Object.entries(data.ratios ?? {})) {
    if (match.test(k) && v) return v;
  }
  // also look in the ratios table (latest period)
  const rowVal = latestRowValue(data.ratiosTable, match);
  return rowVal;
}

/** D/E from the ratios first; otherwise computed from the latest balance-sheet period. */
function computeDebtToEquity(
  data: ScreenerStructuredData,
): { value: string; note?: string } | null {
  const re = /debt\s*to\s*equity|d\/e/i;
  const direct = findRatio(data, re);
  if (direct != null) return { value: direct, note: "from Screener ratios" };

  const bs = data.balanceSheet;
  if (!bs) return null;
  const idx = latestColumnIndex(bs, /borrowing/i);
  if (idx < 0) return null;
  const borrowings = numAt(bs, /borrowing/i, idx);
  const equityCapital = numAt(bs, /equity (share )?capital|share capital/i, idx);
  const reserves = numAt(bs, /reserve/i, idx);
  if (borrowings == null || equityCapital == null || reserves == null) return null;
  const equity = equityCapital + reserves;
  if (equity <= 0) return null;
  const de = borrowings / equity;
  return {
    value: de.toFixed(2),
    note: `computed from balance sheet (${bs.periods[idx] ?? "latest"}): Borrowings ${borrowings} / (Equity ${equityCapital} + Reserves ${reserves})`,
  };
}

function getShareholdingSeries(
  data: ScreenerStructuredData,
  which: "promoters" | "pledged",
): { periods: string[]; values: Array<string | null> } | null {
  const sh: ShareholdingTable | undefined = data.shareholding;
  if (!sh) return null;
  const direct = which === "promoters" ? sh.promoters : sh.pledged;
  if (direct && direct.length) return { periods: sh.periods, values: direct };
  // fall back to a matching row
  const re = which === "promoters" ? /promoter/i : /pledge/i;
  const row = sh.rows?.find((r) => re.test(r.label));
  if (row) return { periods: sh.periods, values: row.values };
  return null;
}

// ---- small structured-table helpers ----

function parseScreenerNumber(s: string | null | undefined): number | null {
  if (s == null) return null;
  const cleaned = s.replace(/[,₹%]/g, "").replace(/\s+/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function latestNonNull(values: Array<string | null>): string | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return null;
}

function rowFor(table: PeriodTable | undefined, match: RegExp) {
  return table?.rows.find((r) => match.test(r.label));
}

function latestRowValue(table: PeriodTable | undefined, match: RegExp): string | null {
  const row = rowFor(table, match);
  return row ? latestNonNull(row.values) : null;
}

/** Index of the latest period column where the matched row has a numeric value. */
function latestColumnIndex(table: PeriodTable, match: RegExp): number {
  const row = rowFor(table, match);
  if (!row) return -1;
  for (let i = row.values.length - 1; i >= 0; i--) {
    if (parseScreenerNumber(row.values[i]) != null) return i;
  }
  return -1;
}

function numAt(table: PeriodTable, match: RegExp, idx: number): number | null {
  const row = rowFor(table, match);
  if (!row) return null;
  return parseScreenerNumber(row.values[idx]);
}

// ---------------------------------------------------------------------------
// Tier-2: document passage retrieval
// ---------------------------------------------------------------------------

const MAX_PASSAGES = 4;
const MAX_EVIDENCE_CHARS = 6000;
const PER_PASSAGE_CHARS = 1800;

async function getDocumentEvidence(
  runId: string,
  strategy: EvidenceStrategy,
  kind: ItemKind,
): Promise<Evidence> {
  const docs = await prisma.sourceDoc.findMany({
    where: {
      runId,
      type: { in: strategy.docTypes ?? [] },
      fetchStatus: "OK",
      extractedText: { not: null },
    },
    orderBy: { createdAt: "asc" }, // harvester stores most-recent first
  });
  if (!docs.length) {
    return { status: "not_available", from: "document", kind, note: "no documents with extracted text" };
  }
  const passages = retrievePassages(docs, strategy.keywords ?? []);
  if (!passages.length) {
    return { status: "not_available", from: "document", kind, note: "no passages matched the keywords" };
  }
  return { status: "found", from: "document", kind, passages, citation: passages[0].citation };
}

interface PageChunk {
  page: number | null;
  text: string;
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Split extracted text into page-tagged chunks using the harvester's "===== PAGE N =====" markers. */
function splitPages(text: string): PageChunk[] {
  const re = /=====\s*PAGE\s+(\d+)\s*=====/g;
  const matches = [...text.matchAll(re)];
  if (!matches.length) {
    return chunkText(text, 3000).map((t) => ({ page: null, text: t }));
  }
  const pages: PageChunk[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    pages.push({ page: Number(m[1]), text: text.slice(start, end).trim() });
  }
  return pages;
}

function sliceAroundKeywords(text: string, kws: string[], radius: number): string {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const k of kws) {
    const j = lower.indexOf(k);
    if (j >= 0 && (idx < 0 || j < idx)) idx = j;
  }
  if (idx < 0) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function countHits(haystackLower: string, kws: string[]): number {
  let n = 0;
  for (const k of kws) {
    let from = 0;
    for (;;) {
      const i = haystackLower.indexOf(k, from);
      if (i < 0) break;
      n++;
      from = i + k.length;
    }
  }
  return n;
}

/** Keyword-score page chunks across docs and return the top passages (token-thrifty). */
function retrievePassages(docs: SourceDoc[], keywords: string[]): EvidencePassage[] {
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  if (!kws.length) return [];

  const scored: Array<{ score: number; doc: SourceDoc; chunk: PageChunk }> = [];
  for (const doc of docs) {
    for (const chunk of splitPages(doc.extractedText ?? "")) {
      const score = countHits(chunk.text.toLowerCase(), kws);
      if (score > 0) scored.push({ score, doc, chunk });
    }
  }
  scored.sort((a, b) => b.score - a.score); // stable in Node — ties keep doc/page order

  const passages: EvidencePassage[] = [];
  let budget = MAX_EVIDENCE_CHARS;
  for (const s of scored) {
    if (passages.length >= MAX_PASSAGES || budget <= 0) break;
    const text = sliceAroundKeywords(s.chunk.text, kws, PER_PASSAGE_CHARS / 2).slice(0, budget);
    if (!text.trim()) continue;
    budget -= text.length;
    passages.push({
      text,
      citation: {
        sourceDocId: s.doc.id,
        sourceUrl: s.doc.sourceUrl,
        page: s.chunk.page,
        docType: s.doc.type,
        docName: s.doc.name,
      },
    });
  }
  return passages;
}

// ---------------------------------------------------------------------------
// Web fallback
// ---------------------------------------------------------------------------

async function getWebEvidence(
  item: EngineItem,
  company: Company | null,
  strategy: EvidenceStrategy,
  kind: ItemKind,
): Promise<Evidence> {
  const name = company?.name || company?.ticker || "";
  const query = [name, strategy.webQuery ?? item.item].filter(Boolean).join(" ").trim();
  if (!query) return { status: "not_available", from: "web", kind, note: "no company/query for web fallback" };

  const res = await webResearcher.search(query);
  if (res.status === "ok" && res.results.length) {
    let passages: EvidencePassage[] = res.results.slice(0, 3).map((h) => ({
      text: [h.title, h.snippet].filter(Boolean).join(" — ").trim(),
      citation: { sourceUrl: h.url },
    }));
    passages = passages.filter((p) => p.text);
    if (!passages.length) {
      const top = res.results[0];
      const fetched = await webResearcher.fetchUrl(top.url);
      if (fetched.status === "ok" && fetched.content) {
        passages = [{ text: fetched.content.slice(0, PER_PASSAGE_CHARS), citation: { sourceUrl: top.url } }];
      }
    }
    if (passages.length) {
      return { status: "found", from: "web", kind, passages, citation: passages[0].citation };
    }
  }
  return { status: "not_available", from: "web", kind, note: res.error ?? "web research returned nothing" };
}
