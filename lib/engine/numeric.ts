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

const CFO_RE = /operating activit|cash (generated |flow )?from operat|net cash (flow )?from operat/i;
const PAT_RE = /net profit|profit after tax|profit for the (year|period)/i;
const EBITDA_RE = /operating profit/i;
const DEP_RE = /depreciation/i;
const OTHER_INCOME_RE = /other income/i;
const PBT_RE = /profit before tax|\bpbt\b/i;

/** Compute a numeric field from the harvested financials. */
export function computeNumeric(
  data: ScreenerStructuredData,
  kind: ComputedNumericKind,
): { value: string; note?: string } | null {
  switch (kind) {
    case "debtToEquity":
      return computeDebtToEquity(data);

    case "cfoToPat": {
      // Prefer the cumulative CFO ÷ PAT (the band is defined "cumulative"), but if
      // a row-label quirk makes either sum unreadable, fall back to the latest
      // single year so the item still classifies instead of dropping to NA.
      let cfo = sumRow(data.cashFlow, CFO_RE);
      let pat = sumRow(data.profitLoss, PAT_RE);
      let basis = "cumulative";
      if (cfo == null || pat == null || pat <= 0) {
        cfo = latestRowNumber(data.cashFlow, CFO_RE);
        pat = latestRowNumber(data.profitLoss, PAT_RE);
        basis = "latest-year";
      }
      if (cfo == null || pat == null || pat <= 0) return null;
      return {
        value: (cfo / pat).toFixed(2),
        note: `${basis} CFO ${Math.round(cfo)} ÷ PAT ${Math.round(pat)}`,
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

    case "otherIncomePctPbt": {
      const oi = latestRowNumber(data.profitLoss, OTHER_INCOME_RE);
      const pbt = latestRowNumber(data.profitLoss, PBT_RE);
      if (oi == null || pbt == null || pbt <= 0) return null;
      const pct = Math.round((oi / pbt) * 1000) / 10;
      return {
        value: `${pct}% of PBT (other income ₹${Math.round(oi)}cr ÷ PBT ₹${Math.round(pbt)}cr)`,
        note: "other income as % of profit before tax",
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
  // A6-05 CEO-to-median pay ratio. A deliberately SUBJECTIVE judgement: a ratio
  // is only a governance concern when it is EXTREME and unjustified. A reasonable
  // multiple is fine (GREEN); the red band is >~100–200x. Anchoring here keeps the
  // default GREEN so a normal ratio isn't neutral-ed for want of a sector benchmark.
  "A6-05": (n) => {
    if (n < 100) return { flag: "GREEN", reason: `CEO-to-median pay ratio ${n}x is within a reasonable range (extreme only above ~100–200x).` };
    if (n >= 200) return { flag: "RED", reason: `CEO-to-median pay ratio ${n}x is extreme and hard to justify (>200x).` };
    return { flag: "NEUTRAL", reason: `CEO-to-median pay ratio ${n}x is elevated (100–200x) — reasonable only if clearly justified.` };
  },
  // A1-04 True independence — driven by the per-director concern COUNT (from the
  // analyzeIndependence table). None = green; one = review (neutral); several =
  // the board's independence is systemically compromised (red).
  "A1-04": (n) => {
    if (n <= 0) return { flag: "GREEN", reason: `All independent directors appear genuinely independent — no disqualifying tenure, ties or fee-dependence.` };
    if (n >= 2) return { flag: "RED", reason: `${n} “independent” directors are not genuinely independent (long tenure / ex-employee / promoter ties / fee dependence) — board independence is compromised.` };
    return { flag: "NEUTRAL", reason: `1 independent director carries an independence concern — worth review; see the per-director breakdown.` };
  },
  // A8-05 Other income as % of PBT. A large, recurring non-operating slice of
  // profit is an earnings-quality concern; a small slice is fine. Bands are
  // deliberately lenient so a cash-rich company's legitimate treasury income
  // isn't false-flagged as a red.
  "A8-05": (n) => {
    if (n <= 20) return { flag: "GREEN", reason: `Other income is ${n}% of PBT — profit is operations-led, not propped by non-operating income.` };
    if (n >= 45) return { flag: "RED", reason: `Other income is ${n}% of PBT — a large share of profit is non-operating (earnings-quality concern).` };
    return { flag: "NEUTRAL", reason: `Other income is ${n}% of PBT — a moderate non-operating share of profit.` };
  },
};

// ---------------------------------------------------------------------------
// Series (trend) classifiers — judge a whole multi-year row deterministically.
// Keyed by item id; each gets the parsed number series (oldest→newest).
// ---------------------------------------------------------------------------

function firstNum(nums: Array<number | null>): number | null {
  for (const n of nums) if (n != null) return n;
  return null;
}
function lastNum(nums: Array<number | null>): number | null {
  for (let i = nums.length - 1; i >= 0; i--) {
    const n = nums[i];
    if (n != null) return n;
  }
  return null;
}

/** Find a whole row across the Screener period tables → its periods + values. */
export function findSeriesRow(
  data: ScreenerStructuredData,
  match: RegExp,
): { periods: string[]; values: Array<string | null> } | null {
  for (const t of [data.ratiosTable, data.profitLoss, data.balanceSheet, data.cashFlow]) {
    if (!t) continue;
    const row = t.rows.find((r) => match.test(r.label));
    if (row) return { periods: t.periods, values: row.values };
  }
  return null;
}

export const CUSTOM_SERIES: Record<
  string,
  (series: { periods: string[]; values: Array<string | null> }) => NumericClassification
> = {
  // A8-02 Working-capital-days creep. Judged on the TREND, not the level: stable
  // or improving is fine; a sharp multi-year rise means cash is increasingly tied
  // up in working capital (a classic forensic flag).
  "A8-02": (s) => {
    const nums = s.values.map(parseScreenerNumber);
    const first = firstNum(nums);
    const last = lastNum(nums);
    if (first == null || last == null) {
      return { flag: "NEUTRAL", reason: "Working-capital-days history is incomplete — trend not established." };
    }
    const change = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : last > 0 ? 100 : 0;
    const span = `${Math.round(first)}→${Math.round(last)} days`;
    if (change <= 10) {
      return { flag: "GREEN", reason: `Working-capital days are stable/improving (${span}) — cash conversion is not deteriorating.` };
    }
    if (change >= 40) {
      return { flag: "RED", reason: `Working-capital days rose sharply (${span}, +${Math.round(change)}%) — cash increasingly tied up in working capital.` };
    }
    return { flag: "NEUTRAL", reason: `Working-capital days rose modestly (${span}, +${Math.round(change)}%).` };
  },
  // A10-01 Dividend-policy consistency. GREEN only for a genuinely consistent
  // payer; a nil/erratic record is NEUTRAL, never a false red — "nil despite
  // cash" needs a cash-context check we don't do deterministically here.
  "A10-01": (s) => {
    const recent = s.values.map(parseScreenerNumber).filter((n): n is number => n != null).slice(-4);
    if (recent.length === 0) {
      return { flag: "NEUTRAL", reason: "Dividend-payout history is not available — not flagged." };
    }
    const paid = recent.filter((n) => n > 0).length;
    const latest = recent[recent.length - 1];
    if (paid === recent.length && latest > 0) {
      return { flag: "GREEN", reason: `Consistent dividend payout — paid in all of the last ${recent.length} years (latest ${Math.round(latest)}%).` };
    }
    if (paid === 0) {
      return { flag: "NEUTRAL", reason: `No dividend in the last ${recent.length} years — fine if reinvesting for growth, but no cash returned to minorities.` };
    }
    return { flag: "NEUTRAL", reason: `Erratic dividend payout — paid in ${paid} of the last ${recent.length} years (latest ${Math.round(latest)}%).` };
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
