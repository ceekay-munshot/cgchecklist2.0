import type { ProviderModule } from "./types";
import { gemini } from "./gemini";
import { groq } from "./groq";
import { mistral } from "./mistral";
import { nvidia } from "./nvidia";
import { openai } from "./openai";

export * from "./types";
export { completeJSONWith, extractJson, JSON_MAX_RETRIES } from "./json";
export { createOpenAICompatibleProvider } from "./openai-compatible";
export { gemini, groq, mistral, nvidia, openai };

/** Every LLM provider module, keyed by id (used by /health). */
export const llmProviders: Record<string, ProviderModule> = {
  openai,
  gemini,
  groq,
  mistral,
  nvidia,
};

/**
 * Provider routing (see PROJECT_BRIEF.md "Provider routing").
 *
 * OpenAI (paid) is the PRIMARY for every role: a run is served by one reliable,
 * high-quota model instead of starving on free-tier per-minute limits — which is
 * what made extraction degrade to NOT_AVAILABLE on real runs. The free providers
 * stay wired as a SAFETY NET: `callJSON` falls back through the role chain to any
 * other CONFIGURED provider if OpenAI errors, so a missing/blank OPENAI_API_KEY
 * (isConfigured() === false) transparently reverts to the old Gemini/Groq/Mistral/
 * Nvidia routing.
 *
 * Engine/orchestration code picks a model by ROLE, not by name, so the table
 * changes in one place.
 */
export const llm = {
  longContext: openai, // long-context document/note reading (was Gemini)
  bulkClassify: openai, // structured extraction across items (was Groq)
  reasoning: openai, // qualitative judgment + tie-breaks (was Mistral)
  fallback: mistral, // safety-net role kept on a free provider
} satisfies Record<string, ProviderModule>;

export type LlmRole = keyof typeof llm;
