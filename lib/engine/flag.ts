import { callJSON } from "./llm";
import { CUSTOM_NUMERIC } from "./numeric";
import { classifyNumeric, parseNumericValue } from "./thresholds";
import {
  isNotAvailable,
  kindOf,
  type Analysis,
  type EngineItem,
  type Flag,
  type FlagResult,
} from "./types";

type JudgeFlag = "GREEN" | "RED" | "NEUTRAL";

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
    `on the finding/evidence above; if it is ambiguous or unsupported, choose NEUTRAL. ` +
    `Give a ONE-sentence reason.`
  );
}

async function judge(
  item: EngineItem,
  analysis: Analysis,
  role: "reasoning" | "bulkClassify" | "fallback" | "longContext",
): Promise<{ flag: JudgeFlag; reason: string; provider: string }> {
  const { data, provider } = await callJSON<JudgeResult>(
    role,
    { prompt: judgePrompt(item, analysis), temperature: 0 },
    JUDGE_SCHEMA,
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
export async function assignFlag(item: EngineItem, analysis: Analysis): Promise<FlagResult> {
  if (isNotAvailable(analysis.value)) {
    return applyGate(item, { flag: "NOT_AVAILABLE", reason: "No evidence available." });
  }

  if (kindOf(item) === "NUMERIC") {
    const num = parseNumericValue(analysis.value);
    if (num == null) {
      return applyGate(item, { flag: "NEUTRAL", reason: `Could not parse a number from "${analysis.value}".` });
    }
    // Items whose checklist bands are textual (e.g. "Near statutory (~25%)") use a
    // dedicated deterministic classifier; the rest parse green/red bands directly.
    const custom = CUSTOM_NUMERIC[item.id];
    const c = custom ? custom(num) : classifyNumeric(num, item.greenFlag, item.redFlag);
    return applyGate(item, { flag: c.flag, reason: c.reason });
  }

  // qualitative
  let judged: { flag: JudgeFlag; reason: string; provider: string };
  try {
    judged = await judge(item, analysis, "reasoning");
  } catch (e) {
    return applyGate(item, { flag: "NEUTRAL", reason: `Judge unavailable (${(e as Error).message}).` });
  }
  return applyGate(
    item,
    { flag: judged.flag, reason: judged.reason, provider: judged.provider },
    // cross-check a non-negotiable RED with a different, cheaper model
    () => judge(item, analysis, "bulkClassify"),
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

  if (item.isNonNegotiable && flag === "RED" && crossCheck) {
    try {
      const second = await crossCheck();
      providerUsed = providerUsed ? `${providerUsed}+${second.provider}` : second.provider;
      if (second.flag !== "RED") {
        flag = "NEUTRAL";
        needsReview = true;
        reason = `Non-negotiable RED not confirmed on cross-check (${second.provider} said ${second.flag}) — needs review. Original: ${reason}`;
      }
    } catch {
      needsReview = true;
      reason = `Non-negotiable RED could not be cross-checked — needs review. Original: ${reason}`;
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
