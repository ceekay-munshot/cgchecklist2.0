import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SourceDoc } from "@prisma/client";

vi.mock("@/lib/db", () => ({
  prisma: {
    sourceDoc: { findFirst: vi.fn(), findMany: vi.fn() },
    analysisRun: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/scrape", () => ({
  webResearcher: { search: vi.fn(), fetchUrl: vi.fn() },
}));
vi.mock("./llm", () => ({ callJSON: vi.fn() }));

import {
  buildWebQuery,
  evidenceStrategyFor,
  getEvidence,
  webHitRelevant,
  researchQueriesFor,
  loadSubjectPeople,
  resetSubjectPeopleCache,
} from "./evidence";
import { callJSON } from "./llm";
import type { Company } from "@prisma/client";
import { prisma } from "@/lib/db";
import { webResearcher } from "@/lib/scrape";
import type { EngineItem } from "./types";

function item(p: Partial<EngineItem> & { id: string }): EngineItem {
  return {
    sectionCode: p.id.split("-")[0],
    item: p.item ?? "Item",
    description: null,
    outputFormat: p.outputFormat ?? null,
    greenFlag: null,
    redFlag: null,
    sourceHint: null,
    isNonNegotiable: false,
    ...p,
  };
}

const sd = (p: Partial<SourceDoc>): SourceDoc => p as unknown as SourceDoc;

const company = (p: Partial<Company>): Company => p as unknown as Company;

describe("buildWebQuery — anchor web research to the Indian listed company", () => {
  it("appends an India anchor so a short name can't match a foreign namesake", () => {
    // "Trent" alone matched "Severn Trent PLC"; anchor it to India + the ticker.
    const q = buildWebQuery(company({ name: "Trent", ticker: "TRENT" }), "senior management team tenure");
    expect(q).toContain("Trent");
    expect(q).toMatch(/india/i);
    expect(q).toContain("senior management team tenure");
  });
  it("does not double-anchor a name that is already India-qualified", () => {
    const q = buildWebQuery(company({ name: "Trent Limited", ticker: "TRENT" }), "auditor reputation");
    // "Limited" already disambiguates — don't bolt on a redundant " India".
    expect(q.match(/india/gi) ?? []).toHaveLength(0);
    expect(q).toContain("Trent Limited");
    expect(q).toContain("auditor reputation");
  });
  it("falls back to the bare topic when there is no company", () => {
    expect(buildWebQuery(null, "promoter background")).toBe("promoter background");
  });
});

describe("webHitRelevant — reject namesake web hits for private companies", () => {
  it("PRIVATE company (no ticker): requires the FULL registered name as a phrase", () => {
    const nora = company({ name: "Nora Enterprises", ticker: null });
    // The real bug: "nora" matched "De Nora India" — must now be rejected.
    expect(webHitRelevant("De Nora India Ltd sells electrodes", nora)).toBe(false);
    expect(webHitRelevant("Sunteck Realty board of directors", nora)).toBe(false);
    // A genuine hit that names the company survives.
    expect(webHitRelevant("Nora Enterprises Chennai — vending FMCG", nora)).toBe(true);
  });
  it("LISTED company (has ticker): a distinctive-token match is enough", () => {
    const trent = company({ name: "Trent Limited", ticker: "TRENT" });
    expect(webHitRelevant("Trent posts record quarter on Zudio growth", trent)).toBe(true);
  });
});

describe("evidenceStrategyFor — routing per item", () => {
  it("routes Tier-1 numeric items to the Screener page", () => {
    expect(evidenceStrategyFor(item({ id: "A14-01", outputFormat: "D/E ratio" })).from).toBe("screener");
    expect(evidenceStrategyFor(item({ id: "A3-02", outputFormat: "%" })).from).toBe("screener");
    expect(evidenceStrategyFor(item({ id: "A3-01", outputFormat: "% + trend" })).from).toBe("screener");
  });
  it("routes numeric-from-document (board independence) to the annual report", () => {
    const s = evidenceStrategyFor(item({ id: "A1-01", outputFormat: "% independent" }));
    expect(s.from).toBe("document");
    expect(s.docTypes).toContain("ANNUAL_REPORT");
  });
  it("routes auditor identity to the annual report", () => {
    expect(evidenceStrategyFor(item({ id: "A4-01", outputFormat: "Yes/No" })).from).toBe("document");
  });
  it("routes the CEO view to documents with a web fallback", () => {
    const s = evidenceStrategyFor(item({ id: "A13-02", outputFormat: "Text/Score" }));
    expect(s.from).toBe("document");
    expect(s.webFallback).toBe(true);
  });
  it("defaults unknown numeric -> screener, unknown qualitative -> document", () => {
    expect(evidenceStrategyFor(item({ id: "A15-99", outputFormat: "%" })).from).toBe("screener");
    expect(evidenceStrategyFor(item({ id: "A5-99", outputFormat: "Yes/No" })).from).toBe("document");
  });
  it("routes computed-numeric items to the Screener page with the right field", () => {
    const s = evidenceStrategyFor(item({ id: "A8-01", outputFormat: "Ratio (cumulative)" }));
    expect(s.from).toBe("screener");
    expect(s.screenerFields?.[0]).toMatchObject({ kind: "cfoToPat" });
  });
  it("gives section-profiled document items note headings to locate", () => {
    const s = evidenceStrategyFor(item({ id: "A7a-13", outputFormat: "Trend" }));
    expect(s.from).toBe("document");
    expect(s.sections).toContain("contingent liabilities and commitments");
  });
  it("marks table-heavy notes (A7a, A5) for Gemini note reading", () => {
    expect(evidenceStrategyFor(item({ id: "A7a-03", outputFormat: "₹ / % NW" })).useGeminiNote).toBe(true);
    expect(evidenceStrategyFor(item({ id: "A5-02", outputFormat: "% of sales" })).useGeminiNote).toBe(true);
    // a non-note document item is NOT flagged for Gemini note reading
    expect(evidenceStrategyFor(item({ id: "A4-01", outputFormat: "Yes/No" })).useGeminiNote).toBeFalsy();
  });
  it("marks web/market-data items (attrition, coverage, …) as expected-NA with a web fallback", () => {
    for (const id of ["A12-01", "A15-03", "A3-07", "A9-01"]) {
      const s = evidenceStrategyFor(item({ id, outputFormat: "Count" }));
      expect(s.expectedNa).toBe(true);
      expect(s.webFallback).toBe(true);
      expect(s.webQuery).toBeTruthy();
    }
    // a normal filing item is NOT marked expected-NA
    expect(evidenceStrategyFor(item({ id: "A4-01", outputFormat: "Yes/No" })).expectedNa).toBeFalsy();
  });
  it("reads board attendance (A1-07) and overboarding (A1-06) from the annual report first, web only as fallback", () => {
    for (const id of ["A1-07", "A1-06"]) {
      const s = evidenceStrategyFor(item({ id, outputFormat: id === "A1-06" ? "Count" : "%" }));
      expect(s.from).toBe("document");
      expect(s.expectedNa).toBeFalsy(); // document-first, not an expected-NA web item
      expect(s.webFallback).toBe(true);
    }
  });
  it("routes Bucket-A items to the right harvested source (notes / transcripts / ratings)", () => {
    // auditor-fee note → Gemini note reading
    expect(evidenceStrategyFor(item({ id: "A4-06", outputFormat: "₹" })).useGeminiNote).toBe(true);
    expect(evidenceStrategyFor(item({ id: "A11-03", outputFormat: "₹" })).useGeminiNote).toBe(true);
    // concall candor → read the earnings-call transcripts
    expect(evidenceStrategyFor(item({ id: "A7-04", outputFormat: "Text" })).docTypes).toContain("EARNINGS_PDF");
    // rating actions → read the credit-rating announcements
    expect(evidenceStrategyFor(item({ id: "A9-05", outputFormat: "Text" })).docTypes).toContain("ANNOUNCEMENT");
    // ESOP existence → share-based-payments section, plain qualitative (not a figure note)
    expect(evidenceStrategyFor(item({ id: "A12-03", outputFormat: "Yes/No" })).sections?.[0]).toContain("stock option");
  });
  it("gives A2-01 a note-window strategy so the committee table can be read", () => {
    const s = evidenceStrategyFor(item({ id: "A2-01", outputFormat: "Yes/No + count" }));
    expect(s.from).toBe("document");
    expect(s.useGeminiNote).toBe(true);
    expect(s.sections?.some((h) => h.includes("audit committee"))).toBe(true);
  });
  it("routes promoter/management-quality items (A13, A9-04) to the web fallback too — doc first, then web", () => {
    for (const id of ["A9-04", "A13-01", "A13-03", "A13-06", "A13-09"]) {
      const s = evidenceStrategyFor(item({ id, sectionCode: id.slice(0, id.indexOf("-")), outputFormat: "Text" }));
      expect(s.webFallback).toBe(true);
      expect(s.expectedNa).toBe(true);
      expect(s.webQuery).toBeTruthy();
      // still tries the document first (filing-first, web-second)
      expect(s.from).toBe("document");
    }
  });
});

describe("researchQueriesFor — analyst multi-angle search for Tier-3 items", () => {
  const tcs = company({ name: "Tata Consultancy Services", ticker: "TCS" });
  it("a research item (A9-04) gets several angles incl. adverse terms + Valuepickr", () => {
    const qs = researchQueriesFor(item({ id: "A9-04", sectionCode: "A9" }), tcs, "promoter track record");
    expect(qs.length).toBeGreaterThanOrEqual(3);
    expect(qs.some((q) => /fraud|default|litigation|SEBI/i.test(q))).toBe(true);
    expect(qs.some((q) => /valuepickr/i.test(q))).toBe(true);
  });
  it("a non-research item gets a single query", () => {
    const qs = researchQueriesFor(item({ id: "A7a-01", sectionCode: "A7a" }), tcs, "contingent liabilities");
    expect(qs).toHaveLength(1);
  });
  it("person-track-record items google the promoter by NAME (not company-anchored)", () => {
    const qs = researchQueriesFor(item({ id: "A9-04", sectionCode: "A9" }), tcs, "promoter track record", [
      "Deepak Parasuraman",
      "Lalit Gupta",
    ]);
    expect(qs.some((q) => q.includes('"Deepak Parasuraman"'))).toBe(true);
    expect(qs.some((q) => q.includes('"Deepak Parasuraman"') && /valuepickr/i.test(q))).toBe(true);
  });
  it("a non-person research item (A9-01 SEBI actions) ignores the names", () => {
    const qs = researchQueriesFor(item({ id: "A9-01", sectionCode: "A9" }), tcs, "SEBI actions", ["Deepak Parasuraman"]);
    expect(qs.every((q) => !q.includes('"Deepak Parasuraman"'))).toBe(true);
  });
  it("DIRECTOR reputation (A1-05) googles each director by name — the Saregama/Pratip gap", () => {
    const s = evidenceStrategyFor(item({ id: "A1-05", sectionCode: "A1", outputFormat: "Text/Score" }));
    expect(s.webFallback).toBe(true); // now a web-research item, not an AR directorship count
    const qs = researchQueriesFor(item({ id: "A1-05", sectionCode: "A1" }), tcs, "director reputation", ["Pratip Chaudhuri"]);
    expect(qs.some((q) => q.includes('"Pratip Chaudhuri"'))).toBe(true);
    expect(qs.some((q) => q.includes('"Pratip Chaudhuri"') && /valuepickr/i.test(q))).toBe(true);
  });
});

describe("loadSubjectPeople — extract promoter/director names for person-search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSubjectPeopleCache();
  });
  it("pulls individual names from the board/promoter section and strips honorifics", async () => {
    vi.mocked(prisma.analysisRun.findUnique).mockResolvedValue({
      company: { name: "Afcom Holdings", ticker: "AFCOM" },
    } as unknown as Awaited<ReturnType<typeof prisma.analysisRun.findUnique>>);
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([
      sd({
        id: "ar1",
        type: "ANNUAL_REPORT",
        sourceUrl: "u",
        name: "AR",
        extractedText: "===== PAGE 12 =====\nBoard of Directors\nThe board comprises Capt. Deepak Parasuraman and Dr. Lalit Gupta.",
      }),
    ]);
    vi.mocked(callJSON).mockResolvedValue({
      data: { names: ["Capt. Deepak Parasuraman", "Dr. Lalit Gupta"] },
      provider: "groq",
    });
    const names = await loadSubjectPeople("runNames");
    expect(names).toContain("Deepak Parasuraman"); // honorific stripped
    expect(names).toContain("Lalit Gupta");
  });
  it("returns [] gracefully when no documents are harvested (never breaks evidence)", async () => {
    vi.mocked(prisma.analysisRun.findUnique).mockResolvedValue({
      company: { name: "X", ticker: "X" },
    } as unknown as Awaited<ReturnType<typeof prisma.analysisRun.findUnique>>);
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([]);
    expect(await loadSubjectPeople("runEmpty")).toEqual([]);
    expect(callJSON).not.toHaveBeenCalled();
  });
});

describe("getEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callJSON).mockReset(); // no leaked name-extraction result
    resetSubjectPeopleCache();
  });

  it("Tier-3 research pools multiple queries, de-dupes, and DROPS the company's own filing hosts", async () => {
    vi.mocked(prisma.analysisRun.findUnique).mockResolvedValue({
      company: { name: "Tata Consultancy Services", ticker: "TCS" },
    } as unknown as Awaited<ReturnType<typeof prisma.analysisRun.findUnique>>);
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([]);
    // Every search angle returns a filing hit (bseindia) AND an independent news hit.
    vi.mocked(webResearcher.search).mockResolvedValue({
      status: "ok",
      query: "q",
      results: [
        { url: "https://www.bseindia.com/xml-data/tcs.pdf", title: "TCS filing", snippet: "TCS discloses" },
        { url: "https://news.example/tcs-promoter-probe", title: "TCS promoter under probe", snippet: "TCS promoter faces scrutiny" },
      ],
    });
    const ev = await getEvidence(item({ id: "A9-04", sectionCode: "A9", outputFormat: "Text" }), "run1");
    // Several analyst angles were searched (plain + adverse-terms + Valuepickr).
    const queries = vi.mocked(webResearcher.search).mock.calls.map((c) => String(c[0]));
    expect(queries.some((q) => /fraud|default|litigation/i.test(q))).toBe(true);
    expect(queries.some((q) => /valuepickr/i.test(q))).toBe(true);
    expect(ev.status).toBe("found");
    // the independent news source survives; the exchange filing host is dropped
    const urls = (ev.passages ?? []).map((p) => p.citation.sourceUrl);
    expect(urls.some((u) => u?.includes("news.example"))).toBe(true);
    expect(urls.every((u) => !u?.includes("bseindia.com"))).toBe(true);
  });

  it("reads Tier-1 structuredData for a numeric item (D/E), citing the SCREENER_PAGE", async () => {
    vi.mocked(prisma.sourceDoc.findFirst).mockResolvedValue(
      sd({
        id: "sd1",
        sourceUrl: "https://screener.in/x",
        name: "Screener page",
        type: "SCREENER_PAGE",
        structuredData: { ratios: { "Debt to equity": "0.09" } } as unknown as SourceDoc["structuredData"],
      }),
    );
    const ev = await getEvidence(item({ id: "A14-01", outputFormat: "D/E ratio" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.from).toBe("screener");
    expect(ev.structured?.["Debt to equity"]).toBe("0.09");
    expect(ev.citation?.docType).toBe("SCREENER_PAGE");
  });

  it("returns not_available when the Screener page is missing", async () => {
    vi.mocked(prisma.sourceDoc.findFirst).mockResolvedValue(null);
    const ev = await getEvidence(item({ id: "A14-01", outputFormat: "D/E ratio" }), "run1");
    expect(ev.status).toBe("not_available");
  });

  it("returns not_available for a document item when no passages match", async () => {
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([
      sd({ id: "ar1", type: "ANNUAL_REPORT", sourceUrl: "u", name: "AR", extractedText: "nothing relevant here" }),
    ]);
    const ev = await getEvidence(item({ id: "A4-01", outputFormat: "Yes/No" }), "run1");
    expect(ev.status).toBe("not_available");
  });

  it("searches the WEB FIRST for a web-only item, even when a tangential filing section exists", async () => {
    // A "board of directors" section exists (would otherwise be 'found' and
    // pre-empt the web) — but A13-09 is a web/market-data item, so web wins.
    vi.mocked(prisma.analysisRun.findUnique).mockResolvedValue({
      company: { name: "Tata Consultancy Services", ticker: "TCS" },
    } as unknown as Awaited<ReturnType<typeof prisma.analysisRun.findUnique>>);
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([
      sd({ id: "ar1", type: "ANNUAL_REPORT", sourceUrl: "u", name: "AR", extractedText: "===== PAGE 9 =====\nBoard of Directors composition and meetings 6 times." }),
    ]);
    vi.mocked(webResearcher.search).mockResolvedValue({
      status: "ok",
      query: "q",
      results: [{ url: "https://news.example/tcs-politics", title: "TCS", snippet: "No political affiliations reported." }],
    });
    const ev = await getEvidence(item({ id: "A13-09", outputFormat: "Text" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.from).toBe("web");
    expect(webResearcher.search).toHaveBeenCalled();
    expect(ev.passages?.[0].citation.sourceUrl).toContain("news.example");
  });

  it("drops social/UGC domains (facebook/instagram/…) as web sources → honest NA", async () => {
    vi.mocked(prisma.analysisRun.findUnique).mockResolvedValue({
      company: { name: "Tata Consultancy Services", ticker: "TCS" },
    } as unknown as Awaited<ReturnType<typeof prisma.analysisRun.findUnique>>);
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([]);
    vi.mocked(webResearcher.search).mockResolvedValue({
      status: "ok",
      query: "q",
      results: [{ url: "https://www.facebook.com/groups/123/posts/456", title: "TCS bench strength", snippet: "TCS hiring" }],
    });
    const ev = await getEvidence(item({ id: "A13-05", outputFormat: "Text" }), "run1");
    expect(ev.status).toBe("not_available"); // facebook source blocked
  });

  it("drops off-topic web results that don't mention the company → honest NA", async () => {
    vi.mocked(prisma.analysisRun.findUnique).mockResolvedValue({
      company: { name: "Tata Consultancy Services", ticker: "TCS" },
    } as unknown as Awaited<ReturnType<typeof prisma.analysisRun.findUnique>>);
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([]); // no doc fallback
    vi.mocked(webResearcher.search).mockResolvedValue({
      status: "ok",
      query: "q",
      results: [{ url: "https://instagram.com/p/abc", title: "Fairfax may exit CSB Bank", snippet: "unrelated company news" }],
    });
    const ev = await getEvidence(item({ id: "A13-09", outputFormat: "Text" }), "run1");
    expect(ev.status).toBe("not_available"); // off-topic result filtered out
  });

  it("KEEPS a promoter-track-record-elsewhere hit about a DIFFERENT company (A9-04 cross-entity)", async () => {
    // A9-04 is "promoter track record ELSEWHERE" — the relevant hit is about the
    // promoter's OTHER venture, which never names this company. The subject-company
    // filter must NOT drop it (the AFCOM-promoter miss), and crossEntity is flagged
    // so the extractor relaxes its subject-only grounding.
    vi.mocked(prisma.analysisRun.findUnique).mockResolvedValue({
      company: { name: "Afcom Holdings", ticker: "AFCOM" },
    } as unknown as Awaited<ReturnType<typeof prisma.analysisRun.findUnique>>);
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([]); // no filing coverage
    vi.mocked(webResearcher.search).mockResolvedValue({
      status: "ok",
      query: "q",
      results: [
        { url: "https://news.example/promoter-past", title: "Promoter's earlier firm Zenith Infra wound up", snippet: "collapsed amid loan defaults and legal cases" },
      ],
    });
    const ev = await getEvidence(item({ id: "A9-04", sectionCode: "A9", outputFormat: "Text" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.from).toBe("web");
    expect(ev.crossEntity).toBe(true);
    expect(ev.passages?.[0].citation.sourceUrl).toContain("news.example");
  });

  it("retrieves matching passages with page citations for a document item", async () => {
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([
      sd({
        id: "ar1",
        type: "ANNUAL_REPORT",
        sourceUrl: "u",
        name: "AR 2026",
        extractedText:
          "===== PAGE 5 =====\nThe statutory auditor is B S R & Co. LLP, Chartered Accountants, appointed as auditors in 2022.\n",
      }),
    ]);
    const ev = await getEvidence(item({ id: "A4-01", outputFormat: "Yes/No" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.from).toBe("document");
    expect(ev.passages?.[0].citation.page).toBe(5);
    expect(ev.passages?.[0].citation.sourceDocId).toBe("ar1");
  });

  it("computes a Tier-1 numeric (CFO/PAT) from structuredData (no LLM)", async () => {
    vi.mocked(prisma.sourceDoc.findFirst).mockResolvedValue(
      sd({
        id: "sp1",
        type: "SCREENER_PAGE",
        sourceUrl: "u",
        name: "Screener page",
        structuredData: {
          profitLoss: { periods: ["FY23", "FY24"], rows: [{ label: "Net Profit", values: ["100", "120"] }] },
          cashFlow: { periods: ["FY23", "FY24"], rows: [{ label: "Cash from Operating Activity", values: ["90", "110"] }] },
        } as unknown as SourceDoc["structuredData"],
      }),
    );
    const ev = await getEvidence(item({ id: "A8-01", outputFormat: "Ratio (cumulative)" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.structured?.["CFO/PAT (cumulative)"]).toBe("0.91"); // 200/220
  });

  it("extracts a whole NOTE by heading (section-aware retrieval) with its page", async () => {
    vi.mocked(prisma.sourceDoc.findMany).mockResolvedValue([
      sd({
        id: "ar1",
        type: "ANNUAL_REPORT",
        sourceUrl: "u",
        name: "AR 2026",
        extractedText:
          "===== PAGE 210 =====\n" +
          "Note 38. Contingent liabilities and commitments\n" +
          "(a) Claims against the Company not acknowledged as debt: Rs 1,234 crore (PY Rs 1,100 crore).\n" +
          "(b) Capital commitments: Rs 567 crore. Bank guarantees Rs 89 crore.\n",
      }),
    ]);
    const ev = await getEvidence(item({ id: "A7a-13", outputFormat: "Trend" }), "run1");
    expect(ev.status).toBe("found");
    expect(ev.from).toBe("document");
    expect(ev.mode).toBe("note"); // routed to Gemini note reading
    expect(ev.passages?.[0].citation.page).toBe(210);
    expect(ev.passages?.[0].text).toContain("Claims against the Company");
  });
});
