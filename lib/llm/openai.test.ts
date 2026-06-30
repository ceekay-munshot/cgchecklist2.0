import { describe, it, expect, afterEach } from "vitest";
import { llmProviders, openai } from "./index";
import { providerChain } from "@/lib/engine/llm";
import { capFor, DEFAULT_DAILY_CAPS } from "@/lib/engine/quota";

const LLM_KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "NVIDIA_API_KEY"] as const;

describe("OpenAI provider wiring", () => {
  const prev = Object.fromEntries(LLM_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of LLM_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it("is registered for /health and exposes the LlmClient surface", () => {
    expect(llmProviders.openai).toBe(openai);
    expect(openai.id).toBe("openai");
    expect(typeof openai.completeJSON).toBe("function");
  });

  it("reads OPENAI_API_KEY at call time (configured iff the key is set)", () => {
    process.env.OPENAI_API_KEY = "";
    expect(openai.isConfigured()).toBe(false);
    process.env.OPENAI_API_KEY = "sk-test";
    expect(openai.isConfigured()).toBe(true);
  });

  it("has a high daily cap so the free-tier gate doesn't throttle the paid key", () => {
    expect(DEFAULT_DAILY_CAPS.openai).toBeGreaterThanOrEqual(100_000);
    expect(capFor("openai")).toBeGreaterThanOrEqual(100_000);
  });

  it("is the PRIMARY in the chain but keeps ALL free providers as fallback", () => {
    for (const k of LLM_KEYS) process.env[k] = "x"; // configure everything
    const chain = providerChain("reasoning").map((p) => p.id);
    expect(chain[0]).toBe("openai"); // primary first
    // the chain-collapse bug is fixed: every free provider is still reachable
    expect(chain).toEqual(expect.arrayContaining(["openai", "mistral", "groq", "nvidia", "gemini"]));
  });

  it("falls back to the pure free-tier chain when OPENAI_API_KEY is blank", () => {
    for (const k of LLM_KEYS) process.env[k] = "x";
    process.env.OPENAI_API_KEY = "";
    expect(providerChain("reasoning").map((p) => p.id)).not.toContain("openai");
  });
});
