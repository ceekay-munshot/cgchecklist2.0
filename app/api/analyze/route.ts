import { connection } from "next/server";
import { prisma } from "@/lib/db";
import { isStale } from "@/lib/analyze/progress";
import { triggerAnalysisWorkflow, isDispatchConfigured } from "@/lib/analyze/dispatch";

/** Statuses for a run that is already on its way (don't start a second one). */
const IN_FLIGHT = ["QUEUED", "HARVESTING", "HARVESTED", "PROCESSING", "PARTIAL"];

/**
 * Start (or reuse) an on-demand analysis for a company.
 *
 *   POST /api/analyze   { ticker, exchange?, force? }
 *
 * Decision:
 *  - a DONE run newer than the freshness window  → { status: "fresh" }  (no work)
 *  - an in-flight run                            → reuse it, just poll
 *  - otherwise                                   → create a QUEUED run + dispatch
 *    the analyze-company worker, return its runId to poll.
 */
export async function POST(req: Request) {
  await connection();

  let body: { ticker?: string; exchange?: string; force?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const raw = (body.ticker ?? "").trim();
  if (!raw) return Response.json({ error: "ticker required" }, { status: 400 });
  const ticker = raw.toUpperCase();

  const company = await prisma.company.findFirst({
    where: { ticker: { equals: raw, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
  });
  const latest = company
    ? await prisma.analysisRun.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } })
    : null;

  const now = new Date();
  if (
    latest &&
    company &&
    latest.status === "DONE" &&
    !body.force &&
    !isStale(latest.lastProcessedAt ?? latest.createdAt, now)
  ) {
    return Response.json({ status: "fresh", ticker: company.ticker ?? ticker, runId: latest.id });
  }

  // A (re)run is needed. Reuse an in-flight run, else create a fresh QUEUED one.
  const comp =
    company ?? (await prisma.company.create({ data: { name: ticker, ticker, exchange: normalizeExchange(body.exchange) } }));

  const inflight = latest && latest.companyId === comp.id && IN_FLIGHT.includes(latest.status) ? latest : null;
  const run =
    inflight ?? (await prisma.analysisRun.create({ data: { companyId: comp.id, status: "QUEUED", createdBy: "web:ondemand" } }));

  // Dispatch the worker whenever the run hasn't actually started yet (QUEUED) —
  // including a REUSED queued run from an earlier search that never fired (e.g.
  // the dispatch token wasn't set then). A run already HARVESTING/PROCESSING has
  // a worker on it, so we don't re-fire.
  let dispatched = true;
  let dispatchError: string | undefined;
  if (run.status === "QUEUED") {
    if (isDispatchConfigured()) {
      const d = await triggerAnalysisWorkflow(comp.ticker ?? ticker, { exchange: body.exchange, force: body.force });
      dispatched = d.ok;
      dispatchError = d.ok ? undefined : d.error;
    } else {
      dispatched = false;
      dispatchError = "dispatch_not_configured";
    }
  }

  return Response.json({
    status: "started",
    ticker: comp.ticker ?? ticker,
    runId: run.id,
    reused: Boolean(inflight),
    dispatched,
    dispatchError,
  });
}

function normalizeExchange(ex?: string): "NSE" | "BSE" | undefined {
  const u = ex?.trim().toUpperCase();
  return u === "NSE" || u === "BSE" ? u : undefined;
}
