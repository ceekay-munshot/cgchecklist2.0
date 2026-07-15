import { connection } from "next/server";
import { PrismaClient } from "@prisma/client";
import { PrismaD1, PrismaD1HTTP } from "@prisma/adapter-d1";

// TEMPORARY diagnostic: reports what the runtime sees for the D1 connection and
// tries BOTH access paths (binding + HTTP) so a live failure is pinpointed to a
// specific cause. Returns only booleans + error messages — never secret values.
// Remove once the live DB connection is confirmed.
export async function GET() {
  await connection();
  const out: Record<string, unknown> = {};

  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] as
    | { env?: Record<string, unknown> }
    | undefined;
  const env = ctx?.env;
  out.hasCloudflareContext = !!ctx;
  out.envKeys = env ? Object.keys(env).sort() : null;
  out.hasDBBinding = !!env?.DB;
  out.tokenInProcessEnv = !!(process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_D1_TOKEN);
  out.tokenInContext = !!(env?.CLOUDFLARE_API_TOKEN || env?.CLOUDFLARE_D1_TOKEN);

  // Path A — the D1 binding (no token).
  if (env?.DB) {
    try {
      const p = new PrismaClient({ adapter: new PrismaD1(env.DB as ConstructorParameters<typeof PrismaD1>[0]) });
      out.bindingSectionCount = await p.checklistSection.count();
      out.binding = "OK";
    } catch (e) {
      out.binding = `ERROR: ${(e as Error).name}: ${(e as Error).message}`;
    }
  } else {
    out.binding = "skipped (no DB binding)";
  }

  // Path B — the D1 HTTP API + token.
  try {
    const token =
      process.env.CLOUDFLARE_API_TOKEN ||
      process.env.CLOUDFLARE_D1_TOKEN ||
      (env?.CLOUDFLARE_API_TOKEN as string) ||
      (env?.CLOUDFLARE_D1_TOKEN as string) ||
      "";
    const p = new PrismaClient({
      adapter: new PrismaD1HTTP({
        CLOUDFLARE_ACCOUNT_ID: "489675fbe898cd94904c654de83ade00",
        CLOUDFLARE_DATABASE_ID: "a29b643f-0b80-44af-ac1c-4a721f8345ed",
        CLOUDFLARE_D1_TOKEN: token,
      }),
    });
    out.httpSectionCount = await p.checklistSection.count();
    out.http = "OK";
  } catch (e) {
    out.http = `ERROR: ${(e as Error).name}: ${(e as Error).message}`;
  }

  return Response.json(out);
}
