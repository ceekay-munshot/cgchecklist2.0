import { callJSON } from "./llm";
import { QuotaExhaustedError } from "./quota";
import { parseNumericValue } from "./thresholds";
import {
  NOT_AVAILABLE,
  type Analysis,
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
  // Table-heavy financial-statement notes → Gemini reads the note's figures.
  if (evidence.mode === "note") {
    return analyzeNote(item, evidence);
  }
  // Board composition is the one numeric-from-document extractor (A1-01).
  if (item.id === "A1-01") {
    return analyzeNumericFromPassages(item, evidence);
  }
  // Audit-committee composition lives in a governance-report table; extract the
  // quantified facts (independent/total members, meetings) so the deterministic
  // A2-01 categorical rule can decide compliance instead of returning NA.
  if (item.id === "A2-01") {
    return analyzeAuditCommittee(item, evidence);
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
  return {
    value: `${round1(pct)}% independent${counts}`,
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
  return {
    value,
    evidenceQuote: data.evidenceQuote,
    citation: citationForPage(evidence, data.page),
    confidence: parts.length ? "high" : "low",
    providerUsed: provider,
  };
}

// ---- qualitative (Mistral / Gemini) ----

interface QualExtract {
  relevant: boolean;
  found: boolean;
  confident?: boolean;
  value?: string;
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
    evidenceQuote: { type: "string" },
    page: { type: ["integer", "null"] },
  },
  required: ["relevant", "found"],
  additionalProperties: false,
} as const;

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
    `If relevant, state the CONCISE fact for this item (a short phrase, not a paragraph). ` +
    `Do NOT decide green/red — just the fact. If the excerpts genuinely don't answer it, ` +
    `set "found" to false. Set "confident" to false when the passage is on-topic but thin ` +
    `(we keep a low-confidence verdict rather than discarding it). Put the exact supporting ` +
    `sentence (<=240 chars) in "evidenceQuote" and its page in "page".\n\n` +
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

  const prompt =
    `You are reading the "${noteNameFor(item)}" note from an annual report. PDF tables ` +
    `are often flattened into messy text — reconstruct the figures carefully.\n` +
    `Checklist item: ${item.item}\n` +
    (item.description ? `Definition: ${item.description}\n` : "") +
    `\nExtract ONLY the figure(s) for THIS SPECIFIC item (per its title above) — in Rs crore, ` +
    `with the year if shown — and IGNORE other figures in the note (e.g. for "Corporate ` +
    `guarantees given" report only guarantees, not tax disputes or capital commitments). ` +
    `Prefer the most recent year. Summarise in "value" as a concise factual statement ` +
    `INCLUDING the key number(s) for this item. RELEVANCE: set "relevant" to false ONLY if ` +
    `these excerpts are clearly a different note. If relevant but THIS item's figure isn't ` +
    `present, set "found" to false. Set "confident" to false if the figures are unclear/` +
    `partial. Put the exact supporting line in "evidenceQuote" and its page in "page".\n\n` +
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
    evidenceQuote: data.evidenceQuote,
    citation: citationForPage(evidence, data.page),
    confidence: data.confident === false ? "low" : "medium",
    providerUsed: provider,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
