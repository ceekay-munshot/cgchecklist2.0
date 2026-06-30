import Link from "next/link";
import { connection } from "next/server";
import { listCompanyCards, type CompanyCard } from "@/lib/report";
import SearchLauncher from "@/app/components/SearchLauncher";

export default async function Home() {
  await connection();
  let cards: CompanyCard[] = [];
  let dbError = false;
  try {
    cards = await listCompanyCards();
  } catch {
    dbError = true;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      {/* Hero */}
      <section className="rise">
        <span className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-indigo-600 ring-1 ring-indigo-100">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" /> Corporate Governance Intelligence
        </span>
        <h1 className="mt-4 max-w-3xl bg-gradient-to-br from-slate-900 to-slate-600 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
          Governance reports for Indian listed companies
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-600">
          ~106 checklist items per company, each a clear{" "}
          <span className="font-semibold text-emerald-600">green</span> /{" "}
          <span className="font-semibold text-rose-600">red</span> /{" "}
          <span className="font-semibold text-amber-600">neutral</span> flag with a verdict, evidence and source.{" "}
          <span className="text-slate-400">No numeric scoring.</span>
        </p>
        <SearchLauncher />
      </section>

      {/* Companies */}
      <section className="mt-12">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            Analysed companies {cards.length > 0 && <span className="text-slate-300">· {cards.length}</span>}
          </h2>
        </div>

        {dbError ? (
          <EmptyPanel
            emoji="🔌"
            title="Database unavailable"
            body="Couldn't reach the database. Check DATABASE_URL, then refresh."
          />
        ) : cards.length === 0 ? (
          <EmptyPanel
            emoji="🌱"
            title="No reports yet"
            body="Search any company above to run its first analysis — it’ll appear here once complete."
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => (
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
      className="rise group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-transparent transition hover:-translate-y-0.5 hover:shadow-xl hover:ring-indigo-100"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold tracking-tight text-slate-900">{c.company}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            {c.ticker && (
              <span className="rounded-md bg-slate-900 px-1.5 py-0.5 font-bold tracking-wide text-white">{c.ticker}</span>
            )}
            {c.exchange && <span className="text-slate-400">{c.exchange}</span>}
            {c.sector && <span className="truncate text-slate-400">· {c.sector}</span>}
          </div>
        </div>
        <GateBadge gatePass={c.gatePass} />
      </div>

      {/* distribution bar */}
      <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <span style={{ width: seg(c.green) }} className="bg-emerald-400" />
        <span style={{ width: seg(c.neutral) }} className="bg-amber-300" />
        <span style={{ width: seg(c.reds) }} className="bg-rose-400" />
        <span style={{ width: seg(c.na) }} className="bg-slate-200" />
      </div>

      <div className="mt-3 flex items-center gap-3 text-xs font-medium">
        <Stat emoji="🟢" n={c.green} className="text-emerald-600" />
        <Stat emoji="🔴" n={c.reds} className="text-rose-600" />
        <Stat emoji="⚪" n={c.neutral} className="text-amber-600" />
        <Stat emoji="▫️" n={c.na} className="text-slate-400" />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
        <span className="text-xs text-slate-400">
          {c.answered}/{c.total} answered · {c.status}
        </span>
        <span className="text-sm font-semibold text-indigo-600 transition group-hover:translate-x-0.5">View →</span>
      </div>
    </Link>
  );
}

function Stat({ emoji, n, className }: { emoji: string; n: number; className: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span className="text-[11px]">{emoji}</span>
      {n}
    </span>
  );
}

function GateBadge({ gatePass }: { gatePass: boolean | null }) {
  if (gatePass === null)
    return <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-400">—</span>;
  return gatePass ? (
    <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-600 ring-1 ring-emerald-200">
      ✓ Gate
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-rose-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-rose-600 ring-1 ring-rose-200">
      ✕ Gate
    </span>
  );
}
