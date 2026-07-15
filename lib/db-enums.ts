/**
 * Former Prisma enums, now string-union types.
 *
 * The datastore is Cloudflare D1 (SQLite), which has no native enums — the columns
 * are plain String — so these unions give the app the same compile-time safety the
 * generated Prisma enums used to. Values MUST match the lists in prisma/schema.prisma.
 */
export type Flag = "GREEN" | "RED" | "NEUTRAL" | "NOT_AVAILABLE";
export type Exchange = "NSE" | "BSE";
export type RunStatus = "QUEUED" | "HARVESTING" | "HARVESTED" | "PROCESSING" | "PARTIAL" | "DONE" | "ERROR";
export type SourceDocType =
  | "SCREENER_PAGE"
  | "ANNUAL_REPORT"
  | "EARNINGS_PDF"
  | "ANNOUNCEMENT"
  | "WEB"
  | "MANUAL_UPLOAD";
export type FetchedVia = "SCREENER" | "FIRECRAWL" | "SCRAPEDO" | "DIRECT" | "MANUAL";
export type FetchStatus = "OK" | "EMPTY" | "FAILED";
export type ItemStatus = "PENDING" | "PROCESSING" | "DONE" | "ERROR" | "DEFERRED" | "NEEDS_REVIEW";
