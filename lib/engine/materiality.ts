import type { PeriodTable, ScreenerStructuredData } from "@/lib/harvest/types";
import { latestRowNumber, parseScreenerNumber } from "./numeric";

/**
 * Materiality + numeric-sanity for amount-based checklist items (Phase 8).
 *
 * A red on a ₹-denominated item (contingent liabilities, guarantees, capital
 * commitments, RPT amounts, royalty/brand fees) must reflect a MATERIAL amount
 * for THIS company — not a large-looking absolute number. We scale the figure
 * against company size (net worth / revenue / PAT from the harvested Tier-1
 * structuredData) and classify by a band; an immaterial amount can never fire a
 * red. A figure that is implausibly large versus that scale is treated as a
 * mis-extraction (distrust → never a confident red), mirroring the A14-02
 * borrowings cross-check.
 *
 * This module is PURE (no DB, no LLM) so the thresholds are unit-testable.
 */

export type FlagLite = "GREEN" | "RED" | "NEUTRAL";
export interface MaterialityResult {
  flag: FlagLite;
  reason: string;
}

/** Company size in ₹ crore, read from the Screener financials. */
export interface CompanyScale {
  netWorth: number | null; // Equity share capital + Reserves (latest)
  revenue: number | null; // Sales / Revenue / Total income (latest)
  pat: number | null; // Net profit (latest)
}

export type MaterialityBase = "netWorth" | "revenue" | "pat";

export interface MaterialityRule {
  base: MaterialityBase;
  /** ≤ greenPct of base → immaterial → GREEN. */
  greenPct: number;
  /** ≥ redPct of base → material → RED. Between the two → NEUTRAL. */
  redPct: number;
}

// Bands derive from the checklist green/red descriptions where they give a %,
// with sensible defaults otherwise. All env-free + per-item overridable here.
export const MATERIALITY_RULES: Record<string, MaterialityRule> = {
  // A5 — Related-party amounts
  "A5-01": { base: "revenue", greenPct: 5, redPct: 15 }, // RPTs as % of revenue (<5% / >15–20%)
  "A5-02": { base: "revenue", greenPct: 1, redPct: 2.5 }, // royalty/brand fees (<1% / >2–3% of sales)
  "A5-03": { base: "netWorth", greenPct: 5, redPct: 15 }, // loans/ICDs/guarantees to group (% net worth)
  "A5-04": { base: "revenue", greenPct: 5, redPct: 15 }, // promoter-vendor transactions
  "A11-03": { base: "netWorth", greenPct: 5, redPct: 15 }, // inter-corporate loans (% net worth)
  // A7a — Contingent liabilities & commitments (₹ amounts, scaled to net worth)
  "A7a-01": { base: "netWorth", greenPct: 25, redPct: 50 }, // CL as % of net worth (<10–25% / >50–100%)
  "A7a-03": { base: "netWorth", greenPct: 10, redPct: 30 }, // direct tax disputes
  "A7a-04": { base: "netWorth", greenPct: 10, redPct: 30 }, // indirect tax disputes
  "A7a-05": { base: "netWorth", greenPct: 10, redPct: 30 }, // litigation / claims not acknowledged
  "A7a-06": { base: "netWorth", greenPct: 10, redPct: 25 }, // corporate guarantees given
  "A7a-07": { base: "netWorth", greenPct: 15, redPct: 40 }, // bank guarantees & LCs
  "A7a-08": { base: "netWorth", greenPct: 15, redPct: 40 }, // capital commitments
  "A7a-09": { base: "netWorth", greenPct: 10, redPct: 25 }, // bills discounted with recourse
  "A7a-10": { base: "netWorth", greenPct: 10, redPct: 30 }, // statutory dues disputes
  "A7a-12": { base: "netWorth", greenPct: 10, redPct: 25 }, // subsidiary/JV/associate CLs
};

/**
 * Qualitatively-judged A7a/A5 items (trend / Yes-No / quality) that are NOT pure
 * magnitude but still must NOT fire a red on an immaterial figure (e.g. the
 * "movement" item red-flagging a tiny subsidiary guarantee). The judge runs, then
 * a guard downgrades a RED whose cited amount is immaterial. Never creates a red.
 */
export const MATERIALITY_GUARD_ITEMS = new Set<string>([
  "A7a-02", // CL trend over time
  "A7a-11", // regulatory/penalty demands (Yes/No)
  "A7a-13", // movement (add/reversal/crystallized)
  "A7a-14", // provided vs only disclosed (Yes/No)
  "A7a-15", // unhedged forex/derivative (%)
  "A5-05", // arm's-length assertion (Yes/No)
  "A5-06", // minority dissent on RPTs (% against)
  // A8-06 goodwill impairment is now decided deterministically (CATEGORICAL_RULES).
]);
/** Below this % of net worth, a cited amount is treated as immaterial by the guard. */
const GUARD_IMMATERIAL_PCT = 10;

const NW_CAPITAL_RE = /equity (share )?capital|share capital/i;
const RESERVES_RE = /reserve/i;
const REVENUE_RE = /\b(sales|revenue|total income|net sales|revenue from operations)\b/i;
const PAT_RE = /net profit|profit after tax|profit for the (year|period)/i;

function netWorthFrom(bs: PeriodTable | undefined): number | null {
  if (!bs) return null;
  const capital = latestRowNumber(bs, NW_CAPITAL_RE);
  const reserves = latestRowNumber(bs, RESERVES_RE);
  if (capital == null && reserves == null) return null;
  const nw = (capital ?? 0) + (reserves ?? 0);
  return nw > 0 ? nw : null;
}

/** Extract company size (₹ crore) from the harvested Tier-1 financials. */
export function companyScaleFrom(data: ScreenerStructuredData): CompanyScale {
  return {
    netWorth: netWorthFrom(data.balanceSheet),
    revenue: latestRowNumber(data.profitLoss, REVENUE_RE),
    pat: latestRowNumber(data.profitLoss, PAT_RE),
  };
}

/**
 * The largest ₹-crore amount mentioned in a fact/evidence string. Unit-anchored
 * (only numbers immediately before "crore"/"cr"), so it ignores bare counts and
 * tolerates the rupee symbol being captured as Rs/₹/H/$ (e.g. "H226 crore").
 * Taking the LARGEST is conservative: if even the biggest figure is immaterial,
 * the item is safely green.
 */
export function extractAmountCr(text: string | null | undefined): number | null {
  if (!text) return null;
  const re = /([\d][\d,]*(?:\.\d+)?)\s*(?:crore|cr\b)/gi;
  let m: RegExpExecArray | null;
  let max: number | null = null;
  while ((m = re.exec(text)) !== null) {
    const n = parseScreenerNumber(m[1]);
    if (n != null && (max == null || n > max)) max = n;
  }
  return max;
}

/**
 * Does the finding AFFIRMATIVELY state a nil/zero for this exposure? A "no
 * related-party transactions", "Nil contingent liabilities", "no promoter
 * pledge", "₹0", "not applicable" etc. is a REAL, favourable finding — a genuine
 * zero — not a data gap. We must NOT confuse it with "not available / not
 * disclosed", which stays a gap. Used so a true zero maps to GREEN (immaterial)
 * instead of a defensive NEUTRAL. General to every ₹-amount item.
 */
export function statesNil(text: string | null | undefined): boolean {
  const t = (text ?? "").toLowerCase();
  if (!t) return false;
  // A genuine data gap is NOT a nil — keep it out.
  if (/\b(not available|not disclosed|no data|could not|unavailable|no information|not found|unable to)\b/.test(t)) {
    return false;
  }
  const exposure =
    "related[- ]?part|rpt|contingent|outstanding|guarantee|loan|advance|goodwill|pledg|litigation|claim|dispute|off[- ]balance|transaction|exposure|material";
  return (
    /\b(nil|none|not applicable|no such)\b/.test(t) ||
    // "no <up to a few words> <exposure>": no promoter pledge, no related party transactions, no group loans…
    new RegExp(`\\bno\\b[\\w\\s-]{0,24}(${exposure})`).test(t) ||
    new RegExp(`\\bzero\\b[\\w\\s-]{0,24}(${exposure})`).test(t) ||
    /(?:^|[^\d.])(?:₹|rs\.?|inr)?\s*0(?:\.0+)?\s*(?:crore|cr\b|lakh)/.test(t)
  );
}

/**
 * Is a ₹-crore amount plausible for a single note line at this company's scale?
 * A single contingent-liability / RPT line larger than ~1.5× the company's
 * revenue (or net worth, whichever bigger) is almost certainly a mis-extraction.
 */
export function isPlausibleAmount(amountCr: number, scale: CompanyScale): boolean {
  const primary = Math.max(scale.revenue ?? 0, scale.netWorth ?? 0);
  const ceiling = primary > 0 ? primary : (scale.pat ?? 0) * 10;
  if (ceiling <= 0) return true; // no scale to judge against — don't block
  return amountCr <= ceiling * 1.5;
}

function baseLabel(base: MaterialityBase): string {
  return base === "netWorth" ? "net worth" : base === "revenue" ? "revenue" : "PAT";
}
function fmtCr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}cr`;
}

/**
 * Classify an amount-based item deterministically by materiality. Returns null
 * when the item has no materiality rule (caller handles it another way).
 *   - amount unparseable / no scale → NEUTRAL (materiality unverified — never a confident red)
 *   - implausibly large             → NEUTRAL (mis-extraction distrusted; Task 3)
 *   - else band(amount / base)      → GREEN / NEUTRAL / RED
 */
export function classifyAmount(
  itemId: string,
  value: string,
  evidenceQuote: string | null | undefined,
  scale: CompanyScale | null | undefined,
): MaterialityResult | null {
  const rule = MATERIALITY_RULES[itemId];
  if (!rule) return null;

  const amount = extractAmountCr(value) ?? extractAmountCr(evidenceQuote);
  if (amount == null) {
    // A genuine nil/none is a real, favourable finding (zero exposure) — GREEN,
    // not a defensive NEUTRAL. Only a true "can't read it" stays unverified.
    if (statesNil(value) || statesNil(evidenceQuote)) {
      return { flag: "GREEN", reason: `Nil / none reported — no material exposure (${value}).` };
    }
    return { flag: "NEUTRAL", reason: "No amount could be read from the note — materiality unverified; not flagged." };
  }
  if (!scale) {
    return { flag: "NEUTRAL", reason: `${fmtCr(amount)} found, but company size is unavailable — materiality unverified.` };
  }
  if (!isPlausibleAmount(amount, scale)) {
    return {
      flag: "NEUTRAL",
      reason: `${fmtCr(amount)} is implausibly large vs ${baseLabel(rule.base)} — extraction distrusted (likely a misread); not flagged.`,
    };
  }
  const base = scale[rule.base];
  if (base == null || base <= 0) {
    return { flag: "NEUTRAL", reason: `${fmtCr(amount)} found, but ${baseLabel(rule.base)} is unavailable — materiality unverified.` };
  }
  const pct = (amount / base) * 100;
  const p = pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
  if (pct >= rule.redPct) {
    return { flag: "RED", reason: `Material — ${fmtCr(amount)} ≈ ${p}% of ${baseLabel(rule.base)} (≥${rule.redPct}% red band).` };
  }
  if (pct <= rule.greenPct) {
    return { flag: "GREEN", reason: `Immaterial — ${fmtCr(amount)} ≈ ${p}% of ${baseLabel(rule.base)} (≤${rule.greenPct}%).` };
  }
  return { flag: "NEUTRAL", reason: `Moderate — ${fmtCr(amount)} ≈ ${p}% of ${baseLabel(rule.base)}.` };
}

/**
 * Guard a qualitatively-judged A7a/A5 item: if the judge said RED but the only
 * figure cited is immaterial for this company, downgrade to NEUTRAL. Returns the
 * downgrade, or null to keep the judged flag. Never turns a non-red into a red.
 */
export function guardAmount(
  itemId: string,
  judgedFlag: FlagLite,
  value: string,
  evidenceQuote: string | null | undefined,
  scale: CompanyScale | null | undefined,
): MaterialityResult | null {
  if (judgedFlag !== "RED" || !MATERIALITY_GUARD_ITEMS.has(itemId)) return null;
  const amount = extractAmountCr(value) ?? extractAmountCr(evidenceQuote);
  if (amount == null || !scale) return null; // can't establish (im)materiality — keep judge's call
  if (!isPlausibleAmount(amount, scale)) {
    return { flag: "NEUTRAL", reason: `${fmtCr(amount)} is implausibly large — extraction distrusted; downgraded from RED.` };
  }
  const nw = scale.netWorth;
  if (nw == null || nw <= 0) return null;
  const pct = (amount / nw) * 100;
  if (pct < GUARD_IMMATERIAL_PCT) {
    const p = pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
    return { flag: "NEUTRAL", reason: `Figure is immaterial — ${fmtCr(amount)} ≈ ${p}% of net worth (<${GUARD_IMMATERIAL_PCT}%); downgraded from RED.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Categorical compliance rules (Task 4) — deterministic Yes/No items where an
// over-strict LLM judge mis-fires a red on a compliant fact.
// ---------------------------------------------------------------------------

/** Independence ratio from "3 of 4" / "3 out of 4" / "75%" → 0..1, else null. */
export function parseIndependenceRatio(text: string): number | null {
  const counts = text.match(/(\d+)\s*(?:of|out of|\/)\s*(\d+)/i);
  if (counts) {
    const a = Number(counts[1]);
    const b = Number(counts[2]);
    if (b > 0 && a <= b) return a / b;
  }
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const n = Number(pct[1]);
    if (n >= 0 && n <= 100) return n / 100;
  }
  return null;
}

/** Number of committee meetings from "met 6 times" / "6 meetings", else null. */
export function parseMeetings(text: string): number | null {
  const m = text.match(/met\s+(\d+)\s+times/i) ?? text.match(/(\d+)\s+meetings?/i);
  return m ? Number(m[1]) : null;
}

/**
 * A2-01 Audit Committee quality. SEBI LODR requires ≥2/3 independent members,
 * an independent chair, and ≥4 meetings a year. The checklist's green wording
 * ("100% independent") is stricter than the law and made the judge red-flag a
 * fully-compliant committee — so this decides it deterministically: compliant →
 * GREEN; red only when genuinely non-compliant.
 */
export function auditCommitteeFlag(value: string, evidenceQuote: string | null | undefined): MaterialityResult {
  const text = `${value} ${evidenceQuote ?? ""}`;
  const ratio = parseIndependenceRatio(text);
  const meetings = parseMeetings(text);
  const pctStr = ratio != null ? `${Math.round(ratio * 100)}% independent` : "independence not quantified";

  if (ratio == null) {
    return { flag: "NEUTRAL", reason: `Audit committee composition not clearly quantified — not flagged (${value}).` };
  }
  if (ratio < 0.5) {
    return { flag: "RED", reason: `Audit committee is not majority-independent (${pctStr}) — non-compliant.` };
  }
  if (meetings != null && meetings < 4) {
    return { flag: "RED", reason: `Audit committee met only ${meetings} times (<4 required) — non-compliant.` };
  }
  if (ratio >= 2 / 3) {
    const met = meetings != null ? `, met ${meetings} times` : "";
    return { flag: "GREEN", reason: `Audit committee is ${pctStr} (≥2/3, SEBI-compliant)${met}.` };
  }
  return { flag: "NEUTRAL", reason: `Audit committee is ${pctStr} — majority but below the 2/3 independence norm.` };
}

/**
 * A3-05 Cheap insider equity. The red is "repeated discounted insider issues"
 * (preferential allotments / warrants to PROMOTERS at a discount). An over-eager
 * judge red-flagged a bare mention of "preference shares issued" (e.g. a
 * subsidiary's Class-B CCPS in the consolidated notes) that has nothing to do
 * with cheap promoter equity. Decide deterministically: a RED requires BOTH an
 * insider beneficiary AND preferential/discounted pricing; a clean "none /
 * at-market" disclosure is GREEN; anything else is NEUTRAL — never a red on an
 * unsubstantiated mention.
 */
export function cheapInsiderEquityFlag(value: string, evidenceQuote: string | null | undefined): MaterialityResult {
  const text = `${value} ${evidenceQuote ?? ""}`.toLowerCase();
  // Cheap-equity terms (stems, no trailing \b, so plurals match).
  const cheapTerms =
    "preferential allotment|preferential issue|preferential basis|preferential|warrant|at a discount|discounted|below market|at a price lower|cheap equity";
  // A NEGATED mention — "no promoter warrants or preferential allotments", "Nil
  // preferential issue", "warrants: none" — is a favourable, GREEN finding, NOT a
  // red. The bare RED test below matched the very words that a nil statement uses
  // to DENY the exposure, so read the negation first. `statesNil` covers the
  // generic "nil / none / not applicable" affirmations.
  const negatedCheap =
    new RegExp(`\\b(no|nil|none|not|without|zero)\\b[\\w\\s,/&()-]{0,32}(${cheapTerms})`).test(text) ||
    new RegExp(`(${cheapTerms})[\\w\\s,/&()-]{0,20}\\b(nil|none|not (issued|applicable|made))\\b`).test(text);
  if (
    /\b(no preferential|not issued|no warrants|at[ -]market|no cheap|no discounted)\b/.test(text) ||
    negatedCheap ||
    statesNil(text)
  ) {
    return { flag: "GREEN", reason: `No preferential/discounted issuance to insiders disclosed (${value}).` };
  }
  const insider = /\b(promoter|insider|related part|key managerial|kmp)/.test(text);
  const cheap = new RegExp(`\\b(${cheapTerms})`).test(text);
  if (insider && cheap) {
    return { flag: "RED", reason: `Preferential/discounted equity or warrants issued to insiders/promoters (${value}).` };
  }
  return { flag: "NEUTRAL", reason: `No discounted insider/promoter issuance identified (${value}).` };
}

/**
 * A4-05 Audit qualifications / emphasis of matter. The red is a MODIFIED opinion
 * (qualified / adverse / disclaimer) or a real going-concern emphasis. Every audit
 * report's "Auditor's Responsibilities" section contains boilerplate about going
 * concern ("…we conclude on the appropriateness… if a material uncertainty exists
 * … we are required to draw attention…"); a judge red-flagged that boilerplate as
 * a qualification on clean-opinion TCS. Decide deterministically: RED only on an
 * EXPLICIT modified opinion or a genuine going-concern emphasis that is NOT the
 * standard responsibilities boilerplate; a clean/unmodified opinion is GREEN.
 */
export function auditOpinionFlag(value: string, evidenceQuote: string | null | undefined): MaterialityResult {
  const text = `${value} ${evidenceQuote ?? ""}`.toLowerCase();
  const modified = /\b(qualified opinion|adverse opinion|disclaimer of opinion)\b/.test(text);
  // Standard auditor-RESPONSIBILITIES boilerplate — not an actual qualification.
  const boilerplate =
    /\b(we are required to|we conclude on|auditor.?s responsibilit|going concern basis of accounting|based on the audit evidence obtained)\b/.test(
      text,
    );
  // A REAL going-concern emphasis draws attention / cites significant doubt.
  const realGoingConcern =
    /going concern/.test(text) &&
    /\b(draw attention|significant doubt|may (not )?(be able to )?continue|material uncertainty (exists|related to))\b/.test(text) &&
    !boilerplate;
  if (modified || realGoingConcern) {
    return { flag: "RED", reason: `Modified audit opinion / going-concern emphasis (${value}).` };
  }
  if (/\b(unmodified|unqualified|true and fair|present(s|ed)? fairly|clean opinion|in our opinion|without (any )?qualification)\b/.test(text)) {
    return { flag: "GREEN", reason: `Clean/unmodified audit opinion (${value}).` };
  }
  // A clean opinion is the NORM, and the green condition here is precisely the
  // ABSENCE of a qualification/adverse opinion/going-concern emphasis. So when we
  // have audit-report evidence and found none of those, the honest flag is GREEN
  // — not a defensive NEUTRAL that reads like a problem. (Only truly context-less
  // evidence stays NEUTRAL.)
  const hasAuditContext = /\b(audit|auditor|opinion|financial statements|report of the)\b/.test(text);
  if (hasAuditContext) {
    return { flag: "GREEN", reason: `No qualification, adverse opinion or going-concern emphasis identified — clean opinion (${value}).` };
  }
  return { flag: "NEUTRAL", reason: `Audit opinion not clearly established (${value}).` };
}

/**
 * A1-02 Chairman–MD separation. GREEN = the roles are held by different people;
 * RED = duality (one person is both Chairman and MD/CEO). A judge red-flagged TCS
 * — whose roles ARE split — on the tangential fact that the chairman is a promoter
 * nominee, which is a different item (independence), not separation. Decide
 * deterministically: separation → GREEN; explicit duality → RED; else NEUTRAL.
 */
export function chairmanMdSeparationFlag(value: string, evidenceQuote: string | null | undefined): MaterialityResult {
  const text = `${value} ${evidenceQuote ?? ""}`.toLowerCase();
  const duality =
    /\b(same person|combined|chairman (cum|and) managing director is the same|no separation|chairman.{0,30}also.{0,20}(ceo|managing director))\b/.test(
      text,
    );
  if (duality) {
    return { flag: "RED", reason: `Chairman and MD/CEO roles are combined (${value}).` };
  }
  if (/\b(roles? (are )?(split|separate)|separation of (the )?roles|(chairman|chair) and (managing director|md|ceo) are (different|separate)|different persons?|non[ -]executive chair)\b/.test(text)) {
    return { flag: "GREEN", reason: `Chairman and MD/CEO roles are separated (${value}).` };
  }
  return { flag: "NEUTRAL", reason: `Chairman–MD separation not clearly established (${value}).` };
}

/**
 * A8-06 Goodwill build-up & impairment. RED = a real goodwill IMPAIRMENT (an
 * existing asset written down). A frequent misread turns the cash-flow "purchase
 * of fixed/intangible assets" line (capital expenditure — an investing OUTFLOW, i.e.
 * the company BOUGHT assets) into a "goodwill impairment", firing a false red on a
 * company that has no goodwill at all. Decide on the EVIDENCE, not the extractor's
 * label: a purchase/addition is never an impairment; a red needs impairment wording.
 */
export function goodwillImpairmentFlag(value: string, evidenceQuote: string | null | undefined): MaterialityResult {
  const ev = (evidenceQuote ?? "").toLowerCase();
  const both = `${value} ${ev}`.toLowerCase();
  if (statesNil(both) || /\bno goodwill\b|goodwill[^.]{0,20}\b(nil|none|no impair)/.test(both)) {
    return { flag: "GREEN", reason: `No goodwill / no impairment reported (${value}).` };
  }
  // A PURCHASE / addition of fixed or intangible assets is capex, not an impairment.
  const purchase = /\b(purchas|addition|acquir|bought|capital expenditure|capex|invest(?:ing|ment) in)/.test(ev);
  // A genuine impairment must be EVIDENCED (not merely the extractor's headline).
  const impaired = /\bimpair/.test(ev) || /\b(written|write)[ -]?(down|off)\b/.test(ev);
  if (purchase && !impaired) {
    return { flag: "GREEN", reason: `The figure is a purchase/addition of assets (capital expenditure), not a goodwill impairment — no impairment identified (${value}).` };
  }
  if (impaired && /goodwill/.test(ev)) {
    return { flag: "RED", reason: `Goodwill impairment identified in the accounts (${value}).` };
  }
  return { flag: "NEUTRAL", reason: `No clear goodwill impairment identified (${value}).` };
}

export const CATEGORICAL_RULES: Record<
  string,
  (value: string, evidenceQuote: string | null | undefined) => MaterialityResult
> = {
  "A1-02": chairmanMdSeparationFlag,
  "A2-01": auditCommitteeFlag,
  "A3-05": cheapInsiderEquityFlag,
  "A4-05": auditOpinionFlag,
  "A8-06": goodwillImpairmentFlag,
};
