import type { Evaluation } from "@/lib/engine";

// The resumable, quota-aware batch over a run's harvested SourceDocs.
export * from "./run";

// ---------------------------------------------------------------------------
// Legacy types retained for the lib/export stub (until the exporter is built).
// ---------------------------------------------------------------------------

export interface AnalysisRequest {
  companyName: string;
  cin?: string;
  fiscalYear?: string;
}

export interface AnalysisResult {
  companyName: string;
  fiscalYear?: string;
  evaluations: Array<Evaluation & { code: string }>;
}
