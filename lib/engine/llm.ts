import { llm, type LlmRole } from "@/lib/llm";
// Imported from its own module (not the barrel) so tests that mock "@/lib/llm"
// see the REAL openai — unconfigured in tests, it filters out and the chain is
// unchanged; in production it's prepended as the primary.
import { openai } from "@/lib/llm/openai";
import { recordProviderUsage } from "@/lib/usage";
import type { CompleteOpts, ProviderModule } from "@/lib/llm";
import {
  QuotaExhaustedError,
  ROLE_CHAINS,
  cooldownMs,
  cooldownRemaining,
  hasDailyQuota,
  inCooldown,
  maxWaitMs,
  recordRateLimit,
  recordSuccess,
} from "./quota";

function isRateLimit(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b429\b|rate.?limit|too many requests|quota/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Quota-aware, role-routed, schema-validated LLM call.
 *
 * Tries the role's preferred provider, falling back through the chain to any
 * provider that is configured AND under its daily cap AND not in a rate-limit
 * cooldown. A 429 puts that provider in a short cooldown (NOT a permanent retire)
 * so it returns to rotation once its per-minute window resets; when every
 * eligible provider is cooling down, the call WAITS out the soonest cooldown
 * (bounded by maxWaitMs) so the request succeeds within the run instead of
 * deferring. Records one unit of ProviderUsage per success.
 *
 * Throws QuotaExhaustedError when no provider can serve the call within the wait
 * budget (all over their daily cap, retired after repeated strikes, or
 * persistently rate-limited) — so the orchestrator DEFERS the item. A genuine
 * provider error (bad JSON, 5xx) is thrown as-is so the item is recorded ERROR.
 */
/** Options affecting which providers a call may use. */
export interface CallOptions {
  /** Exclude the paid primary (OpenAI) — used to get a genuine SECOND opinion
   *  from a different model when cross-checking a RED. */
  excludePrimary?: boolean;
}

/**
 * Ordered, de-duped, CONFIGURED provider chain for a role: OpenAI (the paid
 * primary) first when configured, then the role's free-provider fallback order.
 * A blank OPENAI_API_KEY drops OpenAI out, reverting to the pure free-tier chain.
 * `excludePrimary` omits OpenAI so a cross-check runs on a different model.
 */
export function providerChain(role: LlmRole, opts: CallOptions = {}): ProviderModule[] {
  const seen = new Set<string>();
  const primary = opts.excludePrimary ? [] : [openai];
  return [...primary, ...ROLE_CHAINS[role].map((r) => llm[r])].filter((c) => {
    if (!c || seen.has(c.id)) return false;
    seen.add(c.id);
    return c.isConfigured();
  });
}

export async function callJSON<T>(
  role: LlmRole,
  opts: CompleteOpts,
  schema: object,
  callOpts: CallOptions = {},
): Promise<{ data: T; provider: string }> {
  const chain = providerChain(role, callOpts);
  if (chain.length === 0) {
    throw new QuotaExhaustedError(`no LLM provider configured for role "${role}"`);
  }

  let waited = 0;
  for (;;) {
    const eligible = [];
    for (const c of chain) if (await hasDailyQuota(c.id)) eligible.push(c);
    if (eligible.length === 0) {
      throw new QuotaExhaustedError(`all LLM providers exhausted for role "${role}"`);
    }

    const now = Date.now();
    const ready = eligible.filter((c) => !inCooldown(c.id, now));

    if (ready.length === 0) {
      // Everything is cooling down — wait out the soonest, within the budget.
      const soonest = Math.min(...eligible.map((c) => cooldownRemaining(c.id, now)));
      const wait = Math.max(1, Math.min(soonest, cooldownMs()));
      if (waited + wait > maxWaitMs()) {
        throw new QuotaExhaustedError(`all providers rate-limited for role "${role}"; deferring`);
      }
      await sleep(wait);
      waited += wait;
      continue;
    }

    let lastError: unknown;
    let sawNonRateLimit = false;
    for (const client of ready) {
      try {
        const data = await client.completeJSON<T>(opts, schema);
        recordSuccess(client.id);
        await recordProviderUsage(client.id);
        return { data, provider: client.id };
      } catch (e) {
        lastError = e;
        if (isRateLimit(e)) recordRateLimit(client.id, Date.now());
        else sawNonRateLimit = true;
      }
    }

    // A genuine (non-rate-limit) error is an item error, not a quota defer.
    if (sawNonRateLimit) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    // Otherwise every ready provider just rate-limited → loop; they're cooling now.
  }
}
