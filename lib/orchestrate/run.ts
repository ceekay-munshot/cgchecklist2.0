import pLimit from "p-limit";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { evaluateItem } from "@/lib/engine/evaluateItem";
import { fromPrismaItem } from "@/lib/engine/types";
import { QuotaExhaustedError } from "@/lib/engine/quota";

/**
 * Concurrency for per-item evaluation. Default 2 keeps the request rate under
 * free-tier per-minute limits (so 429s are rare and the long 429 backoff can
 * ride out the few that occur, completing in a single run). Overridable via env.
 */
const CONCURRENCY = Number(process.env.ANALYZE_CONCURRENCY) || 2;

/** Statuses that are terminal for a pass — skipped on re-run. */
const TERMINAL = new Set(["DONE", "NEEDS_REVIEW"]);

// ---------------------------------------------------------------------------
// Summary + non-negotiable gate (pure)
// ---------------------------------------------------------------------------

export interface SectionRollup {
  code: string;
  name: string;
  green: number;
  red: number;
  neutral: number;
  na: number;
  total: number;
}

export interface RunSummary {
  complete: boolean;
  itemsTotal: number;
  itemsDone: number;
  itemsNeedsReview: number;
  itemsError: number;
  itemsDeferred: number;
  itemsPending: number;
  totals: { green: number; red: number; neutral: number; na: number };
  totalReds: number;
  bySection: SectionRollup[];
  /** Fail if ANY non-negotiable item is RED; pass otherwise. */
  nonNegotiable: { gatePass: boolean; failedItems: string[] };
}

export interface RunOutcome {
  runId: string;
  status: "DONE" | "PARTIAL";
  summary: RunSummary;
  deferred: number;
  pruned: boolean;
}

type SummItem = { id: string; sectionCode: string; isNonNegotiable: boolean };
type SummSection = { code: string; name: string };
type SummResult = { itemId: string; status: string; flag: string | null };

/** Roll up per-section flag counts, total reds, and the non-negotiable gate. Pure. */
export function summarize(
  items: SummItem[],
  sections: SummSection[],
  results: SummResult[],
): RunSummary {
  const byId = new Map(results.map((r) => [r.itemId, r]));
  const secMap = new Map<string, SectionRollup>();
  for (const s of sections) {
    secMap.set(s.code, { code: s.code, name: s.name, green: 0, red: 0, neutral: 0, na: 0, total: 0 });
  }
  const ensureSection = (code: string): SectionRollup => {
    let sec = secMap.get(code);
    if (!sec) {
      sec = { code, name: code, green: 0, red: 0, neutral: 0, na: 0, total: 0 };
      secMap.set(code, sec);
    }
    return sec;
  };

  const totals = { green: 0, red: 0, neutral: 0, na: 0 };
  let totalReds = 0;
  const failedItems: string[] = [];
  let itemsDone = 0;
  let itemsNeedsReview = 0;
  let itemsError = 0;
  let itemsDeferred = 0;
  let itemsPending = 0;

  for (const it of items) {
    const sec = ensureSection(it.sectionCode);
    sec.total++;
    const r = byId.get(it.id);

    switch (r?.status) {
      case "DONE":
        itemsDone++;
        break;
      case "NEEDS_REVIEW":
        itemsNeedsReview++;
        break;
      case "ERROR":
        itemsError++;
        break;
      case "DEFERRED":
        itemsDeferred++;
        break;
      default:
        itemsPending++;
    }

    switch (r?.flag) {
      case "GREEN":
        sec.green++;
        totals.green++;
        break;
      case "RED":
        sec.red++;
        totals.red++;
        totalReds++;
        if (it.isNonNegotiable) failedItems.push(it.id);
        break;
      case "NEUTRAL":
        sec.neutral++;
        totals.neutral++;
        break;
      case "NOT_AVAILABLE":
        sec.na++;
        totals.na++;
        break;
      default:
        break; // unprocessed — counted via itemsPending, not a flag bucket
    }
  }

  const itemsTotal = items.length;
  const complete = itemsPending === 0 && itemsError === 0 && itemsDeferred === 0;
  return {
    complete,
    itemsTotal,
    itemsDone,
    itemsNeedsReview,
    itemsError,
    itemsDeferred,
    itemsPending,
    totals,
    totalReds,
    bySection: sections.length ? sections.map((s) => secMap.get(s.code)!) : [...secMap.values()],
    nonNegotiable: { gatePass: failedItems.length === 0, failedItems },
  };
}

// ---------------------------------------------------------------------------
// runAnalysis — resumable, quota-aware, concurrency-limited
// ---------------------------------------------------------------------------

/**
 * Evaluate ALL checklist items for a run, persisting each ItemResult as it
 * finishes. RESUMABLE: only non-terminal items (PENDING / ERROR / DEFERRED) are
 * processed — DONE / NEEDS_REVIEW are skipped, so a re-run continues where it
 * stopped. QUOTA-AWARE: when the LLM providers are exhausted, the item is
 * DEFERRED (Tier-1 zero-LLM numeric items still complete); the run is left
 * PARTIAL so the next run/day resumes. On full completion the run is DONE and
 * heavy document text is pruned.
 */
export async function runAnalysis(runId: string): Promise<RunOutcome> {
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`run ${runId} not found`);

  const [items, sections, existing] = await Promise.all([
    prisma.checklistItem.findMany({ orderBy: [{ sectionCode: "asc" }, { orderIndex: "asc" }] }),
    prisma.checklistSection.findMany({ orderBy: { orderIndex: "asc" } }),
    prisma.itemResult.findMany({ where: { runId }, select: { itemId: true, status: true } }),
  ]);

  const terminalIds = new Set(existing.filter((r) => TERMINAL.has(r.status)).map((r) => r.itemId));
  const todo = items.filter((i) => !terminalIds.has(i.id));

  await prisma.analysisRun.update({
    where: { id: runId },
    data: { status: "PROCESSING", itemsTotal: items.length, lastProcessedAt: new Date() },
  });

  const limit = pLimit(CONCURRENCY);
  let deferred = 0;
  await Promise.all(
    todo.map((ci) =>
      limit(async () => {
        try {
          // Tier-1 zero-LLM numeric items complete here even when LLM quota is
          // gone; LLM items throw QuotaExhaustedError and are deferred below.
          await evaluateItem(fromPrismaItem(ci), runId);
        } catch (e) {
          if (e instanceof QuotaExhaustedError) {
            deferred++;
            await markStatus(runId, ci.id, "DEFERRED", (e as Error).message);
          } else {
            // evaluateItem persists its own ERROR result; this is a defensive net.
            await markStatus(runId, ci.id, "ERROR", (e as Error).message);
          }
        }
      }),
    ),
  );

  const results = await prisma.itemResult.findMany({
    where: { runId },
    select: { itemId: true, status: true, flag: true },
  });
  const summary = summarize(items, sections, results);
  const status: "DONE" | "PARTIAL" = summary.complete ? "DONE" : "PARTIAL";

  await prisma.analysisRun.update({
    where: { id: runId },
    data: {
      status,
      summaryJson: summary as unknown as Prisma.InputJsonValue,
      itemsTotal: summary.itemsTotal,
      itemsDone: summary.itemsDone,
      itemsError: summary.itemsError,
      lastProcessedAt: new Date(),
    },
  });

  let pruned = false;
  if (status === "DONE") {
    await pruneRunText(runId);
    pruned = true;
  }

  return { runId, status, summary, deferred, pruned };
}

async function markStatus(
  runId: string,
  itemId: string,
  status: "DEFERRED" | "ERROR",
  note: string,
): Promise<void> {
  const lastError = note.slice(0, 300);
  await prisma.itemResult
    .upsert({
      where: { runId_itemId: { runId, itemId } },
      create: { runId, itemId, status, attempts: 1, lastError, processedAt: new Date() },
      update: { status, attempts: { increment: 1 }, lastError, processedAt: new Date() },
    })
    .catch(() => {});
}

/**
 * Storage thrift: once a run is DONE, drop the heavy document `extractedText`,
 * keeping ONLY structuredData (SCREENER_PAGE), the ItemResults (evidence quotes
 * + source refs + page), and SourceDoc metadata incl. sourceUrl (so a doc can be
 * re-fetched on demand). Only ever called on completion — text is kept while a
 * run is in-progress / PARTIAL across days.
 */
export async function pruneRunText(runId: string): Promise<number> {
  const res = await prisma.sourceDoc.updateMany({
    where: { runId, extractedText: { not: null } },
    data: { extractedText: null },
  });
  return res.count;
}

// ---------------------------------------------------------------------------
// Queue drainer (doubles as the on-demand queue)
// ---------------------------------------------------------------------------

/**
 * Process eligible runs (HARVESTED or PARTIAL) in creation order — once each per
 * drain. The next drain/day picks up any run still PARTIAL.
 */
export async function drainQueue(opts?: { limit?: number }): Promise<RunOutcome[]> {
  const max = opts?.limit ?? Infinity;
  const runs = await prisma.analysisRun.findMany({
    where: { status: { in: ["HARVESTED", "PARTIAL"] } },
    orderBy: { createdAt: "asc" },
  });
  const outcomes: RunOutcome[] = [];
  for (const run of runs) {
    if (outcomes.length >= max) break;
    outcomes.push(await runAnalysis(run.id));
  }
  return outcomes;
}
