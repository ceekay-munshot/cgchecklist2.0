import type { AnalysisResult } from "@/lib/orchestrate";

export type ExportFormat = "xlsx" | "pdf" | "pptx";

export interface ExportArtifact {
  format: ExportFormat;
  filename: string;
  bytes: Uint8Array;
}

/**
 * Render an analysis result to a downloadable artifact. The report is
 * flag-based (green / red / neutral / not-available) with a one-liner verdict,
 * evidence and source per item — there is NO numeric scoring.
 *
 * TODO: implement the xlsx writer (e.g. `exceljs`) and the pdf/pptx writers
 * (e.g. `pptxgenjs`).
 */
export async function exportAnalysis(
  result: AnalysisResult,
  format: ExportFormat,
): Promise<ExportArtifact> {
  throw new Error(
    `exportAnalysis(${result.companyName}, ${format}) — not implemented yet`,
  );
}
