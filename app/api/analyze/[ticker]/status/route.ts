import { connection } from "next/server";
import { prisma } from "@/lib/db";
import { computeProgress } from "@/lib/analyze/progress";

/**
 * Poll an on-demand run's live progress for the loading screen.
 *
 *   GET /api/analyze/<ticker>/status?runId=<id>
 *
 * Prefer the explicit ?runId (the exact run the POST started) to avoid racing an
 * older run for the same ticker; fall back to the company's latest run. Progress
 * is derived from COMMITTED ItemResults (the orchestrator persists each as it
 * finishes), so the % moves in real time without any extra bookkeeping.
 */
export async function GET(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  await connection();
  const { ticker } = await ctx.params;
  const runId = new URL(req.url).searchParams.get("runId");

  const run = runId
    ? await prisma.analysisRun.findUnique({ where: { id: runId }, include: { company: true } })
    : await latestRunForTicker(decodeURIComponent(ticker));

  if (!run) {
    return Response.json({ phase: "none", percent: 0, stage: "No analysis yet", ready: false, done: false });
  }

  const [doneItems, checklistTotal] = await Promise.all([
    prisma.itemResult.count({ where: { runId: run.id, status: { in: ["DONE", "NEEDS_REVIEW"] } } }),
    run.itemsTotal > 0 ? Promise.resolve(run.itemsTotal) : prisma.checklistItem.count(),
  ]);

  const progress = computeProgress(run.status, doneItems, checklistTotal);
  return Response.json({
    ...progress,
    runStatus: run.status,
    runId: run.id,
    ticker: run.company?.ticker ?? null,
    doneItems,
    total: checklistTotal,
  });
}

async function latestRunForTicker(tickerOrId: string) {
  const byId = await prisma.analysisRun.findUnique({ where: { id: tickerOrId }, include: { company: true } });
  if (byId) return byId;
  const company = await prisma.company.findFirst({
    where: { ticker: { equals: tickerOrId, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
  });
  if (!company) return null;
  return prisma.analysisRun.findFirst({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
    include: { company: true },
  });
}
