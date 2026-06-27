// Deterministic threshold parsing for NUMERIC checklist items.
//
// The checklist expresses green/red bands as human text, e.g.
//   green "<0.5–1.0"                    red ">2 / rising"
//   green "0% (or <10%)"               red ">25% or rising"
//   green "≥50% independent; board 8–12" red "<50% / only meets bare minimum"
// We parse the comparison operators + numbers out of a band and compare a value
// against them DETERMINISTICALLY (no LLM), so numeric flags are reproducible and
// auditable. (Qualitative items are judged by an LLM instead — see flag.ts.)

export type Op = "lt" | "lte" | "gt" | "gte";

export interface Threshold {
  op: Op;
  value: number;
}

export interface ParsedBand {
  raw: string;
  thresholds: Threshold[];
  /** Informational: the unit the band is expressed in. */
  unit: "percent" | "ratio" | "number";
}

const OP_MAP: Record<string, Op> = {
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};

/**
 * Pull the first numeric value out of an extracted value string:
 *   "33%" -> 33 · "1.2x" -> 1.2 · "0.09 times" -> 0.09 · "72.36% (stable)" -> 72.36
 * Returns null when there is no number (e.g. "not available").
 */
export function parseNumericValue(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const m = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function detectUnit(raw: string): ParsedBand["unit"] {
  const s = raw.toLowerCase();
  if (s.includes("%") || s.includes("percent")) return "percent";
  if (
    s.includes("d/e") ||
    s.includes("ratio") ||
    s.includes("times") ||
    s.includes("multiple") ||
    /\bx\b/.test(s)
  ) {
    return "ratio";
  }
  return "number";
}

/** Normalise unicode comparators/dashes to ASCII so the matcher stays simple. */
function normalize(raw: string): string {
  return raw
    .replace(/≥/g, ">=") // ≥
    .replace(/≤/g, "<=") // ≤
    .replace(/[–—]/g, "-"); // – —
}

/**
 * Parse a band string into comparable thresholds.
 *
 * - A single `operator + number` maps directly (`>2` -> gt 2).
 * - A RANGE takes the bound that extends the analyst's stated zone: the UPPER
 *   bound under "<"/"≤" (`<0.5–1.0` -> value ≤ 1.0) and the LOWER bound under
 *   ">"/"≥".
 * - Bare numbers with no operator are ignored (e.g. the "0%" in "0% (or <10%)"
 *   and the "board 8–12" qualifier), because the operator-led number carries the
 *   comparison.
 */
export function parseBand(raw: string | null | undefined): ParsedBand {
  const text = (raw ?? "").trim();
  const unit = detectUnit(text);
  const thresholds: Threshold[] = [];
  if (!text) return { raw: text, thresholds, unit };

  const re = /(<=|>=|<|>)\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/g;
  const normalized = normalize(text);
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const op = OP_MAP[m[1]];
    const a = Number(m[2]);
    const b = m[3] != null ? Number(m[3]) : null;
    if (b != null) {
      if (op === "lt" || op === "lte") thresholds.push({ op: "lte", value: Math.max(a, b) });
      else thresholds.push({ op: "gte", value: Math.min(a, b) });
    } else {
      thresholds.push({ op, value: a });
    }
  }
  return { raw: text, thresholds, unit };
}

function satisfies(t: Threshold, v: number): boolean {
  if (t.op === "lt") return v < t.value;
  if (t.op === "lte") return v <= t.value;
  if (t.op === "gt") return v > t.value;
  return v >= t.value; // gte
}

/** A value is in a band iff it satisfies ALL of the band's thresholds. An empty band never matches. */
export function valueInBand(band: ParsedBand, v: number): boolean {
  return band.thresholds.length > 0 && band.thresholds.every((t) => satisfies(t, v));
}

export type NumericFlag = "GREEN" | "RED" | "NEUTRAL";

export interface NumericClassification {
  flag: NumericFlag;
  reason: string;
}

/**
 * Deterministically classify a numeric value against the green/red bands:
 *   in green only          -> GREEN
 *   in red only            -> RED
 *   in neither, or in both -> NEUTRAL (the "both" case is a band conflict to review)
 */
export function classifyNumeric(
  value: number,
  greenFlag?: string | null,
  redFlag?: string | null,
): NumericClassification {
  const green = parseBand(greenFlag);
  const red = parseBand(redFlag);
  const inGreen = valueInBand(green, value);
  const inRed = valueInBand(red, value);

  if (inGreen && !inRed) return { flag: "GREEN", reason: `${value} meets the green band "${green.raw}".` };
  if (inRed && !inGreen) return { flag: "RED", reason: `${value} meets the red band "${red.raw}".` };
  if (inGreen && inRed) {
    return {
      flag: "NEUTRAL",
      reason: `${value} matches both the green ("${green.raw}") and red ("${red.raw}") bands — needs review.`,
    };
  }
  return {
    flag: "NEUTRAL",
    reason: `${value} is between the green ("${green.raw || "n/a"}") and red ("${red.raw || "n/a"}") bands.`,
  };
}
