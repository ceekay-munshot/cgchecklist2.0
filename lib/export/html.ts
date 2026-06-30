import type { CompanyReport, ReportItem, ReportSection, FlagName } from "@/lib/report";

/**
 * A self-contained, dependency-free HTML report (inline CSS) that mirrors the
 * web UI's look. Opens in any browser with no server or database — used by the
 * report-export job so a report can be downloaded and shared as a single file.
 */

const FLAG: Record<FlagName, { emoji: string; label: string; bg: string; fg: string; ring: string; bar: string }> = {
  GREEN: { emoji: "🟢", label: "Green", bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0", bar: "#34d399" },
  RED: { emoji: "🔴", label: "Red", bg: "#fff1f2", fg: "#be123c", ring: "#fecdd3", bar: "#fb7185" },
  NEUTRAL: { emoji: "⚪", label: "Neutral", bg: "#fffbeb", fg: "#b45309", ring: "#fde68a", bar: "#fcd34d" },
  NOT_AVAILABLE: { emoji: "▫️", label: "N/A", bg: "#f1f5f9", fg: "#64748b", ring: "#e2e8f0", bar: "#e2e8f0" },
};

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function eff(it: ReportItem): FlagName {
  return (it.flag ?? it.staleFlag ?? "NOT_AVAILABLE") as FlagName;
}

function itemRow(it: ReportItem): string {
  const m = FLAG[eff(it)];
  const detail = it.value && it.value.toLowerCase() !== "not available" ? it.value : it.verdict;
  const conf =
    it.confidence == null
      ? ""
      : `<span class="conf">${it.confidence >= 0.8 ? "high" : it.confidence >= 0.45 ? "med" : "low"}</span>`;
  const src = it.source.url
    ? `<a class="src" href="${esc(it.source.url)}" target="_blank" rel="noreferrer">source ↗${it.source.page != null ? ` p.${it.source.page}` : ""}</a>`
    : "";
  const badges =
    (it.isNonNegotiable ? `<span class="badge nn">non-negotiable</span>` : "") +
    (it.needsReview ? `<span class="badge nr">needs review</span>` : "");
  return `<li class="row">
    <span class="chip" style="background:${m.bg};color:${m.fg};box-shadow:0 0 0 1px ${m.ring} inset">${m.emoji} ${m.label}</span>
    <div class="body">
      <div class="head"><span class="id">${esc(it.id)}</span><span class="q">${esc(it.item)}</span>${badges}</div>
      ${detail ? `<p class="detail">${esc(detail)}</p>` : ""}
      ${it.evidenceQuote ? `<p class="ev">“${esc(it.evidenceQuote)}”</p>` : ""}
    </div>
    <div class="meta">${conf}${src}</div>
  </li>`;
}

function sectionCard(s: ReportSection): string {
  const c = s.counts;
  const mini = (emoji: string, n: number) => (n > 0 ? `<span>${emoji} ${n}</span>` : "");
  return `<section class="card">
    <div class="sechead">
      <div class="secname"><span class="code">${esc(s.code)}</span><h2>${esc(s.name)}</h2></div>
      <div class="counts">${mini("🟢", c.green)}${mini("🔴", c.red)}${mini("⚪", c.neutral)}${mini("▫️", c.na)}</div>
    </div>
    <ul class="rows">${s.items.map(itemRow).join("")}</ul>
  </section>`;
}

export function buildHtmlReport(r: CompanyReport): string {
  const t = r.summary?.totals ?? { green: 0, red: 0, neutral: 0, na: 0 };
  const gate = r.summary?.nonNegotiable?.gatePass ?? null;
  const dist = Math.max(1, t.green + t.red + t.neutral + t.na);
  const seg = (n: number, color: string) => (n > 0 ? `<span style="width:${(n / dist) * 100}%;background:${color}"></span>` : "");
  const kpi = (emoji: string, label: string, val: string | number, col: string) =>
    `<div class="kpi"><div class="kl">${emoji} ${label}</div><div class="kv" style="color:${col}">${val}</div></div>`;
  const gateBadge =
    gate === null
      ? `<span class="gate gnull">Gate —</span>`
      : gate
        ? `<span class="gate gpass">✓ Gate pass</span>`
        : `<span class="gate gfail">✕ Gate fail</span>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.company)} — CG Report</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    color:#0f172a;background:radial-gradient(1200px 600px at 100% -10%,#eef2ff,rgba(238,242,255,0) 55%),linear-gradient(180deg,#f8fafc,#f1f5f9);min-height:100vh}
  .wrap{max-width:1000px;margin:0 auto;padding:28px 20px 60px}
  .hdr{border-radius:24px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #e2e8f0;background:#fff}
  .band{background:linear-gradient(120deg,#4f46e5,#7c3aed,#c026d3);color:#fff;padding:26px 28px}
  .band h1{margin:0;font-size:30px;font-weight:800;letter-spacing:-.02em;display:inline}
  .tick{background:rgba(255,255,255,.2);padding:2px 8px;border-radius:8px;font-weight:700;font-size:14px;margin-left:8px}
  .sub{margin-top:6px;font-size:13px;color:rgba(255,255,255,.82)}
  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:#f1f5f9}
  @media(max-width:720px){.kpis{grid-template-columns:repeat(3,1fr)}}
  .kpi{background:#fff;padding:14px;text-align:center}
  .kl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8}
  .kv{font-size:24px;font-weight:800;margin-top:2px}
  .gatewrap{display:grid;place-items:center;background:#fff;padding:14px}
  .gate{padding:6px 12px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.03em}
  .gpass{background:#ecfdf5;color:#047857;box-shadow:0 0 0 1px #a7f3d0 inset}
  .gfail{background:#fff1f2;color:#be123c;box-shadow:0 0 0 1px #fecdd3 inset}
  .gnull{background:#f1f5f9;color:#94a3b8}
  .bar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:#f1f5f9;margin:16px 28px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:18px;box-shadow:0 1px 3px rgba(0,0,0,.05);margin-top:18px;overflow:hidden}
  .sechead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;background:#f8fafc;border-bottom:1px solid #eef2f6}
  .secname{display:flex;align-items:center;gap:12px}
  .code{display:grid;place-items:center;min-width:34px;height:34px;padding:0 8px;border-radius:12px;background:linear-gradient(135deg,#1e293b,#475569);color:#fff;font-weight:800;font-size:12px}
  .sechead h2{margin:0;font-size:16px;font-weight:700;color:#1e293b}
  .counts{display:flex;gap:10px;font-size:12px;font-weight:700;color:#475569}
  .rows{list-style:none;margin:0;padding:0}
  .row{display:flex;gap:14px;padding:14px 18px;border-top:1px solid #f1f5f9}
  .row:first-child{border-top:none}
  .chip{align-self:flex-start;white-space:nowrap;padding:5px 10px;border-radius:10px;font-size:12px;font-weight:800}
  .body{flex:1;min-width:0}
  .head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
  .id{font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:700;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:5px}
  .q{font-weight:600;color:#1e293b}
  .detail{margin:5px 0 0;font-size:14px;color:#475569;line-height:1.5}
  .ev{margin:6px 0 0;padding-left:12px;border-left:2px solid #e2e8f0;font-size:12px;font-style:italic;color:#94a3b8;line-height:1.5}
  .meta{display:flex;flex-direction:column;align-items:flex-end;gap:6px;white-space:nowrap}
  .conf{padding:2px 8px;border-radius:999px;font-size:10px;font-weight:800;text-transform:uppercase;color:#64748b;background:#f1f5f9}
  .src{font-size:12px;font-weight:600;color:#6366f1;text-decoration:none}
  .badge{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;padding:2px 6px;border-radius:5px}
  .nn{background:#f5f3ff;color:#7c3aed;box-shadow:0 0 0 1px #ddd6fe inset}
  .nr{background:#fffbeb;color:#b45309;box-shadow:0 0 0 1px #fde68a inset}
  .foot{margin-top:24px;text-align:center;font-size:12px;color:#94a3b8}
</style></head>
<body><div class="wrap">
  <div class="hdr">
    <div class="band"><div><h1>${esc(r.company)}</h1>${r.ticker ? `<span class="tick">${esc(r.ticker)}</span>` : ""}</div>
      <div class="sub">${[r.exchange, r.sector, `Run ${r.status}`].filter(Boolean).map(esc).join("  ·  ")}${r.lastProcessedAt ? `  ·  ${new Date(r.lastProcessedAt).toLocaleDateString()}` : ""}</div>
    </div>
    <div class="kpis">
      ${kpi("🟢", "Green", t.green, "#059669")}${kpi("🔴", "Red", t.red, "#e11d48")}${kpi("⚪", "Neutral", t.neutral, "#d97706")}${kpi("▫️", "N/A", t.na, "#94a3b8")}${kpi("✅", "Answered", `${r.answered}/${r.total}`, "#4f46e5")}
      <div class="gatewrap">${gateBadge}</div>
    </div>
    <div class="bar">${seg(t.green, "#34d399")}${seg(t.neutral, "#fcd34d")}${seg(t.red, "#fb7185")}${seg(t.na, "#e2e8f0")}</div>
  </div>
  ${r.sections.map(sectionCard).join("")}
  <p class="foot">Flags only — no numeric scoring · SEBI LODR / Ind AS · generated ${new Date().toISOString().slice(0, 10)}</p>
</div></body></html>`;
}
