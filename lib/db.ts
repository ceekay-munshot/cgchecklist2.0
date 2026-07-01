import { PrismaClient } from "@prisma/client/edge";
import type { PrismaClient as BasePrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";

// Cloudflare Workers can't run Prisma's native query engine. We connect through
// Prisma Accelerate, which runs the engine in Prisma's cloud and speaks to it
// over HTTPS — the one connection style that works on Workers. DATABASE_URL is
// the Accelerate connection string ("prisma://…"); Accelerate holds the real
// Neon connection. Works identically in Node (scripts/local) with the same URL.
//
// The runtime client is the Accelerate-extended edge client; we type the export
// as the base PrismaClient (type-only import, erased at build) so `include`/
// relation inference stays exact for callers.
const globalForPrisma = globalThis as unknown as {
  prisma: BasePrismaClient | undefined;
};

const LOG: ("error" | "warn")[] = process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"];

function createClient(): BasePrismaClient {
  return new PrismaClient({ log: LOG }).$extends(withAccelerate()) as unknown as BasePrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
