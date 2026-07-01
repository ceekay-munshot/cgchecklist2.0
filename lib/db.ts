import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";

// Reuse a single PrismaClient across hot reloads in development to avoid
// exhausting database connections. See:
// https://www.prisma.io/docs/orm/more/help-and-troubleshooting/nextjs-help
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const LOG: ("error" | "warn")[] = process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"];

/**
 * Cloudflare Workers run in a V8-isolate runtime with no raw TCP sockets, so
 * Prisma's default query engine cannot reach Postgres there. On Workers ONLY we
 * connect through Neon's serverless (WebSocket/HTTP) driver adapter. Node — the
 * GitHub Actions harvest/analyze/export jobs, local dev, and scripts — keeps the
 * standard client completely untouched, so nothing that works today changes.
 */
function onCloudflareWorkers(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

function createClient(): PrismaClient {
  if (onCloudflareWorkers()) {
    // Route simple queries over HTTP fetch (robust on Workers); transactions
    // still use WebSockets via the pool.
    neonConfig.poolQueryViaFetch = true;
    const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL ?? "" });
    return new PrismaClient({ adapter, log: LOG });
  }
  return new PrismaClient({ log: LOG });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
