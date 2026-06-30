import { connection } from "next/server";
import { loadReport } from "@/lib/report";
import { buildExcelReport, reportFilename } from "@/lib/export/excel";

// Generates the .xlsx on demand from the latest run for this ticker (or runId).
export async function GET(_req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  await connection();
  const { ticker } = await ctx.params;
  const report = await loadReport(decodeURIComponent(ticker));
  if (!report) {
    return new Response("No analysed run found for this company.", { status: 404 });
  }
  const buf = await buildExcelReport(report);
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${reportFilename(report)}"`,
      "Cache-Control": "no-store",
    },
  });
}
