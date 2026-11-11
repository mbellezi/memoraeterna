import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "scripts/ask/**/*.test.ts",
      "scripts/bench/**/*.test.ts",
      "scripts/contrast/**/*.test.ts",
      "scripts/kpi/**/*.test.ts",
      "scripts/lib/**/*.test.ts",
      "scripts/db/**/*.test.ts",
      "scripts/golden/**/*.test.ts",
      "scripts/lib/**/*.test.ts",
      "scripts/relations/**/*.test.ts",
      "scripts/screens/**/*.test.ts",
      "scripts/soak/**/*.test.ts",
      "scripts/spikes/atlas/**/*.test.ts",
      "scripts/topics/**/*.test.ts",
      "e2e/support/**/*.test.ts"
    ],
    coverage: {
      reporter: ["text", "lcov"]
    }
  }
});
