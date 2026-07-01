"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Shared on-demand analysis launcher: POST /api/analyze, then poll
 * /api/analyze/<ticker>/status and show a full-screen progress modal until the
 * report is ready, then navigate to it. Used by the home search box
 * (SearchLauncher) and the report page's "Re-analyse" button.
 */

interface StartResponse {
  status: "fresh" | "started";
  ticker: string;
  runId: string;
  dispatched?: boolean;
  dispatchError?: string;
}

export interface StatusResponse {
  phase: "queued" | "harvesting" | "processing" | "partial" | "done" | "error" | "none";
  percent: number;
  stage: string;
  emoji?: string;
  ready: boolean;
  done: boolean;
}

const POLL_MS = 2500;
const INITIAL: StatusResponse = { phase: "queued", percent: 2, stage: "Starting…", emoji: "⏳", ready: false, done: false };

export function useAnalyzeRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | { ticker: string; runId: string; dispatched: boolean; dispatchError?: string }>(null);
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
        setModal({ ticker: data.ticker, runId: data.runId, dispatched: data.dispatched !== false, dispatchError: data.dispatchError });
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

  const closeModal = useCallback(() => {
    stopPolling();
    setModal(null);
  }, [stopPolling]);

  const overlay = modal ? (
    <LoadingScreen ticker={modal.ticker} dispatched={modal.dispatched} dispatchError={modal.dispatchError} progress={progress} onClose={closeModal} />
  ) : null;

  return { launch, busy, error, overlay };
}

export function LoadingScreen({
  ticker,
  dispatched,
  dispatchError,
  progress,
  onClose,
}: {
  ticker: string;
  dispatched: boolean;
  dispatchError?: string;
  progress: StatusResponse;
  onClose: () => void;
}) {
  const pct = Math.min(100, Math.max(0, Math.round(progress.percent)));
  const failed = progress.phase === "error";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-6 backdrop-blur-md">
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-white shadow-2xl">
        <div className="bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 px-7 pb-8 pt-7 text-white">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold uppercase tracking-wider">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> Live analysis
            </span>
            <span className="rounded-md bg-white/20 px-2 py-0.5 text-sm font-bold tracking-wide">{ticker}</span>
          </div>
          <div className="mt-6 grid place-items-center">
            <Ring pct={pct} failed={failed} />
          </div>
        </div>
        <div className="px-7 py-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <span className="text-lg">{failed ? "⚠️" : progress.emoji ?? "🔍"}</span>
            <span>{progress.stage}</span>
          </div>
          <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all duration-700 ease-out" style={{ width: `${pct}%` }} />
          </div>
          {!dispatched && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-700">
              ⏳ Couldn’t auto-start this run. <b>Reason:</b>{" "}
              <code className="rounded bg-amber-100 px-1 py-0.5">{dispatchError ?? "unknown"}</code>
              {dispatchError === "dispatch_not_configured" ? (
                <> — the site can’t see the dispatch token at runtime.</>
              ) : (
                <> — this is the exact response from the GitHub trigger call (e.g. a token-permission or workflow issue).</>
              )}{" "}
              You can run the <b>analyze-company</b> Action for <b>{ticker}</b> manually meanwhile.
            </div>
          )}
          <div className="mt-5 flex items-center justify-between">
            <p className="text-xs text-slate-400">Keep this open — it jumps to the report when ready.</p>
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700">
              {failed ? "Close" : "Hide"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Ring({ pct, failed }: { pct: number; failed: boolean }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const off = C - (pct / 100) * C;
  return (
    <div className="relative h-32 w-32">
      <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="10" />
        <circle cx="60" cy="60" r={R} fill="none" stroke={failed ? "#fecaca" : "#ffffff"} strokeWidth="10" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={off} className="transition-all duration-700 ease-out" />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="text-3xl font-extrabold tabular-nums">{pct}%</span>
      </div>
    </div>
  );
}
