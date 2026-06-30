import type {
  FetchResult,
  ResearchModule,
  SearchResult,
  WebResearcher,
} from "./types";
import { firecrawl } from "./firecrawl";
import { scrapedo } from "./scrapedo";

export * from "./types";
export { firecrawl } from "./firecrawl";
export { scrapedo } from "./scrapedo";

/** All researcher modules, keyed by id (used by /health). */
export const researchers: Record<string, ResearchModule> = { firecrawl, scrapedo };

// Scrape.do is primary (it does "the most" — URL/document fetching — cheaply);
// Firecrawl is the fallback for fetch AND the only provider that can SEARCH, so
// search() automatically falls through Scrape.do (no search api) to Firecrawl.
const CHAIN: ResearchModule[] = [scrapedo, firecrawl];

/**
 * The composed researcher: tries Scrape.do first, then falls back to Firecrawl,
 * and returns a typed "not_available" if both fail or neither is configured.
 * For search(), Scrape.do has no api → it skips to Firecrawl.
 */
export const webResearcher: WebResearcher = {
  async fetchUrl(url: string): Promise<FetchResult> {
    const errors: string[] = [];
    for (const r of CHAIN) {
      if (!r.isConfigured()) {
        errors.push(`${r.id}: not configured`);
        continue;
      }
      try {
        const result = await r.fetchUrl(url);
        if (result.status === "ok") return result;
        errors.push(`${r.id}: ${result.error ?? "not_available"}`);
      } catch (e) {
        errors.push(`${r.id}: ${(e as Error).message}`);
      }
    }
    return {
      status: "not_available",
      url,
      error: errors.join("; ") || "no researcher configured",
    };
  },

  async search(query: string): Promise<SearchResult> {
    const errors: string[] = [];
    for (const r of CHAIN) {
      if (!r.isConfigured()) {
        errors.push(`${r.id}: not configured`);
        continue;
      }
      try {
        const result = await r.search(query);
        if (result.status === "ok") return result;
        errors.push(`${r.id}: ${result.error ?? "not_available"}`);
      } catch (e) {
        errors.push(`${r.id}: ${(e as Error).message}`);
      }
    }
    return {
      status: "not_available",
      query,
      results: [],
      error: errors.join("; ") || "no researcher configured",
    };
  },
};

export default webResearcher;
