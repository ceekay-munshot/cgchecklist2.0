import { callJSON } from "./llm";
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

function trendOf(values: Array<string | null>): string {
  const f = parseNumericValue(firstNonNull(values));
  const l = parseNumericValue(latestNonNull(values));
  if (f == null || l == null) return "n/a";
  if (l > f + 0.5) return "rising";
  if (l < f - 0.5) return "declining";
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
  if (evidence.kind === "NUMERIC") {
    return analyzeNumericFromPassages(item, evidence);
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
    found: { type: "boolean" },
    independentDirectors: { type: ["integer", "null"] },
    totalDirectors: { type: ["integer", "null"] },
    percentIndependent: { type: ["number", "null"] },
    evidenceQuote: { type: "string" },
    page: { type: ["integer", "null"] },
  },
  required: ["found"],
  additionalProperties: false,
} as const;

async function analyzeNumericFromPassages(item: EngineItem, evidence: Evidence): Promise<Analysis> {
  const passages = evidence.passages ?? [];
  if (!passages.length) return NA;

  const prompt =
    `Checklist item: ${item.item}\n` +
    (item.description ? `Definition: ${item.description}\n` : "") +
    `\nFrom these annual-report excerpts, determine the board composition. ` +
    `Count INDEPENDENT directors and TOTAL directors, and compute ` +
    `percentIndependent = independent / total * 100. Use the most complete/recent statement. ` +
    `If the excerpts do not state it, set "found" to false. ` +
    `Put the exact supporting sentence (<=200 chars) in "evidenceQuote" and its page number in "page".\n\n` +
    passagesBlock(passages);

  try {
    const { data, provider } = await callJSON<BoardExtract>("bulkClassify", { prompt, temperature: 0 }, BOARD_SCHEMA);
    if (!data.found) return NA;
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
  } catch {
    return NA;
  }
}

// ---- qualitative (Mistral / Gemini) ----

interface QualExtract {
  found: boolean;
  value?: string;
  evidenceQuote?: string;
  page?: number | null;
}

const QUAL_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    value: { type: "string" },
    evidenceQuote: { type: "string" },
    page: { type: ["integer", "null"] },
  },
  required: ["found"],
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
    `\nFrom the excerpts below, state the CONCISE fact relevant to this item ` +
    `(a short phrase, not a paragraph — e.g. an auditor's name and whether it is a ` +
    `Big Four / reputed firm; or a one-line view). Do NOT decide green/red here — ` +
    `just the fact. If the excerpts do not support an answer, set "found" to false. ` +
    `Put the exact supporting sentence (<=240 chars) in "evidenceQuote" and its page in "page".\n\n` +
    passagesBlock(passages);

  try {
    const { data, provider } = await callJSON<QualExtract>(role, { prompt, temperature: 0 }, QUAL_SCHEMA);
    if (!data.found || !data.value) return NA;
    return {
      value: data.value,
      evidenceQuote: data.evidenceQuote,
      citation: citationForPage(evidence, data.page),
      confidence: "medium",
      providerUsed: provider,
    };
  } catch {
    return NA;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
