import { createOpenAICompatibleProvider } from "./openai-compatible";

/**
 * OpenAI provider (paid). Used as the PRIMARY for every analysis role so a run
 * is served by one reliable, high-quota model instead of starving on free-tier
 * per-minute limits (which made extraction degrade to NOT_AVAILABLE). It speaks
 * the standard Chat Completions API, so the shared OpenAI-compatible factory
 * covers it — key/model are read from env at call time.
 *
 * Default model is a strong general chat model. Override with OPENAI_MODEL.
 * If a chosen model rejects the `temperature` / `max_tokens` / JSON
 * `response_format` params the shared factory sends, the LLM preflight in
 * analyze-run surfaces the error (and the free-provider fallback still serves),
 * so a bad model id/param is loud rather than a silent all-NA run.
 */
export const openai = createOpenAICompatibleProvider({
  id: "openai",
  label: "OpenAI",
  role: "primary (analysis extraction + judgment)",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4o",
  apiKeyEnv: "OPENAI_API_KEY",
  modelEnv: "OPENAI_MODEL",
});
