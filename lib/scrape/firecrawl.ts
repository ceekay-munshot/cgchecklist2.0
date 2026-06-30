import {
  type ProviderStatus,
  interpretHttpPing,
} from "@/lib/health-types";
import type {
  FetchResult,
  ResearchModule,
  SearchResult,
} from "./types";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v1";
const TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 12_000;

const apiKey = () => process.env.FIRECRAWL_API_KEY?.trim() ?? "";

function authHeaders(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function fetchUrl(url: string): Promise<FetchResult> {
  const key = apiKey();
  if (!key) {
    return { status: "not_available", url, provider: "firecrawl", error: "FIRECRAWL_API_KEY not set" };
  }
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ url, formats: ["markdown"] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { status: "not_available", url, provider: "firecrawl", error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    if (!data.success || !data.data?.markdown) {
      return { status: "not_available", url, provider: "firecrawl", error: "no content returned" };
    }
    return {
      status: "ok",
      url,
      provider: "firecrawl",
      title: data.data.metadata?.title,
      content: data.data.markdown,
      contentType: "markdown",
    };
  } catch (e) {
    return { status: "not_available", url, provider: "firecrawl", error: (e as Error).message };
  }
}

async function search(query: string): Promise<SearchResult> {
  const key = apiKey();
  if (!key) {
    return { status: "not_available", query, provider: "firecrawl", results: [], error: "FIRECRAWL_API_KEY not set" };
  }
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/search`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ query, limit: 5 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { status: "not_available", query, provider: "firecrawl", results: [], error: `HTTP ${res.status}` };
    }
    // Firecrawl's /search has shipped a few response shapes: a flat `data: []`,
    // and a categorised `data: { web: [], news: [] }` (and occasionally a
    // top-level `web: []`). Accept all so a shape change can't silently yield
    // zero results on an HTTP 200.
    type FcHit = { url?: string; title?: string; description?: string; snippet?: string };
    const data = (await res.json()) as {
      success?: boolean;
      data?: FcHit[] | { web?: FcHit[]; news?: FcHit[] };
      web?: FcHit[];
    };
    const arr: FcHit[] = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.data?.web)
        ? data.data.web
        : Array.isArray(data.web)
          ? data.web
          : [];
    const results = arr
      .filter((r): r is FcHit & { url: string } => !!r.url)
      .map((r) => ({ url: r.url, title: r.title, snippet: r.description ?? r.snippet }));
    return { status: "ok", query, provider: "firecrawl", results };
  } catch (e) {
    return { status: "not_available", query, provider: "firecrawl", results: [], error: (e as Error).message };
  }
}

function isConfigured(): boolean {
  return apiKey().length > 0;
}

async function ping(): Promise<ProviderStatus> {
  const base = {
    id: "firecrawl",
    label: "Firecrawl",
    category: "scrape",
    role: "Primary web research (fetch + search)",
    checkedAt: new Date().toISOString(),
  } satisfies Omit<ProviderStatus, "state">;

  const key = apiKey();
  if (!key) {
    return { ...base, state: "not_configured", message: "FIRECRAWL_API_KEY not set" };
  }

  const started = Date.now();
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/team/credit-usage`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return interpretHttpPing({ ...base, latencyMs: Date.now() - started }, res.status, res.ok);
  } catch (e) {
    return { ...base, state: "red", message: `unreachable: ${(e as Error).message}` };
  }
}

export const firecrawl: ResearchModule = {
  id: "firecrawl",
  fetchUrl,
  search,
  isConfigured,
  ping,
};

export default firecrawl;
