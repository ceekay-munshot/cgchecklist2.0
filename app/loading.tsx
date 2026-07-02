/**
 * Instant skeleton for the home page. Because the page is dynamically rendered
 * (live DB read), a navigation back here would otherwise sit on a blank screen
 * until the server responds; this paints immediately so clicks feel instant.
 */
export default function HomeLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10" aria-busy="true" aria-label="Loading">
      <div className="animate-pulse">
        <div className="h-5 w-64 rounded-full bg-slate-200" />
        <div className="mt-5 h-10 w-full max-w-2xl rounded-lg bg-slate-200" />
        <div className="mt-3 h-6 w-full max-w-xl rounded bg-slate-100" />
        <div className="mt-8 h-12 w-full max-w-xl rounded-2xl bg-slate-200" />
      </div>

      <div className="mt-12 h-3 w-40 rounded bg-slate-200" />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-xl border border-slate-200 bg-white p-3.5">
            <div className="flex items-center gap-2">
              <div className="h-4 w-16 rounded-md bg-slate-200" />
              <div className="h-4 w-24 rounded bg-slate-100" />
            </div>
            <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100" />
            <div className="mt-3 h-3 w-2/3 rounded bg-slate-100" />
            <div className="mt-3 h-2.5 w-full rounded bg-slate-50" />
          </div>
        ))}
      </div>
    </div>
  );
}
