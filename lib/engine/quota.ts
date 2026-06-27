import { getProviderUsage } from "@/lib/usage";
import type { LlmRole } from "@/lib/llm";

/**
 * Free-tier quota gating for analysis LLM calls.
 *
 * Two independent limits are modelled:
 *  - DAILY cap (per-provider request/day, from ProviderUsage) — a hard ceiling
 *    that does not reset within a run.
 *  - Transient RATE LIMITS (per-minute 429s) — handled with a short COOLDOWN so
 *    the provider is skipped briefly and then comes back, instead of being
 *    retired for the whole run. A provider is only retired ("dead") after
 *    repeated strikes (which usually means a real daily/hard cap the counter
 *    didn't catch).
 *
 * All knobs are env-overridable (and shrunk in tests):
 *   LLM_DAILY_CAP / <PROVIDER>_DAILY_CAP   daily request caps
 *   LLM_COOLDOWN_MS                        how long a 429'd provider is skipped
 *   LLM_MAX_WAIT_MS                        max a single call waits out cooldowns before deferring
 *   LLM_MAX_STRIKES                        consecutive 429s before a provider is retired
 */

export const DEFAULT_DAILY_CAPS: Record<string, number> = {
  groq: 900,
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

/** Per-role provider preference, each falling back to the others. */
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

export function cooldownMs(): number {
  return Number(process.env.LLM_COOLDOWN_MS) || 60_000;
}
export function maxWaitMs(): number {
  return Number(process.env.LLM_MAX_WAIT_MS) || 75_000;
}
export function maxStrikes(): number {
  return Number(process.env.LLM_MAX_STRIKES) || 4;
}

// In-process state for this run.
const cooldownUntil = new Map<string, number>(); // provider -> epoch ms it's usable again
const strikes = new Map<string, number>(); // consecutive 429s
const dead = new Set<string>(); // retired for the rest of the process

/** Reset all in-process quota state (used by tests). */
export function resetQuotaState(): void {
  cooldownUntil.clear();
  strikes.clear();
  dead.clear();
}

export function isDead(provider: string): boolean {
  return dead.has(provider);
}

export function cooldownRemaining(provider: string, now: number): number {
  return Math.max(0, (cooldownUntil.get(provider) ?? 0) - now);
}

export function inCooldown(provider: string, now: number): boolean {
  return cooldownRemaining(provider, now) > 0;
}

/**
 * Record a rate-limit (429) strike. Puts the provider in cooldown; if it has now
 * struck out (likely a real daily/hard cap), retires it. Returns true if dead.
 */
export function recordRateLimit(provider: string, now: number): boolean {
  const n = (strikes.get(provider) ?? 0) + 1;
  strikes.set(provider, n);
  if (n >= maxStrikes()) {
    dead.add(provider);
    return true;
  }
  cooldownUntil.set(provider, now + cooldownMs());
  return false;
}

/** A successful call clears the provider's strike/cooldown state. */
export function recordSuccess(provider: string): void {
  strikes.set(provider, 0);
  cooldownUntil.delete(provider);
}

/** Daily free-tier headroom (a hard ceiling that does not reset within a run). */
export async function hasDailyQuota(provider: string): Promise<boolean> {
  if (dead.has(provider)) return false;
  const usage = await getProviderUsage(provider);
  return (usage?.requests ?? 0) < capFor(provider);
}
