import type { ProviderStatus } from "@/lib/health-types";
import type { FetchResult, ResearchModule, SearchHit, SearchResult } from "./types";

/**
 * MUNS *tools* researcher — the low-level, CALLER-CONTROLLED MUNS endpoints
 * (`/tools/web-search`, `/tools/web-reader`, `/tools/news-search`), as opposed to
 * the opaque MUNS *chat* the backfill uses. Here WE build the query (pinned to the
 * company) and choose the URLs, so it can't drift to a different company and it
 * returns real, citable sources — an additive quality lift for the engine's
 * web-fallback items (reputation, regulatory, track-record, unlisted).
 *
 * Wired into the researcher chain as a FALLBACK (see index.ts): it only runs when
 * Scrape.do / Firecrawl return nothing, so nothing currently answered changes —
 * it purely fills gaps. `MUNS_TOOLS=0` disables it entirely; auth reuses MUNS_TOKEN.
 */

const TOOLS_BASE = "https://hostapi.muns.io/tools";
const SEARCH_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 45_000;
const PING_TIMEOUT_MS = 12_000;
const MAX_RESULTS = 12;

const token = () => process.env.MUNS_TOKEN?.trim() ?? "";
/** Indian listed/unlisted companies → India is the right default news/search locale. */
const country = () => process.env.MUNS_TOOLS_COUNTRY?.trim() || "India";
const enabled = () => {
  const v = process.env.MUNS_TOOLS;
  return v !== "0" && v !== "false" && v !== "off";
};

async function post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(`${TOOLS_BASE}/${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function dedupeByUrl(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (!h.url || seen.has(h.url)) continue;
    seen.add(h.url);
    out.push(h);
  }
  return out;
}

/** POST /tools/web-search → hits. Returns {hits,error}; never throws. */
async function webSearchCall(query: string): Promise<{ hits: SearchHit[]; error?: string }> {
  try {
    const res = await post("web-search", { query, country: country() }, SEARCH_TIMEOUT_MS);
    if (!res.ok) return { hits: [], error: `web-search HTTP ${res.status}` };
    const data = (await res.json()) as { results?: Array<{ title?: string; link?: string; snippet?: string }> };
    const hits = (data.results ?? [])
      .filter((r) => r.link)
      .map((r) => ({ title: r.title, url: r.link as string, snippet: r.snippet }));
    return { hits };
  } catch (e) {
    return { hits: [], error: (e as Error).message };
  }
}

/** POST /tools/news-search → hits. Returns {hits,error}; never throws. */
async function newsSearchCall(
  query: string,
  opts: { fromDate?: string; toDate?: string } = {},
): Promise<{ hits: SearchHit[]; error?: string }> {
  try {
    const body: Record<string, unknown> = { query, country: country() };
    if (opts.fromDate) body.from_date = opts.fromDate;
    if (opts.toDate) body.to_date = opts.toDate;
    const res = await post("news-search", body, SEARCH_TIMEOUT_MS);
    if (!res.ok) return { hits: [], error: `news-search HTTP ${res.status}` };
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; description?: string }> };
    const hits = (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({ title: r.title, url: r.url as string, snippet: r.description }));
    return { hits };
  } catch (e) {
    return { hits: [], error: (e as Error).message };
  }
}

async function fetchUrl(url: string): Promise<FetchResult> {
  if (!isConfigured()) {
    return { status: "not_available", url, provider: "muns-tools", error: "MUNS_TOKEN not set / MUNS_TOOLS disabled" };
  }
  try {
    const res = await post("web-reader", { urls: [url], task: "Extract the main article text and key facts." }, READ_TIMEOUT_MS);
    if (!res.ok) return { status: "not_available", url, provider: "muns-tools", error: `web-reader HTTP ${res.status}` };
    const data = (await res.json()) as { results?: Array<{ url?: string; content?: string }> };
    const content = data.results?.[0]?.content;
    if (!content) return { status: "not_available", url, provider: "muns-tools", error: "web-reader returned no content" };
    return { status: "ok", url, provider: "muns-tools", content, contentType: "markdown" };
  } catch (e) {
    return { status: "not_available", url, provider: "muns-tools", error: (e as Error).message };
  }
}

/**
 * search() blends web-search + news-search (news is best-effort — a news failure
 * never drops the web hits). News matters for the exact items that reach this
 * fallback: promoter/director reputation, regulatory actions, past conduct.
 */
async function search(query: string): Promise<SearchResult> {
  if (!isConfigured()) {
    return { status: "not_available", query, provider: "muns-tools", results: [], error: "MUNS_TOKEN not set / MUNS_TOOLS disabled" };
  }
  const web = await webSearchCall(query);
  const news = await newsSearchCall(query);
  const merged = dedupeByUrl([...web.hits, ...news.hits]).slice(0, MAX_RESULTS);
  if (!merged.length) {
    return { status: "not_available", query, provider: "muns-tools", results: [], error: web.error ?? news.error ?? "no results" };
  }
  return { status: "ok", query, provider: "muns-tools", results: merged };
}

/**
 * Date-scoped news search — a NEW capability (no other researcher offers it). Not
 * on the WebResearcher interface; call it directly to answer track-record items
 * over a wide historical window (the promoter-history / past-conduct class).
 */
async function newsSearch(query: string, opts: { fromDate?: string; toDate?: string } = {}): Promise<SearchResult> {
  if (!isConfigured()) {
    return { status: "not_available", query, provider: "muns-tools", results: [], error: "MUNS_TOKEN not set / MUNS_TOOLS disabled" };
  }
  const { hits, error } = await newsSearchCall(query, opts);
  if (!hits.length) return { status: "not_available", query, provider: "muns-tools", results: [], error: error ?? "no results" };
  return { status: "ok", query, provider: "muns-tools", results: hits.slice(0, MAX_RESULTS) };
}

function isConfigured(): boolean {
  return token().length > 0 && enabled();
}

async function ping(): Promise<ProviderStatus> {
  const base = {
    id: "muns-tools",
    label: "MUNS tools (search/reader/news)",
    category: "scrape",
    role: "Controlled web-search + reader + news (fallback, fills gaps)",
    checkedAt: new Date().toISOString(),
  } satisfies Omit<ProviderStatus, "state">;

  if (!token()) return { ...base, state: "not_configured", message: "MUNS_TOKEN not set" };
  if (!enabled()) return { ...base, state: "not_configured", message: "MUNS_TOOLS disabled" };

  const started = Date.now();
  try {
    const res = await post("web-search", { query: "ping", country: country() }, PING_TIMEOUT_MS);
    const latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      return { ...base, state: "red", latencyMs, message: `authentication failed (HTTP ${res.status})` };
    }
    // Any non-auth status means the token was accepted (mirrors Scrape.do's ping).
    return { ...base, state: "green", latencyMs, message: `token accepted (HTTP ${res.status})` };
  } catch (e) {
    return { ...base, state: "red", message: `unreachable: ${(e as Error).message}` };
  }
}

export const munsTools: ResearchModule & {
  newsSearch(query: string, opts?: { fromDate?: string; toDate?: string }): Promise<SearchResult>;
} = {
  id: "muns-tools",
  fetchUrl,
  search,
  newsSearch,
  isConfigured,
  ping,
};

export default munsTools;
