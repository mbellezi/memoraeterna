import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createElectronStub, installElectronStub } from "./topics-e2e/electron-stub.js";

/**
 * B6 (F3 D38): how long an AI call holds its lane slot for work that is not the model. A real
 * throwaway PostgreSQL database holds one OpenAI-compatible embedding route; the provider answers
 * at once (a stubbed `fetch`), so what a call spends inside the slot beyond the provider's own time
 * is the route recheck, the provider rows, the credential, the adapter and the job metadata the
 * service reads there. No model, no network, no Electron.
 *
 *   npx tsx apps/desktop/src/main/services/verify-ai-hot-path.ts [--calls 300] [--concurrency 1]
 *
 * It uses only the service's public surface, so the same file measures the code before the caches
 * (copy it into a checkout of the earlier commit) and after. The report is JSON on stdout.
 */
const { values } = parseArgs({
  options: {
    calls: { type: "string" },
    concurrency: { type: "string" },
    warmup: { type: "string" }
  }
});
const calls = Number(values.calls ?? 300);
const concurrency = Number(values.concurrency ?? 1);
const warmup = Number(values.warmup ?? 20);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const stub = createElectronStub();
let decrypts = 0;
const safeStorage = stub.module.safeStorage as { decryptString: (value: Buffer) => string };
const decryptString = safeStorage.decryptString.bind(safeStorage);
safeStorage.decryptString = (value) => {
  decrypts += 1;
  return decryptString(value);
};
installElectronStub(stub);

const [{ createAiScheduler, resolveAiLaneRuntimeConfig }, db, { AiService }, credentialModule] =
  await Promise.all([
    import("@app/ai"),
    import("@app/db"),
    import("./ai-service.js"),
    import("./credential-service.js")
  ]);
const {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} = db;

const sidecar = resolvePostgresSidecarPaths({ cwd: repositoryRoot, env: process.env });
if (!existsSync(join(sidecar.binDir, "postgres"))) {
  console.error("The PostgreSQL sidecar is not installed.");
  process.exit(2);
}

const workDir = await mkdtemp(join(tmpdir(), "memora-hot-path-"));
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_hot_path",
  user: "memora_hot_path",
  password: `hot-path-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
try {
  const connection = await manager.start();
  const pool = createPgPool({ connectionString: connection.connectionString, max: 8 });
  await runMigrations(pool, join(repositoryRoot, "packages/db/drizzle"), {
    seedFolder: join(repositoryRoot, "packages/db/seed")
  });

  let statements = 0;
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    statements += 1;
    return query(...args);
  };

  const userDataPath = join(workDir, "user-data");
  const credentialRef = await new credentialModule.CredentialService(userDataPath).save("probe");
  const config = createAiConfigRepository(pool);
  const provider = await config.upsertProvider({
    provider: "openai-compatible",
    displayName: "probe",
    credentialRef,
    baseUrl: "https://embed-probe.test/v1",
    metadata: { modelId: "probe-embed", capabilities: ["embedding"] }
  });
  const profile = await config.createProfile({ name: "probe", isDefault: true });
  await config.updateProfile({
    id: profile.id,
    providerConfigId: provider.id,
    modelId: "probe-embed",
    runtime: "remote",
    capabilities: ["embedding"],
    privacyMode: "allow_remote"
  });

  // The provider answers at once; the time it spends is the model's, not the slot's overhead.
  let providerMs = 0;
  globalThis.fetch = (async () => {
    const started = performance.now();
    const response = Response.json({
      data: [{ index: 0, embedding: Array.from({ length: 768 }, (_, i) => i / 768) }],
      usage: { prompt_tokens: 3, total_tokens: 3 }
    });
    providerMs += performance.now() - started;
    return response;
  }) as typeof fetch;

  const laneConfig = resolveAiLaneRuntimeConfig(undefined, { packaged: false });
  const inner = createAiScheduler(laneConfig);
  const slots: Array<{ nonModelMs: number; statements: number; decrypts: number }> = [];
  const scheduler: typeof inner = {
    reserve: () => inner.reserve(),
    run: (ticket, execute) =>
      inner.run(ticket, async (permit) => {
        const before = { statements, decrypts, providerMs };
        const started = performance.now();
        const completion = await execute(permit);
        slots.push({
          nonModelMs: performance.now() - started - (providerMs - before.providerMs),
          statements: statements - before.statements,
          decrypts: decrypts - before.decrypts
        });
        return completion;
      }),
    refresh: () => inner.refresh(),
    observeRateLimit: (lane, retryAt) => inner.observeRateLimit(lane, retryAt),
    observeOutcome: (lane, outcome) => inner.observeOutcome(lane, outcome),
    snapshot: () => inner.snapshot()
  };

  const ai = new AiService({
    userDataPath,
    getPool: () => pool,
    workspaceRoot: repositoryRoot,
    resourcesPath: repositoryRoot,
    isPackaged: false,
    scheduler,
    getContentLanguage: async () => "en",
    getKeepLocalEmbeddingModelsLoaded: async () => true
  });
  await ai.setTaskRoute({ task: "embedding", profileId: profile.id });

  const jobId = randomUUID();
  const embed = (index: number) =>
    ai.runDefaultTask("embedding", `Passage ${index} about spaced retrieval practice.`, {
      jobId,
      stage: "embedding",
      workloadClass: "embed",
      priority: "P2",
      embeddingInputType: "document"
    });
  for (let index = 0; index < warmup; index += 1) await embed(index);
  slots.length = 0;
  const startedAt = performance.now();
  const statementsBefore = statements;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < calls) {
        const index = next;
        next += 1;
        await embed(index);
      }
    })
  );
  const wallMs = performance.now() - startedAt;

  const percentile = (list: number[], p: number) =>
    [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.ceil(list.length * p) - 1)] ?? 0;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const nonModel = slots.map((slot) => slot.nonModelMs);
  console.info(
    JSON.stringify(
      {
        calls,
        concurrency,
        wallMs: round(wallMs),
        callsPerSecond: round((calls / wallMs) * 1000),
        statementsPerCall: round((statements - statementsBefore) / calls),
        inSlot: {
          nonModelMs: {
            p50: round(percentile(nonModel, 0.5)),
            p95: round(percentile(nonModel, 0.95)),
            max: round(Math.max(...nonModel))
          },
          statementsPerCall: round(slots.reduce((sum, slot) => sum + slot.statements, 0) / calls),
          decryptsPerCall: round(slots.reduce((sum, slot) => sum + slot.decrypts, 0) / calls)
        }
      },
      null,
      2
    )
  );
  await closePgPool(pool);
} finally {
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
process.exit(0);
