import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "../verify-worker-host.js";
import { createElectronStub, installElectronStub } from "../topics-e2e/electron-stub.js";
import { UsageError, parseFirstRunArgs, usage } from "./config.js";

/**
 * First-run Hybrid end-to-end test (F4 T90, exit criterion E6): a clean install in Hybrid places and
 * connects the first note in at most ten minutes. An empty database, the writer signed in, the two
 * first-run models installed (the embedder and the ranker), two public sources imported with the
 * default plan, all through the product's own services and IPC handlers without Electron (a stub
 * stands in for it). The AI calls go through a cassette; the topic jobs are held while the sources
 * import and released by policy a2 once the first-run ranker is validated: at the first division
 * boundary where the first source has 12 notes (`--topic-release-notes`), then after each source's
 * heavy work. The link jobs run in drain mode, so two replays make the same calls in the same
 * order. A cassette records its release policy and link runtime, and a replay refuses another. Each
 * pass writes `report.json` and `report.md` under `.cache/topics/firstrun-e2e/<time>/`.
 *
 * This file is the harness's only way in (the root `firstrun:e2e` script): no product module
 * imports the folder (`isolation.test.ts`), so nothing here is in the app's bundles.
 *
 * Replay (the cassette, the golden sources, the seeded models; no network, no provider, no key; the
 * install checks and the ranker validation run for real on the seeded files, the AI calls are served
 * with their recorded timing). Each replay is gated: T1 - T0 plus the download term D of the live
 * record, at most ten minutes:
 *
 *   MEMORA_LOCAL_MODEL_SEED_DIR=<repository>/.cache/models npm run firstrun:e2e -- --replays 2
 *
 * Record (once, by the orchestrator: the live clean install with the real download of the two
 * first-run models into the scratch profile, Q5, and the real writer; it takes the local-model slot):
 *
 *   npm run firstrun:e2e -- --mode record --max-tokens 150000 \
 *     --codex-credential-file <file outside the repository> \
 *     --copy-models-to <repository>/.cache/models
 *
 * A recording tries a transient failure of a remote call again itself (`record-retry.ts`, card
 * FRMISS), and one still left with a failed AI call fails its `replayable` check and is not saved:
 * that call has no cassette entry, and its job ran again later, in an order no replay follows.
 *
 * Self-test of the harness itself, with two synthetic papers, simulated installs and synthetic
 * models (no PDF, no Docling, no download, no model; records and replays a throwaway cassette):
 *
 *   npm run firstrun:e2e -- --synthetic
 *
 * Exit code: 0 when every check passed (and the replays of one invocation made the same library),
 * 1 when one failed, 2 for a usage or setup error.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");

const log = (event: string, data?: Record<string, unknown>) =>
  console.error(`FIRSTRUN_E2E ${JSON.stringify({ event, ...data })}`);

try {
  const config = parseFirstRunArgs(process.argv.slice(2), { repositoryRoot, env: process.env });
  if (config === "help") {
    console.info(usage);
  } else {
    const stub = createElectronStub({ locale: config.locale });
    installElectronStub(stub);
    const { runFirstRunE2e, replaysAgree } = await import("./run.js");
    const results = await runFirstRunE2e(config, { electron: stub, env: process.env, log });
    for (const result of results) {
      console.info(config.json ? JSON.stringify(result.report, null, 2) : result.markdown);
      if (result.kept) console.error(`Scratch workspace kept: ${result.workDir}`);
    }
    const agree = replaysAgree(results);
    if (!agree) console.error("The replays of this invocation did not make the same library.");
    process.exitCode =
      results.length > 0 && agree && results.every((result) => result.report.passed) ? 0 : 1;
  }
} catch (error) {
  process.exitCode = 2;
  if (error instanceof UsageError) console.error(error.message);
  else console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
// A helper or a worker thread may outlive the run; the verdict is already in the exit code.
setTimeout(() => process.exit(process.exitCode ?? 0), 20_000).unref();
