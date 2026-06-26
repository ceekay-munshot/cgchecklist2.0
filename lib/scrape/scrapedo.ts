import type { ProviderStatus } from "@/lib/health-types";
import type {
  FetchResult,
  ResearchModule,
  SearchResult,
} from "./types";

// Scrape.do is a proxy/renderer: GET api.scrape.do/?token=...&url=... returns
// the target page's HTML. It has no search endpoint, so search() is always
// "not_available" — the fallback chain handles that.
const SCRAPEDO_BASE = "https://api.scrape.do";
const TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 12_000;
const AUTH_FAIL = [401, 402, 403, 407];

const apiKey = () => process.env.SCRAPEDO_API_KEY?.trim() ?? "";

async function fetchUrl(url: string): Promise<FetchResult> {
  const key = apiKey();
  if (!key) {
    return { status: "not_available", url, provider: "scrapedo", error: "SCRAPEDO_API_KEY not set" };
  }
  try {
    const endpoint = `${SCRAPEDO_BASE}/?token=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      return { status: "not_available", url, provider: "scrapedo", error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    return { status: "ok", url, provider: "scrapedo", content: html, contentType: "html" };
  } catch (e) {
    return { status: "not_available", url, provider: "scrapedo", error: (e as Error).message };
  }
}

async function search(query: string): Promise<SearchResult> {
  // Scrape.do does not offer a search API.
  return {
    status: "not_available",
    query,
    provider: "scrapedo",
    results: [],
    error: "scrape.do does not support search",
  };
}

function isConfigured(): boolean {
  return apiKey().length > 0;
}

async function ping(): Promise<ProviderStatus> {
  const base = {
    id: "scrapedo",
    label: "Scrape.do",
    category: "scrape",
    role: "Fallback web research (fetch only)",
    checkedAt: new Date().toISOString(),
  } satisfies Omit<ProviderStatus, "state">;

  const key = apiKey();
  if (!key) {
    return { ...base, state: "not_configured", message: "SCRAPEDO_API_KEY not set" };
  }

  const started = Date.now();
  try {
    // Call with token but no url: a valid token returns a 400 ("url required"),
    // an invalid token returns an auth error. So anything that is NOT an
    // auth-class status means the token was accepted.
    const res = await fetch(`${SCRAPEDO_BASE}/?token=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (AUTH_FAIL.includes(res.status)) {
      return { ...base, state: "red", latencyMs, message: `authentication failed (HTTP ${res.status})` };
    }
    return { ...base, state: "green", latencyMs, message: `token accepted (HTTP ${res.status})` };
  } catch (e) {
    return { ...base, state: "red", message: `unreachable: ${(e as Error).message}` };
  }
}

export const scrapedo: ResearchModule = {
  id: "scrapedo",
  fetchUrl,
  search,
  isConfigured,
  ping,
};

export default scrapedo;
