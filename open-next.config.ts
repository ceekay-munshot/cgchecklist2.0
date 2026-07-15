import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// OpenNext → Cloudflare adapter config. This is what makes `next build`'s output
// deployable as a Cloudflare Worker (fixing "Workers Builds"). Defaults are fine:
// the app does not rely on ISR/on-demand revalidation, so no incremental-cache,
// tag-cache, or queue backend is wired up yet. The database is reached over the
// D1 HTTP API (lib/db.ts → PrismaD1Http), independent of this adapter.
export default defineCloudflareConfig();
