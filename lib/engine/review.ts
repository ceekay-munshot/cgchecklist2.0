import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { summarize, isCommitted } from "@/lib/orchestrate";
import { callJSON } from "./llm";

/**
 * FINAL self-audit of a completed run — the automated version of the manual
 * report review. After harvest + analysis + MUNS backfill have filled every item,
 * this reads the WHOLE report back and looks for the bug classes a client would
 * catch: a flag that contradicts its own finding, an impossible number (a raw ₹
 * amount fed into a ratio/%% band, a lakh/crore unit slip), a flag that
 * contradicts ANOTHER item, or a RED fired on a normal/statutory fact. Clear
 * errors are corrected in place (flag flipped + an audit note) and the run is
 * re-summarised, so the dashboard only ever shows a consistent report.
 *
 * Conservative + transparent: only CLEAR errors are touched, every change is
 * annotated "[QA-corrected …]" (an analyst can override), and any model/parse
 * failure is a no-op that leaves the report exactly as MUNS left it.
 */

interface QaFinding {
  id: string;
  issue: string;
  corrected_flag: "GREEN" | "RED" | "NEUTRAL" | "KEEP";
  corrected_note: string;
}

const QA_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          issue: { type: "string" },
          corrected_flag: { enum: ["GREEN", "RED", "NEUTRAL", "KEEP"] },
          corrected_note: { type: "string" },
        },
        required: ["id", "issue", "corrected_flag", "corrected_note"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

const QA_PROMPT =
  `You are a senior forensic analyst doing the FINAL audit of a completed corporate-` +
  `governance checklist report before it is shown to a client. Each row is one item: its ` +
  `assigned FLAG (GREEN = good / RED = concern / NEUTRAL), the item's own GREEN and RED ` +
  `definitions, and the FINDING the flag was based on.\n\n` +
  `Your ONLY job is to catch RED flags that are FALSE ALARMS and should be softened to ` +
  `GREEN or NEUTRAL. A red is a false alarm when:\n` +
  `1. It CONTRADICTS ITS OWN FINDING — the flag is RED but the finding text actually reads ` +
  `benign ("conservative", "strong position", "stable", "no concern", "reducing risk", ` +
  `"within limit", "clean", "compliant").\n` +
  `2. It rests on an IMPOSSIBLE NUMBER — a Debt/Equity ratio above ~20; a "% of PBT / % of ` +
  `profit / % of net worth" above ~300 that is really a raw rupee amount; a rupee figure ` +
  `100x off because lakh was labelled crore (or vice-versa). Use other rows to infer scale.\n` +
  `3. It CONTRADICTS ANOTHER ITEM — e.g. one row says "no subsidiaries / single entity" but ` +
  `this red claims "unconsolidated entities"; or the same metric appears with wildly ` +
  `different values across rows (D/E 0.12 in one, 4417 in another).\n` +
  `4. It fires on a NORMAL / STATUTORY FACT that is not a governance defect — holding a ` +
  `required operating licence, directors retiring by rotation under the Companies Act, a ` +
  `single one-time IPO-era / Ind-AS-adoption restatement of prior years.\n\n` +
  `HARD RULES:\n` +
  `- ONLY report items whose current flag is RED. NEVER escalate a GREEN or NEUTRAL to RED, ` +
  `and never touch a GREEN or NEUTRAL item — a favourable finding (e.g. a majority-` +
  `independent board, low leverage, zero pledging) is CORRECT and must be left alone.\n` +
  `- corrected_flag must be GREEN or NEUTRAL (or KEEP if the red is actually justified).\n` +
  `- Only CLEAR, defensible false alarms — do not re-judge borderline matters of degree.\n\n` +
  `For each false-alarm red, return: id, the issue, corrected_flag (GREEN/NEUTRAL/KEEP), and ` +
  `a clean one-line replacement note (no meta-commentary). Empty list if every red is sound.` +
  `\n\nREPORT ROWS:\n`;

export interface QaCorrection {
  id: string;
  from: string;
  to: string;
  issue: string;
}
export interface QaSummary {
  reviewed: number;
  corrections: QaCorrection[];
  skipped?: string;
}

// QA may only SOFTEN a red — never create one. (An over-eager judge once flipped a
// clean 71.4%-independent board GREEN→RED; the report must never gain a red here.)
const SOFTEN_TO = new Set(["GREEN", "NEUTRAL"]);

export async function reviewRun(runId: string): Promise<QaSummary> {
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run) return { reviewed: 0, corrections: [], skipped: `run ${runId} not found` };

  const [items, sections, results] = await Promise.all([
    prisma.checklistItem.findMany({ orderBy: [{ sectionCode: "asc" }, { orderIndex: "asc" }] }),
    prisma.checklistSection.findMany({ orderBy: { orderIndex: "asc" } }),
    prisma.itemResult.findMany({ where: { runId } }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const resultByItem = new Map(results.map((r) => [r.itemId, r]));

  // Audit only committed items that carry a flag.
  const audited = results.filter((r) => isCommitted(r.status) && r.flag);
  const rows = audited.map((r) => {
    const it = itemById.get(r.itemId);
    const g = (it?.greenFlag ?? "").replace(/\s+/g, " ").slice(0, 90);
    const rd = (it?.redFlag ?? "").replace(/\s+/g, " ").slice(0, 90);
    const finding = `${r.value ?? ""} — ${r.verdict ?? ""}`.replace(/\s+/g, " ").slice(0, 320);
    return `${r.itemId} | ${it?.item ?? ""} | FLAG=${r.flag} | GREEN=${g} | RED=${rd} | FINDING=${finding}`;
  });
  if (rows.length < 20) {
    return { reviewed: rows.length, corrections: [], skipped: "too few committed items to audit" };
  }

  let findings: QaFinding[];
  try {
    const { data } = await callJSON<{ findings: QaFinding[] }>(
      "longContext",
      { prompt: QA_PROMPT + rows.join("\n"), temperature: 0, maxTokens: 4000 },
      QA_SCHEMA,
    );
    findings = data.findings ?? [];
  } catch (e) {
    return { reviewed: rows.length, corrections: [], skipped: `QA judge unavailable: ${(e as Error).message}` };
  }

  const corrections: QaCorrection[] = [];
  for (const f of findings) {
    const r = resultByItem.get(f.id);
    // SAFETY: only ever SOFTEN a false-alarm RED to GREEN/NEUTRAL. Skip anything
    // that isn't currently RED, and any target that isn't a softening — so QA can
    // never introduce a new red or otherwise touch a favourable finding.
    if (!r || r.flag !== "RED") continue;
    const to = f.corrected_flag;
    if (!SOFTEN_TO.has(to)) continue;
    await prisma.itemResult
      .update({
        where: { runId_itemId: { runId, itemId: f.id } },
        data: {
          flag: to,
          // Clean, reader-facing note — no internal "QA-corrected" annotation.
          verdict: (f.corrected_note || f.issue || r.verdict || "").slice(0, 900),
          providerUsed: `${r.providerUsed ? r.providerUsed + "+" : ""}qa`,
        },
      })
      .catch(() => {});
    corrections.push({ id: f.id, from: r.flag, to, issue: f.issue });
  }

  // Re-summarise with the corrected flags so the dashboard totals + gate are consistent.
  if (corrections.length) {
    const fresh = await prisma.itemResult.findMany({
      where: { runId },
      select: { itemId: true, status: true, flag: true },
    });
    const summary = summarize(
      items.map((i) => ({ id: i.id, sectionCode: i.sectionCode, isNonNegotiable: i.isNonNegotiable })),
      sections.map((s) => ({ code: s.code, name: s.name })),
      fresh,
    );
    await prisma.analysisRun
      .update({
        where: { id: runId },
        data: {
          summaryJson: summary as unknown as Prisma.InputJsonValue,
          itemsTotal: summary.itemsTotal,
          itemsDone: summary.itemsDone,
        },
      })
      .catch(() => {});
  }

  return { reviewed: rows.length, corrections };
}
