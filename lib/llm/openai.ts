import { createOpenAICompatibleProvider } from "./openai-compatible";

/**
 * OpenAI provider (paid). Used as the PRIMARY for every analysis role so a run
 * is served by one reliable, high-quota model instead of starving on free-tier
 * per-minute limits (which made extraction degrade to NOT_AVAILABLE). It speaks
 * the standard Chat Completions API, so the shared OpenAI-compatible factory
 * covers it — key/model are read from env at call time.
 *
 * Default model is a strong general chat model that supports `temperature` +
 * JSON `response_format`. Override with OPENAI_MODEL (e.g. a newer flagship)
 * — but note the o-series *reasoning* models reject those params and would need
 * the factory adjusted, so keep OPENAI_MODEL on a gpt-4o / gpt-4.1-class model.
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
