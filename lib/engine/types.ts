import type { ChecklistItem, SourceDocType } from "@prisma/client";
import { itemKind, type ItemKind } from "@/lib/checklist";

export type { ItemKind };

/** The four flags every item resolves to. Mirrors the Prisma `Flag` enum. NO numeric score. */
export type Flag = "GREEN" | "RED" | "NEUTRAL" | "NOT_AVAILABLE";

/** Model confidence (NOT a governance score). */
export type Confidence = "high" | "medium" | "low";

/**
 * Normalised checklist item the engine operates on (camelCase). Built from a
 * Prisma `ChecklistItem` (DB) — see `fromPrismaItem`.
 */
export interface EngineItem {
  id: string;
  sectionCode: string;
  item: string;
  description?: string | null;
  outputFormat?: string | null;
  greenFlag?: string | null;
  redFlag?: string | null;
  sourceHint?: string | null;
  isNonNegotiable: boolean;
}

export function fromPrismaItem(ci: ChecklistItem): EngineItem {
  return {
    id: ci.id,
    sectionCode: ci.sectionCode,
    item: ci.item,
    description: ci.description,
    outputFormat: ci.outputFormat,
    greenFlag: ci.greenFlag,
    redFlag: ci.redFlag,
    sourceHint: ci.sourceHint,
    isNonNegotiable: ci.isNonNegotiable,
  };
}

/** NUMERIC vs QUALITATIVE, from the item's output format. */
export function kindOf(item: EngineItem): ItemKind {
  return itemKind({ output_format: item.outputFormat });
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Where an item's evidence comes from. */
export type EvidenceFrom = "screener" | "document" | "web";

/**
 * Numeric values COMPUTED deterministically from the Tier-1 structuredData
 * (financials we already harvested) — no LLM. See `lib/engine/numeric.ts`.
 */
export type ComputedNumericKind =
  | "debtToEquity" // Borrowings ÷ (Equity + Reserves)
  | "cfoToPat" // cumulative CFO ÷ PAT (accruals / cash backing)
  | "cfoToEbitda" // latest CFO ÷ Operating Profit (cash conversion)
  | "taxRate" // effective tax rate (P&L Tax %)
  | "receivableDaysProxy" // debtor days (DSO) — proxy for >6-month ageing
  | "cashEpsRatio" // (PAT + Depreciation) ÷ PAT — cash vs accounting EPS
  | "freeFloat"; // 100 − promoter holding %

/** A Tier-1 structured field to read from the SCREENER_PAGE structuredData. */
export type ScreenerField =
  | { kind: "ratio"; match: RegExp; label: string }
  | { kind: "shareholding"; series: "promoters" | "pledged"; label: string }
  | { kind: ComputedNumericKind; label: string };

export interface EvidenceStrategy {
  from: EvidenceFrom;
  /** "screener": which structured fields to read. */
  screenerFields?: ScreenerField[];
  /** "document": which SourceDoc types to search, and the keywords to match. */
  docTypes?: SourceDocType[];
  /**
   * "document": financial-statement NOTE / governance section headings to locate
   * and extract whole (preferred over keyword scoring; e.g. "Contingent
   * liabilities and commitments", "Related party transactions", "Audit Committee").
   */
  sections?: string[];
  keywords?: string[];
  /** Allow a web fallback when the primary (document) source yields nothing. */
  webFallback?: boolean;
  /** Extra query terms for the web fallback (combined with the company name). */
  webQuery?: string;
}

export interface EvidenceCitation {
  sourceDocId?: string;
  sourceUrl?: string;
  page?: number | null;
  docType?: SourceDocType;
  docName?: string;
}

export interface EvidencePassage {
  text: string;
  citation: EvidenceCitation;
}

export interface Evidence {
  status: "found" | "not_available";
  from: EvidenceFrom;
  kind: ItemKind;
  /** Tier-1 structured key/value(s) (e.g. { "Debt to equity": "0.09" }). */
  structured?: Record<string, string>;
  /** Optional series (e.g. promoter holding across periods) for trend items. */
  series?: { label: string; periods: string[]; values: Array<string | null> };
  /** Retrieved passages for document/web items. */
  passages?: EvidencePassage[];
  /** The primary citation to attach to the result. */
  citation?: EvidenceCitation;
  note?: string;
}

// ---------------------------------------------------------------------------
// Analysis + flag
// ---------------------------------------------------------------------------

export interface Analysis {
  /** Concise fact, or the literal "not available". */
  value: string;
  evidenceQuote?: string;
  citation?: EvidenceCitation;
  confidence: Confidence;
  /** The provider that produced this (e.g. "groq", "mistral", or "deterministic"). */
  providerUsed?: string;
}

export interface FlagResult {
  flag: Flag;
  reason: string;
  /** Non-negotiable gate outcome (green=true, red=false, else null). null when not applicable. */
  gatePass?: boolean | null;
  needsReview?: boolean;
  providerUsed?: string;
}

/** The full ItemResult-shaped object returned by evaluateItem. */
export interface ItemEvaluation {
  itemId: string;
  runId: string;
  sectionCode: string;
  item: string;
  kind: ItemKind;
  flag: Flag;
  verdict: string;
  value: string;
  evidenceQuote?: string;
  citation?: EvidenceCitation;
  confidence: Confidence;
  isNonNegotiable: boolean;
  gatePass: boolean | null;
  needsReview: boolean;
  providersUsed: string[];
  status: "DONE" | "NEEDS_REVIEW" | "ERROR";
  error?: string;
}

/** The literal sentinel an analysis returns when there is no usable evidence. */
export const NOT_AVAILABLE = "not available";

export function isNotAvailable(value: string | null | undefined): boolean {
  return !value || value.trim().toLowerCase() === NOT_AVAILABLE;
}

// ---------------------------------------------------------------------------
// Backwards-compatible exports for the legacy lib/orchestrate stub.
// ---------------------------------------------------------------------------

export interface Evaluation {
  flag: Flag;
  verdict: string;
  evidence?: string;
  source?: string;
  provider?: string;
}
