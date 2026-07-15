import type { FetchStatus, FetchedVia, SourceDocType } from "@/lib/db-enums";

/** A labelled time series: period columns -> values (null = blank cell). */
export interface PeriodTable {
  periods: string[];
  rows: Array<{ label: string; values: Array<string | null> }>;
}

export interface ShareholdingTable extends PeriodTable {
  /** Derived convenience series (also present in `rows`). */
  promoters?: Array<string | null>;
  pledged?: Array<string | null>;
}

/** Clean typed JSON captured by Tier 1 (the single SCREENER_PAGE SourceDoc). */
export interface ScreenerStructuredData {
  ticker: string;
  url: string;
  name?: string;
  about?: string;
  /** Top-of-page ratios: Market Cap, Stock P/E, ROCE, ROE, Debt to equity, … */
  ratios: Record<string, string>;
  profitLoss?: PeriodTable;
  quarters?: PeriodTable;
  balanceSheet?: PeriodTable;
  cashFlow?: PeriodTable;
  /** Debtor/Inventory/Working-capital days, ROCE %, … */
  ratiosTable?: PeriodTable;
  shareholding?: ShareholdingTable;
  peers?: { columns: string[]; rows: string[][] };
  pros: string[];
  cons: string[];
  /** Tier-2 document links discovered on the page (persisted for resumable re-runs). */
  documents?: DocumentLink[];
  capturedAt: string;
}

/** A document discovered in Tier 2 to be downloaded + text-extracted. */
export interface DocumentLink {
  type: SourceDocType; // ANNUAL_REPORT | EARNINGS_PDF | ANNOUNCEMENT
  category: string; // annual_report | concall | credit_rating | announcement
  name: string;
  url: string;
}

/** Outcome of downloading + extracting a single document. */
export interface DocFetchResult {
  ok: boolean;
  status: FetchStatus;
  via: FetchedVia;
  text?: string;
  pages?: number;
  note?: string;
}

export interface HarvestSummary {
  companyId: string;
  runId: string;
  screenerUrl?: string;
  tier1: {
    status: FetchStatus;
    via: FetchedVia;
    fields: string[];
    note?: string;
  };
  tier2: Array<{
    name: string;
    type: SourceDocType;
    category: string;
    via: FetchedVia;
    status: FetchStatus;
    pages?: number;
    note?: string;
  }>;
}
