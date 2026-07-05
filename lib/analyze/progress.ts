/**
 * Pure helpers for the on-demand analysis flow: how stale a run is (cache
 * expiry) and how to turn a run's status + item counts into a smooth progress
 * bar for the loading screen. No DB / IO here so it's trivially unit-testable
 * and safe to import on the client.
 */

/** A finished run is reused (no re-analysis) until it is older than this. */
export const STALE_AFTER_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Total checklist items — fallback when a run hasn't recorded itemsTotal yet. */
export const CHECKLIST_TOTAL = 103;

/** True when there is no run, or the last run is older than STALE_AFTER_DAYS. */
export function isStale(lastProcessedAt: string | Date | null | undefined, now: Date): boolean {
  if (!lastProcessedAt) return true;
  const t = typeof lastProcessedAt === "string" ? new Date(lastProcessedAt) : lastProcessedAt;
  if (Number.isNaN(t.getTime())) return true;
  return now.getTime() - t.getTime() > STALE_AFTER_DAYS * DAY_MS;
}

/** Whole days since `date` (0 if missing/invalid) — for "analysed N days ago". */
export function daysSince(date: string | Date | null | undefined, now: Date): number {
  if (!date) return 0;
  const t = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(t.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - t.getTime()) / DAY_MS));
}

export type RunPhase = "queued" | "harvesting" | "processing" | "partial" | "done" | "error";

export interface Progress {
  phase: RunPhase;
  /** 0..100, monotonic-ish for a pleasant bar. */
  percent: number;
  /** Human-readable current stage. */
  stage: string;
  emoji: string;
  /** The report is viewable (DONE, or PARTIAL with some items committed). */
  ready: boolean;
  /** A terminal state the poller can stop on. */
  done: boolean;
}

/**
 * Map a run's DB status + item counts to a progress bar.
 *
 * Harvest takes the first 15%. The rest is driven by TWO signals so the bar
 * never freezes: `doneItems` (items that reached a terminal state, incl. blanks)
 * carries the bulk, and `answered` (items with a real green/red/neutral verdict)
 * carries the tail. This matters because after the base pass EVERY item is
 * already "committed" (a not-yet-answered item is committed as a blank), yet the
 * research/backfill phase then spends minutes turning those blanks into real
 * answers — during which `doneItems` is flat but `answered` keeps rising. Using
 * both keeps the bar moving through that phase instead of parking at 99%.
 *
 * `total` falls back to the full checklist when the run hasn't stamped itemsTotal
 * yet. `answered` defaults to `doneItems` when a caller doesn't supply it.
 */
export function computeProgress(status: string, doneItems: number, total: number, answered?: number): Progress {
  const t = total > 0 ? total : CHECKLIST_TOTAL;
  const ans = Math.min(answered ?? doneItems, doneItems);
  const doneFrac = Math.min(1, Math.max(0, doneItems / t));
  const ansFrac = Math.min(1, Math.max(0, ans / t));
  // 15 (harvest done) + up to 68 from terminal items + up to 15 from answered.
  const proc = Math.min(98, Math.round(15 + doneFrac * 68 + ansFrac * 15));
  // Base pass finished (all items terminal) but the run isn't DONE → it's in the
  // research/backfill phase, filling the remaining blanks with real answers.
  const researching = doneItems >= t;

  switch (status) {
    case "QUEUED":
      return { phase: "queued", percent: 4, stage: "Queued — spinning up the analysis…", emoji: "⏳", ready: false, done: false };
    case "HARVESTING":
      return { phase: "harvesting", percent: 10, stage: "Fetching filings, reports & ratings…", emoji: "📥", ready: false, done: false };
    case "HARVESTED":
      return { phase: "harvesting", percent: 15, stage: "Documents ready — starting analysis…", emoji: "📑", ready: false, done: false };
    case "PROCESSING":
      return {
        phase: "processing",
        percent: proc,
        stage: researching
          ? `Researching remaining parameters · ${ans} of ${t} answered`
          : `Analysing checklist · ${doneItems} of ${t} items`,
        emoji: "🔍",
        ready: false,
        done: false,
      };
    case "PARTIAL":
      return {
        phase: "partial",
        percent: Math.max(15, proc),
        stage: `Paused at ${ans}/${t} answered — will resume on the next run`,
        emoji: "⏸️",
        ready: doneItems > 0,
        done: true,
      };
    case "DONE":
      return { phase: "done", percent: 100, stage: "Analysis complete", emoji: "✅", ready: true, done: true };
    case "ERROR":
      return { phase: "error", percent: 100, stage: "The run hit an error", emoji: "⚠️", ready: false, done: true };
    default:
      return { phase: "queued", percent: 2, stage: "Preparing…", emoji: "⏳", ready: false, done: false };
  }
}
