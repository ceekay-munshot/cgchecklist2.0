/**
 * CLI: harvest ONE company end-to-end and print Tier-1 fields + Tier-2 docs.
 *
 *   npm run harvest -- <TICKER> [NSE|BSE]
 *
 * Run via `node --import tsx` (see package.json) so `@/` imports resolve.
 */
import type { Exchange } from "@prisma/client";
import { prisma } from "@/lib/db";
import { harvestCompany } from "@/lib/harvest";
import { getProviderUsage } from "@/lib/usage";

async function main() {
  const ticker = process.argv[2]?.trim();
  if (!ticker) {
    console.error("Usage: npm run harvest -- <TICKER> [NSE|BSE]");
    process.exit(2);
  }
  const exArg = process.argv[3]?.trim().toUpperCase();
  const exchange: Exchange | undefined =
    exArg === "BSE" ? "BSE" : exArg === "NSE" ? "NSE" : undefined;

  // The analyst supplies only the company — find or create it.
  let company = await prisma.company.findFirst({
    where: { ticker: { equals: ticker, mode: "insensitive" } },
  });
  if (!company) {
    company = await prisma.company.create({
      data: { name: ticker, ticker: ticker.toUpperCase(), exchange },
    });
  }

  // Reuse the company's latest run (resumable) or create one.
  let run = await prisma.analysisRun.findFirst({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
  });
  if (!run) {
    run = await prisma.analysisRun.create({
      data: { companyId: company.id, status: "QUEUED", createdBy: "cli:harvest" },
    });
  }

  console.log(`\n=== Harvest ${ticker}${exchange ? ` (${exchange})` : ""} ===`);
  console.log(`company=${company.id}  run=${run.id}`);

  const summary = await harvestCompany({ companyId: company.id, runId: run.id });

  console.log(`screenerUrl: ${summary.screenerUrl ?? "(none)"}`);
  console.log(`\n-- TIER 1 (structured page) --`);
  console.log(`status: ${summary.tier1.status} via ${summary.tier1.via}`);
  console.log(
    `fields: ${summary.tier1.fields.length ? summary.tier1.fields.join(", ") : "(none)"}`,
  );
  if (summary.tier1.note) console.log(`note: ${summary.tier1.note}`);

  console.log(`\n-- TIER 2 (documents: ${summary.tier2.length}) --`);
  for (const d of summary.tier2) {
    const pages = d.pages != null ? ` pages=${d.pages}` : "";
    const note = d.note ? `  «${d.note}»` : "";
    console.log(`[${d.status}] ${d.name} | ${d.type} | ${d.category} | via ${d.via}${pages}${note}`);
  }
  if (!summary.tier2.length) console.log("(no documents discovered)");

  const usage = await getProviderUsage("screener");
  console.log(`\n-- usage --`);
  console.log(`screener requests today: ${usage?.requests ?? 0}`);

  // DB-side proof of persistence.
  const docs = await prisma.sourceDoc.findMany({
    where: { runId: run.id },
    select: { type: true, fetchStatus: true },
  });
  const byStatus = docs.reduce<Record<string, number>>((a, d) => {
    a[d.fetchStatus] = (a[d.fetchStatus] ?? 0) + 1;
    return a;
  }, {});
  console.log(
    `SourceDocs persisted: ${docs.length} (${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join(", ") || "none"})`,
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("harvest CLI error:", e);
  await prisma.$disconnect();
  process.exit(1);
});
