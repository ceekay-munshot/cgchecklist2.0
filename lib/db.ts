import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";

// The Prisma Client is engine-free (see prisma/schema.prisma `queryCompiler`), so
// it MUST be constructed with a driver adapter. We use Neon's serverless driver
// over HTTPS (poolQueryViaFetch) — the only DB connection style that works on
// Cloudflare Workers, and it works identically in Node (GitHub Actions, local,
// scripts). No raw TCP, no native engine binary, no runtime detection needed.
neonConfig.poolQueryViaFetch = true;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const LOG: ("error" | "warn")[] = process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"];

function createClient(): PrismaClient {
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL ?? "" });
  return new PrismaClient({ adapter, log: LOG });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
