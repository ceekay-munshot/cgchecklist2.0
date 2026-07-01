import { prisma } from "@/lib/db";
import { analyzeItem } from "@/lib/engine/analyzeItem";
import { assignFlag } from "@/lib/engine/flag";
import { loadCompanyScale } from "@/lib/engine/evidence";
import { fromPrismaItem, kindOf, type Evidence } from "@/lib/engine/types";
import { runAllLanes, type LaneSection } from "./lanes";
import { munsConfigured, munsEnv, defaultDateWindow, type MunsQueryContext } from "./client";

/**
 * MUNS backfill — fill the REMAINING (currently NOT_AVAILABLE) parameters.
 *
 * SAFETY: the target set is chosen from DATA, not a hardcoded list — only items
 * whose current committed flag is NOT_AVAILABLE (or that were never answered) are
 * touched. Every already-working parameter (the Tier-1 numerics + reached
 * document items) is left exactly as it is. Each MUNS answer is fed through the
 * repo's EXISTING classifier (analyzeItem → assignFlag), so backfilled params
 * produce the SAME ItemResult record + green/red verdict shape as wired ones.
 */

const CONFIDENCE_SCORE = { high: 0.9, medium: 0.6, low: 0.3 } as const;
const COMMITTED = new Set(["DONE", "NEEDS_REVIEW"]);

export interface BackfillOutcome {
  skipped?: boolean;
  reason?: string;
  targets: number;
  fetched: number; // MUNS returned a usable answer
  filled: number; // produced a non-NA flag and was written
  byFlag: Record<string, number>;
}

export async function munsBackfill(
  runId: string,
  opts: { lanes?: number; log?: (msg: string) => void } = {},
): Promise<BackfillOutcome> {
  const log = opts.log ?? (() => {});
  const empty: BackfillOutcome = { targets: 0, fetched: 0, filled: 0, byFlag: {} };
  if (!munsConfigured()) return { ...empty, skipped: true, reason: "MUNS_TOKEN not set" };

  const run = await prisma.analysisRun.findUnique({ where: { id: runId }, include: { company: true } });
  if (!run) return { ...empty, skipped: true, reason: `run ${runId} not found` };

  const [items, sections, results] = await Promise.all([
    prisma.checklistItem.findMany({ orderBy: [{ sectionCode: "asc" }, { orderIndex: "asc" }] }),
    prisma.checklistSection.findMany({ orderBy: { orderIndex: "asc" } }),
    prisma.itemResult.findMany({ where: { runId }, select: { itemId: true, status: true, flag: true } }),
  ]);
  const resultByItem = new Map(results.map((r) => [r.itemId, r]));

  // Target = blanks only: no committed result, or a committed NOT_AVAILABLE.
  const targets = items.filter((it) => {
    const r = resultByItem.get(it.id);
    if (!r || !COMMITTED.has(r.status)) return true;
    return r.flag == null || r.flag === "NOT_AVAILABLE";
  });
  if (!targets.length) return { ...empty, reason: "no blank parameters" };

  // Build lane sections (grouped by section; sequential 1..N numbering in order).
  const sectionMeta = new Map(sections.map((s, i) => [s.code, { number: i + 1, title: s.name }]));
  const bySection = new Map<string, LaneSection>();
  for (const it of targets) {
    const meta = sectionMeta.get(it.sectionCode) ?? { number: bySection.size + 1, title: it.sectionCode };
    let sec = bySection.get(it.sectionCode);
    if (!sec) {
      sec = { code: it.sectionCode, number: meta.number, title: meta.title, params: [] };
      bySection.set(it.sectionCode, sec);
    }
    sec.params.push({ id: it.id, sectionCode: it.sectionCode, sectionNumber: meta.number, sectionTitle: meta.title, text: it.item });
  }
  const laneSections = [...bySection.values()];

  const ctx: MunsQueryContext = {
    ticker: run.company.ticker ?? run.company.name,
    companyName: run.company.name,
    ...defaultDateWindow(),
  };
  log(`MUNS backfill: ${targets.length} blank parameters across ${laneSections.length} sections`);

  let done = 0;
  const answers = await runAllLanes(laneSections, munsEnv(), ctx, {
    lanes: opts.lanes,
    onProgress: (id, ok) => {
      done++;
      log(`  [${done}/${targets.length}] ${id} ${ok ? "✓" : "✗"}`);
    },
  });

  const scale = await loadCompanyScale(runId);
  const outcome: BackfillOutcome = { targets: targets.length, fetched: 0, filled: 0, byFlag: {} };

  for (const it of targets) {
    const a = answers.get(it.id);
    if (!a || !a.ok || !a.answer || a.answer.startsWith("[Error]")) continue;
    outcome.fetched++;
    try {
      const engineItem = fromPrismaItem(it);
      const evidence: Evidence = {
        status: "found",
        from: "web", // MUNS is web-search-backed research → existing web guards apply (a RED is softened to NEUTRAL)
        kind: kindOf(engineItem),
        passages: [{ text: a.answer, citation: { docName: "MUNS research" } }],
        citation: { docName: "MUNS research" },
      };
      const analysis = await analyzeItem(engineItem, evidence);
      const flagRes = await assignFlag(engineItem, analysis, { scale, web: true });

      // Only WRITE when we produced a real verdict — never overwrite a blank with a blank.
      if (flagRes.flag === "NOT_AVAILABLE") continue;

      const verdict = (kindOf(engineItem) === "NUMERIC" ? flagRes.reason : `${analysis.value} — ${flagRes.reason}`).slice(0, 280);
      const providers = ["muns", analysis.providerUsed].filter(Boolean).join("+");
      await persist(runId, it.id, {
        status: flagRes.needsReview ? "NEEDS_REVIEW" : "DONE",
        flag: flagRes.flag,
        verdict,
        value: (analysis.value ?? "").slice(0, 200),
        evidenceQuote: analysis.evidenceQuote ?? null,
        sourceUrl: null,
        confidence: CONFIDENCE_SCORE[analysis.confidence],
        isNonNegotiable: it.isNonNegotiable,
        gatePass: flagRes.gatePass ?? null,
        providerUsed: providers || "muns",
      });
      outcome.filled++;
      outcome.byFlag[flagRes.flag] = (outcome.byFlag[flagRes.flag] ?? 0) + 1;
    } catch (e) {
      log(`  ${it.id} classify error: ${(e as Error).message}`);
    }
  }

  log(`MUNS backfill done: fetched ${outcome.fetched}, filled ${outcome.filled} (${JSON.stringify(outcome.byFlag)})`);
  return outcome;
}

async function persist(
  runId: string,
  itemId: string,
  data: {
    status: string;
    flag: "GREEN" | "RED" | "NEUTRAL" | "NOT_AVAILABLE";
    verdict: string;
    value: string;
    evidenceQuote: string | null;
    sourceUrl: string | null;
    confidence: number;
    isNonNegotiable: boolean;
    gatePass: boolean | null;
    providerUsed: string;
  },
): Promise<void> {
  const payload = {
    status: data.status as never,
    flag: data.flag as never,
    verdict: data.verdict,
    value: data.value,
    evidenceQuote: data.evidenceQuote,
    sourceUrl: data.sourceUrl,
    confidence: data.confidence,
    isNonNegotiable: data.isNonNegotiable,
    gatePass: data.gatePass,
    providerUsed: data.providerUsed,
    processedAt: new Date(),
  };
  await prisma.itemResult.upsert({
    where: { runId_itemId: { runId, itemId } },
    create: { runId, itemId, attempts: 1, ...payload },
    update: { ...payload, attempts: { increment: 1 } },
  });
}
