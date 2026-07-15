import { prisma } from "@/lib/db";
import { analyzeItem } from "@/lib/engine/analyzeItem";
import { buildVerdict } from "@/lib/engine/evaluateItem";
import { assignFlag } from "@/lib/engine/flag";
import { loadCompanyScale } from "@/lib/engine/evidence";
import { fromPrismaItem, kindOf, serializeTable, type Evidence } from "@/lib/engine/types";
import { summarize } from "@/lib/orchestrate";
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

/**
 * Sharper research directives for promoter/management-INTEGRITY items. Left to the
 * bare item text, MUNS returns a generic "no external track record" — it doesn't
 * distinguish a genuinely clean promoter from one it simply didn't dig into (the
 * AFCOM promoter-reputation miss). These directives tell it to actively hunt each
 * NAMED person's adverse history across all time and sources. Appended to the
 * question; the 3-bullet answer format is unchanged.
 */
const ADVERSE_HUNT_DIRECTIVE: Record<string, string> = {
  "A1-05":
    "Do NOT just count directorships (that is a separate item). For EACH board member INDIVIDUALLY, by full name — especially the INDEPENDENT directors — research their PERSONAL reputation and integrity: search news, Valuepickr, MCA, and SEBI/CBI/ED/court records for any fraud, default, ban, disqualification, arrest, bail, or serious controversy at ANY company or public role, past or present. Give a per-director verdict: name → standing/credibility → any red flag WITH the entity, year and source. If a director is genuinely clean after a thorough search, say so per name; do NOT infer a clean record from absence.",
  "A9-04":
    "For EACH named promoter and director INDIVIDUALLY (by full name), actively search ALL history and sources — news, Valuepickr and investor forums, MCA filings, credit-rating rationales, and SEBI/NCLT/court/tribunal records — for any past business failure, default, insolvency, fraud, siphoning, litigation, regulatory action, or resignation-under-cloud at OTHER companies. Report each with the entity and year. Only if a thorough search finds nothing, say 'no adverse record found' — do NOT infer a clean record from absence.",
  "A13-01":
    "Assess management depth AND the promoter/CEO's credibility by full name: prior ventures and how they fared, any failures, litigation or controversy — search news and forums, not just the current role.",
  "A13-02":
    "Assess the CEO/MD's actual track record and credibility by full name: past ventures and outcomes, capital-allocation history, and any failure, litigation or controversy — search news and investor forums, not just the current designation.",
  "A13-07":
    "List the promoter's OTHER businesses by name and, for each, whether it has faced failure, default, litigation or controversy — search each entity, not just this company's filings.",
};

/** The MUNS question text for an item — item text plus any adverse-hunt directive. */
function questionText(itemId: string, itemText: string): string {
  const directive = ADVERSE_HUNT_DIRECTIVE[itemId];
  return directive ? `${itemText} — ${directive}` : itemText;
}

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
  if (!targets.length) {
    // analyze-run deferred the run to PROCESSING so the loading screen waited;
    // nothing to fill, so finalize it back to DONE.
    await prisma.analysisRun.update({ where: { id: runId }, data: { status: "DONE" } }).catch(() => {});
    return { ...empty, reason: "no blank parameters" };
  }

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
    sec.params.push({ id: it.id, sectionCode: it.sectionCode, sectionNumber: meta.number, sectionTitle: meta.title, text: questionText(it.id, it.item) });
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

      const verdict = buildVerdict(engineItem, analysis, flagRes);
      const evidenceQuote = analysis.table ? serializeTable(analysis.table) : (analysis.evidenceQuote ?? null);
      const providers = ["muns", analysis.providerUsed].filter(Boolean).join("+");
      // Persist the MUNS citation so the report shows a source per line item (the
      // client's ask). The analyzer's own citation (if it kept one) wins; else the
      // first harvested MUNS source URL.
      const sourceUrl = analysis.citation?.sourceUrl ?? a.sources?.[0] ?? null;
      await persist(runId, it.id, {
        status: flagRes.needsReview ? "NEEDS_REVIEW" : "DONE",
        flag: flagRes.flag,
        verdict,
        value: (analysis.value ?? "").slice(0, 200),
        evidenceQuote,
        sourceUrl,
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

  // Refresh the run's stored summary so the tally + gate reflect the backfilled
  // items (analyze-run wrote summaryJson BEFORE this pass, so it's now stale).
  try {
    const fresh = await prisma.itemResult.findMany({ where: { runId }, select: { itemId: true, status: true, flag: true } });
    const summary = summarize(
      items.map((it) => ({ id: it.id, sectionCode: it.sectionCode, isNonNegotiable: it.isNonNegotiable })),
      sections.map((s) => ({ code: s.code, name: s.name })),
      fresh,
    );
    await prisma.analysisRun.update({
      where: { id: runId },
      // Finalize the run status too — analyze-run deferred it to PROCESSING so
      // the loading screen waited for this backfill to finish.
      data: {
        status: summary.complete ? "DONE" : "PARTIAL",
        summaryJson: summary as never,
        itemsDone: summary.itemsDone,
        itemsError: summary.itemsError,
      },
    });
  } catch (e) {
    log(`summary refresh skipped: ${(e as Error).message}`);
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
