/**
 * Instant skeleton shown the moment a report link is clicked, while the server
 * loads the run. Next streams this in immediately so navigation feels snappy —
 * the click never sits on a blank screen waiting for the DB round-trip.
 */
export default function ReportLoading() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10" aria-busy="true" aria-label="Loading report">
      {/* header block */}
      <div className="animate-pulse">
        <div className="h-3 w-24 rounded bg-slate-200" />
        <div className="mt-4 h-9 w-72 max-w-full rounded-lg bg-slate-200" />
        <div className="mt-3 flex gap-2">
          <div className="h-5 w-16 rounded-md bg-slate-200" />
          <div className="h-5 w-24 rounded-md bg-slate-100" />
          <div className="h-5 w-20 rounded-md bg-slate-100" />
        </div>
      </div>

      {/* KPI strip */}
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-2xl border border-slate-200 bg-white p-4">
            <div className="h-3 w-16 rounded bg-slate-200" />
            <div className="mt-3 h-7 w-12 rounded bg-slate-200" />
          </div>
        ))}
      </div>

      {/* section + rows */}
      <div className="mt-8 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-3">
              <div className="h-6 w-20 rounded-lg bg-slate-200" />
              <div className="h-4 w-40 rounded bg-slate-200" />
            </div>
            <div className="mt-3 h-3 w-full max-w-2xl rounded bg-slate-100" />
            <div className="mt-2 h-3 w-2/3 rounded bg-slate-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
