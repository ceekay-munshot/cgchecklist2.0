import { createOpenAICompatibleProvider } from "./openai-compatible";

/** Mistral — qualitative reasoning + tie-breaks. */
export const mistral = createOpenAICompatibleProvider({
  id: "mistral",
  label: "Mistral",
  role: "Qualitative reasoning + tie-breaks",
  baseUrl: "https://api.mistral.ai/v1",
  defaultModel: "mistral-large-latest",
  apiKeyEnv: "MISTRAL_API_KEY",
  modelEnv: "MISTRAL_MODEL",
});

export default mistral;
