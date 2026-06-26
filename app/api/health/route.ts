import { connection } from "next/server";
import { buildHealthReport } from "@/lib/health";

// Route handlers are not cached by default; connection() additionally guarantees
// this runs per request so env vars and live pings are always fresh.
export async function GET() {
  await connection();
  const report = await buildHealthReport();
  return Response.json(report);
}
