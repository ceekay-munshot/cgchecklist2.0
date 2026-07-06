import Link from "next/link";
import { connection } from "next/server";
import { listCompanyCards, type CompanyCard } from "@/lib/report";
import SearchLauncher from "@/app/components/SearchLauncher";

export default async function Home() {
  await connection();
  let listed: CompanyCard[] = [];
  let unlisted: CompanyCard[] = [];
  let dbError = false;
  try {
    const all = await listCompanyCards();
    // Listed: complete, high-coverage runs (>85 of ~103 answered) — hides
    // thin/half-filled companies that read as low quality.
    listed = all.filter((c) => c.ticker && c.status === "DONE" && c.answered > 85);
    // Unlisted (uploaded documents): partial coverage is expected (market/DB
    // items are N/A), so use a relaxed bar and a separate section.
    unlisted = all.filter((c) => !c.ticker && c.status === "DONE" && c.answered > 20);
  } catch {
    dbError = true;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      {/* Hero — relative z-20 so the search dropdown floats above the cards below */}
      <section className="rise relative z-20">
        <span className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-indigo-600 ring-1 ring-indigo-100">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" /> Corporate Governance Intelligence
        </span>
        <h1 className="mt-4 max-w-3xl bg-gradient-to-br from-slate-900 to-slate-600 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
          Governance reports for Indian listed companies
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-600">
          ~100 checklist items per company, each a clear{" "}
          <span className="font-semibold text-emerald-600">green</span> /{" "}
          <span className="font-semibold text-rose-600">red</span> /{" "}
          <span className="font-semibold text-amber-600">neutral</span> flag with a verdict, evidence and source.{" "}
          <span className="text-slate-400">No numeric scoring.</span>
        </p>
        <SearchLauncher />
        <p className="mt-3 text-sm text-slate-500">
          Private / unlisted company?{" "}
          <Link href="/unlisted/new" className="font-semibold text-indigo-600 transition hover:text-indigo-700">
            Upload its documents →
          </Link>
        </p>
      </section>

      {/* Listed companies */}
      <section className="mt-10">
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Analysed companies {listed.length > 0 && <span className="text-slate-300">· {listed.length}</span>}
          </h2>
        </div>

        {dbError ? (
          <EmptyPanel emoji="🔌" title="Database unavailable" body="Couldn't reach the database. Check DATABASE_URL, then refresh." />
        ) : listed.length === 0 ? (
          <EmptyPanel
            emoji="🌱"
            title="No reports yet"
            body="Search any company above to run its first analysis — it’ll appear here once complete."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {listed.map((c) => (
              <CompanyTile key={c.runId} c={c} />
            ))}
          </div>
        )}
      </section>

      {/* Unlisted companies (uploaded documents) */}
      <section className="mt-10">
        <div className="mb-3 flex items-end justify-between gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Unlisted companies {unlisted.length > 0 && <span className="text-slate-300">· {unlisted.length}</span>}
          </h2>
          <Link href="/unlisted/new" className="text-xs font-semibold text-indigo-600 transition hover:text-indigo-700">
            + Analyse an unlisted company
          </Link>
        </div>

        {unlisted.length === 0 ? (
          <EmptyPanel
            emoji="📄"
            title="No unlisted companies yet"
            body="Upload a private company’s annual report or financial statements to analyse it on the same checklist."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {unlisted.map((c) => (
              <CompanyTile key={c.runId} c={c} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyPanel({ emoji, title, body }: { emoji: string; title: string; body: string }) {
  return (
    <div className="rise grid place-items-center rounded-3xl border border-dashed border-slate-300 bg-white/50 px-6 py-16 text-center">
      <div className="text-4xl">{emoji}</div>
      <h3 className="mt-3 text-lg font-semibold text-slate-800">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">{body}</p>
    </div>
  );
}

function CompanyTile({ c }: { c: CompanyCard }) {
  const slug = encodeURIComponent(c.ticker ?? c.runId);
  const total = Math.max(1, c.green + c.neutral + c.na + c.reds);
  const seg = (n: number) => `${(n / total) * 100}%`;
  return (
    <Link
      href={`/report/${slug}`}
      className="rise group flex flex-col gap-2.5 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg"
    >
      {/* title row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-md bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide text-white">
            {c.ticker ?? "—"}
          </span>
          <h3 className="truncate text-sm font-semibold tracking-tight text-slate-800">{c.company}</h3>
        </div>
        <GateBadge gatePass={c.gatePass} />
      </div>

      {/* distribution bar */}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <span style={{ width: seg(c.green) }} className="bg-emerald-400" />
        <span style={{ width: seg(c.neutral) }} className="bg-amber-300" />
        <span style={{ width: seg(c.reds) }} className="bg-rose-400" />
        <span style={{ width: seg(c.na) }} className="bg-slate-200" />
      </div>

      {/* compact stats */}
      <div className="flex items-center gap-2.5 text-xs font-semibold tabular-nums">
        <Dot className="bg-emerald-500" n={c.green} />
        <Dot className="bg-rose-500" n={c.reds} />
        <Dot className="bg-amber-400" n={c.neutral} />
        <Dot className="bg-slate-300" n={c.na} />
      </div>

      {/* footer: last-run date + answered count */}
      <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-[10.5px] text-slate-400">
        <span title={new Date(c.updatedAt).toLocaleString()}>Updated {timeAgo(c.updatedAt)}</span>
        <span className="tabular-nums">{c.answered}/{c.total}</span>
      </div>
    </Link>
  );
}

/** Compact "x ago" for the card's last-run stamp. */
function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const d = Math.floor(secs / 86400);
  if (d >= 1) return d === 1 ? "1 day ago" : `${d} days ago`;
  const h = Math.floor(secs / 3600);
  if (h >= 1) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const m = Math.floor(secs / 60);
  if (m >= 1) return m === 1 ? "1 min ago" : `${m} min ago`;
  return "just now";
}

function Dot({ n, className }: { n: number; className: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-slate-600">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {n}
    </span>
  );
}

function GateBadge({ gatePass }: { gatePass: boolean | null }) {
  if (gatePass === null) return null;
  return gatePass ? (
    <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-600 ring-1 ring-emerald-200">
      ✓ Gate
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-600 ring-1 ring-rose-200">
      ✕ Gate
    </span>
  );
}
