import { prisma } from "@/lib/db";
import { extractUnlistedFinancials } from "@/lib/engine/unlistedFinancials";
import type { Prisma } from "@prisma/client";

/**
 * Build the Tier-1 `structuredData` blob for an UNLISTED run from its uploaded
 * financial-statement PDFs, and persist it as the run's SCREENER_PAGE SourceDoc —
 * the exact shape a listed company gets from the Screener harvest. Once that doc
 * exists, every deterministic numeric item and the materiality scaler work for the
 * private company with no further changes.
 *
 * IDEMPOTENT + resumable: a no-op when a SCREENER_PAGE already exists (listed runs
 * always have one; a prior pass may have built it) or when the run isn't unlisted.
 */

// Prefer the actual statements over narrative decks / due-diligence reports when
// choosing what to feed the extractor (keeps the prompt focused + under budget).
const STATEMENT_NAME_RE = /financ|balance|profit|p&l|cash.?flow|\bcfs\b|\bfs\b|provisional|statement/i;
const MAX_FEED_CHARS = 120_000;

export async function ensureUnlistedFinancials(runId: string): Promise<boolean> {
  const run = await prisma.analysisRun.findUnique({
    where: { id: runId },
    include: { company: true },
  });
  if (!run || !run.company) return false;
  // Listed companies keep their real Screener page — never synthesise over it.
  if (run.company.ticker) return false;

  const existing = await prisma.sourceDoc.findFirst({
    where: { runId, type: "SCREENER_PAGE" },
    select: { id: true },
  });
  if (existing) return false;

  const docs = await prisma.sourceDoc.findMany({
    where: { runId, fetchStatus: "OK", extractedText: { not: null } },
    select: { name: true, extractedText: true },
  });
  if (docs.length === 0) return false;

  // Statement-looking docs first; fall back to everything if none match by name.
  const statements = docs.filter((d) => STATEMENT_NAME_RE.test(d.name ?? ""));
  const feed = statements.length ? statements : docs;

  let text = "";
  for (const d of feed) {
    if (text.length >= MAX_FEED_CHARS) break;
    text += `\n===== DOCUMENT: ${d.name ?? "financials"} =====\n${d.extractedText ?? ""}\n`;
  }

  const structuredData = await extractUnlistedFinancials(text, {
    name: run.company.name,
    capturedAt: new Date().toISOString(),
  });
  if (!structuredData) return false;

  await prisma.sourceDoc.create({
    data: {
      runId,
      type: "SCREENER_PAGE",
      name: `${run.company.name} — financials (derived from uploads)`,
      sourceUrl: "derived://uploaded-financials",
      fetchedVia: "MANUAL",
      fetchStatus: "OK",
      structuredData: structuredData as unknown as Prisma.InputJsonValue,
    },
  });
  return true;
}
