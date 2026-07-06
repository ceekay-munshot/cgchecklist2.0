import type { Company, SourceDoc, SourceDocType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { webResearcher } from "@/lib/scrape";
import type { ScreenerStructuredData } from "@/lib/harvest/types";
import { computeNumeric, findRatio, findSeriesRow, getShareholdingSeries } from "./numeric";
import { companyScaleFrom, type CompanyScale } from "./materiality";
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
 * Per-item evidence strategies. Routing is by item, not purely by kind, because
 * some NUMERIC items (e.g. board independence) come from a document, and many
 * NUMERIC items are COMPUTED from the Tier-1 financials (no LLM).
 */
const STRATEGY_BY_ID: Record<string, EvidenceStrategy> = {
  // Tier-1 numeric — read or computed from structuredData (no LLM)
  "A14-01": { from: "screener", screenerFields: [{ kind: "debtToEquity", label: "Debt to equity" }] },
  "A14-02": { from: "screener", screenerFields: [{ kind: "debtToEquity", label: "Debt to equity" }] },
  "A3-02": { from: "screener", screenerFields: [{ kind: "shareholding", series: "pledged", label: "Pledged %" }] },
  "A3-01": { from: "screener", screenerFields: [{ kind: "shareholding", series: "promoters", label: "Promoter holding %" }] },
  "A3-06": { from: "screener", screenerFields: [{ kind: "freeFloat", label: "Free float" }] },
  "A8-01": { from: "screener", screenerFields: [{ kind: "cfoToPat", label: "CFO/PAT (cumulative)" }] },
  "A8-12": { from: "screener", screenerFields: [{ kind: "cfoToEbitda", label: "CFO/EBITDA" }] },
  "A8-10": { from: "screener", screenerFields: [{ kind: "taxRate", label: "Effective tax rate" }] },
  "A8-03": { from: "screener", screenerFields: [{ kind: "receivableDaysProxy", label: "Debtor days" }] },
  "A8-11": { from: "screener", screenerFields: [{ kind: "cashEpsRatio", label: "Cash EPS / EPS" }] },
  // Screener wins (Tier-1, deterministic) — previously fell through to docs/MUNS:
  "A8-02": { from: "screener", screenerFields: [{ kind: "seriesRow", match: /working capital days/i, label: "Working capital days" }] },
  "A8-05": { from: "screener", screenerFields: [{ kind: "otherIncomePctPbt", label: "Other income % of PBT" }] },
  "A10-01": { from: "screener", screenerFields: [{ kind: "seriesRow", match: /dividend payout/i, label: "Dividend payout %" }] },
  // Numeric-from-document (keyword retrieval — already validated correct)
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
  // Qualitative-from-document (keyword retrieval — already validated correct)
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
  // ---- Bucket A: deep note/section retrieval for items whose data IS in the
  // harvested docs (AR notes / concall transcripts / credit ratings) but a
  // shallow keyword search missed. All previously NA; no regression to others.
  // Auditor remuneration / non-audit fees — the "Payments to the auditor" note.
  "A4-06": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    sections: ["payments to the auditor", "payment to auditors", "auditor's remuneration", "remuneration to auditors", "payment to statutory auditor"],
    keywords: ["audit fee", "statutory audit", "tax audit", "other services", "reimbursement of expenses", "limited review"],
    useGeminiNote: true,
  },
  "A4-07": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    sections: ["payments to the auditor", "payment to auditors", "auditor's remuneration", "remuneration to auditors", "payment to statutory auditor"],
    keywords: ["audit fee", "statutory audit", "remuneration", "fees", "other services"],
    useGeminiNote: true,
  },
  // Inter-corporate loans / Sec-186 — loans, guarantees & investments note.
  "A11-03": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    sections: ["loans, guarantees and investments", "particulars of loans", "loans given", "section 186", "investments made during the year"],
    keywords: ["loan", "inter-corporate", "section 186", "guarantee", "investment in", "deposits placed"],
    useGeminiNote: true,
  },
  // Share-capital note: one-vote ordinary shares (A3-04) / no preferential or
  // discounted insider issuance (A3-05) → read the rights & changes-in-capital text.
  "A3-04": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    sections: ["rights, preferences and restrictions", "terms/rights attached to equity shares", "rights attached to equity shares", "equity share capital", "share capital"],
    keywords: ["one vote", "per share", "voting rights", "equity shares of", "ordinary shares", "differential voting"],
  },
  "A3-05": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    sections: ["share capital", "changes in equity share capital", "reconciliation of the number of shares", "preferential issue", "employee stock"],
    keywords: ["preferential allotment", "warrants", "at a discount", "bonus issue", "rights issue", "preferential basis", "employee stock option"],
  },
  // Employee stock options / share-based payments note (TCS has none → GREEN).
  "A6-04": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    sections: ["employee stock option", "share-based payment", "employee share-based", "stock options"],
    keywords: ["stock option", "esop", "rsu", "share-based payment", "grant", "exercise price", "dilution"],
  },
  "A12-03": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    sections: ["employee stock option", "share-based payment", "stock options"],
    keywords: ["stock option", "esop", "rsu", "share-based payment", "option pool"],
  },
  // Concall candor & guidance — read the harvested earnings-call transcripts.
  "A7-04": {
    from: "document",
    docTypes: ["EARNINGS_PDF", "ANNUAL_REPORT"],
    keywords: ["guidance", "outlook", "demand", "margin", "deal", "commentary", "we expect", "management"],
  },
  // (A9-05 rating actions intentionally NOT routed to the harvested ICRA doc —
  // that rationale lists OTHER companies and produced a false red; honest NA
  // until a TCS-specific rating source is harvested.)
  // Audit-committee composition lives in a table in the corporate-governance
  // report — give it a large note window so the dedicated A2-01 extractor can
  // reconstruct independent/total members + meetings from the flattened table.
  "A2-01": {
    from: "document",
    docTypes: ["ANNUAL_REPORT"],
    sections: ["audit committee", "composition of the audit committee", "audit committee comprises", "audit committee of the board"],
    keywords: ["audit committee", "independent director", "met", "meetings", "attendance", "chairperson", "members"],
    useGeminiNote: true,
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

/**
 * Per-SECTION note/section headings + synonym keywords for document items, so
 * every item in a section gets note-aware retrieval (locate the right note first)
 * and terminology coverage — not just shallow single-keyword search.
 */
const SECTION_PROFILE: Record<
  string,
  { sections?: string[]; keywords?: string[]; docTypes?: SourceDocType[]; useGeminiNote?: boolean }
> = {
  A2: {
    sections: ["audit committee", "nomination and remuneration committee", "stakeholders relationship committee", "corporate social responsibility committee", "risk management committee", "composition of the committees"],
    keywords: ["committee", "independent", "meetings held", "attendance", "chairperson", "constituted"],
  },
  A3: {
    sections: ["share capital", "equity share capital", "rights, preferences and restrictions"],
    keywords: ["one vote", "differential voting", "equity shares", "per share", "voting rights", "face value"],
  },
  A5: {
    sections: ["related party transactions", "related party disclosures", "transactions with related parties"],
    keywords: ["related party", "related parties", "arm's length", "key managerial personnel", "ordinary course of business", "subsidiaries"],
    useGeminiNote: true, // table-heavy RPT note — Gemini reads the figures
  },
  A6: {
    sections: ["nomination and remuneration policy", "remuneration of directors", "managerial remuneration", "remuneration to key managerial"],
    keywords: ["remuneration", "commission", "variable pay", "performance linked", "perquisites", "sitting fees"],
  },
  A7a: {
    sections: ["contingent liabilities and commitments", "contingent liabilities", "commitments"],
    keywords: ["contingent", "guarantee", "claims not acknowledged as debt", "commitments", "disputed", "demand"],
    useGeminiNote: true, // table-heavy CL note — Gemini reads the figures
  },
  A8: {
    sections: ["material accounting policies", "significant accounting policies", "property, plant and equipment", "intangible assets", "revenue recognition"],
    keywords: ["capitalis", "capitaliz", "accounting policy", "amortis", "depreciation", "revenue is recognised"],
  },
  A11: {
    sections: ["investment in subsidiaries", "subsidiaries", "cash and cash equivalents", "investments"],
    keywords: ["subsidiary", "subsidiaries", "dividend received", "cash and bank", "investment in", "step-down"],
  },
  A13: {
    sections: ["board of directors", "directors' report", "management discussion and analysis"],
    keywords: ["promoter", "family", "succession", "managing director", "founder", "chairman"],
  },
};

/**
 * Items generally absent from filings — they live in web / market data
 * (overboarding, board attendance, employee attrition, analyst/research
 * coverage, marquee-investor entry/exit, SEBI enforcement history). They try the
 * document then a web fallback; a NA here is EXPECTED and labelled as such, not a
 * silent retrieval failure.
 */
export const WEB_ONLY_ITEMS: Record<string, string> = {
  "A1-06": "directors number of other listed company board seats overboarding",
  "A1-07": "board meeting attendance record of directors",
  "A12-01": "employee attrition rate",
  "A15-03": "analyst research coverage brokerages",
  "A3-07": "marquee institutional investor stake entry exit",
  "A9-01": "SEBI order penalty consent order insider trading",
  // Audit-firm calibre: the statutory auditor's name is in the filing, but its
  // STANDING (Big-4 / top-national vs small local firm) isn't — so research the
  // firm's reputation on the web, then fall back to the filing for the name.
  "A4-02": "statutory auditor audit firm name reputation Big Four top national vs small local firm standing",
  // Promoter / management quality (A13) and reputation (A9-04) live in news and
  // market data, not in the annual report — they get a tailored web query and an
  // EXPECTED-NA label when web research is unavailable (no search key) or empty.
  "A9-04": "promoter group track record other listed companies governance record",
  "A13-01": "CEO professional management versus promoter-run company",
  // Look BEYOND the current company: the promoter's earlier ventures / other
  // businesses and how they fared (incl. failures / wound-up companies), not just
  // this company's listing history.
  "A13-03": "promoter founder background history vintage earlier ventures other businesses track record beyond this company including any failed or wound-up companies",
  "A13-04": "senior management leadership team tenure experience",
  "A13-05": "second line management bench strength key executives",
  "A13-06": "promoter family dispute succession feud shareholding",
  "A13-07": "promoter other businesses group companies interests",
  "A13-08": "company government dealings sensitive regulatory contracts",
  "A13-09": "promoter political connections affiliations",
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
  // Items in a profiled section read from the annual-report notes/sections —
  // even NUMERIC ones, because their figures live in the AR notes (contingent
  // liabilities, RPT, committees), not in the Tier-1 Screener page.
  const profile = SECTION_PROFILE[item.sectionCode];
  if (profile) {
    return {
      from: "document",
      docTypes: profile.docTypes ?? defaultDocTypesForSection(item.sectionCode),
      sections: profile.sections,
      keywords: Array.from(new Set([...(profile.keywords ?? []), ...keywordsFromItem(item)])).slice(0, 12),
      useGeminiNote: profile.useGeminiNote,
    };
  }
  if (kindOf(item) === "NUMERIC") {
    const longest = item.item
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0];
    return {
      from: "screener",
      screenerFields: longest ? [{ kind: "ratio", match: new RegExp(longest, "i"), label: item.item }] : [],
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
  const base = STRATEGY_BY_ID[item.id] ?? defaultStrategy(item);
  // Web/market-data items: try the document, then web; an empty result is an
  // EXPECTED NA (honest gap), not a failure.
  const webQuery = WEB_ONLY_ITEMS[item.id];
  if (webQuery && !base.expectedNa) {
    return { ...base, webFallback: true, webQuery: base.webQuery ?? webQuery, expectedNa: true };
  }
  return base;
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

  // Web-PRIMARY items (designated web/market-data: promoter vintage/family/
  // political, SEBI history, attrition, analyst coverage, marquee investors).
  // The filing rarely covers these, and a loosely-related section (e.g. "board
  // of directors") would otherwise pre-empt the web and yield a NA — so search
  // the WEB FIRST, then fall back to the document, then an honest Expected-NA.
  if (strategy.expectedNa && strategy.webFallback) {
    const company = await loadCompany(runId);
    const web = await getWebEvidence(item, company, strategy, kind);
    if (web.status === "found") return web;
    const docFb = await getDocumentEvidence(runId, strategy, kind);
    if (docFb.status === "found") return docFb;
    return { status: "not_available", from: "web", kind, note: web.note ?? docFb.note };
  }

  // Filing-PRIMARY items: document first, then an optional web fallback.
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
  const run = await prisma.analysisRun.findUnique({ where: { id: runId }, include: { company: true } });
  return run?.company ?? null;
}

// Company size (₹ crore) for materiality scaling — read once per run from the
// Tier-1 SCREENER_PAGE and memoised (it does not change within a run).
const scaleCache = new Map<string, Promise<CompanyScale | null>>();

/** Reset the per-run company-scale cache (tests). */
export function resetCompanyScaleCache(): void {
  scaleCache.clear();
}

/** The company's net worth / revenue / PAT from Tier-1 structuredData, or null. */
export function loadCompanyScale(runId: string): Promise<CompanyScale | null> {
  const cached = scaleCache.get(runId);
  if (cached) return cached;
  const p = (async () => {
    const page = await prisma.sourceDoc.findFirst({
      where: { runId, type: "SCREENER_PAGE", fetchStatus: "OK" },
      orderBy: { updatedAt: "desc" },
    });
    if (!page?.structuredData) return null;
    return companyScaleFrom(page.structuredData as unknown as ScreenerStructuredData);
  })();
  scaleCache.set(runId, p);
  return p;
}

// ---------------------------------------------------------------------------
// Tier-1: structured Screener evidence (read or computed; no LLM)
// ---------------------------------------------------------------------------

function latestNonNull(values: Array<string | null>): string | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return null;
}

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
    } else if (field.kind === "shareholding") {
      const s = getShareholdingSeries(data, field.series);
      if (s) {
        const latest = latestNonNull(s.values);
        if (latest != null) structured[field.label] = latest;
        series = { label: field.label, periods: s.periods, values: s.values };
      }
    } else if (field.kind === "seriesRow") {
      // A whole financial-table row read as a multi-year series (trend items).
      const row = findSeriesRow(data, field.match);
      if (row) {
        const latest = latestNonNull(row.values);
        if (latest != null) structured[field.label] = latest;
        series = { label: field.label, periods: row.periods, values: row.values };
      }
    } else {
      // computed-from-financials numeric kind
      const c = computeNumeric(data, field.kind);
      if (c) {
        structured[field.label] = c.value;
        if (c.note) notes.push(c.note);
      }
    }
  }

  if (Object.keys(structured).length === 0) {
    return { status: "not_available", from: "screener", kind, note: "structured field(s) not present on the Screener page" };
  }
  return { status: "found", from: "screener", kind, structured, series, citation, note: notes.join("; ") || undefined };
}

// ---------------------------------------------------------------------------
// Tier-2: document retrieval — note/section-aware, with keyword fallback
// ---------------------------------------------------------------------------

const MAX_PASSAGES = 4;
const MAX_EVIDENCE_CHARS = 6500;
const PER_PASSAGE_CHARS = 1800;
const SECTION_CHARS = 4500; // window extracted for a located note/section
// Gemini note reading gets a larger window so the whole table is visible.
const NOTE_BUDGET_CHARS = 14_000;
const NOTE_SECTION_CHARS = 7000;

async function getDocumentEvidence(
  runId: string,
  strategy: EvidenceStrategy,
  kind: ItemKind,
): Promise<Evidence> {
  const docs = await prisma.sourceDoc.findMany({
    where: { runId, type: { in: strategy.docTypes ?? [] }, fetchStatus: "OK", extractedText: { not: null } },
    orderBy: { createdAt: "asc" }, // harvester stores most-recent first
  });
  if (!docs.length) {
    return { status: "not_available", from: "document", kind, note: "no documents with extracted text" };
  }

  const note = !!strategy.useGeminiNote;
  // 1) Note/section-aware: locate the relevant heading and extract the whole note.
  let passages: EvidencePassage[] = strategy.sections?.length
    ? extractSectionPassages(
        docs,
        strategy.sections,
        note ? NOTE_BUDGET_CHARS : MAX_EVIDENCE_CHARS,
        note ? NOTE_SECTION_CHARS : SECTION_CHARS,
      )
    : [];
  // 2) Fall back to keyword scoring when no heading matched.
  if (!passages.length) {
    passages = retrievePassages(docs, strategy.keywords ?? []);
  }
  if (!passages.length) {
    return { status: "not_available", from: "document", kind, note: "no matching note/section or keyword passages" };
  }
  return {
    status: "found",
    from: "document",
    kind,
    mode: note ? "note" : undefined,
    passages,
    citation: passages[0].citation,
  };
}

/** The most note-like occurrence of a heading (its following window is digit-dense, unlike a TOC line). */
function bestHeadingOffset(lower: string, heading: string): number {
  let best = -1;
  let bestScore = -1;
  let from = 0;
  for (;;) {
    const i = lower.indexOf(heading, from);
    if (i < 0) break;
    const window = lower.slice(i + heading.length, i + heading.length + 1200);
    const digits = (window.match(/\d/g) ?? []).length;
    if (digits > bestScore) {
      bestScore = digits;
      best = i;
    }
    from = i + heading.length;
  }
  return best;
}

function pageAtOffset(text: string, offset: number): number | null {
  const re = /=====\s*PAGE\s+(\d+)\s*=====/g;
  let page: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index <= offset) page = Number(m[1]);
    else break;
  }
  return page;
}

/** Locate each note/section heading and extract its whole body (token-budgeted). */
function extractSectionPassages(
  docs: SourceDoc[],
  headings: string[],
  budgetMax: number = MAX_EVIDENCE_CHARS,
  sectionChars: number = SECTION_CHARS,
): EvidencePassage[] {
  const out: EvidencePassage[] = [];
  let budget = budgetMax;
  for (const doc of docs) {
    const text = doc.extractedText ?? "";
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const heading of headings) {
      if (out.length >= MAX_PASSAGES || budget <= 0) break;
      const at = bestHeadingOffset(lower, heading.toLowerCase());
      if (at < 0) continue;
      const body = text.slice(at, at + sectionChars).trim().slice(0, budget);
      if (!body) continue;
      budget -= body.length;
      out.push({
        text: body,
        citation: { sourceDocId: doc.id, sourceUrl: doc.sourceUrl, page: pageAtOffset(text, at), docType: doc.type, docName: doc.name },
      });
    }
    if (out.length >= MAX_PASSAGES || budget <= 0) break;
  }
  return out;
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

/** Keyword-score page chunks across docs and return the top passages (fallback path). */
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
      citation: { sourceDocId: s.doc.id, sourceUrl: s.doc.sourceUrl, page: s.chunk.page, docType: s.doc.type, docName: s.doc.name },
    });
  }
  return passages;
}

// ---------------------------------------------------------------------------
// Web fallback
// ---------------------------------------------------------------------------

// Social / user-generated / low-credibility hosts: never a governance source.
const BLOCKED_WEB_HOSTS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "reddit.com",
  "quora.com", "pinterest.com", "tiktok.com", "youtube.com", "linkedin.com",
  "threads.net",
];

/** True if the URL's host is a blocked social/UGC domain. */
function isBlockedHost(url: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = url.toLowerCase();
  }
  return BLOCKED_WEB_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

// Generic name words that aren't distinctive enough to match a result on.
const COMPANY_STOPWORDS = new Set([
  "limited", "ltd", "services", "service", "company", "corporation", "corp",
  "industries", "india", "indian", "group", "holdings", "enterprises", "the",
]);

/** Distinctive lowercased tokens identifying the company (name words + ticker). */
function companyTokens(company: Company | null): string[] {
  const toks = new Set<string>();
  for (const w of (company?.name ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !COMPANY_STOPWORDS.has(w)) toks.add(w);
  }
  const ticker = (company?.ticker ?? "").toLowerCase();
  if (ticker.length >= 2) toks.add(ticker);
  return [...toks];
}

/** A web hit is relevant only if it actually mentions the company (title/snippet/url). */
function mentionsCompany(hay: string, tokens: string[]): boolean {
  if (!tokens.length) return true; // no distinctive token to filter on — don't over-filter
  const h = hay.toLowerCase();
  return tokens.some((t) => h.includes(t));
}

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
    // Keep only results that actually mention THIS company — drops the off-topic
    // search noise (e.g. an Instagram post about a different company, a generic
    // HR blog) that otherwise yields confidently-wrong web verdicts.
    const tokens = companyTokens(company);
    const relevant = res.results.filter(
      (h) => !isBlockedHost(h.url) && mentionsCompany(`${h.title ?? ""} ${h.snippet ?? ""} ${h.url}`, tokens),
    );
    let passages: EvidencePassage[] = relevant.slice(0, 3).map((h) => ({
      text: [h.title, h.snippet].filter(Boolean).join(" — ").trim(),
      citation: { sourceUrl: h.url },
    }));
    passages = passages.filter((p) => p.text);
    if (!passages.length && relevant.length) {
      const top = relevant[0];
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
