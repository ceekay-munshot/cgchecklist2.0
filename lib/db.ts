import { PrismaClient } from "@prisma/client";
import { PrismaD1, PrismaD1Http } from "@prisma/adapter-d1";

// Datastore: Cloudflare D1 (SQLite). ONE `prisma` singleton for BOTH runtimes —
// the analysis job (GitHub Actions, Node) and the web app (Cloudflare Worker) —
// so every caller imports it unchanged. The account + database IDs are PUBLIC
// identifiers (they appear in dashboard URLs) and default in-code; only the API
// TOKEN is a secret.
//
// WORKER GOTCHA: on Cloudflare Workers, bindings + secrets are NOT on process.env
// and are NOT available at module-load — they live on a PER-REQUEST context that
// OpenNext stashes on globalThis[Symbol.for("__cloudflare-context__")]. So we must
// (a) build the client LAZILY (first use happens inside a request, when that
// context exists) and (b) read the D1 access from that context there:
//   - Worker  → the D1 **binding** (env.DB) — no token needed, same-datacentre.
//   - Node    → the D1 **HTTP API** + CLOUDFLARE_API_TOKEN from process.env.
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "489675fbe898cd94904c654de83ade00";
const CF_DATABASE_ID = process.env.CLOUDFLARE_DATABASE_ID || "a29b643f-0b80-44af-ac1c-4a721f8345ed";

const LOG: ("error" | "warn")[] = process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"];

// The Worker's env (bindings + vars + secrets) from OpenNext's request-scoped
// Cloudflare context. Returns undefined in plain Node (the symbol is absent), and
// also at module-load on the Worker (the context is only set during a request) —
// which is exactly why the client below is created lazily.
type CfEnv = { DB?: unknown; CLOUDFLARE_API_TOKEN?: string; CLOUDFLARE_D1_TOKEN?: string; CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_DATABASE_ID?: string };
function cloudflareEnv(): CfEnv | undefined {
  return (globalThis as unknown as Record<symbol, { env?: CfEnv } | undefined>)[Symbol.for("__cloudflare-context__")]?.env;
}

function createClient(): PrismaClient {
  const cf = cloudflareEnv();
  // On the Worker the D1 binding is present — use it directly (no token, no HTTP).
  if (cf?.DB) {
    return new PrismaClient({ adapter: new PrismaD1(cf.DB as ConstructorParameters<typeof PrismaD1>[0]), log: LOG });
  }
  // Node (Actions / local): D1 over the HTTP API. Token from process.env, or the
  // Cloudflare context as a fallback if we ever run this branch on the Worker.
  const token =
    process.env.CLOUDFLARE_D1_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN ||
    cf?.CLOUDFLARE_D1_TOKEN ||
    cf?.CLOUDFLARE_API_TOKEN ||
    "";
  const adapter = new PrismaD1Http({
    CLOUDFLARE_ACCOUNT_ID: cf?.CLOUDFLARE_ACCOUNT_ID || CF_ACCOUNT_ID,
    CLOUDFLARE_DATABASE_ID: cf?.CLOUDFLARE_DATABASE_ID || CF_DATABASE_ID,
    CLOUDFLARE_D1_TOKEN: token,
  });
  return new PrismaClient({ adapter, log: LOG });
}

// Lazy singleton: the real client is created on first property access. On a Worker
// that first access is inside a request (context available); in Node it's on the
// first query. Cached on globalThis so hot-reload / repeated imports reuse it.
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };
function getClient(): PrismaClient {
  if (!globalForPrisma.__prisma) globalForPrisma.__prisma = createClient();
  return globalForPrisma.__prisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
});
