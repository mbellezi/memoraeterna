import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "./verify-worker-host.js";
import { UsageError, parseE2eArgs, usage } from "./topics-e2e/config.js";
import { createElectronStub, installElectronStub } from "./topics-e2e/electron-stub.js";

/**
 * Zero-config end-to-end test (F2 T32, exit criterion E6): an empty database, one AI profile from
 * the first-run path plus the default local embedding model, and one PDF give notes in named
 * topics without opening Settings. It starts a throwaway PostgreSQL sidecar and the product's own
 * services without Electron (a stub stands in for it), configures the profiles through the Settings
 * handlers, then imports the paper through the Import handlers with the default plan while counting
 * every IPC call. The AI calls (generation and embeddings) go through a cassette; the topic jobs
 * are held while the import's heavy work runs and released when it completes (D23); there is no
 * ranker, so the placement gate falls back. It evaluates every E6 assertion and writes
 * `report.json` and `report.md` under `.cache/topics/e2e/<time>/`.
 *
 * Replay (no model, no network, no provider; needs the cassette and the golden PDF):
 *
 *   npm run topics:e2e
 *
 * Record (once, by the orchestrator: it needs a real route and the local embedding model, so it takes
 * the local-model slot; a recording resumes from the cassette and only new calls are live):
 *
 *   MEMORA_E2E_API_KEY=<key> npm run topics:e2e -- --mode record --max-tokens 400000 \
 *     --embedding-gguf <Qwen3-Embedding-0.6B-Q8_0.gguf> \
 *     --writer-provider openai-compatible --writer-model <model> --writer-base-url <url>
 *   (or --profile <name>, which reads .cache/profiles/<name>/e2e-route.json; or a local MLX writer:
 *    --writer-local mlx-qwen3-4b-instruct-2507-4bit --writer-path <model dir>)
 *
 * The credentials of a profile belong to the Electron app (safeStorage) and are never copied: the
 * route names where a key is read from, and the scratch workspace encrypts it with a key that lives
 * only in this process. The owner's profile and `.cache/profiles/*` are never touched. The cassette
 * `.cache/topics/cassettes/e2e-plos` keeps `e2e-route.json` (the route without secrets, the content
 * language and the reference counts), which the replay rebuilds its profile from.
 *
 * Self-test of the harness itself, with a tiny synthetic library and a synthetic model (no PDF, no
 * Docling, no model; records and replays a throwaway cassette):
 *
 *   npm run topics:e2e -- --synthetic
 *
 * Exit code: 0 when every check passed, 1 when one failed, 2 for a usage or setup error.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const log = (event: string, data?: Record<string, unknown>) =>
  console.error(`TOPICS_E2E ${JSON.stringify({ event, ...data })}`);

try {
  const config = parseE2eArgs(process.argv.slice(2), { repositoryRoot });
  if (config === "help") {
    console.info(usage);
  } else {
    const stub = createElectronStub({ locale: config.locale });
    installElectronStub(stub);
    const { runTopicsE2e } = await import("./topics-e2e/run.js");
    const results = await runTopicsE2e(config, { electron: stub, env: process.env, log });
    for (const result of results) {
      console.info(config.json ? JSON.stringify(result.report, null, 2) : result.markdown);
      if (result.kept) console.error(`Scratch workspace kept: ${result.workDir}`);
    }
    process.exitCode =
      results.length > 0 && results.every((result) => result.report.passed) ? 0 : 1;
  }
} catch (error) {
  process.exitCode = 2;
  if (error instanceof UsageError) console.error(error.message);
  else console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
// A helper or a worker thread may outlive the run; the verdict is already in the exit code.
setTimeout(() => process.exit(process.exitCode ?? 0), 20_000).unref();
