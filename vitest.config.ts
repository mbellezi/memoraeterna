import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx"
    ],
    coverage: {
      reporter: ["text", "lcov"]
    }
  }
});
