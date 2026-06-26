import type { CompleteOpts, CompleteResult, ProviderModule } from "./types";
import { LlmError } from "./types";
import { completeJSONWith } from "./json";
import {
  type ProviderStatus,
  interpretHttpPing,
} from "@/lib/health-types";

const PING_TIMEOUT_MS = 12_000;
const COMPLETE_TIMEOUT_MS = 60_000;

export interface OpenAICompatibleConfig {
  id: string;
  label: string;
  /** Routing role text shown on /health. */
  role: string;
  /** Base URL up to and including the API version, e.g. ".../openai/v1". */
  baseUrl: string;
  defaultModel: string;
  apiKeyEnv: string;
  modelEnv?: string;
}

/**
 * Build a ProviderModule for any OpenAI-compatible Chat Completions API
 * (Groq, Mistral, Nvidia NIM). Reads its key/model from env at call time so a
 * key added after boot is picked up without a restart.
 */
export function createOpenAICompatibleProvider(
  cfg: OpenAICompatibleConfig,
): ProviderModule {
  const apiKey = () => process.env[cfg.apiKeyEnv]?.trim() ?? "";
  const resolveModel = (override?: string) =>
    override ||
    (cfg.modelEnv ? process.env[cfg.modelEnv]?.trim() : undefined) ||
    cfg.defaultModel;

  async function complete(opts: CompleteOpts): Promise<CompleteResult> {
    const key = apiKey();
    if (!key) throw new LlmError(cfg.id, `${cfg.apiKeyEnv} is not set`);

    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: opts.prompt });

    const body: Record<string, unknown> = {
      model: resolveModel(opts.model),
      messages,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.json) body.response_format = { type: "json_object" };

    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
      });
    } catch (e) {
      throw new LlmError(cfg.id, `request failed: ${(e as Error).message}`, e);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new LlmError(cfg.id, `HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return { text: data.choices?.[0]?.message?.content ?? "" };
  }

  function completeJSON<T>(opts: CompleteOpts, schema: object): Promise<T> {
    return completeJSONWith<T>(cfg.id, complete, opts, schema);
  }

  function isConfigured(): boolean {
    return apiKey().length > 0;
  }

  async function ping(): Promise<ProviderStatus> {
    const base = {
      id: cfg.id,
      label: cfg.label,
      category: "llm",
      role: cfg.role,
      checkedAt: new Date().toISOString(),
    } satisfies Omit<ProviderStatus, "state">;

    const key = apiKey();
    if (!key) {
      return { ...base, state: "not_configured", message: `${cfg.apiKeyEnv} not set` };
    }

    const started = Date.now();
    try {
      const res = await fetch(`${cfg.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      return interpretHttpPing(
        { ...base, latencyMs: Date.now() - started },
        res.status,
        res.ok,
      );
    } catch (e) {
      return { ...base, state: "red", message: `unreachable: ${(e as Error).message}` };
    }
  }

  return { id: cfg.id, complete, completeJSON, isConfigured, ping };
}
