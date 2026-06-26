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

// Firecrawl is primary; Scrape.do is the fallback.
const CHAIN: ResearchModule[] = [firecrawl, scrapedo];

/**
 * The composed researcher: tries Firecrawl, then falls back to Scrape.do, and
 * returns a typed "not_available" result if both fail or neither is configured.
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
