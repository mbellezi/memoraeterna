// `npm run journeys` (F5 T137, spec 5.3): Playwright drives the built, unpackaged Memora through
// `_electron.launch`, one spec at a time, never retried (a flaky spec is red and gets fixed).
// Run it only with your own `--grep`, from the proof worktree, under the slot rules (D4).
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

import { journeysRun } from "./support/profile.js";

// Sets MEMORA_JOURNEYS_RUN in the runner, which the global setup and the workers inherit.
const run = journeysRun();

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  globalSetup: "./global-setup.ts",
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: join(run.evidenceDir, "playwright"),
  preserveOutput: "always",
  reporter: [["list"], ["json", { outputFile: join(run.evidenceDir, "report.json") }]]
});
