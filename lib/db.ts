import { PrismaClient } from "@prisma/client";
import { PrismaD1Http } from "@prisma/adapter-d1";

// Datastore: Cloudflare D1 (SQLite) over the D1 HTTP API. ONE connection style for
// BOTH runtimes — the analysis job (GitHub Actions, Node) and the web app
// (Cloudflare Worker) — so the `prisma` singleton below is imported unchanged by
// every caller (no per-request client, no bindings, no connection string).
//
// The account + database IDs are PUBLIC identifiers (they appear in dashboard URLs),
// so they default in-code; only the API TOKEN is a secret, provided via env
// (CLOUDFLARE_API_TOKEN) in the Worker's secrets and the GitHub Actions secrets.
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "489675fbe898cd94904c654de83ade00";
const CF_DATABASE_ID = process.env.CLOUDFLARE_DATABASE_ID || "a29b643f-0b80-44af-ac1c-4a721f8345ed";
const CF_D1_TOKEN = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function createClient(): PrismaClient {
  const adapter = new PrismaD1Http({
    CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    CLOUDFLARE_DATABASE_ID: CF_DATABASE_ID,
    CLOUDFLARE_D1_TOKEN: CF_D1_TOKEN,
  });
  return new PrismaClient({ adapter, log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"] });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
