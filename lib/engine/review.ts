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
  `You are a senior forensic analyst doing the FINAL consistency audit of a completed ` +
  `corporate-governance checklist report before it is shown to a client. Each row is one ` +
  `item: its assigned FLAG (GREEN = good / RED = concern / NEUTRAL), the item's own GREEN ` +
  `and RED definitions, and the FINDING the flag was based on.\n\n` +
  `Flag ONLY items that are clearly WRONG for one of these reasons:\n` +
  `1. CONTRADICTS ITS OWN FINDING — flag RED but the finding text actually says something ` +
  `benign ("conservative", "strong position", "stable", "no concern", "reducing risk", ` +
  `"within limit", "clean"); or flag GREEN while the finding describes a clear problem.\n` +
  `2. IMPOSSIBLE NUMBER for its metric — a Debt/Equity ratio above ~20; a "% of PBT / % of ` +
  `profit / % of net worth" above ~300 that is really a raw rupee amount; a rupee figure ` +
  `100x off because lakh was labelled crore (or vice-versa). Use the other rows to infer ` +
  `the true scale of the company.\n` +
  `3. CONTRADICTS ANOTHER ITEM — e.g. one row says "no subsidiaries / single entity" but ` +
  `another flags "unconsolidated entities" / "consolidation opacity"; or two rows report ` +
  `the same metric with wildly different values (e.g. D/E 0.12 in one, 4417 in another).\n` +
  `4. RED ON A NORMAL / STATUTORY FACT that is not a governance defect — holding a required ` +
  `operating licence, directors retiring by rotation under the Companies Act, a single ` +
  `one-time IPO-era restatement of prior years.\n\n` +
  `Do NOT re-judge borderline calls or matters of degree, and do NOT invent new problems — ` +
  `only CLEAR, defensible errors. For each, return: id, the issue, the flag it SHOULD be ` +
  `(corrected_flag; use "KEEP" if you are not sure), and a corrected one-line note. Return ` +
  `an empty list if the report is internally consistent.\n\nREPORT ROWS:\n`;

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

const REAL_FLAGS = new Set(["GREEN", "RED", "NEUTRAL"]);

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
    if (!r || !r.flag) continue;
    const to = f.corrected_flag;
    if (!REAL_FLAGS.has(to) || to === r.flag) continue; // KEEP / same flag = no-op
    await prisma.itemResult
      .update({
        where: { runId_itemId: { runId, itemId: f.id } },
        data: {
          flag: to,
          verdict: `[QA-corrected ${r.flag}→${to}] ${f.corrected_note} (${f.issue})`.slice(0, 900),
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
