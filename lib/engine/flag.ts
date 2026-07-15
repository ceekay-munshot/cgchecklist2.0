import { callJSON } from "./llm";
import { evidenceStrategyFor } from "./evidence";
import { CUSTOM_NUMERIC, CUSTOM_SERIES } from "./numeric";
import {
  CATEGORICAL_RULES,
  classifyAmount,
  guardAmount,
  type CompanyScale,
} from "./materiality";
import { classifyNumeric, parseNumericValue } from "./thresholds";
import {
  isNotAvailable,
  kindOf,
  type Analysis,
  type EngineItem,
  type Flag,
  type FlagResult,
} from "./types";

/** Optional context for flag assignment. */
export interface FlagContext {
  /** Company size for materiality scaling. */
  scale?: CompanyScale | null;
  /** True when the evidence came from web research (news/blogs/search snippets). */
  web?: boolean;
}

type JudgeFlag = "GREEN" | "RED" | "NEUTRAL";

/**
 * Promoter / management INTEGRITY items ask "is there anything adverse?" For these,
 * a research result of "nothing found / nil / no verified record" is ABSENCE of
 * evidence — NOT a positive clean bill. Greening it produces a false all-clear on
 * exactly the item an analyst scans first (the AFCOM promoter-reputation miss). So
 * an absence finding here becomes NEUTRAL + a "corroborate" note, never a confident
 * GREEN. (SEBI/NCLT actions are PUBLIC record, so their genuine "nil" is meaningful
 * and stays OUT of this set — only the hard-to-search reputation items are in.)
 */
const INTEGRITY_ABSENCE_ITEMS = new Set(["A1-05", "A9-04", "A13-01", "A13-02", "A13-07"]);

/** A finding that reads as "we found nothing", not a positive confirmation. */
export function isAbsenceFinding(text: string | null | undefined): boolean {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return true;
  return /\b(nil|none|no\s+(such|verified|adverse|material|prior|external|other|known|reported|disclosed|evidence|record|history|track)\b|not\s+(found|identified|available|disclosed|established)|no\s+\w+\s+(found|identified|reported|established))\b/.test(
    t,
  );
}

interface JudgeResult {
  flag: JudgeFlag;
  reason: string;
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    flag: { enum: ["GREEN", "RED", "NEUTRAL"] },
    reason: { type: "string" },
  },
  required: ["flag", "reason"],
  additionalProperties: false,
} as const;

function judgePrompt(item: EngineItem, analysis: Analysis): string {
  return (
    `Checklist item: ${item.item}\n` +
    (item.description ? `Definition: ${item.description}\n` : "") +
    `GREEN means: ${item.greenFlag ?? "n/a"}\n` +
    `RED means: ${item.redFlag ?? "n/a"}\n\n` +
    `Finding: ${analysis.value}\n` +
    (analysis.evidenceQuote ? `Evidence: ${analysis.evidenceQuote}\n` : "") +
    `\nDecide the flag for this finding: GREEN if it matches the green description, ` +
    `RED if it matches the red description, otherwise NEUTRAL. Base the decision ONLY ` +
    `on the finding/evidence above. Use ONLY evidence of the type this item asks about — ` +
    `if the finding is actually about a DIFFERENT concept (e.g. goodwill is not a ` +
    `contingent liability; a revenue figure is not remuneration), choose NEUTRAL.\n` +
    `IMPORTANT — follow the descriptions, don't hedge: if the finding SATISFIES the ` +
    `green description (including a nil / zero / "none" / clean / compliant / ` +
    `within-limit outcome), you MUST return GREEN. Do NOT downgrade a genuinely ` +
    `favourable or compliant finding to NEUTRAL just because a precise number is ` +
    `absent, the disclosure is brief, or you couldn't independently verify it — a ` +
    `reported zero or a clean disclosure IS the green condition. Likewise return RED ` +
    `when it genuinely matches the red description. Use NEUTRAL only for genuinely ` +
    `mixed or ambiguous cases. For "reason", give ONE or TWO sentences an analyst ` +
    `would sign off on: name the SPECIFIC number or threshold that drives the call ` +
    `and the governance implication — do NOT merely restate the rule.`
  );
}

async function judge(
  item: EngineItem,
  analysis: Analysis,
  role: "reasoning" | "bulkClassify" | "fallback" | "longContext",
  callOpts?: { excludePrimary?: boolean },
): Promise<{ flag: JudgeFlag; reason: string; provider: string }> {
  const { data, provider } = await callJSON<JudgeResult>(
    role,
    { prompt: judgePrompt(item, analysis), temperature: 0 },
    JUDGE_SCHEMA,
    callOpts,
  );
  return { flag: data.flag, reason: data.reason, provider };
}

/**
 * Assign a flag to an analysed item.
 *   - NUMERIC     -> DETERMINISTIC comparison of the value against the parsed
 *                    green/red bands (no LLM).
 *   - QUALITATIVE -> an LLM judges the finding against the green/red descriptions.
 *   - not available -> NOT_AVAILABLE.
 *
 * Non-negotiable gate: gatePass = green→true / red→false / else→null. A RED on a
 * non-negotiable qualitative item is cross-checked by a second, cheaper model;
 * RED is confirmed only if both agree, else it becomes NEUTRAL + "needs review".
 */
export async function assignFlag(
  item: EngineItem,
  analysis: Analysis,
  context: FlagContext = {},
): Promise<FlagResult> {
  if (isNotAvailable(analysis.value)) {
    return applyGate(item, { flag: "NOT_AVAILABLE", reason: "No evidence available." });
  }

  const num = parseNumericValue(analysis.value);

  // Trend classifier for Tier-1 series items (Working-capital days, Dividend
  // payout): judges the whole multi-year row deterministically. Runs first so a
  // textual "Stable/improving" band never traps it in the generic numeric path.
  const seriesRule = CUSTOM_SERIES[item.id];
  if (seriesRule && analysis.series && analysis.series.values.some((v) => v != null)) {
    const c = seriesRule(analysis.series);
    return applyGate(item, { flag: c.flag, reason: c.reason, provider: "deterministic" });
  }

  // Dedicated deterministic classifier (textual-band items like A8-10, and
  // Tier-1-anchored items like A14-02 that are "Text" by format but numeric by
  // value). Runs first so numeric sanity holds regardless of output_format.
  const custom = CUSTOM_NUMERIC[item.id];
  if (custom && num != null) {
    const c = custom(num);
    return applyGate(item, { flag: c.flag, reason: c.reason });
  }

  // Categorical compliance rule (e.g. A2-01 audit committee): decide
  // deterministically so an over-strict LLM judge can't red a compliant fact.
  const categorical = CATEGORICAL_RULES[item.id];
  if (categorical) {
    const c = categorical(analysis.value, analysis.evidenceQuote);
    return applyGate(item, { flag: c.flag, reason: c.reason, provider: "deterministic" });
  }

  // Amount-based item (contingent liabilities, guarantees, RPT amounts, royalty):
  // classify by MATERIALITY against company size — an immaterial amount can never
  // be a red, and an implausibly large figure is distrusted (Tasks 1 & 3). No LLM.
  const amountFlag = classifyAmount(item.id, analysis.value, analysis.evidenceQuote, context.scale);
  if (amountFlag) {
    return applyGate(item, { flag: amountFlag.flag, reason: amountFlag.reason, provider: "deterministic" });
  }

  // NUMERIC items with a clean parseable number are classified deterministically
  // against their green/red bands — EXCEPT note items, whose value is a figures
  // statement judged qualitatively. When the extractor returned a value WITHOUT a
  // clean number (e.g. "Full attendance", "not overboarded"), we no longer
  // dead-end with a "could not parse a number" verdict: we fall through to the
  // qualitative judge below, which reads the value + evidence against the item's
  // descriptions and returns a real green/red/neutral call.
  const noteItem = evidenceStrategyFor(item).useGeminiNote === true;
  if (kindOf(item) === "NUMERIC" && !noteItem && num != null) {
    const c = classifyNumeric(num, item.greenFlag, item.redFlag);
    return applyGate(item, { flag: c.flag, reason: c.reason });
  }

  // qualitative
  let judged: { flag: JudgeFlag; reason: string; provider: string };
  try {
    judged = await judge(item, analysis, "reasoning");
  } catch (e) {
    return applyGate(item, { flag: "NEUTRAL", reason: `Judge unavailable (${(e as Error).message}).` });
  }

  // Materiality guard: a trend/quality A7a/A5 item must not red on an immaterial
  // figure (Task 2 — e.g. the "movement" item red-flagging a tiny guarantee).
  const guard = guardAmount(item.id, judged.flag, analysis.value, analysis.evidenceQuote, context.scale);
  if (guard) {
    return applyGate(item, { flag: guard.flag, reason: guard.reason, provider: judged.provider });
  }

  // Integrity-absence guard: on a promoter/management-integrity item, "nothing
  // adverse found" is ABSENCE of evidence, not a clean record — never let it stand
  // as a confident GREEN. Downgrade to NEUTRAL with an explicit corroborate note.
  if (
    INTEGRITY_ABSENCE_ITEMS.has(item.id) &&
    judged.flag === "GREEN" &&
    isAbsenceFinding(`${analysis.value} ${analysis.evidenceQuote ?? ""}`)
  ) {
    return applyGate(item, {
      flag: "NEUTRAL",
      reason:
        `No adverse record surfaced in research — this is ABSENCE of evidence, not a ` +
        `confirmed clean record. Corroborate against news / Valuepickr / MCA / court & ` +
        `tribunal records before treating the promoter's track record as clean. (${judged.reason})`,
      provider: judged.provider,
    });
  }

  // Web-sourced evidence (news, market data, Valuepickr-style forums) is a
  // legitimate — often the ONLY — source for qualitative governance signals like a
  // promoter's track record elsewhere. It MAY fire a RED, but a web red is held to
  // the same bar as any other: the mandatory two-model cross-check below must
  // confirm it, and the finding is carried at LOW confidence (set upstream in the
  // extractor) so the reader knows to corroborate. We annotate the reason so the
  // web provenance is explicit in the report.
  const reason =
    context.web && judged.flag === "RED"
      ? `${judged.reason} (Web-sourced — low confidence; corroborate against filings/primary sources.)`
      : judged.reason;

  return applyGate(
    item,
    { flag: judged.flag, reason, provider: judged.provider },
    // EVERY qualitative RED is cross-checked by a DIFFERENT model (primary
    // excluded) — a one-off judge misfire can't stand as a red.
    () => judge(item, analysis, "bulkClassify", { excludePrimary: true }),
  );
}

async function applyGate(
  item: EngineItem,
  base: { flag: Flag; reason: string; provider?: string },
  crossCheck?: () => Promise<{ flag: JudgeFlag; reason: string; provider: string }>,
): Promise<FlagResult> {
  let { flag, reason } = base;
  let providerUsed = base.provider;
  let needsReview = false;

  // Cross-check EVERY qualitative RED with a second (different) model; a red
  // stands only if confirmed. Disagreement → NEUTRAL + needs-review. A transient
  // cross-check failure keeps the RED (don't suppress a real red) but flags it.
  if (flag === "RED" && crossCheck) {
    try {
      const second = await crossCheck();
      providerUsed = providerUsed ? `${providerUsed}+${second.provider}` : second.provider;
      if (second.flag !== "RED") {
        flag = "NEUTRAL";
        needsReview = true;
        reason = `RED not confirmed on cross-check (${second.provider} said ${second.flag}) — downgraded to NEUTRAL for review. Original: ${reason}`;
      }
    } catch {
      needsReview = true;
      reason = `RED could not be cross-checked — needs review. Original: ${reason}`;
    }
  }

  const gatePass = item.isNonNegotiable
    ? flag === "GREEN"
      ? true
      : flag === "RED"
        ? false
        : null
    : null;

  return { flag, reason, gatePass, needsReview, providerUsed };
}
