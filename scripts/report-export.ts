/**
 * Export a company's latest run as downloadable files (no server / hosting):
 *   npm run report-export -- <TICKER|runId>
 * Writes report-export/<TICKER>-cg-report.xlsx and .html. Run in CI (which has
 * the Neon DATABASE_URL) so the real report can be downloaded as an artifact.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { loadReport } from "@/lib/report";
import { buildExcelReport, reportFilename } from "@/lib/export/excel";
import { buildHtmlReport } from "@/lib/export/html";

const OUT_DIR = path.join(process.cwd(), "report-export");

async function main() {
  const arg = process.argv.slice(2).find((a) => a && !a.startsWith("--"));
  if (!arg) {
    console.error("Usage: npm run report-export -- <TICKER|runId>");
    process.exitCode = 1;
    return;
  }
  const report = await loadReport(arg);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!report) {
    console.error(`No analysed run found for "${arg}".`);
    fs.writeFileSync(path.join(OUT_DIR, "ERROR.txt"), `No analysed run found for "${arg}".\n`);
    process.exitCode = 1;
    return;
  }

  const xlsxName = reportFilename(report);
  const htmlName = xlsxName.replace(/\.xlsx$/, ".html");
  fs.writeFileSync(path.join(OUT_DIR, xlsxName), await buildExcelReport(report));
  fs.writeFileSync(path.join(OUT_DIR, htmlName), buildHtmlReport(report), "utf8");

  console.log(`Exported ${report.company} (${report.ticker ?? report.runId})`);
  console.log(`  → report-export/${xlsxName}`);
  console.log(`  → report-export/${htmlName}`);
  console.log(`  ${report.answered}/${report.total} answered · ${report.summary?.totals.red ?? 0} red(s) · gate ${report.summary?.nonNegotiable.gatePass ? "PASS" : "—"}`);
}

main()
  .catch((e) => {
    console.error("report-export error:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
