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
  process.env.LLM_DAILY_CAP = "5";
  process.env.LLM_COOLDOWN_MS = "1"; // tiny cooldown so waits are instant
  process.env.LLM_MAX_WAIT_MS = "1000";
  process.env.LLM_MAX_STRIKES = "3";
});
afterEach(() => {
  for (const k of ["LLM_DAILY_CAP", "LLM_COOLDOWN_MS", "LLM_MAX_WAIT_MS", "LLM_MAX_STRIKES", "GROQ_DAILY_CAP"]) {
    delete process.env[k];
  }
});

describe("callJSON — quota gating", () => {
  it("uses the role's preferred provider when it has quota", async () => {
    usage({});
    asMock(llm.bulkClassify.completeJSON).mockResolvedValueOnce({ ok: true });
    const r = await callJSON("bulkClassify", { prompt: "x" }, {});
    expect(r.provider).toBe("groq");
    expect(asMock(recordProviderUsage)).toHaveBeenCalledWith("groq");
  });

  it("falls back to the next provider when the preferred is over its daily cap", async () => {
    usage({ groq: 5 });
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ ok: true });
    const r = await callJSON("bulkClassify", { prompt: "x" }, {});
    expect(r.provider).toBe("mistral");
    expect(asMock(llm.bulkClassify.completeJSON)).not.toHaveBeenCalled();
  });

  it("throws QuotaExhaustedError when ALL providers are over their daily cap", async () => {
    usage({ groq: 5, mistral: 5, gemini: 5, nvidia: 5 });
    await expect(callJSON("bulkClassify", { prompt: "x" }, {})).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(asMock(llm.bulkClassify.completeJSON)).not.toHaveBeenCalled();
  });

  it("a 429 cools the provider down and falls back to another in the same pass", async () => {
    usage({});
    asMock(llm.bulkClassify.completeJSON).mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    asMock(llm.reasoning.completeJSON).mockResolvedValueOnce({ ok: true });
    const r = await callJSON("bulkClassify", { prompt: "x" }, {});
    expect(r.provider).toBe("mistral");
  });

  it("WAITS out a cooldown and recovers (does not permanently retire on a transient 429)", async () => {
    usage({ mistral: 5, gemini: 5, nvidia: 5 }); // only groq eligible
    asMock(llm.bulkClassify.completeJSON)
      .mockRejectedValueOnce(new Error("429 rate limit"))
      .mockResolvedValue({ ok: true });
    const r = await callJSON("bulkClassify", { prompt: "x" }, {});
    expect(r.provider).toBe("groq");
    expect(asMock(llm.bulkClassify.completeJSON).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("retires a provider after repeated strikes and then defers (QuotaExhaustedError)", async () => {
    usage({ mistral: 5, gemini: 5, nvidia: 5 }); // only groq eligible
    asMock(llm.bulkClassify.completeJSON).mockRejectedValue(new Error("429 rate limit"));
    await expect(callJSON("bulkClassify", { prompt: "x" }, {})).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(asMock(llm.bulkClassify.completeJSON).mock.calls.length).toBe(3); // MAX_STRIKES
  });

  it("re-throws a genuine (non-rate-limit) provider error as an item error", async () => {
    usage({ mistral: 5, gemini: 5, nvidia: 5 }); // only groq eligible
    asMock(llm.bulkClassify.completeJSON).mockRejectedValue(new Error("invalid JSON after retries"));
    await expect(callJSON("bulkClassify", { prompt: "x" }, {})).rejects.toThrow(/invalid JSON/);
  });

  it("capFor honors per-provider and global env overrides", () => {
    process.env.GROQ_DAILY_CAP = "3";
    expect(capFor("groq")).toBe(3);
    delete process.env.GROQ_DAILY_CAP;
    expect(capFor("groq")).toBe(5);
  });
});
