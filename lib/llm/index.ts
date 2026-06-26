import type { ProviderModule } from "./types";
import { gemini } from "./gemini";
import { groq } from "./groq";
import { mistral } from "./mistral";
import { nvidia } from "./nvidia";

export * from "./types";
export { completeJSONWith, extractJson, JSON_MAX_RETRIES } from "./json";
export { createOpenAICompatibleProvider } from "./openai-compatible";
export { gemini, groq, mistral, nvidia };

/** Every LLM provider module, keyed by id (used by /health). */
export const llmProviders: Record<string, ProviderModule> = {
  gemini,
  groq,
  mistral,
  nvidia,
};

/**
 * Provider routing (see PROJECT_BRIEF.md "Provider routing"):
 *   longContext  -> Gemini  (annual reports, auditor notes)
 *   bulkClassify -> Groq    (fast/cheap across many items)
 *   reasoning    -> Mistral (qualitative reasoning + tie-breaks)
 *   fallback     -> Nvidia  (fallback capacity)
 *
 * Engine/orchestration code should pick a model by ROLE, not by name, so the
 * routing table can change in one place.
 */
export const llm = {
  longContext: gemini,
  bulkClassify: groq,
  reasoning: mistral,
  fallback: nvidia,
} satisfies Record<string, ProviderModule>;

export type LlmRole = keyof typeof llm;
