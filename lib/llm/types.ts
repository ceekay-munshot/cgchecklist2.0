import type { ProviderStatus } from "@/lib/health-types";

/** Options accepted by every LLM call. */
export interface CompleteOpts {
  /** The user prompt. */
  prompt: string;
  /** Optional system instruction. */
  system?: string;
  /** Model override; each provider has a sensible default. */
  model?: string;
  /** Sampling temperature (default 0.2). */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /**
   * Hint that the provider should return JSON. Set automatically by
   * `completeJSON`; you normally don't pass this yourself.
   */
  json?: boolean;
}

export interface CompleteResult {
  text: string;
}

/**
 * The single typed interface every provider client implements.
 *   - complete: free-form text
 *   - completeJSON: structured output validated against a JSON Schema
 */
export interface LlmClient {
  complete(opts: CompleteOpts): Promise<CompleteResult>;
  completeJSON<T>(opts: CompleteOpts, schema: object): Promise<T>;
}

/**
 * A provider module = an LlmClient plus metadata and a health check. Each file
 * in lib/llm exports one of these.
 */
export interface ProviderModule extends LlmClient {
  readonly id: string;
  /** True when the provider's API key env var is set. */
  isConfigured(): boolean;
  /** Cheap authenticated health check used by /health. */
  ping(): Promise<ProviderStatus>;
}

export class LlmError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "LlmError";
  }
}

export class LlmJsonError extends LlmError {
  constructor(
    provider: string,
    message: string,
    public readonly attempts: number,
    public readonly lastText?: string,
  ) {
    super(provider, message);
    this.name = "LlmJsonError";
  }
}
