import Link from "next/link";

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">
        Internal tool
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        Corporate Governance Checklist
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
        Ingests a company&rsquo;s annual report and filings, evaluates ~106
        governance checklist items against the SEBI LODR / Ind AS framework, and
        produces a flag-based report &mdash; no numeric scoring.
      </p>

      <dl className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <dt className="text-sm font-medium text-zinc-500">Output per item</dt>
          <dd className="mt-1 text-sm">
            A green / red / neutral / not-available flag, a one-liner verdict,
            supporting evidence, and a source.
          </dd>
        </div>
        <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <dt className="text-sm font-medium text-zinc-500">Exports</dt>
          <dd className="mt-1 text-sm">
            Excel and PPT / PDF reports for review and distribution.
          </dd>
        </div>
      </dl>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/health"
          className="inline-flex items-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Check provider health &rarr;
        </Link>
        <a
          href="/PROJECT_BRIEF.md"
          className="inline-flex items-center rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Read the project brief
        </a>
      </div>
    </div>
  );
}
