import type { ProviderStatus } from "@/lib/health-types";
import { prisma } from "@/lib/db";
import { llmProviders } from "@/lib/llm";
import { researchers } from "@/lib/scrape";

async function pingDatabase(): Promise<ProviderStatus> {
  const base = {
    id: "database",
    label: "Cloudflare D1",
    category: "database",
    role: "Primary datastore (Prisma + D1 HTTP)",
    checkedAt: new Date().toISOString(),
  } satisfies Omit<ProviderStatus, "state">;

  // D1 is reached over the HTTP API; only the API token is a secret (the account
  // + database IDs default in-code — see lib/db.ts).
  if (!(process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN)?.trim()) {
    return { ...base, state: "not_configured", message: "CLOUDFLARE_API_TOKEN not set" };
  }

  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ...base, state: "green", latencyMs: Date.now() - started, message: "ok" };
  } catch (e) {
    return {
      ...base,
      state: "red",
      latencyMs: Date.now() - started,
      message: (e as Error).message,
    };
  }
}

export interface HealthReport {
  checkedAt: string;
  summary: {
    green: number;
    red: number;
    notConfigured: number;
    total: number;
  };
  providers: ProviderStatus[];
}

/**
 * Ping every LLM provider, every web researcher, and the database concurrently.
 * Each check is self-contained and never throws (failures become a red status),
 * so one bad provider can't break the page.
 */
export async function checkAllProviders(): Promise<ProviderStatus[]> {
  const checks: Array<Promise<ProviderStatus>> = [
    ...Object.values(llmProviders).map((p) => p.ping()),
    ...Object.values(researchers).map((r) => r.ping()),
    pingDatabase(),
  ];
  return Promise.all(checks);
}

export async function buildHealthReport(): Promise<HealthReport> {
  const providers = await checkAllProviders();
  return {
    checkedAt: new Date().toISOString(),
    summary: {
      green: providers.filter((p) => p.state === "green").length,
      red: providers.filter((p) => p.state === "red").length,
      notConfigured: providers.filter((p) => p.state === "not_configured").length,
      total: providers.length,
    },
    providers,
  };
}
