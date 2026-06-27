import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("@/lib/usage", () => ({
  recordProviderUsage: vi.fn(),
  getProviderUsage: vi.fn(),
}));
vi.mock("@/lib/llm", () => {
  const mk = (id: string) => ({
    id,
    complete: vi.fn(),
    completeJSON: vi.fn(),
    isConfigured: () => true,
  });
  return {
    llm: { bulkClassify: mk("groq"), reasoning: mk("mistral"), longContext: mk("gemini"), fallback: mk("nvidia") },
  };
});

import { callJSON } from "./llm";
import { QuotaExhaustedError, resetQuotaState, capFor } from "./quota";
import { llm } from "@/lib/llm";
import { getProviderUsage, recordProviderUsage } from "@/lib/usage";

const asMock = (fn: unknown) => fn as unknown as Mock;

function usage(map: Record<string, number>) {
  asMock(getProviderUsage).mockImplementation(async (p: string) => ({ requests: map[p] ?? 0 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQuotaState();
  process.env.LLM_DAILY_CAP = "5"; // low cap → deterministic exhaustion
  process.env.LLM_BACKOFF_MS = "1"; // keep 429 backoff fast
});
afterEach(() => {
  delete process.env.LLM_DAILY_CAP;
  delete process.env.LLM_BACKOFF_MS;
  delete process.env.GROQ_DAILY_CAP;
});

describe("callJSON — quota gating + fallback", () => {
  it("uses the role's preferred provider when it has quota", async () => {
    usage({});
    asMock(llm.bulkClassify.completeJSON).mockResolvedValueOnce({ ok: true });
    const r = await callJSON("bulkClassify", { prompt: "x" }, {});
    expect(r.provider).toBe("groq");
    expect(asMock(recordProviderUsage)).toHaveBeenCalledWith("groq");
  });

  it("falls back to the next provider when the preferred is exhausted", async () => {
    usage({ groq: 5 }); // groq at cap, mistral has room
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ ok: true });
    const r = await callJSON("bulkClassify", { prompt: "x" }, {});
    expect(r.provider).toBe("mistral");
    expect(asMock(llm.bulkClassify.completeJSON)).not.toHaveBeenCalled();
  });

  it("throws QuotaExhaustedError when ALL providers are exhausted", async () => {
    usage({ groq: 5, mistral: 5, gemini: 5, nvidia: 5 });
    await expect(callJSON("bulkClassify", { prompt: "x" }, {})).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(asMock(llm.bulkClassify.completeJSON)).not.toHaveBeenCalled();
  });

  it("treats a persistent 429 as exhaustion and falls back to the next provider", async () => {
    usage({});
    asMock(llm.bulkClassify.completeJSON).mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ ok: true });
    const r = await callJSON("bulkClassify", { prompt: "x" }, {});
    expect(r.provider).toBe("mistral");
  });

  it("re-throws a genuine (non-rate-limit) provider error as an item error", async () => {
    usage({ groq: 5, gemini: 5, nvidia: 5 }); // only mistral usable
    asMock(llm.reasoning.completeJSON).mockRejectedValue(new Error("invalid JSON after retries"));
    await expect(callJSON("reasoning", { prompt: "x" }, {})).rejects.toThrow(/invalid JSON/);
  });

  it("capFor honors per-provider and global env overrides", () => {
    process.env.GROQ_DAILY_CAP = "3";
    expect(capFor("groq")).toBe(3); // per-provider wins
    delete process.env.GROQ_DAILY_CAP;
    expect(capFor("groq")).toBe(5); // falls back to LLM_DAILY_CAP
  });
});
