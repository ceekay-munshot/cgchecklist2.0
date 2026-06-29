import type { PeriodTable, ScreenerStructuredData, ShareholdingTable } from "@/lib/harvest/types";
import type { ComputedNumericKind } from "./types";
import type { NumericClassification } from "./thresholds";

// ---------------------------------------------------------------------------
// Small helpers over Screener's structuredData period tables
// ---------------------------------------------------------------------------

export function parseScreenerNumber(s: string | null | undefined): number | null {
  if (s == null) return null;
  const cleaned = s.replace(/[,₹%]/g, "").replace(/\s+/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function rowFor(table: PeriodTable | undefined, match: RegExp) {
  return table?.rows.find((r) => match.test(r.label));
}

function latestNonNull(values: Array<string | null>): string | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return null;
}

/** The most recent numeric value in the matched row, or null. */
export function latestRowNumber(table: PeriodTable | undefined, match: RegExp): number | null {
  const row = rowFor(table, match);
  if (!row) return null;
  for (let i = row.values.length - 1; i >= 0; i--) {
    const n = parseScreenerNumber(row.values[i]);
    if (n != null) return n;
  }
  return null;
}

/** Sum of all numeric values in the matched row (cumulative over reported years), or null. */
function sumRow(table: PeriodTable | undefined, match: RegExp): number | null {
  const row = rowFor(table, match);
  if (!row) return null;
  const nums = row.values.map(parseScreenerNumber).filter((n): n is number => n != null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

/** Find a top-ratio (or latest ratios-table) value as a string, e.g. for D/E or ROE. */
export function findRatio(data: ScreenerStructuredData, match: RegExp): string | null {
  for (const [k, v] of Object.entries(data.ratios ?? {})) {
    if (match.test(k) && v) return v;
  }
  const row = rowFor(data.ratiosTable, match);
  return row ? latestNonNull(row.values) : null;
}

/** The promoter / pledged shareholding series (convenience array, else a matching row). */
export function getShareholdingSeries(
  data: ScreenerStructuredData,
  which: "promoters" | "pledged",
): { periods: string[]; values: Array<string | null> } | null {
  const sh: ShareholdingTable | undefined = data.shareholding;
  if (!sh) return null;
  const direct = which === "promoters" ? sh.promoters : sh.pledged;
  if (direct && direct.length) return { periods: sh.periods, values: direct };
  const re = which === "promoters" ? /promoter/i : /pledge/i;
  const row = sh.rows?.find((r) => re.test(r.label));
  return row ? { periods: sh.periods, values: row.values } : null;
}

function promoterLatest(data: ScreenerStructuredData): number | null {
  const s = getShareholdingSeries(data, "promoters");
  return s ? parseScreenerNumber(latestNonNull(s.values)) : null;
}

// ---------------------------------------------------------------------------
// Deterministic numeric computations (no LLM). Return null only when the
// underlying series is genuinely absent.
// ---------------------------------------------------------------------------

function computeDebtToEquity(data: ScreenerStructuredData): { value: string; note?: string } | null {
  const direct = findRatio(data, /debt\s*to\s*equity|d\/e/i);
  if (direct != null) return { value: direct, note: "from Screener ratios" };

  const bs = data.balanceSheet;
  if (!bs) return null;
  const borrowings = latestRowNumber(bs, /borrowing/i);
  const equityCapital = latestRowNumber(bs, /equity (share )?capital|share capital/i);
  const reserves = latestRowNumber(bs, /reserve/i);
  if (borrowings == null || equityCapital == null || reserves == null) return null;
  const equity = equityCapital + reserves;
  if (equity <= 0) return null;
  return {
    value: (borrowings / equity).toFixed(2),
    note: `balance sheet: Borrowings ${borrowings} ÷ (Equity ${equityCapital} + Reserves ${reserves})`,
  };
}

const CFO_RE = /operating activit/i;
const PAT_RE = /net profit|profit after tax/i;
const EBITDA_RE = /operating profit/i;
const DEP_RE = /depreciation/i;

/** Compute a numeric field from the harvested financials. */
export function computeNumeric(
  data: ScreenerStructuredData,
  kind: ComputedNumericKind,
): { value: string; note?: string } | null {
  switch (kind) {
    case "debtToEquity":
      return computeDebtToEquity(data);

    case "cfoToPat": {
      const cfo = sumRow(data.cashFlow, CFO_RE);
      const pat = sumRow(data.profitLoss, PAT_RE);
      if (cfo == null || pat == null || pat <= 0) return null;
      return {
        value: (cfo / pat).toFixed(2),
        note: `cumulative CFO ${Math.round(cfo)} ÷ PAT ${Math.round(pat)} over reported years`,
      };
    }

    case "cfoToEbitda": {
      const cfo = latestRowNumber(data.cashFlow, CFO_RE);
      const ebitda = latestRowNumber(data.profitLoss, EBITDA_RE);
      if (cfo == null || ebitda == null || ebitda <= 0) return null;
      return {
        value: (cfo / ebitda).toFixed(2),
        note: `latest CFO ${Math.round(cfo)} ÷ Operating Profit (EBITDA) ${Math.round(ebitda)}`,
      };
    }

    case "taxRate": {
      const t = latestRowNumber(data.profitLoss, /tax\s*%/i);
      if (t == null) return null;
      return { value: `${t}%`, note: "effective tax rate (P&L Tax %)" };
    }

    case "receivableDaysProxy": {
      const d = latestRowNumber(data.ratiosTable, /debtor days/i);
      if (d == null) return null;
      return { value: `${d} days`, note: "debtor days (DSO) — proxy for >6-month receivables ageing" };
    }

    case "cashEpsRatio": {
      const pat = latestRowNumber(data.profitLoss, PAT_RE);
      const dep = latestRowNumber(data.profitLoss, DEP_RE);
      if (pat == null || pat <= 0 || dep == null) return null;
      return {
        value: ((pat + dep) / pat).toFixed(2),
        note: `(PAT ${Math.round(pat)} + Depreciation ${Math.round(dep)}) ÷ PAT`,
      };
    }

    case "freeFloat": {
      const p = promoterLatest(data);
      if (p == null) return null;
      return { value: `${(100 - p).toFixed(2)}%`, note: `100 − promoter holding ${p}%` };
    }
  }
}

// ---------------------------------------------------------------------------
// Custom deterministic classifiers for items whose checklist bands are textual
// (so the generic threshold parser can't compare them). Keyed by item id.
// ---------------------------------------------------------------------------

export const CUSTOM_NUMERIC: Record<string, (n: number) => NumericClassification> = {
  // A8-10 Effective tax rate — near India's ~25% statutory rate is fine; a large
  // (persistent, unexplained) deviation is the red flag.
  "A8-10": (n) => {
    if (n >= 18 && n <= 34) return { flag: "GREEN", reason: `Effective tax rate ${n}% is near the ~25% statutory rate.` };
    if (n < 10 || n > 45) return { flag: "RED", reason: `Effective tax rate ${n}% deviates sharply from the ~25% statutory rate.` };
    return { flag: "NEUTRAL", reason: `Effective tax rate ${n}% is somewhat off the ~25% statutory rate.` };
  },
  // A8-03 Receivables >6-month ageing, proxied by debtor days (DSO); 6 months ≈ 182 days.
  "A8-03": (n) => {
    if (n < 45) return { flag: "GREEN", reason: `Debtor days ${n} — fast collection, little >6-month ageing (DSO proxy).` };
    if (n > 150) return { flag: "RED", reason: `Debtor days ${n} — slow collection, likely significant >6-month receivables (DSO proxy).` };
    return { flag: "NEUTRAL", reason: `Debtor days ${n} — moderate collection period (DSO proxy for >6-month ageing).` };
  },
  // A8-11 Cash EPS vs accounting EPS = (PAT+Dep)/PAT. Close to 1 = earnings not
  // propped by heavy non-cash add-backs; a wide gap is the concern.
  "A8-11": (n) => {
    if (n <= 1.35) return { flag: "GREEN", reason: `Cash EPS ≈ accounting EPS (ratio ${n}); earnings not reliant on heavy non-cash add-backs.` };
    if (n >= 2.0) return { flag: "RED", reason: `Wide cash-vs-accounting EPS gap (ratio ${n}); large non-cash add-backs.` };
    return { flag: "NEUTRAL", reason: `Moderate cash-vs-accounting EPS gap (ratio ${n}).` };
  },
  // A14-02 Debt & advances level — NUMERIC SANITY: the debt level is anchored on
  // the SAME Tier-1 D/E as A14-01, so a document mis-read of "borrowings" can
  // never produce a leverage verdict that contradicts A14-01.
  "A14-02": (n) => {
    if (n <= 1) return { flag: "GREEN", reason: `Modest leverage — D/E ${n} (Tier-1); debt level is conservative.` };
    if (n > 2) return { flag: "RED", reason: `High leverage — D/E ${n} (Tier-1).` };
    return { flag: "NEUTRAL", reason: `Moderate leverage — D/E ${n} (Tier-1).` };
  },
};

/**
 * Numeric sanity primitive: decide whether to trust a debt/borrowings figure
 * extracted from a document. If the document implies high debt but the Tier-1
 * D/E says the company is (near) debt-free, the document extraction is
 * inconsistent — distrust it and use Tier-1.
 */
export function reconcileDebtWithTier1(
  docImpliesHighDebt: boolean,
  tier1DebtToEquity: number | null,
): "trust_doc" | "use_tier1" {
  if (docImpliesHighDebt && tier1DebtToEquity != null && tier1DebtToEquity < 1) return "use_tier1";
  return "trust_doc";
}
