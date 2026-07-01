"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAnalyzeRun } from "@/app/components/AnalyzeRun";

interface StockSuggestion {
  ticker: string;
  name: string;
  industry?: string;
  country?: string;
}

/**
 * Home search box with a live MUNS-powered typeahead. Type ≥2 chars → a
 * dropdown of matching companies; pick one (fills the box) or hit Analyse →
 * useAnalyzeRun opens the report if fresh, else starts an on-demand analysis
 * with the live progress modal.
 */
export default function SearchLauncher() {
  const [query, setQuery] = useState("");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<StockSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listboxId = useId();

  const { launch, busy, error, overlay } = useAnalyzeRun();

  // Debounced typeahead (250ms), min 2 chars, aborts stale requests.
  useEffect(() => {
    const q = query.trim();
    const handle = setTimeout(async () => {
      if (q.length < 2) {
        abortRef.current?.abort();
        setSuggestions([]);
        setLoading(false);
        setSearched(false);
        setActiveIndex(-1);
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      setLoading(true);
      try {
        const res = await fetch(`/api/stock-search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const data = (await res.json()) as { results?: StockSuggestion[] };
        setSuggestions(data.results ?? []);
        setActiveIndex(-1);
        setSearched(true);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setSuggestions([]);
          setSearched(true);
        }
      } finally {
        clearTimeout(timeout);
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  // Close on click-outside.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (s: StockSuggestion) => {
    setQuery(s.name);
    setSelectedTicker(s.ticker);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
  };

  const analyse = () => {
    const t = (selectedTicker || query.trim()).trim();
    if (!t) return;
    setOpen(false);
    launch(t);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (open && activeIndex >= 0 && suggestions[activeIndex]) {
        e.preventDefault();
        pick(suggestions[activeIndex]);
      } else {
        e.preventDefault();
        analyse();
      }
      return;
    }
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showList = open && query.trim().length >= 2 && (loading || searched);

  return (
    <>
      <div ref={containerRef} className="relative mt-8 w-full max-w-xl">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">🔎</span>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedTicker(null);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              placeholder="Search any company — e.g. Reliance, TCS, Infosys"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={showList}
              aria-controls={listboxId}
              aria-autocomplete="list"
              className="w-full rounded-2xl border border-slate-200 bg-white/80 py-3.5 pl-11 pr-4 text-sm font-medium text-slate-800 shadow-sm outline-none ring-indigo-100 backdrop-blur transition placeholder:font-normal placeholder:text-slate-400 focus:border-indigo-300 focus:ring-4"
            />
            {showList && (
              <ul
                id={listboxId}
                role="listbox"
                className="absolute left-0 right-0 top-full z-30 mt-2 max-h-80 overflow-auto rounded-2xl border border-slate-200 bg-white p-1 shadow-[0_16px_40px_rgba(15,23,42,0.12)]"
              >
                {loading && suggestions.length === 0 && (
                  <li className="flex items-center gap-2 px-4 py-3 text-xs text-slate-400">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-500" /> Searching…
                  </li>
                )}
                {!loading && searched && suggestions.length === 0 && (
                  <li className="px-4 py-3 text-xs text-slate-400">No matches found.</li>
                )}
                {suggestions.map((s, idx) => (
                  <li
                    key={s.ticker}
                    role="option"
                    aria-selected={idx === activeIndex}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(s);
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition ${idx === activeIndex ? "bg-indigo-50" : "hover:bg-slate-50"}`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">{s.name}</p>
                      {s.industry ? <p className="mt-0.5 truncate text-[11px] text-slate-400">{s.industry}</p> : null}
                    </div>
                    <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
                      {s.ticker}
                      {s.country ? <span className="ml-1 font-sans text-slate-400">· {s.country === "India" ? "IN" : s.country}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={analyse}
            disabled={busy || !(selectedTicker || query.trim())}
            className="w-full shrink-0 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {busy ? "Starting…" : "Analyse →"}
          </button>
        </div>
      </div>

      {error && <p className="mt-2 text-sm font-medium text-rose-600">⚠️ {error}</p>}
      <p className="mt-2 text-xs text-slate-400">
        Cached for 90 days — a fresh company runs a full analysis (this takes a few minutes) and refreshes automatically when it ages out.
      </p>
      {overlay}
    </>
  );
}
