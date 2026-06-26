// Shared health/status types used by the LLM and scrape providers and by the
// /health page + /api/health route. Kept dependency-free to avoid import cycles.

export type HealthState = "green" | "red" | "not_configured";

export type ProviderCategory = "llm" | "scrape" | "database";

export interface ProviderStatus {
  /** Stable id, e.g. "gemini". */
  id: string;
  /** Human label, e.g. "Gemini". */
  label: string;
  category: ProviderCategory;
  /** What this provider is used for (from the routing table). */
  role: string;
  state: HealthState;
  /** Round-trip latency of the health check, when one was performed. */
  latencyMs?: number;
  /** Short human-readable detail (ok / error / status code). */
  message?: string;
  /** ISO timestamp of when the check ran. */
  checkedAt: string;
}

/**
 * Map an HTTP ping response onto a ProviderStatus. A 2xx is green; an
 * auth-class status (401/402/403/407) is a red "authentication failed"; any
 * other status is red with the code. `base` should already carry latencyMs.
 */
export function interpretHttpPing(
  base: Omit<ProviderStatus, "state">,
  status: number,
  ok: boolean,
): ProviderStatus {
  if (ok) {
    return { ...base, state: "green", message: `ok (HTTP ${status})` };
  }
  if ([401, 402, 403, 407].includes(status)) {
    return {
      ...base,
      state: "red",
      message: `authentication failed (HTTP ${status})`,
    };
  }
  return { ...base, state: "red", message: `HTTP ${status}` };
}
