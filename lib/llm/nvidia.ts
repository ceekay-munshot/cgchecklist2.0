import { createOpenAICompatibleProvider } from "./openai-compatible";

/** Nvidia NIM — fallback capacity (OpenAI-compatible endpoint). */
export const nvidia = createOpenAICompatibleProvider({
  id: "nvidia",
  label: "Nvidia NIM",
  role: "Fallback capacity",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  defaultModel: "meta/llama-3.1-70b-instruct",
  apiKeyEnv: "NVIDIA_API_KEY",
  modelEnv: "NVIDIA_MODEL",
});

export default nvidia;
