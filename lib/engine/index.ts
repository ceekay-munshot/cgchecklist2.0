import type { LlmRole } from "@/lib/llm";

/** The four flags every checklist item resolves to. Mirrors the Prisma `Flag` enum. */
export type Flag = "GREEN" | "RED" | "NEUTRAL" | "NOT_AVAILABLE";

export interface ChecklistItemInput {
  code: string;
  category: string;
  title: string;
  description?: string;
  /** SEBI LODR clause / Ind AS reference. */
  regReference?: string;
  /** How to evaluate (what is green vs red). */
  guidance?: string;
}

export interface EvaluationInput {
  item: ChecklistItemInput;
  /** Relevant source text extracted during ingestion. */
  context: string;
}

export interface Evaluation {
  flag: Flag;
  /** One-liner verdict. */
  verdict: string;
  /** Supporting evidence / quotes. */
  evidence?: string;
  /** Citation: document + page / url. */
  source?: string;
  /** Which provider produced this result. */
  provider?: string;
}

/**
 * Evaluate a single checklist item against source context and return a
 * flag-based result. There is intentionally NO numeric scoring.
 *
 * TODO: implement using the role-routed LLM clients (see `lib/llm`). Bulk items
 * go through `llm.bulkClassify` (Groq); ambiguous items escalate to
 * `llm.reasoning` (Mistral) as a tie-break.
 */
export async function evaluateItem(
  input: EvaluationInput,
  role: LlmRole = "bulkClassify",
): Promise<Evaluation> {
  throw new Error(
    `evaluateItem(${input.item.code}) via role "${role}" — not implemented yet`,
  );
}
