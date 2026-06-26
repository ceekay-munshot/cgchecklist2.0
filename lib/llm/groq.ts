import { createOpenAICompatibleProvider } from "./openai-compatible";

/** Groq — fast/cheap bulk classification across many checklist items. */
export const groq = createOpenAICompatibleProvider({
  id: "groq",
  label: "Groq",
  role: "Fast/cheap bulk classification across many checklist items",
  baseUrl: "https://api.groq.com/openai/v1",
  defaultModel: "llama-3.3-70b-versatile",
  apiKeyEnv: "GROQ_API_KEY",
  modelEnv: "GROQ_MODEL",
});

export default groq;
