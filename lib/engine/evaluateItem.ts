import { prisma } from "@/lib/db";
import { getEvidence, evidenceStrategyFor, loadCompanyScale } from "./evidence";
import { analyzeItem } from "./analyzeItem";
import { assignFlag } from "./flag";
import { QuotaExhaustedError } from "./quota";
import {
  kindOf,
  type Analysis,
  type EngineItem,
  type FlagResult,
  type ItemEvaluation,
} from "./types";

const CONFIDENCE_SCORE: Record<Analysis["confidence"], number> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

function providersFrom(analysis: Analysis, flagRes: FlagResult): string[] {
  const set = new Set<string>();
  for (const p of [analysis.providerUsed, flagRes.providerUsed]) {
    if (!p) continue;
    for (const one of p.split("+")) if (one) set.add(one);
  }
  return [...set];
}

/**
 * The reader-facing answer. When the extractor produced a reasoned `rationale`
 * (the specific figures/dates and why they matter) we lead with it and append
 * the flag engine's compliance reason — giving a detailed 2-3 sentence answer.
 * Otherwise we fall back to the concise `value — reason` one-liner.
 */
export function buildVerdict(item: EngineItem, analysis: Analysis, flagRes: FlagResult): string {
  if (flagRes.flag === "NOT_AVAILABLE") {
    return evidenceStrategyFor(item).expectedNa
      ? "Expected NA — not disclosed in filings; this is a web/market-data item."
      : "Not available — no supporting evidence found.";
  }
  const reason = (flagRes.reason ?? "").trim();
  const rationale = analysis.rationale?.trim();
  if (rationale) {
    const withReason =
      reason && !rationale.toLowerCase().includes(reason.toLowerCase())
        ? `${rationale} ${reason}`
        : rationale;
    return withReason.slice(0, 700);
  }
  const value = (analysis.value ?? "").trim();
  const hasValue = value && value.toLowerCase() !== "not available";
  const v =
    kindOf(item) === "NUMERIC" || !hasValue
      ? reason || value
      : reason && !reason.includes(value)
        ? `${value} — ${reason}`
        : value;
  return v.slice(0, 700);
}

/**
 * Evaluate a single checklist item against a run's harvested SourceDocs:
 *   getEvidence -> analyzeItem -> assignFlag
 * Returns a full ItemResult-shaped object and upserts the ItemResult row
 * (resumable per-item state). Never throws — failures become an ERROR result.
 */
export async function evaluateItem(item: EngineItem, runId: string): Promise<ItemEvaluation> {
  const kind = kindOf(item);
  try {
    const evidence = await getEvidence(item, runId);
    const analysis = await analyzeItem(item, evidence);
    // Company size (Tier-1) lets assignFlag scale ₹-amounts for materiality.
    const scale = await loadCompanyScale(runId);
    const flagRes = await assignFlag(item, analysis, { scale, web: evidence.from === "web" });

    const result: ItemEvaluation = {
      itemId: item.id,
      runId,
      sectionCode: item.sectionCode,
      item: item.item,
      kind,
      flag: flagRes.flag,
      verdict: buildVerdict(item, analysis, flagRes),
      value: analysis.value,
      evidenceQuote: analysis.evidenceQuote,
      citation: analysis.citation ?? evidence.citation,
      confidence: analysis.confidence,
      isNonNegotiable: item.isNonNegotiable,
      gatePass: flagRes.gatePass ?? null,
      needsReview: !!flagRes.needsReview,
      providersUsed: providersFrom(analysis, flagRes),
      status: flagRes.needsReview ? "NEEDS_REVIEW" : "DONE",
    };
    await persist(result);
    return result;
  } catch (e) {
    // Quota exhaustion is not an item error — let the orchestrator DEFER it.
    if (e instanceof QuotaExhaustedError) throw e;
    const result: ItemEvaluation = {
      itemId: item.id,
      runId,
      sectionCode: item.sectionCode,
      item: item.item,
      kind,
      flag: "NOT_AVAILABLE",
      verdict: `Error: ${(e as Error).message}`.slice(0, 280),
      value: "not available",
      confidence: "low",
      isNonNegotiable: item.isNonNegotiable,
      gatePass: null,
      needsReview: false,
      providersUsed: [],
      status: "ERROR",
      error: (e as Error).message,
    };
    await persist(result).catch(() => {});
    return result;
  }
}

/** Upsert the resumable ItemResult row for this (run, item). Best-effort. */
async function persist(r: ItemEvaluation): Promise<void> {
  const data = {
    status: r.status,
    flag: r.flag,
    verdict: r.verdict,
    value: r.value.slice(0, 200),
    evidenceQuote: r.evidenceQuote ?? null,
    sourceDocId: r.citation?.sourceDocId ?? null,
    sourcePage: r.citation?.page ?? null,
    sourceUrl: r.citation?.sourceUrl ?? null,
    confidence: CONFIDENCE_SCORE[r.confidence],
    isNonNegotiable: r.isNonNegotiable,
    gatePass: r.gatePass,
    providerUsed: r.providersUsed.join("+") || null,
    lastError: r.error ?? null,
    processedAt: new Date(),
  };
  try {
    await prisma.itemResult.upsert({
      where: { runId_itemId: { runId: r.runId, itemId: r.itemId } },
      create: { runId: r.runId, itemId: r.itemId, attempts: 1, ...data },
      update: { ...data, attempts: { increment: 1 } },
    });
  } catch {
    // best-effort: a persistence failure must not break evaluation
  }
}
