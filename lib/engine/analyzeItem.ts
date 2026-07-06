import { callJSON } from "./llm";
import { QuotaExhaustedError } from "./quota";
import { parseNumericValue } from "./thresholds";
import {
  NOT_AVAILABLE,
  type Analysis,
  type DataTable,
  type EngineItem,
  type Evidence,
  type EvidenceCitation,
  type EvidencePassage,
} from "./types";

const NA: Analysis = { value: NOT_AVAILABLE, confidence: "low" };

/**
 * Run a schema-validated extraction, degrading a GENUINE provider error (bad
 * JSON after retries, 5xx, a model that consistently fails on this passage) to
 * `null` so the caller returns a clean NA instead of a hard ERROR — matching the
 * project's "never throw, return not_available" philosophy. A QuotaExhaustedError
 * is NOT swallowed: it propagates so the orchestrator DEFERS the item.
 *
 * This is what stops items like A3-03 / A3-07 from failing deterministically: a
 * provider hiccup on their passages now yields an honest NA, not an ERROR.
 */
async function extract<T>(
  role: Parameters<typeof callJSON>[0],
  opts: Parameters<typeof callJSON>[1],
  schema: object,
): Promise<{ data: T; provider: string } | null> {
  try {
    return await callJSON<T>(role, opts, schema);
  } catch (e) {
    if (e instanceof QuotaExhaustedError) throw e;
    return null;
  }
}

/** Concatenate retrieved passages into a compact, citation-tagged prompt block. */
function passagesBlock(passages: EvidencePassage[]): string {
  return passages
    .map((p) => {
      const tag = [p.citation.docName, p.citation.page != null ? `p.${p.citation.page}` : null]
        .filter(Boolean)
        .join(" ");
      return `[${tag || p.citation.sourceUrl || "source"}]\n${p.text}`;
    })
    .join("\n\n");
}

function citationForPage(evidence: Evidence, page: number | null | undefined): EvidenceCitation | undefined {
  if (page != null) {
    const hit = evidence.passages?.find((p) => p.citation.page === page);
    if (hit) return hit.citation;
  }
  return evidence.citation ?? evidence.passages?.[0]?.citation;
}

function firstNonNull(values: Array<string | null>): string | null {
  for (const v of values) if (v != null && v.trim() !== "") return v.trim();
  return null;
}

function latestNonNull(values: Array<string | null>): string | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return null;
}

// Shared by all trend (series) items. Tolerance is ~2 percentage points (scaling
// slightly for large bases) so a near-flat series — e.g. promoter holding
// drifting 72.30% -> 71.77% over years — reads as "stable", not "declining".
// This is the label only; the flag is decided separately from the level.
function trendOf(values: Array<string | null>): string {
  const f = parseNumericValue(firstNonNull(values));
  const l = parseNumericValue(latestNonNull(values));
  if (f == null || l == null) return "n/a";
  const tol = Math.max(2, Math.abs(f) * 0.02);
  if (l > f + tol) return "rising";
  if (l < f - tol) return "declining";
  return "stable";
}

/**
 * Turn evidence into a concise extracted fact + citation + confidence.
 *
 *   - not available        -> the NA sentinel (no LLM call)
 *   - Tier-1 structured     -> direct map (no LLM; exact + free)
 *   - numeric-from-document -> cheap Groq extraction over the passages
 *   - qualitative           -> Mistral (or Gemini for large passage sets)
 *
 * NEVER fabricates: when the evidence is insufficient it returns "not available".
 */
export async function analyzeItem(item: EngineItem, evidence: Evidence): Promise<Analysis> {
  if (evidence.status === "not_available") return NA;

  if (evidence.from === "screener" && evidence.structured) {
    return analyzeScreener(evidence);
  }
  // Item-specific extractors run FIRST — even when their evidence is a large
  // "note" window — so the generic note/figure reader below doesn't hijack them.
  // Board composition is the one numeric-from-document extractor (A1-01).
  if (item.id === "A1-01") {
    return analyzeNumericFromPassages(item, evidence);
  }
  // Audit-committee composition lives in a governance-report table; extract the
  // quantified facts (independent/total members, meetings) so the deterministic
  // A1-06 Overboarding — build a per-director table from the governance report's
  // "directorships in other companies" disclosure (SEBI-mandated).
  if (item.id === "A1-06") {
    return analyzeDirectors(item, evidence);
  }
  // A2-01 categorical rule can decide compliance instead of returning NA.
  if (item.id === "A2-01") {
    return analyzeAuditCommittee(item, evidence);
  }
  // Table-heavy financial-statement notes → Gemini reads the note's figures.
  if (evidence.mode === "note") {
    return analyzeNote(item, evidence);
  }
  return analyzeQualitative(item, evidence);
}

// ---- Tier-1 structured (deterministic, no LLM) ----

function analyzeScreener(evidence: Evidence): Analysis {
  const entries = Object.entries(evidence.structured ?? {});
  if (!entries.length) return NA;
  const [label, val] = entries[0];

  if (evidence.series && evidence.series.values.length) {
    const latest = latestNonNull(evidence.series.values) ?? val;
    const trend = trendOf(evidence.series.values);
    const compact = evidence.series.periods
      .map((p, i) => `${p}:${evidence.series!.values[i] ?? "-"}`)
      .slice(-6)
      .join(", ");
    return {
      value: `${latest} (${trend})`,
      // Carry the full series so a trend classifier (CUSTOM_SERIES) can judge it.
      series: { periods: evidence.series.periods, values: evidence.series.values },
      evidenceQuote: `${label} — ${compact}`,
      citation: evidence.citation,
      confidence: "high",
      providerUsed: "deterministic",
    };
  }

  return {
    value: val,
    evidenceQuote: evidence.note ?? `${label} = ${val}`,
    citation: evidence.citation,
    confidence: "high",
    providerUsed: "deterministic",
  };
}

// ---- numeric-from-document (Groq extraction) ----

interface BoardExtract {
  relevant: boolean;
  found: boolean;
  independentDirectors?: number | null;
  totalDirectors?: number | null;
  percentIndependent?: number | null;
  evidenceQuote?: string;
  page?: number | null;
}

const BOARD_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    found: { type: "boolean" },
    independentDirectors: { type: ["integer", "null"] },
    totalDirectors: { type: ["integer", "null"] },
    percentIndependent: { type: ["number", "null"] },
    evidenceQuote: { type: "string" },
    page: { type: ["integer", "null"] },
  },
  required: ["relevant", "found"],
  additionalProperties: false,
} as const;

async function analyzeNumericFromPassages(item: EngineItem, evidence: Evidence): Promise<Analysis> {
  const passages = evidence.passages ?? [];
  if (!passages.length) return NA;

  const prompt =
    `Checklist item: ${item.item}\n` +
    (item.description ? `Definition: ${item.description}\n` : "") +
    `\nFIRST decide if these excerpts are ACTUALLY about board composition / director ` +
    `independence for this item (not merely sharing a word); if not, set "relevant" to false.\n` +
    `If relevant, determine the board composition: count INDEPENDENT directors and TOTAL ` +
    `directors and compute percentIndependent = independent / total * 100 (use the most ` +
    `complete/recent statement). If the excerpts do not state it, set "found" to false. ` +
    `Put the exact supporting sentence (<=200 chars) in "evidenceQuote" and its page in "page".\n\n` +
    passagesBlock(passages);

  // Quota errors propagate (→ DEFER); a genuine provider failure degrades to NA.
  const res = await extract<BoardExtract>("bulkClassify", { prompt, temperature: 0 }, BOARD_SCHEMA);
  if (!res) return NA;
  const { data, provider } = res;
  if (!data.relevant || !data.found) return NA;
  const pct =
    data.percentIndependent ??
    (data.independentDirectors && data.totalDirectors
      ? (data.independentDirectors / data.totalDirectors) * 100
      : null);
  if (pct == null) return NA;
  const counts =
    data.independentDirectors && data.totalDirectors
      ? ` (${data.independentDirectors} of ${data.totalDirectors})`
      : "";
  const rationale =
    data.independentDirectors && data.totalDirectors
      ? `The board has ${data.totalDirectors} directors, of whom ${data.independentDirectors} are independent — ${round1(pct)}% independent. SEBI LODR requires at least one-third independent directors (one-half where the chairperson is executive or promoter-linked), so this is the level to weigh independence and boardroom oversight against.`
      : `Independent directors make up ${round1(pct)}% of the board, to be read against the SEBI LODR minimum of one-third (one-half where the chair is executive/promoter-linked).`;
  return {
    value: `${round1(pct)}% independent${counts}`,
    rationale,
    evidenceQuote: data.evidenceQuote,
    citation: citationForPage(evidence, data.page),
    confidence: counts ? "high" : "medium",
    providerUsed: provider,
  };
}

// ---- audit committee composition (A2-01; Groq structured extraction) ----

interface AuditCommitteeExtract {
  relevant: boolean;
  found: boolean;
  independentMembers?: number | null;
  totalMembers?: number | null;
  meetings?: number | null;
  evidenceQuote?: string;
  page?: number | null;
}

const AUDIT_COMMITTEE_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    found: { type: "boolean" },
    independentMembers: { type: ["integer", "null"] },
    totalMembers: { type: ["integer", "null"] },
    meetings: { type: ["integer", "null"] },
    evidenceQuote: { type: "string" },
    page: { type: ["integer", "null"] },
  },
  required: ["relevant", "found"],
  additionalProperties: false,
} as const;

async function analyzeAuditCommittee(item: EngineItem, evidence: Evidence): Promise<Analysis> {
  const passages = evidence.passages ?? [];
  if (!passages.length) return NA;

  const prompt =
    `You are reading the Corporate Governance Report of an annual report.\n` +
    `Checklist item: ${item.item}\n` +
    (item.description ? `Definition: ${item.description}\n` : "") +
    `\nFIRST decide if these excerpts actually describe the AUDIT COMMITTEE (not the ` +
    `board overall or another committee); if not, set "relevant" to false.\n` +
    `If relevant, from the Audit Committee composition table determine: the number of ` +
    `INDEPENDENT directors on the audit committee ("independentMembers"), the TOTAL number ` +
    `of audit-committee members ("totalMembers"), and the number of audit-committee MEETINGS ` +
    `held during the year ("meetings"). Use null for any value the excerpts do not state, and ` +
    `set "found" to false only if none of these are present. Put the exact supporting line ` +
    `(<=200 chars) in "evidenceQuote" and its page in "page".\n\n` +
    passagesBlock(passages);

  // Quota errors propagate (→ DEFER); a genuine provider failure degrades to NA.
  const res = await extract<AuditCommitteeExtract>("bulkClassify", { prompt, temperature: 0 }, AUDIT_COMMITTEE_SCHEMA);
  if (!res) return NA;
  const { data, provider } = res;
  if (!data.relevant || !data.found) return NA;

  const parts: string[] = [];
  if (data.independentMembers != null && data.totalMembers != null) {
    parts.push(`${data.independentMembers} of ${data.totalMembers} independent`);
  }
  if (data.meetings != null) parts.push(`met ${data.meetings} times`);
  // Nothing quantified — let the categorical rule read it as "unquantified" (NEUTRAL),
  // which is still more honest than a silent NA.
  const value = parts.length ? parts.join(", ") : (data.evidenceQuote ?? "Audit committee composition disclosed");
  const rParts: string[] = [];
  if (data.independentMembers != null && data.totalMembers != null) {
    rParts.push(
      `The audit committee has ${data.totalMembers} members, of whom ${data.independentMembers} are independent; SEBI LODR requires at least three members with two-thirds independent and an independent chair.`,
    );
  }
  if (data.meetings != null) {
    rParts.push(`It met ${data.meetings} time(s) during the year, against the SEBI minimum of four.`);
  }
  return {
    value,
    rationale: rParts.length ? rParts.join(" ") : undefined,
    evidenceQuote: data.evidenceQuote,
    citation: citationForPage(evidence, data.page),
    confidence: parts.length ? "high" : "low",
    providerUsed: provider,
  };
}

// ---- per-director table (A1-06 Overboarding; structured extraction) ----

interface DirectorRow {
  name: string;
  otherBoards?: number | null;
}
interface DirectorsExtract {
  found: boolean;
  directors?: DirectorRow[];
}

const DIRECTORS_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    directors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          otherBoards: { type: ["integer", "null"] },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  required: ["found"],
  additionalProperties: false,
} as const;

// SEBI caps a person at 7 listed boards (and audit/SRC memberships separately);
// the checklist green band is "<=7 listed boards".
const OVERBOARD_LIMIT = 7;

async function analyzeDirectors(item: EngineItem, evidence: Evidence): Promise<Analysis> {
  const passages = evidence.passages ?? [];
  if (!passages.length) return NA;

  const prompt =
    `You are reading a company's Corporate Governance report from its annual report.\n` +
    `List EVERY director on the board and, for each, the NUMBER OF OTHER company directorships ` +
    `they hold — from the "Directorships in other companies" / "No. of other directorships" / ` +
    `"Directorship in other listed entities" disclosure (SEBI mandates this table). Prefer the ` +
    `count of OTHER LISTED-company boards; if only a total is given, use that. Return one row per ` +
    `director with their "name" and "otherBoards" (an integer, or null if not stated). Use the ` +
    `MOST RECENT year. If you genuinely cannot find any director-wise directorship data, set ` +
    `"found" to false.\n\n` +
    passagesBlock(passages);

  const res = await extract<DirectorsExtract>("longContext", { prompt, temperature: 0 }, DIRECTORS_SCHEMA);
  if (!res) return NA;
  const { data, provider } = res;
  const directors = (data.directors ?? []).filter((d) => d.name && d.name.trim());
  if (!data.found || directors.length === 0) return NA;

  // Busiest director first so the concern reads at the top of the table.
  const sorted = [...directors].sort((a, b) => (b.otherBoards ?? -1) - (a.otherBoards ?? -1));
  const counts = sorted.map((d) => d.otherBoards).filter((n): n is number => n != null);
  const maxBoards = counts.length ? Math.max(...counts) : null;
  const over = sorted.filter((d) => d.otherBoards != null && d.otherBoards > OVERBOARD_LIMIT);

  // value LEADS with maxBoards so the numeric flag rule reads it (≤7 green / >7 red).
  const value =
    maxBoards != null
      ? `${maxBoards} other directorships on the busiest director — ${over.length} of ${sorted.length} directors above ${OVERBOARD_LIMIT}`
      : `Board of ${sorted.length} directors; other-directorship counts not quantified`;
  const rationale =
    maxBoards != null
      ? `The board has ${sorted.length} directors. The busiest, ${sorted[0].name}, holds ${maxBoards} other directorships` +
        (over.length
          ? `; ${over.length} director(s) sit on more than ${OVERBOARD_LIMIT} boards (${over.map((d) => d.name).join(", ")}), which dilutes the attention each board receives.`
          : `, and every director is within the ${OVERBOARD_LIMIT}-board norm — no overboarding concern.`)
      : undefined;
  const table: DataTable = {
    columns: ["Director", "Other boards", "Status"],
    rows: sorted.map((d) => [
      d.name.trim(),
      d.otherBoards != null ? String(d.otherBoards) : "—",
      d.otherBoards != null && d.otherBoards > OVERBOARD_LIMIT ? "Overboarded" : "OK",
    ]),
  };

  return {
    value,
    rationale,
    table,
    citation: citationForPage(evidence, null),
    confidence: maxBoards != null ? "high" : "low",
    providerUsed: provider,
  };
}

// ---- qualitative (Mistral / Gemini) ----

interface QualExtract {
  relevant: boolean;
  found: boolean;
  confident?: boolean;
  value?: string;
  rationale?: string;
  evidenceQuote?: string;
  page?: number | null;
}

const QUAL_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    found: { type: "boolean" },
    confident: { type: "boolean" },
    value: { type: "string" },
    rationale: { type: "string" },
    evidenceQuote: { type: "string" },
    page: { type: ["integer", "null"] },
  },
  required: ["relevant", "found"],
  additionalProperties: false,
} as const;

/**
 * Shared instruction that turns a bare fact into a reader-grade answer: a short
 * `value` for the flag engine PLUS a `rationale` of 2-3 full sentences carrying
 * the actual figures/dates/names and why they matter — no green/red call.
 */
const RATIONALE_INSTRUCTION =
  `You are a BUY-SIDE governance analyst writing for an investment committee. Don't ` +
  `just extract — ASSESS. Return TWO things:\n` +
  `  • "value": the one-line headline fact, WITH the key number, that drives the ` +
  `flag, e.g. "18.2% independent (2 of 11)" or "Auditor rotated in FY2023". If the ` +
  `item is inherently a COUNT or a RATE, "value" MUST contain that number.\n` +
  `  • "rationale": 2-4 tight sentences of ANALYSIS (as many as the evidence ` +
  `supports — do NOT pad), in this order: (1) the specific facts WITH numbers — ` +
  `counts, %, ₹ amounts, ratios, how-many-of-how-many, and the actual NAMES when it ` +
  `is about people; (2) CONTEXT — how it reads against the relevant norm (SEBI LODR / ` +
  `Ind AS / Companies Act minimum) and against the prior-year trend if the excerpts ` +
  `show it; (3) the SO-WHAT — what it signals about governance quality or investor ` +
  `risk. Write the way an analyst writes: sharp, quantified, names named, and call ` +
  `out anything that looks like box-ticking, a boilerplate/thin disclosure, or a gap. ` +
  `Stay STRICTLY grounded in the excerpts — no speculation, no invented numbers; if a ` +
  `needed detail isn't disclosed, SAY SO plainly (a disclosure gap is itself a ` +
  `finding). Do NOT declare green/red/pass/fail.\n` +
  `FRESHNESS: use the MOST RECENT fiscal year present in the excerpts; if several ` +
  `years appear, prefer the latest and IGNORE older ones. State which fiscal year ` +
  `the figures are for (e.g. "(FY2025-26)").\n` +
  `NIL IS A REAL ANSWER: if the item's figure/exposure is genuinely ZERO — the ` +
  `company reports none, or the line item is absent because there is nothing to ` +
  `report (no related-party transactions, no contingent liabilities, no goodwill, ` +
  `no promoter pledge, no group loans, etc.) — then set "value" to "Nil" or "₹0" ` +
  `EXPLICITLY. A true zero is a concrete favourable finding; do NOT report it as ` +
  `"not available". Reserve "not available" for when the figure genuinely can't be ` +
  `determined from the excerpts.\n`;

const LARGE_PASSAGE_CHARS = 12_000;

async function analyzeQualitative(item: EngineItem, evidence: Evidence): Promise<Analysis> {
  const passages = evidence.passages ?? [];
  if (!passages.length) return NA;

  const totalChars = passages.reduce((n, p) => n + p.text.length, 0);
  const role = totalChars > LARGE_PASSAGE_CHARS ? "longContext" : "reasoning";

  const prompt =
    `Checklist item: ${item.item}\n` +
    (item.description ? `Definition: ${item.description}\n` : "") +
    `\nRELEVANCE GATE — set "relevant" to false ONLY if these excerpts are about a ` +
    `CLEARLY DIFFERENT subject than this item (e.g. a revenue line for a contingent-` +
    `liability item, or a CSR officer for "family disputes"). Sharing some general ` +
    `topic counts as relevant. When in doubt, treat it as RELEVANT — do not reject ` +
    `merely because the passage is brief or indirect.\n` +
    `If relevant, answer for this item. ${RATIONALE_INSTRUCTION}` +
    `If the excerpts genuinely don't answer it, set "found" to false. Set "confident" ` +
    `to false when the passage is on-topic but thin (we keep a low-confidence verdict ` +
    `rather than discarding it). Put the exact supporting sentence (<=240 chars) in ` +
    `"evidenceQuote" and its page in "page".\n\n` +
    passagesBlock(passages);

  const res = await extract<QualExtract>(role, { prompt, temperature: 0 }, QUAL_SCHEMA);
  if (!res) return NA;
  const { data, provider } = res;
  if (!data.relevant || !data.found || !data.value) return NA;
  // Web-sourced facts (news / market data) are inherently softer than audited
  // filings — keep them low-confidence even when the model is sure.
  const confidence = evidence.from === "web" || data.confident === false ? "low" : "medium";
  return {
    value: data.value,
    rationale: cleanRationale(data.rationale),
    evidenceQuote: data.evidenceQuote,
    citation: citationForPage(evidence, data.page),
    confidence,
    providerUsed: provider,
  };
}

// ---- table-heavy notes (Gemini reads the note's figures) ----

function noteNameFor(item: EngineItem): string {
  if (item.sectionCode === "A7a") return "Contingent liabilities and commitments";
  if (item.sectionCode === "A5") return "Related party transactions";
  return "the relevant financial-statement note";
}

async function analyzeNote(item: EngineItem, evidence: Evidence): Promise<Analysis> {
  const passages = evidence.passages ?? [];
  if (!passages.length) return NA;

  // A contingent-liabilities/commitments note lists every category that applies,
  // so a category that ISN'T listed means the company has none — a real nil, not
  // a data gap. (Zero exposure then reads GREEN downstream.)
  const isContingency = item.sectionCode === "A7a";
  const absenceClause = isContingency
    ? `A contingent-liabilities/commitments note lists EVERY category that applies. ` +
      `If the note is present but THIS specific category (per the title above) is NOT ` +
      `listed, the company has NO such exposure — set "found" to true and "value" to ` +
      `"Nil" (₹0). Only set "found" to false if the note itself is absent/unreadable.`
    : `If relevant but THIS item's figure isn't present, set "found" to false.`;

  const prompt =
    `You are reading the "${noteNameFor(item)}" note from an annual report. PDF tables ` +
    `are often flattened into messy text — reconstruct the figures carefully.\n` +
    `Checklist item: ${item.item}\n` +
    (item.description ? `Definition: ${item.description}\n` : "") +
    `\nExtract ONLY the figure(s) for THIS SPECIFIC item (per its title above) — in Rs crore, ` +
    `with the year if shown — and IGNORE other figures in the note (e.g. for "Corporate ` +
    `guarantees given" report only guarantees, not tax disputes or capital commitments). ` +
    `Prefer the most recent year. ${RATIONALE_INSTRUCTION}` +
    `The "rationale" must quote the actual Rs-crore figures (and the comparative year ` +
    `if shown) and note the trend. RELEVANCE: set "relevant" to false ONLY if these ` +
    `excerpts are clearly a different note. ${absenceClause} Set "confident" to false if ` +
    `the figures are unclear/partial. Put the exact supporting line in "evidenceQuote" ` +
    `and its page in "page".\n\n` +
    passagesBlock(passages);

  // Gemini (longContext) is best at reconstructing flattened tables; the quota
  // layer falls back through the chain if it is unavailable. A genuine provider
  // failure degrades to NA (quota errors still propagate → DEFER).
  const res = await extract<QualExtract>("longContext", { prompt, temperature: 0 }, QUAL_SCHEMA);
  if (!res) return NA;
  const { data, provider } = res;
  if (!data.relevant || !data.found || !data.value) return NA;
  return {
    value: data.value,
    rationale: cleanRationale(data.rationale),
    evidenceQuote: data.evidenceQuote,
    citation: citationForPage(evidence, data.page),
    confidence: data.confident === false ? "low" : "medium",
    providerUsed: provider,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Trim a model rationale; drop it if empty or a bare echo of nothing useful. */
function cleanRationale(s: string | undefined | null): string | undefined {
  const t = (s ?? "").trim();
  if (t.length < 8) return undefined;
  return t.slice(0, 600);
}
