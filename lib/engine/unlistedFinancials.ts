import type { PeriodTable, ScreenerStructuredData } from "@/lib/harvest/types";
import { callJSON } from "./llm";
import { QuotaExhaustedError } from "./quota";

/**
 * Phase 8 — Unlisted-company financials extractor.
 *
 * A listed company gets its Tier-1 financials (P&L / balance sheet / cash flow /
 * ratios) as a SCREENER_PAGE structuredData blob from the Screener harvest, and
 * ~30-40% of the checklist (every deterministic numeric item + all materiality
 * scaling) is answered from it. An UNLISTED company has no Screener page, so those
 * items came back "not available".
 *
 * This module reads the uploaded financial-statement PDFs and produces the SAME
 * `ScreenerStructuredData` shape, so every existing classifier and the materiality
 * scaler work UNCHANGED — no per-item logic is duplicated. The heavy lifting is an
 * LLM pass (Gemini reads flattened PDF tables best); the normalization + shaping is
 * deterministic and unit-tested.
 *
 * Two real-world traps this handles (seen in actual client docs):
 *   1. Statement FORMAT varies — Schedule III vertical (private companies) vs the
 *      old horizontal "T-form" Trading & P&L (partnership firms). The LLM reads
 *      both; we only consume canonical metrics.
 *   2. Reported UNITS are unreliable. Figures may be in absolute rupees, ₹ lakhs or
 *      ₹ crore, and the printed header LIES (one real P&L was headed "₹ (in Cr's)"
 *      but the values were absolute rupees). So we INFER the scale from magnitude
 *      (with the model's unit as a tie-breaker) and normalise everything to ₹ crore
 *      — the unit the whole engine assumes.
 */

// ---------------------------------------------------------------------------
// LLM extraction shape
// ---------------------------------------------------------------------------

export type ReportingUnit = "rupees" | "lakhs" | "crores" | "unknown";

export interface FinancialsExtract {
  found: boolean;
  reportingUnit?: ReportingUnit;
  /** Period labels, OLDEST → NEWEST (e.g. ["FY24-25", "FY25-26"]). */
  periods?: string[];
  // Each metric is an array aligned to `periods` (null = not disclosed that year).
  revenue?: Array<number | null>; // Sales / Revenue from operations
  otherIncome?: Array<number | null>;
  profitBeforeTax?: Array<number | null>;
  profitAfterTax?: Array<number | null>; // Net profit for the year
  depreciation?: Array<number | null>;
  financeCost?: Array<number | null>; // Interest / finance costs
  currentTax?: Array<number | null>;
  shareCapital?: Array<number | null>; // Share capital / partners' capital account
  reserves?: Array<number | null>; // Reserves & surplus (null for a partnership)
  borrowings?: Array<number | null>; // Total debt (long-term + short-term, secured + unsecured)
  tradeReceivables?: Array<number | null>;
  inventory?: Array<number | null>;
  cashFromOperations?: Array<number | null>; // Net cash from operating activities
  totalAssets?: Array<number | null>; // Balance-sheet total (scale sanity)
  evidenceQuote?: string;
}

const numArr = { type: "array", items: { type: ["number", "null"] } } as const;

const FINANCIALS_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    reportingUnit: { enum: ["rupees", "lakhs", "crores", "unknown"] },
    periods: { type: "array", items: { type: "string" } },
    revenue: numArr,
    otherIncome: numArr,
    profitBeforeTax: numArr,
    profitAfterTax: numArr,
    depreciation: numArr,
    financeCost: numArr,
    currentTax: numArr,
    shareCapital: numArr,
    reserves: numArr,
    borrowings: numArr,
    tradeReceivables: numArr,
    inventory: numArr,
    cashFromOperations: numArr,
    totalAssets: numArr,
    evidenceQuote: { type: "string" },
  },
  required: ["found"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Deterministic normalization + shaping (pure, unit-tested)
// ---------------------------------------------------------------------------

const METRIC_KEYS = [
  "revenue",
  "otherIncome",
  "profitBeforeTax",
  "profitAfterTax",
  "depreciation",
  "financeCost",
  "currentTax",
  "shareCapital",
  "reserves",
  "borrowings",
  "tradeReceivables",
  "inventory",
  "cashFromOperations",
  "totalAssets",
] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

/** The largest absolute figure across all metrics — the scale signal. */
export function maxAbsValue(e: FinancialsExtract): number {
  let max = 0;
  for (const k of METRIC_KEYS) {
    for (const v of e[k] ?? []) {
      if (v != null && Number.isFinite(v) && Math.abs(v) > max) max = Math.abs(v);
    }
  }
  return max;
}

/**
 * Divisor that converts a RAW figure to ₹ crore. Magnitude is the primary signal
 * (it's objective and the printed unit label can't be trusted); the model's unit
 * hint only breaks ties in the ambiguous mid-range.
 *   - ≥ ₹1 crore shown in full (≥1e7) → absolute rupees → ÷1e7
 *   - else trust an explicit unit hint (crores ÷1, lakhs ÷100, rupees ÷1e7)
 *   - else fall back to magnitude (≥1e4 → lakhs ÷100, else already crore ÷1)
 */
export function inferCroreDivisor(maxAbs: number, unit: ReportingUnit | undefined): number {
  if (maxAbs >= 1e7) return 1e7;
  if (unit === "crores") return 1;
  if (unit === "lakhs") return 100;
  if (unit === "rupees") return 1e7;
  if (maxAbs >= 1e4) return 100;
  return 1;
}

/** Round to 2 dp and stringify (drops a trailing ".00" style noise via Number). */
function cr(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Align a metric array to `n` periods (pad with null / truncate). */
function align(vals: Array<number | null> | undefined, n: number): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < n; i++) out.push(vals?.[i] ?? null);
  return out;
}

/** Per-period combine of two aligned series with a function, null if any input null. */
function combine(
  a: Array<number | null>,
  b: Array<number | null>,
  f: (x: number, y: number) => number | null,
): Array<number | null> {
  return a.map((x, i) => {
    const y = b[i];
    return x != null && y != null ? f(x, y) : null;
  });
}

function toStrRow(label: string, vals: Array<number | null>, divisor: number): PeriodTable["rows"][number] {
  return { label, values: vals.map((v) => (v != null ? cr(v / divisor) : null)) };
}

/** True when a series has at least one real number. */
function hasAny(vals: Array<number | null>): boolean {
  return vals.some((v) => v != null);
}

/**
 * Build the `ScreenerStructuredData` blob from an LLM extract. PURE + deterministic:
 * normalises to ₹ crore, maps to the canonical row labels the engine's regexes
 * already match, and derives Operating Profit (EBITDA proxy), Tax %, Debtor Days and
 * the D/E ratio. Returns null when nothing usable was extracted.
 */
export function buildUnlistedScreenerData(
  e: FinancialsExtract,
  opts: { name?: string; capturedAt: string },
): ScreenerStructuredData | null {
  if (!e.found) return null;
  const periods = e.periods ?? [];
  if (periods.length === 0) return null;
  const n = periods.length;

  const divisor = inferCroreDivisor(maxAbsValue(e), e.reportingUnit);
  const raw = Object.fromEntries(METRIC_KEYS.map((k) => [k, align(e[k], n)])) as Record<
    MetricKey,
    Array<number | null>
  >;

  // Derived (in RAW units so they normalise with the same divisor):
  // EBITDA proxy = PBT + finance cost + depreciation.
  const operatingProfit = raw.profitBeforeTax.map((pbt, i) => {
    const fin = raw.financeCost[i];
    const dep = raw.depreciation[i];
    return pbt != null && (fin != null || dep != null) ? pbt + (fin ?? 0) + (dep ?? 0) : null;
  });

  // Tax % and Debtor Days are UNITLESS — computed from raw (the divisor cancels).
  const taxPct = combine(raw.currentTax, raw.profitBeforeTax, (t, p) =>
    p > 0 ? Math.round((t / p) * 1000) / 10 : null,
  );
  const debtorDays = combine(raw.tradeReceivables, raw.revenue, (rec, rev) =>
    rev > 0 ? Math.round((rec / rev) * 365) : null,
  );

  const plRows: PeriodTable["rows"] = [];
  if (hasAny(raw.revenue)) plRows.push(toStrRow("Sales", raw.revenue, divisor));
  if (hasAny(raw.otherIncome)) plRows.push(toStrRow("Other Income", raw.otherIncome, divisor));
  if (hasAny(raw.profitBeforeTax)) plRows.push(toStrRow("Profit before tax", raw.profitBeforeTax, divisor));
  if (hasAny(operatingProfit)) plRows.push(toStrRow("Operating Profit", operatingProfit, divisor));
  if (hasAny(raw.depreciation)) plRows.push(toStrRow("Depreciation", raw.depreciation, divisor));
  if (hasAny(raw.profitAfterTax)) plRows.push(toStrRow("Net Profit", raw.profitAfterTax, divisor));
  // Tax % is already a percentage — store it verbatim (no ÷divisor).
  if (hasAny(taxPct)) plRows.push({ label: "Tax %", values: taxPct.map((v) => (v != null ? String(v) : null)) });

  const bsRows: PeriodTable["rows"] = [];
  if (hasAny(raw.borrowings)) bsRows.push(toStrRow("Borrowings", raw.borrowings, divisor));
  if (hasAny(raw.shareCapital)) bsRows.push(toStrRow("Equity Capital", raw.shareCapital, divisor));
  if (hasAny(raw.reserves)) bsRows.push(toStrRow("Reserves", raw.reserves, divisor));
  if (hasAny(raw.inventory)) bsRows.push(toStrRow("Inventory", raw.inventory, divisor));
  if (hasAny(raw.tradeReceivables)) bsRows.push(toStrRow("Trade Receivables", raw.tradeReceivables, divisor));

  const cfRows: PeriodTable["rows"] = [];
  if (hasAny(raw.cashFromOperations)) {
    cfRows.push(toStrRow("Cash from Operating Activity", raw.cashFromOperations, divisor));
  }

  const ratioRows: PeriodTable["rows"] = [];
  if (hasAny(debtorDays)) {
    ratioRows.push({ label: "Debtor Days", values: debtorDays.map((v) => (v != null ? String(v) : null)) });
  }

  if (plRows.length === 0 && bsRows.length === 0 && cfRows.length === 0) return null;

  // Top-of-page ratios: latest D/E = total borrowings ÷ (equity capital + reserves).
  const ratios: Record<string, string> = {};
  const latest = (vals: Array<number | null>): number | null => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return vals[i]!;
    return null;
  };
  const debt = latest(raw.borrowings);
  const cap = latest(raw.shareCapital) ?? 0;
  const res = latest(raw.reserves) ?? 0;
  const nw = cap + res;
  if (debt != null && nw > 0) ratios["Debt to equity"] = String(Math.round((debt / nw) * 100) / 100);

  return {
    ticker: "",
    url: "derived://uploaded-financials",
    name: opts.name,
    ratios,
    profitLoss: plRows.length ? { periods, rows: plRows } : undefined,
    balanceSheet: bsRows.length ? { periods, rows: bsRows } : undefined,
    cashFlow: cfRows.length ? { periods, rows: cfRows } : undefined,
    ratiosTable: ratioRows.length ? { periods, rows: ratioRows } : undefined,
    pros: [],
    cons: [],
    capturedAt: opts.capturedAt,
  };
}

// ---------------------------------------------------------------------------
// LLM extraction (thin wrapper; degrades to null on provider failure)
// ---------------------------------------------------------------------------

const EXTRACT_PROMPT = (name: string | undefined) =>
  `You are a forensic accountant reading the audited / provisional financial statements of ${
    name ? `"${name}"` : "an Indian company"
  } (a PRIVATE company or partnership firm). The statements may be in EITHER format:\n` +
  `  • Schedule III VERTICAL format (Shareholder's Funds, Long-term borrowings, Revenue from operations…), or\n` +
  `  • the old HORIZONTAL "T-form" (Trading and Profit & Loss Account with To/By, a Provisional Balance Sheet with Liabilities on the left and Assets on the right, a partners' "Capital Account").\n` +
  `PDF tables are often flattened into messy text — reconstruct the columns carefully.\n\n` +
  `Extract these metrics for EVERY year/period shown, as an array aligned to "periods" (oldest → newest). Use null for a year not disclosed:\n` +
  `  revenue (Sales / Revenue from operations — NOT total income), otherIncome, profitBeforeTax, profitAfterTax (net profit for the year), depreciation, financeCost (interest), currentTax, shareCapital (for a partnership use the partners' capital account TOTAL), reserves (reserves & surplus; null for a partnership), borrowings (TOTAL debt = long-term + short-term, secured + unsecured — SUM them), tradeReceivables (sundry debtors), inventory (closing stock), cashFromOperations (net cash from operating activities, from the cash-flow statement), totalAssets (the balance-sheet total).\n\n` +
  `CRITICAL — UNITS: report the figures EXACTLY as printed (do NOT convert). Read the actual digits, keeping Indian grouping (e.g. "23,59,07,304" → 235907304). Then set "reportingUnit" to your best judgement of the scale from the MAGNITUDE of the numbers and any header: "rupees" (absolute, values in crores show as ~10^8-10^9), "lakhs", or "crores". Do not trust a header label blindly — infer from magnitude.\n` +
  `Set "found" false only if there are no financial statements here at all. Put one supporting line in "evidenceQuote".\n\n`;

const MAX_EXTRACT_CHARS = 60_000;

/**
 * Run the LLM extraction over the concatenated financial-statement text and build
 * the structured blob. Returns null on empty/failed extraction. A QuotaExhaustedError
 * propagates so the orchestrator can DEFER (consistent with the rest of the engine).
 */
export async function extractUnlistedFinancials(
  text: string,
  opts: { name?: string; capturedAt: string },
): Promise<ScreenerStructuredData | null> {
  const body = text.slice(0, MAX_EXTRACT_CHARS);
  if (!body.trim()) return null;

  let data: FinancialsExtract;
  try {
    const res = await callJSON<FinancialsExtract>(
      "longContext",
      { prompt: `${EXTRACT_PROMPT(opts.name)}${body}`, temperature: 0 },
      FINANCIALS_SCHEMA,
    );
    data = res.data;
  } catch (e) {
    if (e instanceof QuotaExhaustedError) throw e;
    return null; // a genuine provider failure → no Tier-1 (items stay NA), not a hard error
  }
  return buildUnlistedScreenerData(data, opts);
}
