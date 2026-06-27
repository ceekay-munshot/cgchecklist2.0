import { prisma } from "@/lib/db";
import { getEvidence } from "./evidence";
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

function buildVerdict(item: EngineItem, analysis: Analysis, flagRes: FlagResult): string {
  if (flagRes.flag === "NOT_AVAILABLE") return "Not available — no supporting evidence found.";
  const v =
    kindOf(item) === "NUMERIC" ? flagRes.reason : `${analysis.value} — ${flagRes.reason}`;
  return v.slice(0, 280);
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
    const flagRes = await assignFlag(item, analysis);

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
