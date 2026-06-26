import type { CompleteOpts, CompleteResult, ProviderModule } from "./types";
import { LlmError } from "./types";
import { completeJSONWith } from "./json";
import {
  type ProviderStatus,
  interpretHttpPing,
} from "@/lib/health-types";

// Native Google Generative Language API (not the OpenAI-compatible shim) so we
// keep full access to Gemini's long-context document features.
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.0-flash";
const PING_TIMEOUT_MS = 12_000;
const COMPLETE_TIMEOUT_MS = 120_000; // long-context reads can be slow

const apiKey = () => process.env.GEMINI_API_KEY?.trim() ?? "";
const resolveModel = (override?: string) =>
  override || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

async function complete(opts: CompleteOpts): Promise<CompleteResult> {
  const key = apiKey();
  if (!key) throw new LlmError("gemini", "GEMINI_API_KEY is not set");

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.maxTokens) generationConfig.maxOutputTokens = opts.maxTokens;
  if (opts.json) generationConfig.responseMimeType = "application/json";

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig,
  };
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }

  const url =
    `${GEMINI_BASE}/models/${encodeURIComponent(resolveModel(opts.model))}` +
    `:generateContent?key=${encodeURIComponent(key)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new LlmError("gemini", `request failed: ${(e as Error).message}`, e);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LlmError("gemini", `HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";
  return { text };
}

function completeJSON<T>(opts: CompleteOpts, schema: object): Promise<T> {
  return completeJSONWith<T>("gemini", complete, opts, schema);
}

function isConfigured(): boolean {
  return apiKey().length > 0;
}

async function ping(): Promise<ProviderStatus> {
  const base = {
    id: "gemini",
    label: "Gemini",
    category: "llm",
    role: "Long-context document reading (annual reports, auditor notes)",
    checkedAt: new Date().toISOString(),
  } satisfies Omit<ProviderStatus, "state">;

  const key = apiKey();
  if (!key) {
    return { ...base, state: "not_configured", message: "GEMINI_API_KEY not set" };
  }

  const started = Date.now();
  try {
    const res = await fetch(`${GEMINI_BASE}/models?key=${encodeURIComponent(key)}`, {
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

export const gemini: ProviderModule = {
  id: "gemini",
  complete,
  completeJSON,
  isConfigured,
  ping,
};

export default gemini;
