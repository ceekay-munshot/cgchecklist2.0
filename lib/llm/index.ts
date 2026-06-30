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
 * Per-ROLE provider table (see PROJECT_BRIEF.md "Provider routing"). These four
 * stay DISTINCT so the fallback chain spans every provider:
 *   longContext  -> Gemini   bulkClassify -> Groq
 *   reasoning    -> Mistral   fallback     -> Nvidia
 *
 * OpenAI (paid) is the PRIMARY but is NOT placed in this table — overloading
 * multiple roles onto one provider collapses the de-duped fallback chain (it cut
 * Groq/Gemini out of rotation entirely). Instead, `lib/engine/llm.ts` PREPENDS
 * OpenAI to every role's chain when it is configured, so a run is served by the
 * reliable paid model first and still falls through to ALL of Gemini/Groq/
 * Mistral/Nvidia if OpenAI errors or is unconfigured. Pick a model by ROLE.
 */
export const llm = {
  longContext: gemini,
  bulkClassify: groq,
  reasoning: mistral,
  fallback: nvidia,
} satisfies Record<string, ProviderModule>;

export type LlmRole = keyof typeof llm;
