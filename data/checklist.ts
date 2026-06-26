import type { ChecklistItemInput } from "@/lib/engine";

/**
 * Representative STARTER sample of the corporate-governance checklist.
 *
 * The full framework is ~106 items spanning SEBI LODR / Ind AS. Extend this
 * list (or load it from a maintained spreadsheet) and seed it into the
 * `ChecklistItem` table. Every item is flag-based — guidance describes what is
 * GREEN vs RED; there is no numeric scoring.
 */
export const CHECKLIST_SEED: ChecklistItemInput[] = [
  {
    code: "BOARD-01",
    category: "Board Composition",
    title: "Board meets the minimum independent-director requirement",
    regReference: "SEBI LODR Reg. 17(1)",
    guidance:
      "GREEN if independent directors meet the threshold (≥1/3, or ≥1/2 where the chair is executive / promoter-related); RED if below.",
  },
  {
    code: "BOARD-02",
    category: "Board Composition",
    title: "Chairperson and CEO/MD roles are separated",
    regReference: "SEBI LODR Reg. 17(1B)",
    guidance:
      "GREEN if the roles are held by different persons and the chair is non-executive; RED if combined without the required separation.",
  },
  {
    code: "BOARD-03",
    category: "Board Diversity",
    title: "Board has at least one woman independent director",
    regReference: "SEBI LODR Reg. 17(1)(a)",
    guidance: "GREEN if present; RED if absent.",
  },
  {
    code: "AUDIT-01",
    category: "Audit Committee",
    title: "Audit committee is composed of a majority of independent directors",
    regReference: "SEBI LODR Reg. 18",
    guidance:
      "GREEN if ≥2/3 members are independent and the chair is independent; RED otherwise.",
  },
  {
    code: "AUDIT-02",
    category: "Auditor",
    title: "Statutory auditor's report carries no qualification",
    regReference: "Companies Act 2013 s.143; Ind AS",
    guidance:
      "GREEN if unqualified/clean; RED if qualified, adverse, or a disclaimer; NEUTRAL with emphasis-of-matter only.",
  },
  {
    code: "RPT-01",
    category: "Related Party Transactions",
    title: "Material RPTs received shareholder approval",
    regReference: "SEBI LODR Reg. 23",
    guidance:
      "GREEN if material RPTs were approved by audit committee and shareholders; RED if not; NOT_AVAILABLE if disclosure is absent.",
  },
  {
    code: "REMUN-01",
    category: "Remuneration",
    title: "Nomination & Remuneration Committee is constituted as required",
    regReference: "SEBI LODR Reg. 19",
    guidance:
      "GREEN if constituted with the required independent-director composition; RED otherwise.",
  },
  {
    code: "DISC-01",
    category: "Disclosure & Transparency",
    title: "Corporate governance report is included in the annual report",
    regReference: "SEBI LODR Reg. 34(3) & Sch. V",
    guidance: "GREEN if present and complete; RED if missing material sections.",
  },
  {
    code: "SHARE-01",
    category: "Shareholder Rights",
    title: "Dividend distribution policy is disclosed (top-1000 by market cap)",
    regReference: "SEBI LODR Reg. 43A",
    guidance:
      "GREEN if disclosed; RED if required but absent; NOT_AVAILABLE if not applicable.",
  },
  {
    code: "RISK-01",
    category: "Risk Management",
    title: "Risk Management Committee is constituted (top-1000 by market cap)",
    regReference: "SEBI LODR Reg. 21",
    guidance:
      "GREEN if constituted with required composition; RED if required but absent; NOT_AVAILABLE if not applicable.",
  },
];
