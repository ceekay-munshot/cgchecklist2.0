import type { ProviderStatus } from "@/lib/health-types";

/** Every research call either succeeds or is explicitly "not_available". */
export type ResearchStatus = "ok" | "not_available";

export interface SearchHit {
  title?: string;
  url: string;
  snippet?: string;
}

export interface FetchResult {
  status: ResearchStatus;
  url: string;
  /** Which researcher produced this result. */
  provider?: string;
  title?: string;
  /** Page content (markdown when available, otherwise html/text). */
  content?: string;
  contentType?: "markdown" | "html" | "text";
  /** Populated when status is "not_available". */
  error?: string;
}

export interface SearchResult {
  status: ResearchStatus;
  query: string;
  provider?: string;
  results: SearchHit[];
  error?: string;
}

/** The single typed interface every web researcher implements. */
export interface WebResearcher {
  fetchUrl(url: string): Promise<FetchResult>;
  search(query: string): Promise<SearchResult>;
}

/** A researcher module = a WebResearcher plus metadata and a health check. */
export interface ResearchModule extends WebResearcher {
  readonly id: string;
  isConfigured(): boolean;
  ping(): Promise<ProviderStatus>;
}
