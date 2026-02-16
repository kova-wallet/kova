import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // T8-F9 fix: Set KOVA_ALLOW_MEMORY_STORE for tests since the NODE_ENV=test
    // bypass was removed from MemoryStore's production guard.
    env: {
      KOVA_ALLOW_MEMORY_STORE: "1",
    },
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts"],
    },
    testTimeout: 30_000,
  },
});
