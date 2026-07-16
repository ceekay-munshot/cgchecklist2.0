import { connection } from "next/server";
import { prisma } from "@/lib/db";
import { triggerRunAnalysis, isDispatchConfigured } from "@/lib/analyze/dispatch";

/**
 * TARGETED re-run: re-evaluate ONE section or ONE item of an existing run, in
 * place, on its already-harvested/uploaded documents (no Screener harvest, no
 * whole-report MUNS/QA backfill). Every other item keeps its current result.
 *
 *   POST /api/analyze/scope   { runId, sectionCode }   // redo a whole section
 *   POST /api/analyze/scope   { runId, itemId }        // redo a single parameter
 *
 * This backs the report page's per-section and per-parameter "re-run" buttons.
 * Like /api/analyze/run it dispatches analyze-run.yml (the background worker that
 * has the DB + LLM keys) — here with a section/item scope — then flips the run to
 * QUEUED so the loading modal can poll it to completion by runId.
 */
export async function POST(req: Request) {
  await connection();

  let body: { runId?: string; sectionCode?: string; itemId?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const runId = (body.runId ?? "").trim();
  const sectionCode = (body.sectionCode ?? "").trim();
  const itemId = (body.itemId ?? "").trim();

  if (!runId) return Response.json({ error: "runId required" }, { status: 400 });
  // Exactly one target — a section OR a single item, never both / neither.
  if (!sectionCode && !itemId) {
    return Response.json({ error: "sectionCode or itemId required" }, { status: 400 });
  }
  if (sectionCode && itemId) {
    return Response.json({ error: "pass only one of sectionCode / itemId" }, { status: 400 });
  }

  const run = await prisma.analysisRun.findUnique({ where: { id: runId }, include: { company: true } });
  if (!run) return Response.json({ error: "run not found" }, { status: 404 });

  // No dispatcher configured → report it, leave the run untouched (its existing
  // report stays viewable); the client shows the same "run the Action manually" note.
  if (!isDispatchConfigured()) {
    return Response.json({
      status: "started",
      runId,
      ticker: run.company.ticker ?? null,
      scope: sectionCode ? { sectionCode } : { itemId },
      dispatched: false,
      dispatchError: "dispatch_not_configured",
    });
  }

  const d = await triggerRunAnalysis(runId, {
    ...(sectionCode ? { sectionCode } : { itemId }),
  });
  if (!d.ok) {
    // Dispatch failed → do NOT flip status; the current report stays intact.
    return Response.json({
      status: "started",
      runId,
      ticker: run.company.ticker ?? null,
      scope: sectionCode ? { sectionCode } : { itemId },
      dispatched: false,
      dispatchError: d.error,
    });
  }

  // Dispatch succeeded → flip to QUEUED so the loading modal tracks the targeted
  // re-run to completion. loadReport() serves the run by id regardless of status,
  // so the report stays reachable while the one section/item re-processes.
  await prisma.analysisRun.update({ where: { id: runId }, data: { status: "QUEUED" } }).catch(() => {});

  return Response.json({
    status: "started",
    runId,
    ticker: run.company.ticker ?? null,
    scope: sectionCode ? { sectionCode } : { itemId },
    dispatched: true,
  });
}
