// Analysis core — turn harvested SourceDocs into flag-based ItemResults.
//
//   evaluateItem(item, runId)
//     = getEvidence(item, runId)    // route to Screener structuredData / docs / web
//     → analyzeItem(item, evidence) // extract a concise fact (cheap/no LLM where possible)
//     → assignFlag(item, analysis)  // numeric = deterministic bands; qualitative = LLM judge
//
// Flag-based only — there is intentionally NO numeric scoring anywhere.

export * from "./types";
export * from "./thresholds";
export * from "./evidence";
export * from "./analyzeItem";
export * from "./flag";
export * from "./evaluateItem";
