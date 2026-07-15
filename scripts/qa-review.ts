/**
 * FINAL self-audit stage. After harvest + analysis + MUNS backfill have filled
 * every item, this re-reads the completed run and auto-corrects clear report bugs
 * — contradictory flags, impossible numbers, lakh/crore unit slips, reds fired on
 * normal/statutory facts (see lib/engine/review.ts) — then finalizes the run to
 * DONE. It is the LAST step before the dashboard opens the report, so the report
 * is already bug-cleared. Never fails the job.
 *
 *   npm run qa-review -- <TICKER|runId>
 */
import { prisma } from "@/lib/db";
import { reviewRun } from "@/lib/engine/review";

async function resolveRunId(arg: string): Promise<string | null> {
  const byId = await prisma.analysisRun.findUnique({ where: { id: arg } });
  if (byId) return byId.id;
  const company = await prisma.company.findFirst({
    where: { ticker: arg.toUpperCase() },
    orderBy: { createdAt: "desc" },
  });
  if (!company) return null;
  const run = await prisma.analysisRun.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } });
  return run?.id ?? null;
}

async function main() {
  const arg = process.argv.slice(2).find((a) => a && !a.startsWith("--"));
  if (!arg) {
    console.error("Usage: npm run qa-review -- <TICKER|runId>");
    return;
  }
  const runId = await resolveRunId(arg);
  if (!runId) {
    console.error(`No run found for "${arg}".`);
    return;
  }

  console.log(`QA self-audit for run ${runId} …`);
  try {
    const qa = await reviewRun(runId);
    if (qa.skipped) console.log(`QA note: ${qa.skipped}`);
    console.log(`QA reviewed ${qa.reviewed} item(s); corrected ${qa.corrections.length}.`);
    for (const c of qa.corrections) console.log(`  ${c.id}: ${c.from} → ${c.to}  (${c.issue})`);
  } catch (e) {
    console.error("QA review error (non-fatal):", (e as Error).message);
  } finally {
    // Last stage: lift the run out of the deferred PROCESSING state (set by
    // analyze-run + muns-backfill precisely so this audit could run first) so the
    // loading screen opens the now bug-cleared report. Leave PARTIAL runs alone —
    // the resume cron owns those.
    const run = await prisma.analysisRun.findUnique({ where: { id: runId }, select: { status: true } });
    if (run?.status === "PROCESSING") {
      await prisma.analysisRun.update({ where: { id: runId }, data: { status: "DONE" } }).catch(() => {});
      console.log("Run finalized: DONE.");
    }
  }
}

main()
  .catch((e) => console.error("qa-review error:", e))
  .finally(() => prisma.$disconnect().catch(() => {}));
