"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Search box + full-screen on-demand loading experience.
 *
 * Submit a ticker → POST /api/analyze. If a fresh (≤90-day) report exists we go
 * straight to it; otherwise a background analysis is kicked off and this opens a
 * full-screen modal that polls the live progress (% + current stage) until the
 * report is ready, then navigates there.
 */

interface StartResponse {
  status: "fresh" | "started";
  ticker: string;
  runId: string;
  dispatched?: boolean;
  dispatchError?: string;
}

interface StatusResponse {
  phase: "queued" | "harvesting" | "processing" | "partial" | "done" | "error" | "none";
  percent: number;
  stage: string;
  emoji?: string;
  ready: boolean;
  done: boolean;
}

const POLL_MS = 2500;

export default function SearchLauncher() {
  const router = useRouter();
  const [ticker, setTicker] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<null | {
    ticker: string;
    runId: string;
    dispatched: boolean;
  }>(null);
  const [progress, setProgress] = useState<StatusResponse>({
    phase: "queued",
    percent: 2,
    stage: "Starting…",
    emoji: "⏳",
    ready: false,
    done: false,
  });
  const [error, setError] = useState<string | null>(null);
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
    },
    [router, stopPolling],
  );

  const poll = useCallback(
    async (t: string, runId: string) => {
      try {
        const res = await fetch(`/api/analyze/${encodeURIComponent(t)}/status?runId=${encodeURIComponent(runId)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: StatusResponse = await res.json();
        setProgress(data);
        if (data.ready) goToReport(t);
        else if (data.done) stopPolling(); // PARTIAL with nothing committed, or ERROR
      } catch {
        /* transient — keep polling */
      }
    },
    [goToReport, stopPolling],
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const t = ticker.trim();
      if (!t || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: t }),
        });
        const data: StartResponse = await res.json();
        if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? "Could not start analysis.");

        if (data.status === "fresh") {
          goToReport(data.ticker);
          return;
        }
        // started — open the modal and poll
        setModal({ ticker: data.ticker, runId: data.runId, dispatched: data.dispatched !== false });
        setProgress({ phase: "queued", percent: 2, stage: "Queued — spinning up the analysis…", emoji: "⏳", ready: false, done: false });
        stopPolling();
        pollRef.current = setInterval(() => poll(data.ticker, data.runId), POLL_MS);
        poll(data.ticker, data.runId);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [ticker, busy, goToReport, poll, stopPolling],
  );

  const closeModal = useCallback(() => {
    stopPolling();
    setModal(null);
  }, [stopPolling]);

  return (
    <>
      <form onSubmit={onSubmit} className="mt-8 flex w-full max-w-xl items-center gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">🔎</span>
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="Search any company by ticker — e.g. TCS, INFY, RELIANCE"
            spellCheck={false}
            autoCapitalize="characters"
            className="w-full rounded-2xl border border-slate-200 bg-white/80 py-3.5 pl-11 pr-4 text-sm font-medium text-slate-800 shadow-sm outline-none ring-indigo-100 backdrop-blur transition placeholder:font-normal placeholder:text-slate-400 focus:border-indigo-300 focus:ring-4"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !ticker.trim()}
          className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Starting…" : "Analyse →"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm font-medium text-rose-600">⚠️ {error}</p>}
      <p className="mt-2 text-xs text-slate-400">
        Cached for 90 days — a fresh company runs a full analysis (this takes a few minutes) and refreshes automatically when it ages out.
      </p>

      {modal && <LoadingScreen ticker={modal.ticker} dispatched={modal.dispatched} progress={progress} onClose={closeModal} />}
    </>
  );
}

function LoadingScreen({
  ticker,
  dispatched,
  progress,
  onClose,
}: {
  ticker: string;
  dispatched: boolean;
  progress: StatusResponse;
  onClose: () => void;
}) {
  const pct = Math.min(100, Math.max(0, Math.round(progress.percent)));
  const failed = progress.phase === "error";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-6 backdrop-blur-md">
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-white shadow-2xl">
        {/* gradient banner */}
        <div className="bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 px-7 pb-8 pt-7 text-white">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold uppercase tracking-wider">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> Live analysis
            </span>
            <span className="rounded-md bg-white/20 px-2 py-0.5 text-sm font-bold tracking-wide">{ticker}</span>
          </div>

          {/* progress ring */}
          <div className="mt-6 grid place-items-center">
            <Ring pct={pct} failed={failed} />
          </div>
        </div>

        {/* stage + bar */}
        <div className="px-7 py-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <span className="text-lg">{failed ? "⚠️" : progress.emoji ?? "🔍"}</span>
            <span>{progress.stage}</span>
          </div>
          <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all duration-700 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>

          {!dispatched && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-700">
              ⏳ The run is <b>queued</b> but no auto-dispatch token is configured, so it won’t start on its own. Run the{" "}
              <b>analyze-company</b> Action for <b>{ticker}</b> and this screen will track it live. (Set{" "}
              <code>GITHUB_DISPATCH_TOKEN</code> + <code>GITHUB_REPO</code> to make search fully self-serve.)
            </div>
          )}

          <div className="mt-5 flex items-center justify-between">
            <p className="text-xs text-slate-400">You can keep this open — it’ll jump to the report when it’s ready.</p>
            <button
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
            >
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
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke={failed ? "#fecaca" : "#ffffff"}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={off}
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="text-3xl font-extrabold tabular-nums">{pct}%</span>
      </div>
    </div>
  );
}
