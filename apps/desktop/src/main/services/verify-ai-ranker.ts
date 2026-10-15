import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { MlxHelperHost, type MlxHelperScoreResult } from "@app/ai";
import {
  aiRouteKeys,
  closePgPool,
  createAiConfigRepository,
  createLocalModelRepository,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import type { AiService as AiServiceType } from "./ai-service.js";

// Outside Electron only its secure storage is replaced; this proof stores no credential.
const electronHook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "electron"
      ? { url: "data:text/javascript,export const safeStorage={};", shortCircuit: true }
      : next(specifier, context);
  }
});
const { AiService, decideRouteKey } = await import("./ai-service.js");
const { LocalModelService } = await import("./local-model-service.js");
electronHook.deregister();

/**
 * Real-model proof of F2 T14 (D17, D18): the ranker execution path, the route keys and minimal
 * residency, on a temporary PostgreSQL sidecar and the real models. It touches no other database
 * and no profile: the models are read in place.
 *
 * 1. The catalog rows of the Qwen3-Reranker (MLX by default, or the GGUF fallback) and the GGUF
 *    Qwen3 embedding point at local files; the ranker is validated through the model test
 *    (artifact, runtime build, smoke), and the catalog sync exposes `reranking`.
 * 2. Two profiles take the models; the first-run seeding routes `embedding` and `class:decide`.
 * 3. The route-key SQL: `class:decide` resolves the ranker; an `op:` override wins and never falls
 *    through; note matching on the `reranking` task never reaches the ranker; a route whose
 *    profile task is inactive yields nothing.
 * 4. The measured run: rank calls of 1 query × 5 documents, each followed by a GGUF embedding call
 *    and an idle release like the job supervisor's. It reports p50/p95 of the call as the caller
 *    sees it and of the helper's scoring, the helper processes started and the model loads.
 *
 *   npx tsx apps/desktop/src/main/services/verify-ai-ranker.ts --embedding-gguf <file>
 *     [--runtime mlx|gguf] [--ranker-path <dir or file>] [--helper-root <repository>]
 *     [--calls 50] [--report <file>]
 *
 * `--ranker-path` defaults to the ranker under `<helper-root>/.cache/models`, and `--helper-root`
 * (the repository whose `native/mlx-helper/.build/release` holds the built helper) to this one.
 * The p95 bar and the helper checks apply to the MLX ranker; the GGUF run proves that the GGUF
 * ranker and the GGUF embedding stay resident together in one process.
 */
const workspace = resolve(import.meta.dirname, "../../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const seedFolder = join(workspace, "packages/db/seed");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  return value ? value : undefined;
}

const embeddingGguf = option("--embedding-gguf");
if (!embeddingGguf)
  throw new Error("--embedding-gguf <Qwen3-Embedding-0.6B-Q8_0.gguf> is required");
const helperRoot = resolve(option("--helper-root") ?? workspace);
const runtime = option("--runtime") ?? "mlx";
if (runtime !== "mlx" && runtime !== "gguf") throw new Error("--runtime is mlx or gguf");
const rankerDir = resolve(
  option("--ranker-path") ??
    join(
      helperRoot,
      runtime === "mlx"
        ? ".cache/models/qwen3-reranker-0.6b-mlx"
        : ".cache/models/qwen3-reranker-0.6b-q8_0-gguf/qwen3-reranker-0.6b-q8_0.gguf"
    )
);
const calls = Number(option("--calls") ?? 50);
const reportPath = option("--report");
const helperPath = join(helperRoot, "native/mlx-helper/.build/release/memora-mlx-helper");
const rankerCatalogId =
  runtime === "mlx" ? "mlx-qwen3-reranker-0.6b" : "gguf-qwen3-reranker-0.6b-q8-0";
const embeddingCatalogId = "gguf-qwen3-embedding-0.6b-q8-0";
/** D19 (c): gate p95 per gated note; the target is 0.2 s. */
const p95BarMs = 300;

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const round = (value: number) => Math.round(value * 10) / 10;

/** Local inference runs one model at a time: wait until no other local-model job runs. */
async function waitForLocalModelSlot(): Promise<void> {
  const job = /memora-mlx-helper|node-llama-cpp|scripts\/spikes\/.*(score|embed)/u;
  for (;;) {
    const others = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => job.test(line) && !line.includes("grep"))
      .filter((line) => !line.trim().startsWith(`${process.pid} `));
    if (others.length === 0) return;
    console.info(`Waiting for other local-model jobs:\n  ${others.join("\n  ")}`);
    await new Promise((done) => setTimeout(done, 30_000));
  }
}

const query =
  "Title: Photosynthesis in C4 plants\nIdea: C4 plants concentrate CO2 around RuBisCO, which " +
  "cuts photorespiration in hot climates.\nText: Maize and sugarcane fix carbon first into " +
  "four-carbon acids in the mesophyll and release it in the bundle sheath.";
const documents = [
  "Topic: Plant physiology\nAbout: How plants capture light, fix carbon and move water.\n" +
    "Examples: Stomata and transpiration; The Calvin cycle; Leaf anatomy",
  "Topic: Futebol brasileiro\nAbout: Clubes, campeonatos e táticas do futebol no Brasil.\n" +
    "Examples: O Brasileirão; A seleção de 1970; O 4-3-3",
  "Topic: Climate and agriculture\nAbout: How heat and drought change crop yields.\n" +
    "Examples: Heat stress in wheat; Irrigation; Crop models",
  "Topic: Enzyme kinetics\nAbout: Rates of enzyme reactions and their regulation.\n" +
    "Examples: Michaelis-Menten; Allosteric control; Inhibitors",
  "Topic: Medieval history\nAbout: Europe between the fifth and the fifteenth centuries.\n" +
    "Examples: The Carolingians; The Black Death; Feudalism"
];
const instruction = "Given a note, judge whether it belongs under the topic described";

if (runtime === "mlx") await access(helperPath);
await access(embeddingGguf);
await access(rankerDir);

const workDir = await mkdtemp(join(tmpdir(), "memora-ai-ranker-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_ai_ranker",
  user: "memora_ai_ranker",
  password: `ai-ranker-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const pools: PgPool[] = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), runtime, calls };
let ai: AiServiceType | null = null;

try {
  const connection = await manager.start();
  const db = createPgPool({ connectionString: connection.connectionString, max: 8 });
  pools.push(db);
  await runMigrations(db, migrationsFolder, { seedFolder });

  // The helper of the service, observed: processes started and every scoring's model load.
  const host = new MlxHelperHost({ helperPath });
  const scorings: Array<{ modelCached: boolean; loadMs: number; durationMs: number }> = [];
  const pids = new Set<number>();
  const score = host.score.bind(host);
  host.score = async (...args: Parameters<MlxHelperHost["score"]>) => {
    const result: MlxHelperScoreResult = await score(...args);
    scorings.push({
      modelCached: result.timing.modelCached,
      loadMs: result.timing.loadMs,
      durationMs: result.durationMs
    });
    if (host.pid) pids.add(host.pid);
    return result;
  };
  let embeddingLoads = 0;
  const service = new AiService({
    userDataPath: workDir,
    getPool: () => db,
    workspaceRoot: helperRoot,
    resourcesPath: workDir,
    isPackaged: false,
    logger: console,
    mlxHost: host,
    getContentLanguage: async () => "en",
    getKeepLocalEmbeddingModelsLoaded: async () => true,
    onLocalEmbeddingLoadStatus: (status) => {
      if (status.state === "loading") embeddingLoads += 1;
    }
  });
  ai = service;
  const localModels = new LocalModelService({
    getPool: () => db,
    userDataPath: workDir,
    isPackaged: false,
    workspaceRoot: workspace,
    env: {},
    isModelInUse: (id) => service.isLocalModelInUse(id),
    testModel: (id) => service.testLocalModel(id)
  });
  await localModels.list();
  const models = createLocalModelRepository(db);
  const ranker = (await models.findByCatalogId(rankerCatalogId))!;
  const embedding = (await models.findByCatalogId(embeddingCatalogId))!;
  await models.updateModel(ranker.id, { status: "ready", managedPath: rankerDir });
  await models.updateModel(embedding.id, { status: "ready", managedPath: embeddingGguf });

  await waitForLocalModelSlot();

  // 1. Validation through the model test; the sync then exposes `reranking`.
  const validationStarted = performance.now();
  const summary = await localModels.test(rankerCatalogId);
  const validated = (await models.findById(ranker.id))!;
  assert.ok(validated.capabilities.includes("reranking"), "the validated ranker can rank");
  const validation = validated.metadata.decideValidation as Record<string, unknown>;
  report.validation = {
    ms: Math.round(performance.now() - validationStarted),
    runtimeBuild: validation.runtimeBuild,
    summary: summary.split("\n")
  };

  // 2. Profiles; assigning a model runs the first-run seeding of the task and class routes.
  const embeddingProfile = await service.createProfile({
    name: "Embedding",
    isDefault: true,
    privacyMode: "offline_only",
    outputLanguage: "ui"
  });
  await service.updateProfile({
    id: embeddingProfile.id,
    localModelId: embedding.id,
    modelId: embedding.modelId,
    runtime: "gguf",
    capabilities: ["embedding"]
  });
  const rankerProfile = await service.createProfile({
    name: "Ranker",
    isDefault: false,
    privacyMode: "offline_only",
    outputLanguage: "ui"
  });
  await service.updateProfile({
    id: rankerProfile.id,
    localModelId: ranker.id,
    modelId: ranker.modelId,
    runtime,
    capabilities: ["reranking"]
  });
  const repository = createAiConfigRepository(db);
  const routes = Object.fromEntries(
    (await repository.listTaskRoutes()).map((route) => [route.task, route.profileId])
  );
  assert.equal(routes[decideRouteKey], rankerProfile.id, "class:decide is seeded with the ranker");
  assert.equal(routes.embedding, embeddingProfile.id, "embedding is seeded");
  assert.equal(routes.reranking, undefined, "the ranker never takes the prompt route of reranking");
  assert.ok(
    (await service.listTaskRoutes()).every((route) => !route.task.startsWith("class:")),
    "the settings list hides class routes"
  );
  report.routes = Object.fromEntries(
    Object.entries(routes).map(([task, profileId]) => [
      task,
      profileId === rankerProfile.id ? "ranker" : "embedding"
    ])
  );

  // 3. The route-key SQL on the real schema.
  const gateKeys = aiRouteKeys(decideRouteKey, { operation: "topic_gate" }).filter(
    (key) => key !== decideRouteKey
  );
  const decide = await repository.getDefaultTask(decideRouteKey, undefined, [
    ...gateKeys,
    decideRouteKey
  ]);
  assert.equal(decide?.routeKey, decideRouteKey);
  assert.equal(decide?.localModelId, ranker.id);
  await repository.seedTaskRoute("op:topic_gate", embeddingProfile.id);
  const overridden = await repository.getDefaultTask(decideRouteKey, undefined, [
    "op:topic_gate",
    decideRouteKey
  ]);
  assert.equal(overridden?.routeKey, "op:topic_gate", "the operation override wins");
  assert.equal(overridden?.localModelId, embedding.id);
  await assert.rejects(
    service.rank({ operation: "topic_gate", instruction, query, documents }),
    /errors\.ai\.unsupportedTask/u,
    "an override on a model that cannot rank fails visibly instead of falling through"
  );
  await db.query("delete from ai_task_profile_routes where task = 'op:topic_gate'");
  const matching = await repository.getDefaultTask(
    "reranking",
    undefined,
    aiRouteKeys("reranking", { operation: "note_matching_reranking" })
  );
  assert.equal(matching, null, "note matching never resolves the ranker");
  assert.equal(
    await service.runDefaultTask("reranking", "Decide the relation.", {
      operation: "note_matching_reranking"
    }),
    null,
    "note matching finds no prompt decider and never runs the ranker"
  );
  await db.query("update ai_profile_tasks set status = 'paused' where task = $1", [decideRouteKey]);
  assert.equal(
    await repository.getDefaultTask(decideRouteKey, undefined, [decideRouteKey]),
    null,
    "a route whose profile task is inactive yields nothing"
  );
  assert.equal(await service.decideRouteStatus("topic_gate"), "missing");
  await db.query("update ai_profile_tasks set status = 'active' where task = $1", [decideRouteKey]);
  assert.equal(await service.decideRouteStatus("topic_gate"), "ready");
  const space = await service.activeEmbeddingSpace();
  report.sql = {
    decideResolves: "ranker",
    operationOverrideWins: true,
    matchingNeverReachesRanker: true,
    inactiveRouteYieldsNothing: true
  };

  // 4. The measured run.
  const internals = service as unknown as { resident: { rank?: { adapter: unknown } } };
  const runsBefore = scorings.length;
  const spawnsBefore = host.spawnCount;
  const wall: number[] = [];
  const helper: number[] = [];
  let firstSpace: string | undefined;
  let residentRanker: unknown;
  let rankerRebuilds = 0;
  for (let index = 0; index < calls; index++) {
    const started = performance.now();
    const ranked = await service.rank({
      operation: "topic_gate",
      instruction,
      query,
      documents,
      priority: "background"
    });
    wall.push(performance.now() - started);
    helper.push(ranked.durationMs);
    assert.equal(ranked.logOdds.length, documents.length);
    const embedded = await service.runDefaultTask("embedding", `${query}\n(${index})`, {
      embeddingInputType: "document"
    });
    firstSpace ??= embedded?.embeddingSpaceKey;
    residentRanker ??= internals.resident.rank?.adapter;
    if (internals.resident.rank?.adapter !== residentRanker) rankerRebuilds += 1;
    assert.equal(embedded?.embeddingSpaceKey, firstSpace);
    // What the job supervisor does whenever a lane finds no job (keep loaded embeddings: on).
    await service.releaseLocalRuntime(false, true);
  }
  const measured = scorings.slice(runsBefore);
  const loads = measured.filter((entry) => !entry.modelCached);
  const helpers = execFileSync("ps", ["-axo", "ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim().startsWith(`${process.pid} `) && /memora-mlx-helper/u.test(line));
  const finalLogOdds = (
    await service.rank({ operation: "topic_gate", instruction, query, documents })
  ).logOdds;
  report.run = {
    rankCallMs: {
      p50: round(percentile(wall, 50)),
      p95: round(percentile(wall, 95)),
      max: round(Math.max(...wall)),
      firstCall: round(wall[0]!)
    },
    rankCallAfterFirstMs: {
      p50: round(percentile(wall.slice(1), 50)),
      p95: round(percentile(wall.slice(1), 95))
    },
    helperScoringMs: { p50: percentile(helper, 50), p95: percentile(helper, 95) },
    helperProcessesStarted: host.spawnCount - spawnsBefore,
    helperProcessesAlive: helpers.length,
    rankerAdapterRebuilds: rankerRebuilds,
    rankerLoads: runtime === "mlx" ? loads.length : null,
    rankerReloads: runtime === "mlx" ? Math.max(0, loads.length - 1) : rankerRebuilds,
    firstLoadMs: loads[0]?.loadMs ?? null,
    embeddingLoads,
    embeddingCalls: calls,
    logOdds: finalLogOdds.map((value) => Math.round(value * 1000) / 1000),
    activeSpaceConfirmed: space ? firstSpace === space.spaceKey : null
  };
  assert.equal(rankerRebuilds, 0, "the resident ranker was never rebuilt");
  assert.ok(helpers.length <= 1, "at most one MLX helper process");
  assert.equal(
    host.spawnCount - spawnsBefore,
    runtime === "mlx" ? 1 : 0,
    "the helper started once for the MLX ranker and never restarted"
  );
  assert.ok(loads.length <= 1, "the ranker loaded at most once (0 reloads)");
  assert.equal(embeddingLoads, 1, "the embedding model loaded once");
  assert.equal(firstSpace, space?.spaceKey, "the space computed without a call is the call's");
  if (runtime === "mlx") assert.ok(percentile(wall, 95) <= p95BarMs, `rank p95 ≤ ${p95BarMs} ms`);
  const audits = await db.query<{ count: string; tokens: string; cost: string | null }>(
    `select count(*)::text as count, sum(input_tokens)::text as tokens, max(cost_estimate)::text as cost
       from ai_task_runs where task_type = 'reranking' and status = 'succeeded'
        and capabilities_used @> '["reranking"]'::jsonb and adapter = $1`,
    [runtime === "mlx" ? "mlx-swift-lm" : "node-llama-cpp"]
  );
  report.audit = audits.rows[0];
  console.info(JSON.stringify({ ok: true, ...report }, null, 2));
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await ai?.dispose().catch(() => undefined);
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
