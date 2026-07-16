"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Shared on-demand analysis launcher: POST /api/analyze, then poll
 * /api/analyze/<ticker>/status and show a progress modal until the report is
 * ready, then navigate to it. Used by the home search box (SearchLauncher) and
 * the report page's "Re-analyse" button.
 *
 * The modal look mirrors the sister dashboard (elapsed timer + green progress
 * bar + phase checklist), but the progress is driven by OUR real run status
 * (actual items completed, and it waits for the MUNS backfill) — not a fake
 * time-based curve.
 */

interface StartResponse {
  status: "fresh" | "started";
  ticker: string;
  runId: string;
  dispatched?: boolean;
  dispatchError?: string;
}

export interface RunDoc {
  name: string;
  type: string;
  pages: number | null;
  ok: boolean;
}

export interface StatusResponse {
  phase: "queued" | "harvesting" | "processing" | "partial" | "done" | "error" | "none";
  percent: number;
  stage: string;
  emoji?: string;
  ready: boolean;
  done: boolean;
  documents?: RunDoc[];
}

function docTypeLabel(type: string): string {
  switch (type) {
    case "ANNUAL_REPORT":
      return "Annual report";
    case "EARNINGS_PDF":
      return "Concall";
    case "ANNOUNCEMENT":
      return "Filing";
    case "WEB":
      return "Web";
    default:
      return type.replace(/_/g, " ").toLowerCase();
  }
}

const POLL_MS = 2500;
const INITIAL: StatusResponse = { phase: "queued", percent: 2, stage: "Starting…", emoji: "⏳", ready: false, done: false };

export function useAnalyzeRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | {
    ticker: string;
    runId: string;
    dispatched: boolean;
    dispatchError?: string;
    startedAt: number;
  }>(null);
  const [progress, setProgress] = useState<StatusResponse>(INITIAL);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const goToReport = useCallback(
    (t: string) => {
      stopPolling();
      // Dismiss the loading overlay. Critical when "Re-analyse" is clicked FROM the
      // report page: router.push to the same /report/<ticker> URL doesn't remount
      // this component, so without clearing modal state the overlay would sit at
      // "Analysis complete · 100%" forever even though the refreshed report is ready.
      setModal(null);
      router.push(`/report/${encodeURIComponent(t)}`);
      router.refresh();
    },
    [router, stopPolling],
  );

  const poll = useCallback(
    async (t: string, runId: string) => {
      try {
        const res = await fetch(`/api/analyze/${encodeURIComponent(t)}/status?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data: StatusResponse = await res.json();
        setProgress(data);
        if (data.ready) goToReport(t);
        else if (data.done) stopPolling();
      } catch {
        /* transient — keep polling */
      }
    },
    [goToReport, stopPolling],
  );

  const launch = useCallback(
    async (ticker: string, opts: { force?: boolean } = {}) => {
      const t = ticker.trim();
      if (!t || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: t, force: opts.force }),
        });
        const data: StartResponse = await res.json();
        if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? "Could not start analysis.");
        if (data.status === "fresh") {
          goToReport(data.ticker);
          return;
        }
        setModal({ ticker: data.ticker, runId: data.runId, dispatched: data.dispatched !== false, dispatchError: data.dispatchError, startedAt: Date.now() });
        setProgress(INITIAL);
        stopPolling();
        pollRef.current = setInterval(() => poll(data.ticker, data.runId), POLL_MS);
        poll(data.ticker, data.runId);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, goToReport, poll, stopPolling],
  );

  // Show the live modal for an ALREADY-STARTED run (e.g. an unlisted upload that
  // created the run itself). Skips the POST /api/analyze; polls by runId.
  const launchByRun = useCallback(
    (runId: string, opts: { label?: string; dispatched?: boolean; dispatchError?: string } = {}) => {
      setModal({
        ticker: opts.label ?? runId,
        runId,
        dispatched: opts.dispatched !== false,
        dispatchError: opts.dispatchError,
        startedAt: Date.now(),
      });
      setProgress(INITIAL);
      stopPolling();
      pollRef.current = setInterval(() => poll(runId, runId), POLL_MS);
      poll(runId, runId);
    },
    [poll, stopPolling],
  );

  // Re-analyse an EXISTING run in place (force) on its already-harvested docs —
  // used by the report page's Re-analyse button for UNLISTED companies (no ticker,
  // so /api/analyze can't serve them). POSTs /api/analyze/run, then polls by runId.
  const reanalyseRun = useCallback(
    async (runId: string, opts: { label?: string } = {}) => {
      const id = runId.trim();
      if (!id || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/analyze/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: id }),
        });
        const data: { dispatched?: boolean; dispatchError?: string; error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not start re-analysis.");
        launchByRun(id, { label: opts.label, dispatched: data.dispatched !== false, dispatchError: data.dispatchError });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, launchByRun],
  );

  // Targeted re-run of ONE section or ONE item of an existing run — used by the
  // report page's per-section and per-parameter "re-run" buttons. POSTs
  // /api/analyze/scope, then polls the run by id like reanalyseRun. Every other
  // item on the report is left untouched.
  const reanalyseScope = useCallback(
    async (runId: string, scope: { sectionCode?: string; itemId?: string }, opts: { label?: string } = {}) => {
      const id = runId.trim();
      if (!id || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/analyze/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: id, ...scope }),
        });
        const data: { dispatched?: boolean; dispatchError?: string; error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not start re-run.");
        launchByRun(id, { label: opts.label, dispatched: data.dispatched !== false, dispatchError: data.dispatchError });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, launchByRun],
  );

  const closeModal = useCallback(() => {
    stopPolling();
    setModal(null);
  }, [stopPolling]);

  const overlay = modal ? (
    <LoadingModal
      ticker={modal.ticker}
      dispatched={modal.dispatched}
      dispatchError={modal.dispatchError}
      startedAt={modal.startedAt}
      progress={progress}
      onClose={closeModal}
    />
  ) : null;

  return { launch, launchByRun, reanalyseRun, reanalyseScope, busy, error, overlay };
}

// ---------------------------------------------------------------------------
// Loading modal (visual parity with the sister dashboard; our real progress)
// ---------------------------------------------------------------------------

const PHASES: { label: string; at: number }[] = [
  { label: "Queued — spinning up the analysis", at: 0 },
  { label: "Fetching filings, reports & ratings", at: 8 },
  { label: "Analysing governance checklist", at: 16 },
  { label: "Reviewing audit & compliance signals", at: 45 },
  { label: "Filling remaining items via research", at: 72 },
  { label: "Finalising findings", at: 96 },
];

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function LoadingModal({
  ticker,
  dispatched,
  dispatchError,
  startedAt,
  progress,
  onClose,
}: {
  ticker: string;
  dispatched: boolean;
  dispatchError?: string;
  startedAt: number;
  progress: StatusResponse;
  onClose: () => void;
}) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pct = Math.min(100, Math.max(0, Math.round(progress.percent)));
  const failed = progress.phase === "error";
  const complete = pct >= 100;
  // Active phase = the furthest phase our real % has reached.
  const activeIdx = complete ? PHASES.length : PHASES.reduce((idx, p, i) => (pct >= p.at ? i : idx), 0);
  const elapsed = formatElapsed(now - startedAt);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Fully opaque backdrop — the app never shows through */}
      <div className="fixed inset-0 bg-gradient-to-b from-white via-slate-50 to-slate-100" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Analysing company"
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_20px_60px_rgba(15,23,42,0.18)] ring-1 ring-black/5 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#6f7d97]">Governance analysis</p>
            <h2 className="mt-1 truncate text-base font-semibold tracking-tight text-[#0a1422]">
              {ticker}
              <span className="ml-2 font-normal text-[#6f7d97]">· live</span>
            </h2>
          </div>
          <span className="shrink-0 rounded-full bg-[#ecf6ee] px-2.5 py-1 text-[11px] font-semibold tabular-nums text-[#1a5d30]">{elapsed}</span>
        </div>

        {/* progress bar */}
        <div className="mt-4">
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 w-full overflow-hidden rounded-full bg-[#eef2f8]"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-700 ease-out ${failed ? "bg-[#c43838]" : "bg-[#2f9c50]"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-[#6f7d97]">
            <span className="truncate pr-2">{failed ? "Run failed" : progress.stage}</span>
            <span className="tabular-nums">{pct}%</span>
          </div>
        </div>

        {/* phase checklist */}
        <ul className="mt-4 space-y-1.5">
          {PHASES.map((phase, i) => {
            const status = i < activeIdx ? "done" : i === activeIdx && !complete ? "active" : complete ? "done" : "pending";
            return (
              <li key={phase.label} className={`flex items-center gap-2.5 text-[13px] ${status === "pending" ? "text-[#6f7d97]" : "text-[#0a1422]"}`}>
                <span
                  aria-hidden
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    status === "done"
                      ? "bg-[#2f9c50] text-white"
                      : status === "active"
                        ? "bg-[#ecf6ee] text-[#1a5d30] ring-2 ring-[#2f9c50]"
                        : "bg-[#eef2f8] text-[#6f7d97]"
                  }`}
                >
                  {status === "done" ? "✓" : status === "active" ? <span className="block h-2 w-2 animate-pulse rounded-full bg-[#237a3e]" /> : i + 1}
                </span>
                <span className="leading-snug">{phase.label}</span>
              </li>
            );
          })}
        </ul>

        {/* Documents the analysis is running on — appears as they're gathered. */}
        {progress.documents && progress.documents.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#6f7d97]">
              Documents · {progress.documents.length}
            </p>
            <ul className="mt-1.5 max-h-28 space-y-1 overflow-y-auto pr-1">
              {progress.documents.map((d, i) => (
                <li key={`${d.name}-${i}`} className="flex items-center gap-2 text-[12px] text-[#525f78]">
                  <span className="shrink-0 rounded bg-[#eef2f8] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-[#6f7d97]">
                    {docTypeLabel(d.type)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  {d.pages != null && <span className="shrink-0 tabular-nums text-[#9aa6bd]">{d.pages}p</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* dispatch failure diagnostic (kept) */}
        {!dispatched && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
            ⏳ Couldn’t auto-start. <b>Reason:</b> <code className="rounded bg-amber-100 px-1 py-0.5">{dispatchError ?? "unknown"}</code>. You can run the{" "}
            <b>analyze-company</b> Action for <b>{ticker}</b> manually meanwhile.
          </div>
        )}

        {/* note (one line — keeps the modal short) */}
        <p className="mt-4 rounded-lg bg-[#f7f9fc] px-3 py-2 text-center text-[12px] leading-relaxed text-[#525f78]">
          Opens automatically when done — you can leave this tab open.
        </p>

        {/* cancel */}
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#dde4ee] bg-white px-4 text-sm font-medium text-[#525f78] transition hover:bg-[#fbe9e9] hover:text-[#731e1e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f988e]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
            {failed ? "Close" : "Hide"}
          </button>
        </div>
      </div>
    </div>
  );
}
