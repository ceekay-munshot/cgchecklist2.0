import { prisma } from "@/lib/db";
import { isCommitted, summarize } from "@/lib/orchestrate";
import type { RunSummary } from "@/lib/orchestrate";
import { parseTable, type DataTable } from "@/lib/engine/types";
import { isListedOnlyItem, LISTED_ONLY_NA_VERDICT } from "@/lib/engine/applicability";

/**
 * Read models for the report UI + exporters. One place loads a company's latest
 * run into a fully-shaped, presentation-ready object (mirrors analyze-run's
 * writeReport): committed-only `flag`, a non-terminal item's leftover flag in
 * `staleFlag`, evidence, citation and confidence.
 */

export type FlagName = "GREEN" | "RED" | "NEUTRAL" | "NOT_AVAILABLE";

export interface ReportItem {
  id: string;
  item: string;
  description: string | null;
  outputFormat: string | null;
  sectionCode: string;
  status: string;
  flag: FlagName | null; // committed-only
  staleFlag: FlagName | null; // leftover flag on a non-terminal item
  /**
   * For a NOT_AVAILABLE flag, WHY it's blank:
   *   - "not_applicable": a listed-only item on an unlisted company (by design)
   *   - "no_data": genuinely couldn't be answered from the available sources
   */
  naKind: "not_applicable" | "no_data" | null;
  value: string | null;
  verdict: string | null;
  confidence: number | null;
  provider: string | null;
  isNonNegotiable: boolean;
  needsReview: boolean;
  evidenceQuote: string | null;
  /** Structured breakdown (e.g. per-director overboarding), when present. */
  table: DataTable | null;
  source: { page: number | null; url: string | null; doc: string | null };
}

/** A harvested document the run had access to (for the report's source list). */
export interface ReportDoc {
  name: string;
  type: string;
  url: string | null;
  pages: number | null;
}

export interface ReportSection {
  code: string;
  name: string;
  items: ReportItem[];
  counts: { green: number; red: number; neutral: number; na: number; total: number };
}

export interface CompanyReport {
  runId: string;
  ticker: string | null;
  company: string;
  exchange: string | null;
  sector: string | null;
  status: string;
  createdAt: string;
  lastProcessedAt: string | null;
  summary: RunSummary | null;
  sections: ReportSection[];
  /** Documents the run harvested + read from (source transparency). */
  documents: ReportDoc[];
  /** convenience rollup for headers/cards */
  answered: number; // green + red + neutral
  total: number;
}

export interface CompanyCard {
  ticker: string | null;
  company: string;
  exchange: string | null;
  sector: string | null;
  runId: string;
  status: string;
  answered: number;
  total: number;
  reds: number;
  green: number;
  neutral: number;
  na: number;
  gatePass: boolean | null;
  updatedAt: string;
}

const NA = "NOT_AVAILABLE";

function countItems(items: ReportItem[]): ReportSection["counts"] {
  const c = { green: 0, red: 0, neutral: 0, na: 0, total: items.length };
  for (const it of items) {
    const f = it.flag;
    if (f === "GREEN") c.green++;
    else if (f === "RED") c.red++;
    else if (f === "NEUTRAL") c.neutral++;
    else c.na++; // NOT_AVAILABLE or not-yet-committed
  }
  return c;
}

/** Load the latest run for a ticker (or a runId) into a presentation-ready report. */
export async function loadReport(tickerOrRunId: string): Promise<CompanyReport | null> {
  let run = await prisma.analysisRun.findUnique({
    where: { id: tickerOrRunId },
    include: { company: true },
  });
  if (!run) {
    const company = await prisma.company.findFirst({
      where: { ticker: tickerOrRunId.toUpperCase() },
      orderBy: { createdAt: "desc" },
    });
    if (!company) return null;
    run = await prisma.analysisRun.findFirst({
      where: { companyId: company.id },
      orderBy: { createdAt: "desc" },
      include: { company: true },
    });
  }
  if (!run) return null;

  const [items, sections, results, docs] = await Promise.all([
    prisma.checklistItem.findMany({ orderBy: [{ sectionCode: "asc" }, { orderIndex: "asc" }] }),
    prisma.checklistSection.findMany({ orderBy: { orderIndex: "asc" } }),
    prisma.itemResult.findMany({ where: { runId: run.id } }),
    prisma.sourceDoc.findMany({
      where: { runId: run.id },
      select: { id: true, name: true, type: true, sourceUrl: true, pages: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
  ]);
  const byId = new Map(results.map((r) => [r.itemId, r]));
  const docById = new Map(docs.map((d) => [d.id, d]));

  // Applicability is AUTHORITATIVE at read time: a listed-only item on an unlisted
  // company is "not applicable" regardless of any flag a prior pass may have stored
  // (a run that spanned a deploy, or was evaluated before the gate existed, can
  // otherwise show a stale NEUTRAL/GREEN on a structurally-inapplicable item).
  const unlisted = !run.company.ticker;
  const forcedNA = (id: string) => unlisted && isListedOnlyItem(id);

  const reportSections: ReportSection[] = sections.map((s) => {
    const secItems: ReportItem[] = items
      .filter((it) => it.sectionCode === s.code)
      .map((it) => {
        const r = byId.get(it.id);
        const committed = isCommitted(r?.status);
        const na = forcedNA(it.id);
        return {
          id: it.id,
          item: it.item,
          description: it.description,
          outputFormat: it.outputFormat,
          sectionCode: it.sectionCode,
          status: na ? "DONE" : (r?.status ?? "PENDING"),
          flag: (na ? NA : committed ? (r?.flag ?? null) : null) as FlagName | null,
          staleFlag: (!na && !committed && r?.flag ? r.flag : null) as FlagName | null,
          naKind: na
            ? "not_applicable"
            : committed && r?.flag === NA
              ? r?.verdict === LISTED_ONLY_NA_VERDICT
                ? "not_applicable"
                : "no_data"
              : null,
          value: na ? "not applicable" : (r?.value ?? null),
          verdict: na ? LISTED_ONLY_NA_VERDICT : (r?.verdict ?? null),
          confidence: r?.confidence ?? null,
          provider: r?.providerUsed ?? null,
          isNonNegotiable: r?.isNonNegotiable ?? it.isNonNegotiable,
          needsReview: r?.status === "NEEDS_REVIEW",
          // A structured table rides in evidenceQuote behind a marker — split it out.
          table: parseTable(r?.evidenceQuote),
          evidenceQuote: parseTable(r?.evidenceQuote) ? null : (r?.evidenceQuote ?? null),
          source: {
            page: r?.sourcePage ?? null,
            url: r?.sourceUrl ?? null,
            doc: (r?.sourceDocId ? docById.get(r.sourceDocId)?.name : null) ?? null,
          },
        };
      });
    return { code: s.code, name: s.name, items: secItems, counts: countItems(secItems) };
  });

  const allItems = reportSections.flatMap((s) => s.items);
  const answered = allItems.filter((i) => i.flag === "GREEN" || i.flag === "RED" || i.flag === "NEUTRAL").length;

  // Recompute the summary from the LIVE item results rather than trusting the
  // stored summaryJson — a later stage (e.g. MUNS backfill) may have filled
  // items after analyze-run wrote the summary, so the stored tally can be stale.
  const summary = summarize(
    items.map((it) => ({ id: it.id, sectionCode: it.sectionCode, isNonNegotiable: it.isNonNegotiable })),
    sections.map((s) => ({ code: s.code, name: s.name })),
    // Apply the same applicability override to the tally so the KPIs match the rows.
    items.map((it) => {
      if (forcedNA(it.id)) return { itemId: it.id, status: "DONE", flag: NA };
      const r = byId.get(it.id);
      return { itemId: it.id, status: r?.status ?? "PENDING", flag: r?.flag ?? null };
    }),
  );

  return {
    runId: run.id,
    ticker: run.company.ticker,
    company: run.company.name,
    exchange: run.company.exchange ?? null,
    sector: run.company.sector ?? null,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    lastProcessedAt: run.lastProcessedAt?.toISOString() ?? null,
    summary,
    sections: reportSections,
    documents: docs.map((d) => ({ name: d.name, type: d.type, url: d.sourceUrl || null, pages: d.pages ?? null })),
    answered,
    total: allItems.length,
  };
}

/**
 * One card per company (its latest run) for the landing/list page.
 *
 * Batched to 3 queries total (companies → latest runs → grouped flag counts)
 * instead of the old 1 + 2×N round-trips, which made the home page crawl over
 * the Accelerate connection once a handful of companies existed.
 */
export async function listCompanyCards(): Promise<CompanyCard[]> {
  const companies = await prisma.company.findMany({ orderBy: { name: "asc" } });
  if (!companies.length) return [];
  const companyIds = companies.map((c) => c.id);

  // Latest run per company — one query, newest first, keep the first per company.
  const runs = await prisma.analysisRun.findMany({
    where: { companyId: { in: companyIds } },
    orderBy: { createdAt: "desc" },
  });
  const latestRun = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latestRun.has(r.companyId)) latestRun.set(r.companyId, r);

  const runIds = [...latestRun.values()].map((r) => r.id);
  // Committed flag tallies for all those runs — one groupBy instead of N findMany.
  const grouped = runIds.length
    ? await prisma.itemResult.groupBy({
        by: ["runId", "flag"],
        where: { runId: { in: runIds }, status: { in: ["DONE", "NEEDS_REVIEW"] } },
        _count: { _all: true },
      })
    : [];
  const tally = new Map<string, { green: number; red: number; neutral: number; na: number }>();
  for (const g of grouped) {
    const t = tally.get(g.runId) ?? { green: 0, red: 0, neutral: 0, na: 0 };
    const n = g._count._all;
    if (g.flag === "GREEN") t.green += n;
    else if (g.flag === "RED") t.red += n;
    else if (g.flag === "NEUTRAL") t.neutral += n;
    else if (g.flag === NA) t.na += n;
    tally.set(g.runId, t);
  }

  const cards: CompanyCard[] = [];
  for (const c of companies) {
    const run = latestRun.get(c.id);
    if (!run) continue;
    const t = tally.get(run.id) ?? { green: 0, red: 0, neutral: 0, na: 0 };
    const summary = run.summaryJson as unknown as RunSummary | null;
    cards.push({
      ticker: c.ticker,
      company: c.name,
      exchange: c.exchange ?? null,
      sector: c.sector ?? null,
      runId: run.id,
      status: run.status,
      answered: t.green + t.red + t.neutral,
      total: t.green + t.red + t.neutral + t.na,
      reds: t.red,
      green: t.green,
      neutral: t.neutral,
      na: t.na,
      gatePass: summary?.nonNegotiable?.gatePass ?? null,
      updatedAt: (run.lastProcessedAt ?? run.createdAt).toISOString(),
    });
  }
  return cards;
}
