/**
 * Run the FULL 106-item, resumable, quota-aware analysis for a company (or drain
 * the queue), then write a report artifact grouped by section + the summaryJson
 * + the non-negotiable gate.
 *
 *   npm run analyze-run -- <TICKER|runId>   # one run (resolved from ticker or id)
 *   npm run analyze-run                      # drain all HARVESTED/PARTIAL runs
 *
 * Resumable: re-running continues where it stopped (DONE items skipped). Under an
 * exhausted quota it PARTIALs and resumes next run. Reporting never fails the job.
 * Run via `node --import tsx` so `@/` imports resolve.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { llmProviders, openai } from "@/lib/llm";
import { researchers, webResearcher } from "@/lib/scrape";
import { runAnalysis, drainQueue, isCommitted, type RunOutcome } from "@/lib/orchestrate";

const OUT_DIR = path.join(process.cwd(), "analyze-run-report");

/**
 * Print each configured LLM provider's health before analysing, so a
 * misconfigured key (bad/expired key, no model access, no billing) is LOUD in
 * the job log instead of silently degrading every item to NOT_AVAILABLE. The
 * primary (OpenAI) also gets a 1-token completion probe, which surfaces chat-API
 * errors a /models ping can't (404 no-model-access, 429 insufficient_quota).
 * Best-effort and never fatal.
 */
async function preflightProviders(): Promise<void> {
  const configured = Object.values(llmProviders).filter((p) => p.isConfigured());
  if (!configured.length) {
    console.log("LLM preflight: NO providers configured (set OPENAI_API_KEY / GROQ_API_KEY / …).");
    return;
  }
  console.log(`LLM preflight (${configured.length} configured):`);
  for (const p of configured) {
    try {
      const s = await p.ping();
      console.log(`  ${p.id}: ${s.state}${s.message ? ` — ${s.message}` : ""}`);
    } catch (e) {
      console.log(`  ${p.id}: ping threw — ${(e as Error).message}`);
    }
  }
  if (openai.isConfigured()) {
    try {
      await openai.complete({ prompt: "ping", maxTokens: 1, temperature: 0 });
      console.log("  openai completion probe: ok");
    } catch (e) {
      console.log(`  openai completion probe FAILED — ${(e as Error).message}`);
    }
  }
}

/**
 * Web-research preflight: ping each configured researcher and run ONE real search
 * through the composed chain, so a dead/empty web path (bad key, wrong endpoint,
 * changed response shape) is visible in the log instead of silently turning the
 * web/market-data items into "Expected NA". Best-effort and never fatal.
 */
async function preflightWeb(): Promise<void> {
  const configured = Object.values(researchers).filter((r) => r.isConfigured());
  if (!configured.length) {
    console.log("Web preflight: NO researcher configured — web items will be Expected NA (set FIRECRAWL_API_KEY for search).");
    return;
  }
  console.log(`Web preflight (${configured.length} configured):`);
  for (const r of configured) {
    try {
      const s = await r.ping();
      console.log(`  ${r.id}: ${s.state}${s.message ? ` — ${s.message}` : ""}`);
    } catch (e) {
      console.log(`  ${r.id}: ping threw — ${(e as Error).message}`);
    }
  }
  try {
    const res = await webResearcher.search("Tata Consultancy Services promoter Tata Sons");
    console.log(`  search probe: ${res.status} — ${res.results.length} result(s)${res.error ? ` — ${res.error}` : ""}`);
    if (res.results[0]) console.log(`    top: ${res.results[0].url}`);
  } catch (e) {
    console.log(`  search probe threw — ${(e as Error).message}`);
  }
}

async function resolveRunId(arg: string): Promise<string | null> {
  const byId = await prisma.analysisRun.findUnique({ where: { id: arg } });
  if (byId) return byId.id;
  const company = await prisma.company.findFirst({
    where: { ticker: arg.toUpperCase() },
    orderBy: { createdAt: "desc" },
  });
  if (!company) return null;
  const run = await prisma.analysisRun.findFirst({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
  });
  return run?.id ?? null;
}

function appendStepSummary(text: string) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try {
    fs.appendFileSync(f, text + "\n");
  } catch {
    /* ignore */
  }
}

async function writeReport(runId: string, outcome: RunOutcome) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const run = await prisma.analysisRun.findUnique({ where: { id: runId }, include: { company: true } });
  const [items, sections, results] = await Promise.all([
    prisma.checklistItem.findMany({ orderBy: [{ sectionCode: "asc" }, { orderIndex: "asc" }] }),
    prisma.checklistSection.findMany({ orderBy: { orderIndex: "asc" } }),
    prisma.itemResult.findMany({ where: { runId } }),
  ]);
  const byId = new Map(results.map((r) => [r.itemId, r]));

  const grouped = sections.map((s) => ({
    code: s.code,
    name: s.name,
    items: items
      .filter((it) => it.sectionCode === s.code)
      .map((it) => {
        const r = byId.get(it.id);
        // Mirror summarize(): only a COMMITTED (terminal) item exposes a live
        // `flag`. A non-terminal item keeps its old flag in `staleFlag` so the
        // value isn't lost, but `flag` is null — machine consumers of
        // results.json then agree with summary.totals instead of reading a
        // deferred item's leftover RED/GREEN as a fresh verdict.
        const committed = isCommitted(r?.status);
        return {
          id: it.id,
          item: it.item,
          status: r?.status ?? "PENDING",
          flag: committed ? (r?.flag ?? null) : null,
          staleFlag: !committed && r?.flag ? r.flag : null,
          value: r?.value ?? null,
          verdict: r?.verdict ?? null,
          confidence: r?.confidence ?? null,
          provider: r?.providerUsed ?? null,
          evidenceQuote: r?.evidenceQuote ?? null,
          source: { sourceDocId: r?.sourceDocId ?? null, page: r?.sourcePage ?? null, url: r?.sourceUrl ?? null },
        };
      }),
  }));

  const report = {
    runId,
    ticker: run?.company.ticker ?? null,
    company: run?.company.name ?? null,
    status: run?.status ?? outcome.status,
    summary: run?.summaryJson ?? outcome.summary,
    sections: grouped,
  };
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(report, null, 2) + "\n");

  // ---- human-readable summary.md (also -> GITHUB_STEP_SUMMARY) ----
  const s = outcome.summary;
  const lines: string[] = [];
  lines.push(`# Analysis run — ${report.ticker ?? runId} (${report.status})`);
  lines.push("");
  lines.push(
    `Items: ${s.itemsDone} done · ${s.itemsNeedsReview} needs-review · ${s.itemsError} error · ` +
      `${s.itemsDeferred} deferred · ${s.itemsPending} pending / ${s.itemsTotal} total`,
  );
  lines.push(`Flags: 🟢 ${s.totals.green} · 🔴 ${s.totals.red} · ⚪ ${s.totals.neutral} · ▫️ ${s.totals.na}  (total reds: ${s.totalReds})`);
  lines.push(
    `Non-negotiable gate: **${s.nonNegotiable.gatePass ? "PASS" : "FAIL"}**` +
      (s.nonNegotiable.failedItems.length ? ` (red: ${s.nonNegotiable.failedItems.join(", ")})` : ""),
  );
  lines.push("");
  lines.push("| section | 🟢 | 🔴 | ⚪ | ▫️ | total |");
  lines.push("|---|--:|--:|--:|--:|--:|");
  for (const sec of s.bySection) {
    lines.push(`| ${sec.code} ${sec.name} | ${sec.green} | ${sec.red} | ${sec.neutral} | ${sec.na} | ${sec.total} |`);
  }
  lines.push("");
  for (const g of grouped) {
    lines.push(`### ${g.code} — ${g.name}`);
    for (const it of g.items) {
      const src = it.source.url ? ` _(src: ${it.source.url}${it.source.page != null ? ` p.${it.source.page}` : ""})_` : "";
      // `flag` is already committed-only (set above); a non-terminal item exposes
      // its leftover flag as `staleFlag`, marked so a PARTIAL run's report can't
      // be misread as a fresh verdict for every line.
      const statusTag = it.flag
        ? it.flag
        : `${it.status}${it.staleFlag ? ` (stale ${it.staleFlag})` : ""}`;
      // A bare "not available" value is uninformative — fall back to the verdict,
      // which carries the honest detail (e.g. "Expected NA — … web/market-data item").
      const answered = it.value && it.value.toLowerCase() !== "not available" ? it.value : null;
      const detail = answered ?? it.verdict ?? it.value ?? "—";
      lines.push(`- **${it.id}** ${statusTag}: ${it.item} — ${detail}${src}`);
    }
    lines.push("");
  }
  const md = lines.join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "summary.md"), md + "\n");
  appendStepSummary(md);
  // Also emit to stdout so the full per-item breakdown is visible in the job log
  // (the uploaded artifact lives behind storage egress that CI consumers/tools
  // can't always reach).
  console.log("\n" + md);
}

async function main() {
  const args = process.argv.slice(2).map((a) => a.trim());
  // --force / --reset re-evaluates ALL 106 items, ignoring prior DONE status.
  const force = args.includes("--force") || args.includes("--reset");
  const arg = args.find((a) => a && !a.startsWith("--"));

  await preflightProviders();
  await preflightWeb();

  if (!arg) {
    console.log(`Draining queue (HARVESTED / PARTIAL runs)${force ? " [force]" : ""}…`);
    const outcomes = await drainQueue({ force });
    if (!outcomes.length) console.log("No eligible runs.");
    for (const o of outcomes) {
      console.log(`run ${o.runId}: ${o.status} (done=${o.summary.itemsDone}/${o.summary.itemsTotal}, deferred=${o.deferred})`);
      await writeReport(o.runId, o);
    }
    return;
  }

  const runId = await resolveRunId(arg);
  if (!runId) {
    console.error(`No run found for "${arg}". Harvest the ticker first (harvest-validate).`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify({ error: `no run for ${arg}` }, null, 2) + "\n");
    return;
  }

  console.log(`Analyzing run ${runId}${force ? " [force re-eval]" : ""} …`);
  const outcome = await runAnalysis(runId, { force });
  console.log(
    `status=${outcome.status}  done=${outcome.summary.itemsDone}/${outcome.summary.itemsTotal}  ` +
      `reds=${outcome.summary.totalReds}  deferred=${outcome.deferred}  pruned=${outcome.pruned}  ` +
      `gate=${outcome.summary.nonNegotiable.gatePass ? "PASS" : "FAIL"}`,
  );
  await writeReport(runId, outcome);

  // If a MUNS backfill step follows (MUNS_TOKEN set), keep the run OUT of the
  // terminal DONE state so the on-demand loading screen waits for the blanks to
  // be filled before opening the report. muns-backfill sets the final status.
  if (process.env.MUNS_TOKEN && outcome.status === "DONE") {
    await prisma.analysisRun.update({ where: { id: runId }, data: { status: "PROCESSING" } }).catch(() => {});
    console.log("Deferring DONE until MUNS backfill completes.");
  }
}

main()
  .catch((e) => {
    console.error("analyze-run error:", e);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  });
