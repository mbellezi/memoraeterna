import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createElectronStub, installElectronStub } from "./topics-e2e/electron-stub.js";

/**
 * The embedding stage on a measurement profile, before and after batching (F3 D37, T56): the
 * library's chunks are embedded the way the stage did before (one lane request and one audit row per
 * chunk) and the way it does now (batches of 32, then again with every vector kept), on the same
 * local model, and the vectors, the space key and the audit rows are compared. It runs the local
 * embedding model, so it takes the local-model slot (`.cache/f2/LOCAL_MODEL_BUSY`), and it works only
 * on an APFS clone of a profile (`cp -cR`), never on the profile itself:
 *
 *   npx tsx apps/desktop/src/main/services/verify-embedding-stage.ts --clone <clone of ENV-G>
 *
 * The clone's database is started on its own (credentials from its `dev-connection.json`), migrated,
 * and its model path is pointed at the clone. Chunk vectors of the clone are replaced by the run.
 */
const { values } = parseArgs({ options: { clone: { type: "string" }, limit: { type: "string" } } });
const clone = values.clone ? resolve(values.clone) : "";
if (!clone || !existsSync(join(clone, "database", "dev-connection.json"))) {
  console.error("Pass --clone <an APFS clone of a profile that has database/dev-connection.json>.");
  process.exit(2);
}
if (clone.includes(`${join(".cache", "profiles")}/`)) {
  console.error("Refusing to run on a profile itself: clone it into .cache/f3/scratch first.");
  process.exit(2);
}
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
installElectronStub(createElectronStub());

const [db, { AiService }, { createJobEmbeddingGenerators }, { embedChunkVectors }, prompts] =
  await Promise.all([
    import("@app/db"),
    import("./ai-service.js"),
    import("./job-embedding.js"),
    import("./embedding-stage.js"),
    import("./prompt-runtime.js")
  ]);
const {
  PostgresSidecarManager,
  closePgPool,
  createEmbeddingRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} = db;

const connectionFile = JSON.parse(
  await readFile(join(clone, "database", "dev-connection.json"), "utf8")
) as { database: string; user: string; password: string };
const sidecar = resolvePostgresSidecarPaths({ cwd: repositoryRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(clone, "database", "postgres-data"),
  database: connectionFile.database,
  user: connectionFile.user,
  password: connectionFile.password,
  startupTimeoutMs: 60_000,
  shutdownTimeoutMs: 30_000
});
const round = (value: number) => Math.round(value * 10) / 10;
try {
  const connection = await manager.start();
  const pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
  await runMigrations(pool, join(repositoryRoot, "packages/db/drizzle"), {
    seedFolder: join(repositoryRoot, "packages/db/seed")
  });
  // The clone's model lives in the clone, not in the profile it was copied from.
  const models = await pool.query<{ id: string; managed_path: string }>(
    "select id, managed_path from local_models where capabilities ? 'embedding' and status = 'ready'"
  );
  for (const model of models.rows) {
    const folder = model.managed_path.split("/").at(-1)!;
    await pool.query("update local_models set managed_path = $2 where id = $1", [
      model.id,
      join(clone, "local-models", folder)
    ]);
  }

  const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY;
  const chunks = (
    await pool.query<{ id: string; content: string; content_hash: string; source_item_id: string }>(
      "select id, content, content_hash, source_item_id from chunks order by source_item_id, chunk_index"
    )
  ).rows
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      content: row.content,
      contentHash: row.content_hash,
      sourceItemId: row.source_item_id
    }));
  const taskRuns = async () =>
    Number(
      (
        await pool.query<{ count: string }>(
          "select count(*) from ai_task_runs where task_type = 'embedding'"
        )
      ).rows[0]!.count
    );
  const clearChunkVectors = async () => {
    for (const dimensions of [256, 768, 1024])
      await pool.query(`delete from embeddings_${dimensions} where target_type = 'chunk'`);
  };

  const ai = new AiService({
    userDataPath: clone,
    getPool: () => pool,
    workspaceRoot: repositoryRoot,
    resourcesPath: repositoryRoot,
    isPackaged: false,
    getContentLanguage: async () => "pt-BR",
    getKeepLocalEmbeddingModelsLoaded: async () => true
  });
  const render = (content: string) =>
    prompts.renderPrompt("embedding.content.chunk", { source_text: content });
  const context = {
    jobId: "00000000-0000-4000-8000-000000000056",
    ingestionRunId: "run",
    sourceItemId: chunks[0]?.sourceItemId ?? "",
    documentId: "document"
  };
  const generators = createJobEmbeddingGenerators(ai);
  const embeddings = createEmbeddingRepository(pool);

  // The model loads once; the stage meets a loaded model, so the load is timed apart.
  const loadStarted = performance.now();
  await ai.runDefaultTask("embedding", render("warm up"), {
    workloadClass: "embed",
    priority: "P2",
    embeddingInputType: "document"
  });
  const loadMs = performance.now() - loadStarted;
  const spaceKey = await ai.embeddingRouteSpaceKey();
  const stored = await pool.query<{ strategy: string }>(
    `select distinct strategy from embeddings_768 where target_type = 'atomic_note'
     union select distinct strategy from embeddings_256 where target_type = 'atomic_note'
     union select distinct strategy from embeddings_1024 where target_type = 'atomic_note'`
  );

  // Before: one lane request and one audit row per chunk, each stored as it arrives.
  await clearChunkVectors();
  const runsBeforeSingle = await taskRuns();
  const singleVectors: number[][] = [];
  const singleStarted = performance.now();
  for (const chunk of chunks) {
    const result = await ai.runDefaultTask(
      "embedding",
      render(chunk.content),
      {
        ...context,
        stage: "embedding",
        chunkId: chunk.id,
        embeddingInputType: "document",
        workloadClass: "embed",
        priority: "P2"
      },
      undefined
    );
    if (!result || !Array.isArray(result.output)) throw new Error("no embedding route");
    const embedding = result.output.map(Number);
    await embeddings.upsert({
      targetType: "chunk",
      targetId: chunk.id,
      chunkId: chunk.id,
      provider: result.providerId,
      model: result.modelId,
      runtime: result.runtime,
      strategy: result.embeddingSpaceKey ? `native-v2:${result.embeddingSpaceKey}` : "native",
      contentHash: chunk.contentHash,
      embedding
    });
    singleVectors.push(embedding);
  }
  const singleMs = performance.now() - singleStarted;
  const singleRuns = (await taskRuns()) - runsBeforeSingle;

  // After: batches of at most 32 (nothing to keep), then again with every vector kept.
  await clearChunkVectors();
  const runsBeforeBatched = await taskRuns();
  const stage = {
    pool,
    signal: new AbortController().signal,
    generate: generators.generateEmbeddings,
    routeSpaceKey: generators.embeddingSpaceKey,
    validate: async (embedding: number[]) => embedding,
    context,
    chunks,
    render
  };
  const batchedStarted = performance.now();
  const batched = await embedChunkVectors(stage);
  const batchedMs = performance.now() - batchedStarted;
  const batchedRuns = (await taskRuns()) - runsBeforeBatched;

  const runsBeforeKept = await taskRuns();
  const keptStarted = performance.now();
  const kept = await embedChunkVectors(stage);
  const keptMs = performance.now() - keptStarted;

  let identical = 0;
  for (const [index, vector] of singleVectors.entries()) {
    const other = batched.vectors[index];
    if (other && other.length === vector.length && vector.every((v, i) => Object.is(v, other[i])))
      identical += 1;
  }
  let keptIdentical = 0;
  for (const [index, vector] of batched.vectors.entries()) {
    const other = kept.vectors[index];
    // Stored in pgvector's single precision, so a kept vector is compared at that precision.
    if (other && vector.every((v, i) => Math.fround(v) === Math.fround(other[i]!)))
      keptIdentical += 1;
  }
  console.info(
    JSON.stringify(
      {
        clone,
        chunks: chunks.length,
        modelLoadMs: round(loadMs),
        embeddingSpaceKey: spaceKey,
        spaceKeyEqualsStoredNoteSpace: stored.rows.some(
          (row) => row.strategy === `native-v2:${spaceKey}`
        ),
        storedNoteStrategies: stored.rows.length,
        before: {
          wallMs: round(singleMs),
          msPerChunk: round(singleMs / chunks.length),
          laneRequests: singleRuns,
          auditRows: singleRuns
        },
        after: {
          wallMs: round(batchedMs),
          msPerChunk: round(batchedMs / chunks.length),
          embedded: batched.embedded,
          laneRequests: batchedRuns,
          auditRows: batchedRuns
        },
        speedup: round(singleMs / batchedMs),
        vectorsIdenticalToSingleCalls: `${identical} of ${chunks.length}`,
        rerunWithVectorsKept: {
          wallMs: round(keptMs),
          embedded: kept.embedded,
          reused: kept.reused,
          newAuditRows: (await taskRuns()) - runsBeforeKept,
          vectorsIdentical: `${keptIdentical} of ${chunks.length}`
        }
      },
      null,
      2
    )
  );
  await ai.dispose();
  await closePgPool(pool);
} finally {
  await manager.stop().catch(() => undefined);
}
process.exit(0);
