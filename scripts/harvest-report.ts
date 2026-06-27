/**
 * Build the harvest artifact for a ticker's latest run:
 *   harvest-report/structuredData.json  — the SCREENER_PAGE structured JSON
 *   harvest-report/documents.json       — list of document SourceDocs
 *   harvest-report/summary.txt          — human summary (also -> GITHUB_STEP_SUMMARY)
 *
 * Reporting must never fail the job, so this exits 0 even on error.
 * Run via `node --import tsx` (see the workflow) so `@/` imports resolve.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";

function nonEmptyKeys(obj: Record<string, unknown>): string[] {
  return Object.entries(obj)
    .filter(([, v]) => {
      if (v === null || v === undefined) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v as object).length > 0;
      return true;
    })
    .map(([k]) => k);
}

async function main() {
  const ticker = process.argv[2]?.trim() ?? "";
  const outDir = path.join(process.cwd(), "harvest-report");
  fs.mkdirSync(outDir, { recursive: true });

  const lines: string[] = [];
  const log = (s = "") => {
    lines.push(s);
    console.log(s);
  };

  const finish = () => {
    fs.writeFileSync(path.join(outDir, "summary.txt"), lines.join("\n") + "\n");
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) {
      try {
        fs.appendFileSync(stepSummary, lines.join("\n") + "\n");
      } catch {
        /* ignore */
      }
    }
  };

  log(`# Harvest report — ${ticker || "(no ticker)"}`);

  const company = ticker
    ? await prisma.company.findFirst({
        where: { ticker: { equals: ticker, mode: "insensitive" } },
        orderBy: { createdAt: "desc" },
      })
    : null;
  const run = company
    ? await prisma.analysisRun.findFirst({
        where: { companyId: company.id },
        orderBy: { createdAt: "desc" },
      })
    : null;

  if (!company || !run) {
    log(`No company/run found for ticker "${ticker}".`);
    fs.writeFileSync(path.join(outDir, "structuredData.json"), "{}\n");
    fs.writeFileSync(path.join(outDir, "documents.json"), "[]\n");
    finish();
    return;
  }

  log(`company=${company.id} (${company.name})  run=${run.id}  status=${run.status}`);
  log(`screenerUrl=${company.screenerUrl ?? "(none)"}`);

  const docs = await prisma.sourceDoc.findMany({
    where: { runId: run.id },
    orderBy: { createdAt: "asc" },
  });
  const screenerPage = docs.find((d) => d.type === "SCREENER_PAGE");

  // ---- structuredData.json ----
  fs.writeFileSync(
    path.join(outDir, "structuredData.json"),
    JSON.stringify(
      {
        ticker,
        runStatus: run.status,
        fetchStatus: screenerPage?.fetchStatus ?? "MISSING",
        fetchedVia: screenerPage?.fetchedVia ?? null,
        note: screenerPage?.note ?? null,
        structuredData: screenerPage?.structuredData ?? null,
      },
      null,
      2,
    ) + "\n",
  );

  // ---- documents.json ----
  const docList = docs
    .filter((d) => d.type !== "SCREENER_PAGE")
    .map((d) => ({
      name: d.name,
      type: d.type,
      fetchStatus: d.fetchStatus,
      fetchedVia: d.fetchedVia,
      pages: d.pages,
      textChars: d.extractedText?.length ?? 0,
      sourceUrl: d.sourceUrl,
      note: d.note,
    }));
  fs.writeFileSync(
    path.join(outDir, "documents.json"),
    JSON.stringify(docList, null, 2) + "\n",
  );

  // ---- human summary ----
  log("");
  log(`## Tier 1 — SCREENER_PAGE: ${screenerPage?.fetchStatus ?? "MISSING"}${screenerPage?.note ? ` — ${screenerPage.note}` : ""}`);
  if (screenerPage?.structuredData) {
    const keys = nonEmptyKeys(screenerPage.structuredData as Record<string, unknown>);
    log(`structuredData keys: ${keys.join(", ") || "(none)"}`);
  }

  log("");
  log(`## Tier 2 — documents (${docList.length})`);
  if (docList.length) {
    log("| status | type | via | pages | textChars | name |");
    log("|---|---|---|---|---|---|");
    for (const d of docList) {
      log(`| ${d.fetchStatus} | ${d.type} | ${d.fetchedVia} | ${d.pages ?? ""} | ${d.textChars} | ${d.name.slice(0, 60)} |`);
    }
  } else {
    log("(no documents discovered)");
  }

  const counts: Record<string, number> = {};
  for (const d of docs) counts[d.fetchStatus] = (counts[d.fetchStatus] ?? 0) + 1;
  log("");
  log(`SourceDocs persisted: ${docs.length} — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}`);

  finish();
}

main()
  .catch((e) => {
    console.error("harvest-report error:", e);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  });
