import type { Evaluation } from "@/lib/engine";
import type { IngestSource } from "@/lib/ingest";

export interface AnalysisRequest {
  companyName: string;
  cin?: string;
  fiscalYear?: string;
  sources: IngestSource[];
}

export interface AnalysisResult {
  companyName: string;
  fiscalYear?: string;
  evaluations: Array<Evaluation & { code: string }>;
}

/**
 * End-to-end pipeline: ingest sources → evaluate every checklist item →
 * persist an `AnalysisRun` + `ItemResult`s. Ties together `lib/ingest`,
 * `lib/engine`, `lib/llm`, `lib/scrape` and `lib/db`.
 *
 * TODO: implement.
 */
export async function runAnalysis(
  request: AnalysisRequest,
): Promise<AnalysisResult> {
  throw new Error(`runAnalysis(${request.companyName}) — not implemented yet`);
}
