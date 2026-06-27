import { llm, type LlmRole } from "@/lib/llm";
import { recordProviderUsage } from "@/lib/usage";
import type { CompleteOpts } from "@/lib/llm";

/**
 * Role-routed, schema-validated LLM call for the engine. Wraps the provider's
 * `completeJSON` (JSON-schema validated, 2 retries) and records one unit of
 * ProviderUsage for free-tier quota tracking. Returns the data + provider id.
 */
export async function callJSON<T>(
  role: LlmRole,
  opts: CompleteOpts,
  schema: object,
): Promise<{ data: T; provider: string }> {
  const client = llm[role];
  const data = await client.completeJSON<T>(opts, schema);
  await recordProviderUsage(client.id);
  return { data, provider: client.id };
}
