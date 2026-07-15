import Link from "next/link";
import { connection } from "next/server";
import { loadReport, type CompanyReport } from "@/lib/report";
import { ReportView } from "./ReportView";

export default async function ReportPage({ params }: { params: Promise<{ ticker: string }> }) {
  await connection();
  const { ticker } = await params;
  let report: CompanyReport | null = null;
  let dbError = false;
  try {
    report = await loadReport(decodeURIComponent(ticker));
  } catch {
    dbError = true;
  }

  if (!report) {
    return (
      <div className="mx-auto grid max-w-2xl place-items-center px-6 py-24 text-center">
        <div className="text-5xl">{dbError ? "🔌" : "🔍"}</div>
        <h1 className="mt-4 text-2xl font-semibold text-slate-800">
          {dbError ? "Database unavailable" : "No report found"}
        </h1>
        <p className="mt-2 text-slate-500">
          {dbError
            ? "Couldn't reach the database — check the Cloudflare D1 connection (CLOUDFLARE_API_TOKEN)."
            : `No analysed run exists for “${decodeURIComponent(ticker)}” yet.`}
        </p>
        <Link
          href="/"
          className="mt-6 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
        >
          ← Back to reports
        </Link>
      </div>
    );
  }

  return <ReportView report={report} />;
}
