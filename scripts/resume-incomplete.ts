/**
 * Self-healing resume — drive every not-yet-complete run to completion.
 *
 *   npm run resume-incomplete
 *
 * The analysis runs server-side and is fully resumable (finished items are
 * skipped), so a run can be left half-done only if its job was interrupted:
 * the free LLM quota ran out mid-pass, or the Action hit its time limit. Such a
 * run is left PARTIAL, or stuck in PROCESSING if the job died before it could
 * write a status. Nothing re-triggers it on its own — this script is that
 * trigger. It:
 *
 *   1. finds runs with harvested data that never reached DONE, and that no
 *      on-demand job has touched in the last few minutes (so we don't collide),
 *   2. resumes the 106-item analysis (skips items already finished),
 *   3. runs the MUNS backfill to fill any remaining blanks,
 *   4. finalises the run to DONE/PARTIAL.
 *
 * Idempotent and safe to run on a schedule — a run stops being picked up only
 * once it is DONE. Meant for the hourly `analyze-resume` workflow.
 */
import { prisma } from "@/lib/db";
import { runAnalysis } from "@/lib/orchestrate";
import { munsBackfill } from "@/lib/muns/backfill";
import { munsConfigured } from "@/lib/muns/client";

// Statuses whose SourceDocs are already harvested, so a plain analysis resume
// can finish them (no re-harvest needed).
const RESUMABLE = ["HARVESTED", "PARTIAL", "PROCESSING"] as const;
// Skip runs an on-demand job is actively working right now (touched recently).
const STALE_MINUTES = 12;
// Bound the work per invocation so a scheduled run stays inside its job timeout.
const MAX_RUNS = Number(process.env.RESUME_MAX_RUNS || "8");

async function main() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000);

  const runs = await prisma.analysisRun.findMany({
    where: {
      status: { in: [...RESUMABLE] },
      OR: [{ lastProcessedAt: null }, { lastProcessedAt: { lt: cutoff } }],
    },
    include: { company: true },
    orderBy: { createdAt: "asc" },
    take: MAX_RUNS,
  });

  if (!runs.length) {
    console.log("resume-incomplete: nothing to do — no stale unfinished runs.");
    return;
  }

  console.log(`resume-incomplete: ${runs.length} unfinished run(s) to resume.`);
  const muns = munsConfigured();
  if (!muns) console.log("  (MUNS_TOKEN not set — resuming analysis only, no research backfill)");

  for (const run of runs) {
    const label = `${run.company.ticker ?? run.company.name} [${run.id}]`;
    try {
      console.log(`\n▶ ${label} — was ${run.status}; resuming analysis…`);
      const outcome = await runAnalysis(run.id);
      console.log(`  analysis → ${outcome.status} (deferred ${outcome.deferred})`);

      if (muns) {
        const bf = await munsBackfill(run.id, { log: (m) => console.log(`  ${m}`) });
        console.log(`  MUNS → filled ${bf.filled}/${bf.targets}`);
      }

      // Belt-and-braces: never leave a run stranded in PROCESSING.
      const fresh = await prisma.analysisRun.findUnique({ where: { id: run.id }, select: { status: true } });
      if (fresh?.status === "PROCESSING") {
        await prisma.analysisRun.update({ where: { id: run.id }, data: { status: "PARTIAL" } }).catch(() => {});
      }
    } catch (e) {
      console.error(`  ✗ ${label} resume failed: ${(e as Error).message}`);
    }
  }
}

main()
  .catch((e) => {
    console.error("resume-incomplete error:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
