import { Prisma } from "@prisma/client";
import type { FetchStatus, FetchedVia, SourceDocType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { openScreenerSession, type ScreenerSession } from "./browser";
import { extractDocumentLinks, parseScreenerPage } from "./parse";
import { downloadAndExtract } from "./documents";
import { stripNul, stripNulDeep } from "./sanitize";
import type {
  DocumentLink,
  HarvestSummary,
  ScreenerStructuredData,
} from "./types";

export { openScreenerSession } from "./browser";
export * from "./types";

const SCREENER_BASE = "https://www.screener.in";
const CATEGORY_CAPS: Record<string, number> = {
  annual_report: 3,
  concall: 8,
  credit_rating: 5,
  announcement: 20,
};

type StructuredWithDocs = ScreenerStructuredData;

function companyUrlCandidates(ticker: string): string[] {
  const t = encodeURIComponent(ticker.trim().toUpperCase());
  return [
    `${SCREENER_BASE}/company/${t}/consolidated/`,
    `${SCREENER_BASE}/company/${t}/`,
  ];
}

function looksLikeCompanyPage(html: string): boolean {
  return /id="top-ratios"|id="profit-loss"|class="company-profile"|class="company-info"/.test(
    html,
  );
}

/** Apply per-category caps (last 3 annual reports, recent concalls, etc.). */
function capLinks(links: DocumentLink[]): DocumentLink[] {
  const counts: Record<string, number> = {};
  const out: DocumentLink[] = [];
  for (const l of links) {
    const cap = CATEGORY_CAPS[l.category] ?? 10;
    const n = counts[l.category] ?? 0;
    if (n < cap) {
      out.push(l);
      counts[l.category] = n + 1;
    }
  }
  return out;
}

function summariseFields(s: StructuredWithDocs): string[] {
  const f: string[] = [];
  const rc = Object.keys(s.ratios ?? {}).length;
  if (rc) f.push(`ratios(${rc})`);
  if (s.profitLoss) f.push(`profitLoss(${s.profitLoss.rows.length}r×${s.profitLoss.periods.length}p)`);
  if (s.quarters) f.push(`quarters(${s.quarters.rows.length}r)`);
  if (s.balanceSheet) f.push(`balanceSheet(${s.balanceSheet.rows.length}r)`);
  if (s.cashFlow) f.push(`cashFlow(${s.cashFlow.rows.length}r)`);
  if (s.ratiosTable) f.push(`ratiosTable(${s.ratiosTable.rows.length}r)`);
  if (s.shareholding) f.push(`shareholding(${s.shareholding.periods.length}p${s.shareholding.pledged ? "+pledged" : ""})`);
  if (s.peers) f.push(`peers(${s.peers.rows.length}r)`);
  if (s.pros?.length) f.push(`pros(${s.pros.length})`);
  if (s.cons?.length) f.push(`cons(${s.cons.length})`);
  if (s.documents?.length) f.push(`documents(${s.documents.length})`);
  return f;
}

interface UpsertInput {
  type: SourceDocType;
  name: string;
  sourceUrl: string;
  fetchedVia: FetchedVia;
  fetchStatus: FetchStatus;
  structuredData?: Prisma.InputJsonValue;
  extractedText?: string | null;
  pages?: number | null;
  note?: string | null;
}


async function upsertSourceDoc(runId: string, d: UpsertInput): Promise<void> {
  const data = {
    type: d.type,
    name: d.name,
    fetchedVia: d.fetchedVia,
    fetchStatus: d.fetchStatus,
    // Postgres rejects NUL (0x00) in TEXT/JSONB — strip before writing.
    structuredData:
      d.structuredData === undefined
        ? undefined
        : (stripNulDeep(d.structuredData) as Prisma.InputJsonValue),
    extractedText: d.extractedText ? stripNul(d.extractedText) : undefined,
    pages: d.pages ?? undefined,
    note: d.note ? stripNul(d.note).slice(0, 1000) : undefined,
  };
  await prisma.sourceDoc.upsert({
    where: { runId_sourceUrl: { runId, sourceUrl: d.sourceUrl } },
    create: { runId, sourceUrl: d.sourceUrl, ...data },
    update: data,
  });
}

async function fetchScreenerPage(
  session: ScreenerSession | null,
  ticker: string,
  knownUrl: string | null,
): Promise<{ url: string; html: string; ok: boolean; note?: string }> {
  const fallback = companyUrlCandidates(ticker)[1];
  if (!session) {
    return { url: fallback, html: "", ok: false, note: "browser session unavailable" };
  }
  const candidates = knownUrl
    ? [knownUrl, ...companyUrlCandidates(ticker)]
    : companyUrlCandidates(ticker);
  const tried = new Set<string>();
  let note: string | undefined;
  for (const url of candidates) {
    if (tried.has(url)) continue;
    tried.add(url);
    try {
      const r = await session.fetchRenderedHtml(url);
      if (r.ok && looksLikeCompanyPage(r.html)) {
        return { url: r.finalUrl || url, html: r.html, ok: true };
      }
      note = `HTTP ${r.status} at ${url}`;
    } catch (e) {
      note = `${(e as Error).message} at ${url}`;
    }
  }
  return { url: fallback, html: "", ok: false, note };
}

/**
 * Fully-automated, two-tier harvest of one company into SourceDoc rows.
 *
 * - Tier 1: structured Screener page scrape → one SCREENER_PAGE SourceDoc with
 *   rich `structuredData` (most NUMERIC items, ~zero LLM).
 * - Tier 2: download + text-extract annual reports / concalls / credit ratings /
 *   announcements → one SourceDoc each (durable `extractedText`).
 *
 * IDEMPOTENT + RESUMABLE: re-running only (re)fetches what is missing or was
 * previously FAILED. GRACEFUL: never throws — failures become FAILED/EMPTY
 * SourceDocs + notes and the run is still left ready for processing.
 */
export async function harvestCompany({
  companyId,
  runId,
}: {
  companyId: string;
  runId: string;
}): Promise<HarvestSummary> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const ticker = (company.ticker || company.name || "").trim();
  // Stable key for the single SCREENER_PAGE row (so re-runs upsert, not duplicate).
  const canonicalUrl = companyUrlCandidates(ticker)[1];

  await prisma.analysisRun.update({
    where: { id: runId },
    data: { status: "HARVESTING", lastProcessedAt: new Date() },
  });

  const summary: HarvestSummary = {
    companyId,
    runId,
    screenerUrl: company.screenerUrl ?? undefined,
    tier1: { status: "FAILED", via: "SCREENER", fields: [] },
    tier2: [],
  };

  let session: ScreenerSession | null = null;
  try {
    try {
      session = await openScreenerSession();
    } catch (e) {
      summary.tier1.note = `browser launch failed: ${(e as Error).message}`;
    }

    // ---------------- TIER 1 ----------------
    let links: DocumentLink[] = [];
    const existingPage = await prisma.sourceDoc.findUnique({
      where: { runId_sourceUrl: { runId, sourceUrl: canonicalUrl } },
    });

    if (existingPage?.fetchStatus === "OK" && existingPage.structuredData) {
      const structured = existingPage.structuredData as unknown as StructuredWithDocs;
      links = capLinks((structured.documents ?? []) as DocumentLink[]);
      summary.screenerUrl = company.screenerUrl ?? canonicalUrl;
      summary.tier1 = {
        status: "OK",
        via: existingPage.fetchedVia,
        fields: summariseFields(structured),
        note: "reused (already OK)",
      };
    } else {
      const fetched = await fetchScreenerPage(session, ticker, company.screenerUrl ?? null);
      summary.screenerUrl = fetched.url;
      await prisma.company
        .update({ where: { id: companyId }, data: { screenerUrl: fetched.url } })
        .catch(() => {});

      if (fetched.ok && fetched.html) {
        links = capLinks(extractDocumentLinks(fetched.html, SCREENER_BASE));
        const structured: StructuredWithDocs = {
          ...parseScreenerPage(fetched.html, {
            ticker,
            url: fetched.url,
            capturedAt: new Date().toISOString(),
          }),
          documents: links,
        };
        await upsertSourceDoc(runId, {
          type: "SCREENER_PAGE",
          name: `Screener page — ${company.name}`,
          sourceUrl: canonicalUrl,
          fetchedVia: "SCREENER",
          fetchStatus: "OK",
          structuredData: structured as unknown as Prisma.InputJsonValue,
          note: session?.loggedIn ? null : "logged-out scrape",
        });
        summary.tier1 = { status: "OK", via: "SCREENER", fields: summariseFields(structured) };
      } else {
        const note = fetched.note ?? session?.note ?? "could not load Screener page";
        await upsertSourceDoc(runId, {
          type: "SCREENER_PAGE",
          name: `Screener page — ${company.name}`,
          sourceUrl: canonicalUrl,
          fetchedVia: "SCREENER",
          fetchStatus: "FAILED",
          note,
        });
        summary.tier1 = { status: "FAILED", via: "SCREENER", fields: [], note };
      }
    }

    // ---------------- TIER 2 ----------------
    for (const link of links) {
      // Per-document try/catch: one document's failure (download, parse, or a
      // persist error) must never abort the rest of the harvest.
      try {
        const existingDoc = await prisma.sourceDoc.findUnique({
          where: { runId_sourceUrl: { runId, sourceUrl: link.url } },
        });
        if (existingDoc?.fetchStatus === "OK") {
          summary.tier2.push({
            name: link.name,
            type: link.type,
            category: link.category,
            via: existingDoc.fetchedVia,
            status: "OK",
            pages: existingDoc.pages ?? undefined,
            note: "reused",
          });
          continue;
        }
        const r = await downloadAndExtract(link, session);
        await upsertSourceDoc(runId, {
          type: link.type,
          name: link.name,
          sourceUrl: link.url,
          fetchedVia: r.via,
          fetchStatus: r.status,
          extractedText: r.text ?? null,
          pages: r.pages ?? null,
          note: r.note ?? null,
        });
        summary.tier2.push({
          name: link.name,
          type: link.type,
          category: link.category,
          via: r.via,
          status: r.status,
          pages: r.pages,
          note: r.note,
        });
      } catch (e) {
        const note = `persist error: ${(e as Error).message}`.slice(0, 300);
        // best-effort: record the failure (without the offending payload)
        await upsertSourceDoc(runId, {
          type: link.type,
          name: link.name,
          sourceUrl: link.url,
          fetchedVia: "SCREENER",
          fetchStatus: "FAILED",
          note,
        }).catch(() => {});
        summary.tier2.push({
          name: link.name,
          type: link.type,
          category: link.category,
          via: "SCREENER",
          status: "FAILED",
          note,
        });
      }
    }
  } catch (e) {
    summary.tier1.note = `${summary.tier1.note ? summary.tier1.note + "; " : ""}harvest error: ${(e as Error).message}`;
  } finally {
    if (session) await session.close().catch(() => {});
    // Acquisition is complete (success or graceful degradation) — mark the run
    // HARVESTED so the separate, later processing phase can pick it up.
    await prisma.analysisRun
      .update({ where: { id: runId }, data: { status: "HARVESTED", lastProcessedAt: new Date() } })
      .catch(() => {});
  }

  return summary;
}
