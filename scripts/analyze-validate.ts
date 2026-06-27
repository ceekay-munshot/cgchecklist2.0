/**
 * Validate the analysis CORE on REAL data: evaluate a focused set of checklist
 * items for a company's latest run and write an artifact so the verdicts can be
 * eyeballed. Proves all evidence paths (Tier-1 numeric, numeric-from-document,
 * qualitative-from-document, web fallback / not-available) on ~6 items.
 *
 *   npm run analyze -- <TICKER>          (default TICKER=TCS)
 *
 * Reporting must never fail the job, so this exits 0 even on error.
 * Run via `node --import tsx` so `@/` imports resolve.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { evaluateItem, fromPrismaItem, type ItemEvaluation } from "@/lib/engine";
import { getProviderUsage } from "@/lib/usage";

// 6 items spanning every evidence path (see PROJECT_BRIEF §13).
const ITEM_IDS = [
  "A14-01", // Leverage (D/E)          — Tier-1 numeric
  "A3-02", // Share pledging           — Tier-1 numeric
  "A3-01", // Promoter holding trend   — Tier-1 numeric series
  "A1-01", // Board independence ratio — numeric, from the annual report
  "A4-01", // Auditor identity         — qualitative, from the annual report
  "A13-02", // View on the CEO          — qualitative; web fallback / not available
];

const USAGE_PROVIDERS = ["groq", "mistral", "gemini", "nvidia", "firecrawl", "scrapedo"];

function citationText(r: ItemEvaluation): string {
  const c = r.citation;
  if (!c) return "—";
  const where = c.docName ?? c.docType ?? (c.sourceUrl ? new URL(c.sourceUrl).hostname : "source");
  const page = c.page != null ? ` p.${c.page}` : "";
  return `${where}${page}`;
}

async function main() {
  const ticker = (process.argv[2]?.trim() || "TCS").toUpperCase();
  const outDir = path.join(process.cwd(), "analyze-report");
  fs.mkdirSync(outDir, { recursive: true });

  const lines: string[] = [];
  const log = (s = "") => {
    lines.push(s);
    console.log(s);
  };
  const finish = (results: ItemEvaluation[]) => {
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2) + "\n");
    fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\n") + "\n");
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) {
      try {
        fs.appendFileSync(stepSummary, lines.join("\n") + "\n");
      } catch {
        /* ignore */
      }
    }
  };

  log(`# Analyze report — ${ticker}`);

  const company = await prisma.company.findFirst({
    where: { ticker: { equals: ticker, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
  });
  const run = company
    ? await prisma.analysisRun.findFirst({
        where: { companyId: company.id },
        orderBy: { createdAt: "desc" },
      })
    : null;

  if (!company || !run) {
    log(`No company/run found for ticker "${ticker}". Harvest it first (harvest-validate).`);
    finish([]);
    return;
  }
  log(`company=${company.id} (${company.name})  run=${run.id}  status=${run.status}`);
  log("");

  const items = await prisma.checklistItem.findMany({ where: { id: { in: ITEM_IDS } } });
  const byId = new Map(items.map((i) => [i.id, i]));

  const results: ItemEvaluation[] = [];
  for (const id of ITEM_IDS) {
    const ci = byId.get(id);
    if (!ci) {
      log(`- ${id}: (not seeded — skipped)`);
      continue;
    }
    const r = await evaluateItem(fromPrismaItem(ci), run.id);
    results.push(r);
    const providers = r.providersUsed.join("+") || "—";
    console.log(
      `[${r.flag}] ${id} ${ci.item} | value="${r.value}" | src=${citationText(r)} | ${providers} | conf=${r.confidence}`,
    );
  }

  // ---- markdown table for the artifact + step summary ----
  log("| id | item | flag | value | source | provider | conf |");
  log("|---|---|---|---|---|---|---|");
  for (const r of results) {
    log(
      `| ${r.itemId} | ${r.item} | ${r.flag} | ${r.value.slice(0, 60)} | ${citationText(r)} | ${r.providersUsed.join("+") || "—"} | ${r.confidence} |`,
    );
  }
  log("");
  for (const r of results) {
    log(`### ${r.itemId} — ${r.item} → **${r.flag}**${r.needsReview ? " _(needs review)_" : ""}`);
    log(`- value: ${r.value}`);
    log(`- verdict: ${r.verdict}`);
    if (r.evidenceQuote) log(`- evidence: “${r.evidenceQuote.slice(0, 300)}”`);
    log(`- source: ${citationText(r)}${r.citation?.sourceUrl ? ` (${r.citation.sourceUrl})` : ""}`);
    log("");
  }

  // ---- provider usage today ----
  log("## LLM / research usage today");
  for (const p of USAGE_PROVIDERS) {
    const u = await getProviderUsage(p);
    if (u && u.requests > 0) log(`- ${p}: ${u.requests} requests`);
  }

  finish(results);
}

main()
  .catch((e) => {
    console.error("analyze-validate error:", e);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  });
