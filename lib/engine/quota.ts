import { getProviderUsage } from "@/lib/usage";
import type { LlmRole } from "@/lib/llm";

/**
 * Free-tier daily quota gating for analysis LLM calls.
 *
 * One config, sensible defaults, overridable via env (handy for forcing a low
 * cap in tests / a constrained day):
 *   LLM_DAILY_CAP=<n>            global cap for every provider
 *   <PROVIDER>_DAILY_CAP=<n>     per-provider cap (e.g. GROQ_DAILY_CAP)
 *
 * Caps are intentionally conservative request/day numbers; the real ceiling is
 * the provider's own 429, which the caller treats as exhaustion.
 */
export const DEFAULT_DAILY_CAPS: Record<string, number> = {
  groq: 900, // generous free tier
  mistral: 500,
  gemini: 1400,
  nvidia: 400,
};

const FALLBACK_CAP = 300;

/** Thrown when NO LLM provider can serve a call (all exhausted / unconfigured). */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

/**
 * Per-role provider preference, each falling back to the others. Any provider
 * can serve any role (all implement completeJSON); the head is the preferred one.
 */
export const ROLE_CHAINS: Record<LlmRole, LlmRole[]> = {
  bulkClassify: ["bulkClassify", "reasoning", "fallback", "longContext"],
  reasoning: ["reasoning", "bulkClassify", "fallback", "longContext"],
  longContext: ["longContext", "reasoning", "bulkClassify", "fallback"],
  fallback: ["fallback", "bulkClassify", "reasoning", "longContext"],
};

export function capFor(provider: string): number {
  const perProvider = process.env[`${provider.toUpperCase()}_DAILY_CAP`];
  if (perProvider != null && perProvider !== "") return Number(perProvider);
  const global = process.env.LLM_DAILY_CAP;
  if (global != null && global !== "") return Number(global);
  return DEFAULT_DAILY_CAPS[provider] ?? FALLBACK_CAP;
}

// In-process cache of providers known exhausted this run (cap reached, or a
// persistent 429). Avoids re-hitting the DB once we know a provider is out.
const exhausted = new Set<string>();

export function markExhausted(provider: string): void {
  exhausted.add(provider);
}

/** Reset the in-process exhaustion cache (used by tests). */
export function resetQuotaState(): void {
  exhausted.clear();
}

/** True if the provider still has free-tier headroom today. */
export async function hasQuota(provider: string): Promise<boolean> {
  if (exhausted.has(provider)) return false;
  const usage = await getProviderUsage(provider);
  const used = usage?.requests ?? 0;
  if (used >= capFor(provider)) {
    exhausted.add(provider);
    return false;
  }
  return true;
}
