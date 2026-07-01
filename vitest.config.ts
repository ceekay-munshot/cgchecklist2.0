import { defineConfig } from "vitest/config";

// The codebase imports modules via the `@/` path alias (see tsconfig paths).
// Vitest needs the same alias to resolve those imports inside tests.
export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "node",
    // The Prisma Accelerate client validates DATABASE_URL eagerly; give tests a
    // dummy Accelerate URL so incidental client init doesn't emit noise. Tests
    // that touch the DB mock it — nothing here makes a real connection.
    env: {
      DATABASE_URL: "prisma://accelerate.prisma-data.net/?api_key=test",
    },
  },
});
