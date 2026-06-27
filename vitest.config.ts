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
  },
});
