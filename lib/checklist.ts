import fs from "node:fs";
import path from "node:path";

// Typed view over data/checklist.json (the 106-item CG framework, 16 sections).
// The JSON keeps snake_case keys; we expose them as-is here and map to the
// Prisma camelCase columns in prisma/seed.ts.

export interface ChecklistItemJson {
  id: string;
  item: string;
  description?: string;
  output_format?: string;
  green_flag?: string;
  red_flag?: string;
  source_hint?: string;
  is_non_negotiable?: boolean;
  threshold_logic?: string;
}

export interface ChecklistSectionJson {
  code: string;
  name: string;
  items: ChecklistItemJson[];
}

export interface ChecklistFileJson {
  title?: string;
  meta?: unknown;
  sections: ChecklistSectionJson[];
}

export type ItemKind = "NUMERIC" | "QUALITATIVE";

const CHECKLIST_PATH = path.join(process.cwd(), "data", "checklist.json");

let cache: ChecklistFileJson | null = null;

function load(): ChecklistFileJson {
  if (cache) return cache;
  if (!fs.existsSync(CHECKLIST_PATH)) {
    throw new Error(
      `data/checklist.json not found at ${CHECKLIST_PATH}. ` +
        "Add the 106-item checklist file (see PROJECT_BRIEF.md §9).",
    );
  }
  cache = JSON.parse(fs.readFileSync(CHECKLIST_PATH, "utf8")) as ChecklistFileJson;
  return cache;
}

/** The 16 section-blocks, in file order. */
export function getSections(): ChecklistSectionJson[] {
  return load().sections;
}

/** All 106 items, flattened across sections, in file order. */
export function getItems(): ChecklistItemJson[] {
  return load().sections.flatMap((section) => section.items);
}

/** Look up a single item by its id (e.g. "A1-01"). */
export function getItem(id: string): ChecklistItemJson | undefined {
  return getItems().find((item) => item.id === id);
}

// Checked before the numeric hints so explicit Yes/No, Text and Categorical
// formats are treated as judgment items even if they mention a number.
const QUALITATIVE_HINTS = [
  "text",
  "categor", // categorical / category
  "yes/no",
  "yes / no",
  "yes-no",
  "boolean",
  "narrative",
  "descript", // descriptive / description
  "qualitative",
  "commentary",
  "free text",
  "free-text",
];

const NUMERIC_HINTS = [
  "%",
  "percent",
  "ratio",
  "₹",
  "rs.",
  "rs ",
  "inr",
  "rupee",
  "crore",
  "lakh",
  "count",
  "number",
  "numeric",
  "integer",
  "amount",
  "d/e",
  "d:e",
  "debt-to-equity",
  "debt to equity",
  "times",
  "days",
  "bps",
  "basis point",
  "decimal",
  "multiple",
];

/**
 * Classify an item by its output format:
 *   NUMERIC     = %, ₹, ratio, count, D/E (comparable bands), etc.
 *   QUALITATIVE = Text / Categorical / Yes-No judgment (also the default).
 */
export function itemKind(item: { output_format?: string | null }): ItemKind {
  const fmt = (item.output_format ?? "").toLowerCase();
  if (!fmt) return "QUALITATIVE";
  if (QUALITATIVE_HINTS.some((hint) => fmt.includes(hint))) return "QUALITATIVE";
  if (NUMERIC_HINTS.some((hint) => fmt.includes(hint))) return "NUMERIC";
  return "QUALITATIVE";
}
