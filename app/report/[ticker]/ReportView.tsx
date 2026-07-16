"use client";

import Link from "next/link";
import { memo, useDeferredValue, useMemo, useState } from "react";
import type { CompanyReport, FlagName, ReportDoc, ReportItem, ReportSection } from "@/lib/report";
import { useAnalyzeRun } from "@/app/components/AnalyzeRun";

type FilterKey = "ALL" | FlagName;

const FLAG: Record<FlagName, { emoji: string; label: string; chip: string; bar: string; text: string }> = {
  GREEN: { emoji: "🟢", label: "Green", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", bar: "bg-emerald-400", text: "text-emerald-600" },
  RED: { emoji: "🔴", label: "Red", chip: "bg-rose-50 text-rose-700 ring-rose-200", bar: "bg-rose-400", text: "text-rose-600" },
  NEUTRAL: { emoji: "⚪", label: "Neutral", chip: "bg-amber-50 text-amber-700 ring-amber-200", bar: "bg-amber-300", text: "text-amber-600" },
  NOT_AVAILABLE: { emoji: "▫️", label: "N/A", chip: "bg-slate-100 text-slate-500 ring-slate-200", bar: "bg-slate-200", text: "text-slate-400" },
};

function effective(it: ReportItem): FlagName {
  return (it.flag ?? it.staleFlag ?? "NOT_AVAILABLE") as FlagName;
}

export function ReportView({ report }: { report: CompanyReport }) {
  const [filter, setFilter] = useState<FilterKey>("ALL");
  const [query, setQuery] = useState("");
  const slug = encodeURIComponent(report.ticker ?? report.runId);
  const { launch, reanalyseRun, busy, overlay } = useAnalyzeRun();

  const totals = report.summary?.totals ?? { green: 0, red: 0, neutral: 0, na: 0 };
  const gatePass = report.summary?.nonNegotiable?.gatePass ?? null;

  // Defer the query so typing/clicking stays responsive — React can keep the
  // input snappy and re-filter the 106 rows in the background.
  const deferredQuery = useDeferredValue(query);
  const sections = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return report.sections
      .map((s) => ({
        ...s,
        items: s.items.filter((it) => {
          const f = effective(it);
          if (filter !== "ALL" && f !== filter) return false;
          if (!q) return true;
          return (
            it.id.toLowerCase().includes(q) ||
            it.item.toLowerCase().includes(q) ||
            (it.verdict ?? "").toLowerCase().includes(q) ||
            (it.value ?? "").toLowerCase().includes(q)
          );
        }),
      }))
      .filter((s) => s.items.length > 0);
  }, [report.sections, filter, deferredQuery]);

  const distTotal = Math.max(1, totals.green + totals.red + totals.neutral + totals.na);

  // Split the N/A bucket so the reader sees WHY items are blank: structurally
  // "not applicable" (a listed-only item on a private company) vs a genuine
  // "no data" gap in the available sources.
  const naSplit = useMemo(() => {
    let notApplicable = 0;
    let noData = 0;
    for (const s of report.sections) {
      for (const it of s.items) {
        if ((it.flag ?? null) !== "NOT_AVAILABLE") continue;
        if (it.naKind === "not_applicable") notApplicable++;
        else noData++;
      }
    }
    return { notApplicable, noData };
  }, [report.sections]);
  const naSub =
    naSplit.notApplicable > 0
      ? `${naSplit.notApplicable} n/a · ${naSplit.noData} no data`
      : undefined;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/" className="text-sm font-medium text-slate-400 transition hover:text-slate-700">
        ← All reports
      </Link>

      {/* Header */}
      <header className="rise mt-3 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 px-7 py-7 text-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-bold tracking-tight">{report.company}</h1>
                {report.ticker && (
                  <span className="rounded-lg bg-white/20 px-2 py-0.5 text-sm font-bold tracking-wide backdrop-blur">
                    {report.ticker}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm text-white/80">
                {[report.exchange, report.sector, `Run ${report.status}`].filter(Boolean).join("  ·  ")}
                {report.lastProcessedAt && `  ·  ${new Date(report.lastProcessedAt).toLocaleDateString()}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/api/report/${slug}/excel`}
                className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50"
              >
                <span>📊</span> Export to Excel
              </a>
              <button
                onClick={() =>
                  report.ticker
                    ? launch(report.ticker, { force: true })
                    : reanalyseRun(report.runId, { label: report.company })
                }
                disabled={busy}
                title={
                  report.ticker
                    ? "Run a fresh analysis now (ignores the 90-day cache)"
                    : "Re-analyse this company on its uploaded documents (unlisted — no re-upload needed)"
                }
                className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/30 backdrop-blur transition hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>🔄</span> {busy ? "Starting…" : "Re-analyse"}
              </button>
              <ComingSoon label="PDF" />
              <ComingSoon label="PPTX" />
            </div>
          </div>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi emoji="🟢" label="Green" value={totals.green} tint="text-emerald-600" />
          <Kpi emoji="🔴" label="Red" value={totals.red} tint="text-rose-600" />
          <Kpi emoji="⚪" label="Neutral" value={totals.neutral} tint="text-amber-600" />
          <Kpi emoji="▫️" label="N/A" value={totals.na} tint="text-slate-400" sub={naSub} />
          <Kpi emoji="✅" label="Answered" value={`${report.answered}/${report.total}`} tint="text-indigo-600" />
          <div className="grid place-items-center bg-white px-4 py-4">
            {gatePass === null ? (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold uppercase text-slate-400">Gate —</span>
            ) : gatePass ? (
              <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-emerald-600 ring-1 ring-emerald-200">
                ✓ Gate pass
              </span>
            ) : (
              <span className="rounded-full bg-rose-50 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-rose-600 ring-1 ring-rose-200">
                ✕ Gate fail
              </span>
            )}
          </div>
        </div>

        {/* distribution bar */}
        <div className="px-7 py-4">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
            <Seg n={totals.green} d={distTotal} cls="bg-emerald-400" />
            <Seg n={totals.neutral} d={distTotal} cls="bg-amber-300" />
            <Seg n={totals.red} d={distTotal} cls="bg-rose-400" />
            <Seg n={totals.na} d={distTotal} cls="bg-slate-200" />
          </div>
        </div>
      </header>

      {/* Toolbar */}
      <div className="rise sticky top-[57px] z-30 mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 backdrop-blur-xl">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search items, verdicts…"
          className="min-w-[180px] flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white focus:ring-2 focus:ring-indigo-100"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={filter === "ALL"} onClick={() => setFilter("ALL")} label={`All ${report.total}`} />
          <Chip active={filter === "GREEN"} onClick={() => setFilter("GREEN")} label={`🟢 ${totals.green}`} ring="ring-emerald-200" />
          <Chip active={filter === "RED"} onClick={() => setFilter("RED")} label={`🔴 ${totals.red}`} ring="ring-rose-200" />
          <Chip active={filter === "NEUTRAL"} onClick={() => setFilter("NEUTRAL")} label={`⚪ ${totals.neutral}`} ring="ring-amber-200" />
          <Chip active={filter === "NOT_AVAILABLE"} onClick={() => setFilter("NOT_AVAILABLE")} label={`▫️ ${totals.na}`} ring="ring-slate-200" />
        </div>
      </div>

      {/* Documents the analysis had access to */}
      <DocumentsPanel docs={report.documents} />

      {/* Sections */}
      <div className="mt-6 space-y-5">
        {sections.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-slate-300 bg-white/50 py-16 text-center text-slate-500">
            <div className="text-3xl">🪄</div>
            <p className="mt-2 text-sm">No items match this filter.</p>
          </div>
        ) : (
          sections.map((s) => <SectionCard key={s.code} section={s} />)
        )}
      </div>

      <p className="mt-8 text-center text-xs text-slate-400">
        Flags only — no numeric scoring. Web-sourced verdicts are marked low-confidence and cross-checked — corroborate before acting.
      </p>
      {overlay}
    </div>
  );
}

function SectionCard({ section }: { section: ReportSection }) {
  const c = section.counts;
  return (
    <section className="rise overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span className="grid h-9 min-w-9 place-items-center rounded-xl bg-gradient-to-br from-slate-800 to-slate-600 px-2 text-xs font-bold text-white shadow-sm">
            {section.code}
          </span>
          <h2 className="font-semibold tracking-tight text-slate-800">{section.name}</h2>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold">
          {c.green > 0 && <Mini emoji="🟢" n={c.green} cls="text-emerald-600" />}
          {c.red > 0 && <Mini emoji="🔴" n={c.red} cls="text-rose-600" />}
          {c.neutral > 0 && <Mini emoji="⚪" n={c.neutral} cls="text-amber-600" />}
          {c.na > 0 && <Mini emoji="▫️" n={c.na} cls="text-slate-400" />}
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {section.items.map((it) => (
          <ItemRow key={it.id} it={it} />
        ))}
      </ul>
      <SectionSources items={section.items} />
    </section>
  );
}

/** Distinct source documents used to answer this section's items. */
function SectionSources({ items }: { items: ReportItem[] }) {
  const docs = Array.from(new Set(items.map((i) => i.source.doc).filter((d): d is string => !!d)));
  if (docs.length === 0) return null;
  return (
    <div className="border-t border-slate-100 bg-slate-50/40 px-5 py-2.5 text-[11px] leading-relaxed">
      <span className="font-semibold uppercase tracking-wide text-slate-400">Sources · </span>
      <span className="text-slate-500">{docs.join("  ·  ")}</span>
    </div>
  );
}

function docTypeLabel(type: string): string {
  switch (type) {
    case "ANNUAL_REPORT":
      return "Annual report";
    case "EARNINGS_PDF":
      return "Concall";
    case "SCREENER_PAGE":
      return "Screener";
    case "ANNOUNCEMENT":
      return "Filing";
    default:
      return type.replace(/_/g, " ").toLowerCase();
  }
}

/** Collapsible list of the documents this run harvested + read from. */
function DocumentsPanel({ docs }: { docs: ReportDoc[] }) {
  if (!docs.length) return null;
  return (
    <details className="group mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-3.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-slate-700">
        <span>
          Documents referenced <span className="text-slate-400">· {docs.length}</span>
        </span>
        <span className="text-xs font-medium text-indigo-500">
          <span className="group-open:hidden">show</span>
          <span className="hidden group-open:inline">hide</span>
        </span>
      </summary>
      <ul className="mt-3 grid grid-cols-1 gap-1.5 border-t border-slate-100 pt-3 sm:grid-cols-2">
        {docs.map((d, i) => (
          <li key={`${d.name}-${i}`} className="flex items-center gap-2 text-xs text-slate-500">
            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {docTypeLabel(d.type)}
            </span>
            {d.url ? (
              <a href={d.url} target="_blank" rel="noreferrer" className="truncate text-indigo-500 transition hover:text-indigo-700">
                {d.name}
              </a>
            ) : (
              <span className="truncate">{d.name}</span>
            )}
            {d.pages != null && <span className="ml-auto shrink-0 text-slate-300">{d.pages}p</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

// Memoised: rows keep the same ReportItem reference across filter/search
// changes, so unchanged rows skip re-rendering entirely.
const ItemRow = memo(function ItemRow({ it }: { it: ReportItem }) {
  const f = effective(it);
  const meta = FLAG[f];
  const stale = !it.flag && !!it.staleFlag;
  const [whyOpen, setWhyOpen] = useState(false);
  // Lead with the reasoned narrative (verdict); fall back to the concise value.
  const detail =
    it.verdict && it.verdict.toLowerCase() !== "not available" ? it.verdict : it.value;

  return (
    <li className="flex gap-4 px-5 py-4 transition hover:bg-slate-50/70">
      <div className="flex flex-col items-center gap-1.5 pt-0.5">
        <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold ring-1 ${meta.chip} ${stale ? "opacity-60" : ""}`}>
          <span>{meta.emoji}</span>
          {meta.label}
        </span>
        <button
          type="button"
          onClick={() => setWhyOpen((o) => !o)}
          aria-label="Why this flag?"
          aria-expanded={whyOpen}
          title="Why this flag?"
          className={`grid h-5 w-5 place-items-center rounded-full border text-[11px] font-bold transition ${
            whyOpen
              ? "border-indigo-300 bg-indigo-50 text-indigo-600"
              : "border-slate-200 bg-white text-slate-400 hover:border-indigo-200 hover:text-indigo-500"
          }`}
        >
          ?
        </button>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-500">{it.id}</span>
          <span className="font-medium text-slate-800">{it.item}</span>
          {it.isNonNegotiable && (
            <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-600 ring-1 ring-violet-200">
              non-negotiable
            </span>
          )}
          {it.needsReview && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
              needs review
            </span>
          )}
          {stale && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">stale</span>
          )}
          {it.naKind === "not_applicable" && (
            <span
              title="This is a listed-company / market disclosure — it does not apply to an unlisted company."
              className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 ring-1 ring-slate-200"
            >
              not applicable
            </span>
          )}
          {it.naKind === "no_data" && (
            <span
              title="Couldn't be answered from the available documents or web sources."
              className="rounded bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400 ring-1 ring-slate-200"
            >
              no data
            </span>
          )}
        </div>
        {detail && <p className="mt-1 text-sm leading-relaxed text-slate-600">{detail}</p>}
        {it.evidenceQuote && (
          <p className="mt-1.5 border-l-2 border-slate-200 pl-3 text-xs italic leading-relaxed text-slate-400">
            “{it.evidenceQuote}”
          </p>
        )}
        {it.table && it.table.rows.length > 0 && <BreakdownTable table={it.table} />}
        {whyOpen && <WhyPanel it={it} flag={f} />}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Confidence v={it.confidence} />
        {it.source.url && (
          <a
            href={it.source.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-indigo-500 transition hover:text-indigo-700"
          >
            source ↗{it.source.page != null ? ` p.${it.source.page}` : ""}
          </a>
        )}
      </div>
    </li>
  );
});

// The audit trace behind a flag: what decided it, how sure, and from where.
function WhyPanel({ it, flag }: { it: ReportItem; flag: FlagName }) {
  const meta = FLAG[flag];
  return (
    <div className="mt-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-600">Why this is {meta.label.toLowerCase()}</span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {confidenceLabel(it.confidence)} confidence
        </span>
      </div>
      <p className="mt-1.5 leading-relaxed text-slate-600">
        {it.verdict || it.value || "No reasoning was recorded for this item."}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-200/70 pt-2 text-[11px] text-slate-400">
        <span>
          Decided by <b className="font-semibold text-slate-500">{basisLabel(it.provider)}</b>
        </span>
        {it.source.url ? (
          <a
            href={it.source.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-indigo-500 transition hover:text-indigo-700"
          >
            source ↗{it.source.page != null ? ` p.${it.source.page}` : ""}
          </a>
        ) : (
          <span>Source: {it.source.page != null ? `p.${it.source.page}` : "—"}</span>
        )}
      </div>
    </div>
  );
}

function confidenceLabel(v: number | null): string {
  if (v == null) return "—";
  return v >= 0.8 ? "High" : v >= 0.45 ? "Medium" : "Low";
}

/** Plain-language "how was this flag decided" from the provider string. */
function basisLabel(provider: string | null): string {
  const p = (provider ?? "").toLowerCase();
  if (!p) return "the engine";
  if (p.includes("deterministic")) return "a deterministic rule (no AI)";
  if (p.includes("muns")) return "AI research over the web";
  return `AI reasoning over the filings`;
}

// A structured per-item breakdown (e.g. the per-director overboarding table).
function BreakdownTable({ table }: { table: NonNullable<ReportItem["table"]> }) {
  const cellClass = (cell: string, col: number) => {
    const base = col === 0 ? "font-medium text-slate-700" : "text-slate-600";
    if (cell === "Overboarded") return "font-semibold text-rose-600";
    if (cell === "OK") return "font-medium text-emerald-600";
    return base;
  };
  return (
    <div className="mt-2.5 overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[320px] border-collapse text-xs">
        <thead>
          <tr className="bg-slate-50/70">
            {table.columns.map((c, i) => (
              <th key={i} className="border-b border-slate-200 px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className="even:bg-slate-50/40">
              {row.map((cell, ci) => (
                <td key={ci} className={`border-b border-slate-100 px-3 py-1.5 tabular-nums ${cellClass(cell, ci)}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Confidence({ v }: { v: number | null }) {
  if (v == null) return null;
  const label = v >= 0.8 ? "high" : v >= 0.45 ? "med" : "low";
  const cls = v >= 0.8 ? "bg-emerald-50 text-emerald-600 ring-emerald-200" : v >= 0.45 ? "bg-amber-50 text-amber-600 ring-amber-200" : "bg-slate-100 text-slate-400 ring-slate-200";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}`}>{label}</span>;
}

function Kpi({ emoji, label, value, tint, sub }: { emoji: string; label: string; value: number | string; tint: string; sub?: string }) {
  return (
    <div className="bg-white px-4 py-4 text-center">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {emoji} {label}
      </div>
      <div className={`mt-0.5 text-2xl font-bold tabular-nums ${tint}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] font-medium leading-tight text-slate-400">{sub}</div>}
    </div>
  );
}

function Seg({ n, d, cls }: { n: number; d: number; cls: string }) {
  if (n <= 0) return null;
  return <span style={{ width: `${(n / d) * 100}%` }} className={cls} />;
}

function Chip({ active, onClick, label, ring }: { active: boolean; onClick: () => void; label: string; ring?: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
        active ? `bg-slate-900 text-white shadow-sm` : `bg-white text-slate-600 ring-1 ${ring ?? "ring-slate-200"} hover:bg-slate-50`
      }`}
    >
      {label}
    </button>
  );
}

function Mini({ emoji, n, cls }: { emoji: string; n: number; cls: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${cls}`}>
      <span className="text-[10px]">{emoji}</span>
      {n}
    </span>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <span
      title="Coming soon"
      className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold text-white/60 ring-1 ring-white/20"
    >
      {label}
      <span className="rounded bg-white/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider">soon</span>
    </span>
  );
}
