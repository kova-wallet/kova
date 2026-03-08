import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@kova": path.resolve(__dirname, "../src"),
    },
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  },
});
