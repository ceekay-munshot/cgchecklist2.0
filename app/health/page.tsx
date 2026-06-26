import { connection } from "next/server";
import { checkAllProviders } from "@/lib/health";
import { HealthDashboard } from "./HealthDashboard";

export default async function HealthPage() {
  // Force request-time rendering so the statuses below reflect live pings and
  // the current environment, not a build-time snapshot.
  await connection();
  const providers = await checkAllProviders();
  return <HealthDashboard initial={providers} />;
}
