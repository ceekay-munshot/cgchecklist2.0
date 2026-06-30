import { describe, it, expect, afterEach } from "vitest";
import { llm, llmProviders, openai } from "./index";
import { capFor, DEFAULT_DAILY_CAPS } from "@/lib/engine/quota";

describe("OpenAI provider wiring", () => {
  const prev = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  });

  it("is registered for /health and exposes the LlmClient surface", () => {
    expect(llmProviders.openai).toBe(openai);
    expect(openai.id).toBe("openai");
    expect(typeof openai.completeJSON).toBe("function");
  });

  it("is the PRIMARY for every extraction/judgment role", () => {
    expect(llm.longContext.id).toBe("openai");
    expect(llm.bulkClassify.id).toBe("openai");
    expect(llm.reasoning.id).toBe("openai");
    // safety-net role stays on a free provider so a missing key can fall back
    expect(llm.fallback.id).not.toBe("openai");
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
});
