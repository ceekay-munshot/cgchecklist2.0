"use client";

import { useState } from "react";
import { useAnalyzeRun } from "@/app/components/AnalyzeRun";

/**
 * Home-page search box. Submit a ticker → useAnalyzeRun opens the report if a
 * fresh one exists, otherwise kicks off an on-demand analysis and shows the
 * live progress modal until it's ready.
 */
export default function SearchLauncher() {
  const [ticker, setTicker] = useState("");
  const { launch, busy, error, overlay } = useAnalyzeRun();

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          launch(ticker);
        }}
        className="mt-8 flex w-full max-w-xl items-center gap-2"
      >
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
      {overlay}
    </>
  );
}
