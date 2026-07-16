import { connection } from "next/server";
import { prisma } from "@/lib/db";
import { triggerRunAnalysis, isDispatchConfigured } from "@/lib/analyze/dispatch";

/**
 * Re-analyse an EXISTING run in place, on its already-harvested/uploaded documents
 * (no Screener harvest) — a force re-evaluation of all items.
 *
 *   POST /api/analyze/run   { runId }
 *
 * This is what the report page's "Re-analyse" button uses for UNLISTED companies:
 * they have no ticker, so the ticker-based /api/analyze (which drives a Screener
 * harvest) can't serve them. Their documents were uploaded and live on the run, so
 * we just re-run analyze-run --force against that run and let the loading modal
 * poll it by runId.
 */
export async function POST(req: Request) {
  await connection();

  let body: { runId?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const runId = (body.runId ?? "").trim();
  if (!runId) return Response.json({ error: "runId required" }, { status: 400 });

  const run = await prisma.analysisRun.findUnique({ where: { id: runId }, include: { company: true } });
  if (!run) return Response.json({ error: "run not found" }, { status: 404 });

  // No dispatcher configured → report it, leave the run untouched (its existing
  // report stays viewable); the client shows the same "run the Action manually" note.
  if (!isDispatchConfigured()) {
    return Response.json({ status: "started", runId, ticker: run.company.ticker ?? null, dispatched: false, dispatchError: "dispatch_not_configured" });
  }

  const d = await triggerRunAnalysis(runId, { force: true });
  if (!d.ok) {
    // Dispatch failed → do NOT flip status; the current DONE report stays intact.
    return Response.json({ status: "started", runId, ticker: run.company.ticker ?? null, dispatched: false, dispatchError: d.error });
  }

  // Dispatch succeeded → flip to QUEUED so the loading modal tracks the re-run to
  // completion. Without this the poller would immediately see the still-DONE run and
  // bounce back to the unchanged report. loadReport() serves the run by id
  // regardless of status, so the report stays reachable while it re-processes.
  await prisma.analysisRun.update({ where: { id: runId }, data: { status: "QUEUED" } }).catch(() => {});

  return Response.json({ status: "started", runId, ticker: run.company.ticker ?? null, dispatched: true });
}
