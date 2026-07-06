/**
 * Item applicability by company type (Phase 8 — unlisted support).
 *
 * The checklist was written for LISTED companies. A private/unlisted company files
 * no exchange disclosures, has no public float, no traded stock, and isn't bound by
 * the SEBI LODR board/committee mandates — so a set of items simply CANNOT apply to
 * it, and grading them would produce misleading fake-greens or noisy "not found"
 * gaps. Those items are marked LISTED-ONLY and short-circuit to an honest, explicit
 * "not applicable to an unlisted company" for unlisted runs.
 *
 * EVERYTHING ELSE is universal: it applies to private companies too and is answered
 * best-effort from the uploaded financial statements (incl. the derived Tier-1
 * financials), the notes, related documents (e.g. a due-diligence report), and web
 * research / source scraping. A universal item that genuinely can't be answered
 * still returns a normal NA — that's a data gap, distinct from "doesn't apply".
 *
 * The split is by NATURE of the requirement (SEBI/market/stock-specific vs a
 * governance trait any company has), NOT hardcoded to any company.
 */

export const LISTED_ONLY_ITEMS = new Set<string>([
  // A1 Board — SEBI LODR mandates (independence ratio, overboarding cap, attendance
  // & skills-matrix disclosures, ID tenure/resignation/reappointment) that private
  // boards neither follow nor disclose. (A1-02/03 chairman-MD split, A1-05 director
  // reputation stay universal — answerable from docs/web.)
  "A1-01", // board size & independence ratio (≥50% independent — SEBI)
  "A1-04", // true independence of independent directors
  "A1-06", // overboarding (≤7 LISTED boards)
  "A1-07", // board-meeting attendance records (SEBI-mandated table)
  "A1-08", // board skills/competence matrix (SEBI-mandated chart)
  "A1-09", // independent-director resignation pattern
  "A1-10", // reappointment/removal patterns (shareholder-vote governance)
  // A2 Committees — SEBI-mandated audit/NRC/risk/stakeholder committees & their
  // substance. (A2-03 CSR is a Companies-Act duty that can apply to a large private
  // company, so it stays universal / best-effort.)
  "A2-01", // audit committee quality
  "A2-02", // NRC / risk / stakeholder committees
  "A2-04", // board-meeting substance vs paper
  // A3 Ownership — public-market constructs: pledging disclosed to exchanges, the
  // minimum-public-shareholding free float, and the promoter-holding-trend/MPS band
  // (a private company is ~fully promoter-owned, so the band is meaningless).
  "A3-01", // promoter holding trend / MPS band
  "A3-02", // share pledging / encumbrance (exchange disclosure)
  "A3-06", // free-float level (minimum public shareholding)
  // A5 — minority dissent needs a listed shareholder vote.
  "A5-06", // minority dissent on RPT resolutions
  // A6 — CEO-to-median pay ratio is the SEBI/Sec-197 Rule 5 listed-only disclosure.
  "A6-05", // CEO-to-median ratio & severance
  // A7 — Reg 30 timeliness / listing-disclosure fines.
  "A7-01", // disclosure timeliness / completeness (SEBI Reg 30)
  // A9 — SEBI has jurisdiction only over listed entities.
  "A9-01", // SEBI actions / consent orders / insider trading
  // A10 — institutional (public-shareholder) voting patterns.
  "A10-03", // institutional voting patterns
  // A15 — everything here needs a traded stock.
  "A15-01", // stock volatility
  "A15-02", // volume & liquidity
  "A15-03", // research/analyst coverage
]);

/** Does this item structurally NOT apply to an unlisted company? */
export function isListedOnlyItem(itemId: string): boolean {
  return LISTED_ONLY_ITEMS.has(itemId);
}
