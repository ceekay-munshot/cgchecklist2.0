import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Prisma OUT of the Next/Turbopack server bundle so OpenNext can wire its
  // WASM query engine for the Cloudflare Worker. Without this the client is
  // inlined and fails at runtime with "could not locate the Query Engine" /
  // "query_compiler_bg.wasm no such file or directory".
  // See: https://opennext.js.org/cloudflare/howtos/db
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
