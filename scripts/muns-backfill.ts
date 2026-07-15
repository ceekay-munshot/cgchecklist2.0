/**
 * Fill the remaining (NOT_AVAILABLE) parameters for a company's latest run via
 * the MUNS Chat API, then classify each answer with the repo's existing
 * green/red-flag logic.
 *
 *   npm run muns-backfill -- <TICKER|runId>
 *
 * Requires MUNS_TOKEN (and optionally USER_INDEX, CONTEXT_EMAIL, MUNS_LANES).
 * Only touches blank parameters — already-answered items are left untouched.
 */
import { prisma } from "@/lib/db";
import { munsBackfill } from "@/lib/muns/backfill";
import { munsConfigured } from "@/lib/muns/client";

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
    console.error("Usage: npm run muns-backfill -- <TICKER|runId>");
    process.exitCode = 1;
    return;
  }
  if (!munsConfigured()) {
    console.error("MUNS_TOKEN is not set — nothing to do.");
    process.exitCode = 1;
    return;
  }
  const runId = await resolveRunId(arg);
  if (!runId) {
    console.error(`No run found for "${arg}". Harvest + analyze it first.`);
    process.exitCode = 1;
    return;
  }
  console.log(`MUNS backfill for run ${runId} …`);
  try {
    const outcome = await munsBackfill(runId, { log: (m) => console.log(m) });
    console.log("\n=== MUNS backfill summary ===");
    console.log(JSON.stringify(outcome, null, 2));
  } finally {
    // Never leave the run stuck in the deferred PROCESSING state (e.g. if MUNS
    // errored mid-run): finalize it so the loading screen can open the report.
    const run = await prisma.analysisRun.findUnique({ where: { id: runId }, select: { status: true } });
    if (run?.status === "PROCESSING") {
      await prisma.analysisRun.update({ where: { id: runId }, data: { status: "DONE" } }).catch(() => {});
    }
  }
}

main()
  .catch((e) => {
    console.error("muns-backfill error:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
