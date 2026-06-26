export type SourceKind =
  | "annual_report"
  | "filing"
  | "press_release"
  | "webpage"
  | "other";

export interface IngestSource {
  kind: SourceKind;
  /** A URL or local / object-storage path to the raw document. */
  location: string;
  fiscalYear?: string;
  title?: string;
}

export interface IngestedDocument {
  source: IngestSource;
  /** Extracted plain text. */
  text: string;
  /** Optional page map, used for citations in evidence/source. */
  pages?: Array<{ page: number; text: string }>;
}

/**
 * Ingest a source document (PDF / HTML / filing) into extracted text + page map.
 *
 * TODO: implement extraction. Long documents are read with Gemini
 * (`llm.longContext`); web sources are fetched via `lib/scrape`'s
 * `webResearcher` (Firecrawl → Scrape.do).
 */
export async function ingestDocument(
  source: IngestSource,
): Promise<IngestedDocument> {
  throw new Error(
    `ingestDocument(${source.kind}: ${source.location}) — not implemented yet`,
  );
}
