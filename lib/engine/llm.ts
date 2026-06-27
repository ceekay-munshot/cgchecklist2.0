import { llm, type LlmRole } from "@/lib/llm";
import { recordProviderUsage } from "@/lib/usage";
import type { CompleteOpts } from "@/lib/llm";
import { QuotaExhaustedError, ROLE_CHAINS, hasQuota, markExhausted } from "./quota";

const MAX_RATELIMIT_RETRIES = 2;

function isRateLimit(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b429\b|rate.?limit|too many requests|quota/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  // Base delay is read at call time so tests can shrink it (LLM_BACKOFF_MS).
  let delay = Number(process.env.LLM_BACKOFF_MS) || 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimit(e) || attempt >= MAX_RATELIMIT_RETRIES) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
}

/**
 * Quota-aware, role-routed, schema-validated LLM call.
 *
 * Tries the role's preferred provider, falling back through the chain to any
 * provider that is configured AND under its daily free-tier cap. Records one
 * unit of ProviderUsage per successful call; retries 429s with exponential
 * backoff, then marks the provider exhausted and falls back.
 *
 * Throws QuotaExhaustedError when NO provider can serve the call (all exhausted
 * / rate-limited / unconfigured) so the orchestrator can DEFER. A genuine
 * provider error (bad JSON, 5xx) is thrown as-is so the item is recorded ERROR.
 */
export async function callJSON<T>(
  role: LlmRole,
  opts: CompleteOpts,
  schema: object,
): Promise<{ data: T; provider: string }> {
  const seen = new Set<string>();
  const candidates = ROLE_CHAINS[role]
    .map((r) => llm[r])
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return c.isConfigured();
    });

  const usable: typeof candidates = [];
  for (const c of candidates) {
    if (await hasQuota(c.id)) usable.push(c);
  }
  if (usable.length === 0) {
    throw new QuotaExhaustedError(
      `no LLM provider available for role "${role}" (all exhausted or unconfigured)`,
    );
  }

  let lastError: unknown;
  let allRateLimited = true;
  for (const client of usable) {
    try {
      const data = await withBackoff(() => client.completeJSON<T>(opts, schema));
      await recordProviderUsage(client.id);
      return { data, provider: client.id };
    } catch (e) {
      lastError = e;
      if (isRateLimit(e)) markExhausted(client.id);
      else allRateLimited = false;
    }
  }

  if (allRateLimited) {
    throw new QuotaExhaustedError(
      `all available providers rate-limited for role "${role}": ${(lastError as Error)?.message ?? "unknown"}`,
    );
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
