import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "scripts/contrast/**/*.test.ts",
      "scripts/kpi/**/*.test.ts",
      "scripts/db/**/*.test.ts",
      "scripts/golden/**/*.test.ts",
      "scripts/relations/**/*.test.ts",
      "scripts/soak/**/*.test.ts",
      "scripts/topics/**/*.test.ts"
    ],
    coverage: {
      reporter: ["text", "lcov"]
    }
  }
});
