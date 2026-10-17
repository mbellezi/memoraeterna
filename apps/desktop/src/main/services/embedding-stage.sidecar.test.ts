import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createEmbeddingRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import {
  embedChunkVectors,
  embedHeaderVectors,
  type EmbeddingBatch,
  type EmbeddingBatchGenerator
} from "./embedding-stage.js";

// The embedding stage's chunk skip against the real vector tables (F3 D37): a chunk whose content
// hash and embedding space are unchanged keeps its vector, the others are embedded in batches of at
// most 32 and each batch is stored before the next.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const dimensions = 256;
const space = {
  provider: "local-gguf",
  model: "embed-test",
  runtime: "local",
  spaceKey: "space-a"
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** A unit vector that depends on the text only. */
function vectorOf(text: string): number[] {
  const seed = parseInt(sha(text).slice(0, 8), 16);
  const raw = Array.from({ length: dimensions }, (_, index) => Math.sin(seed + index * 0.37));
  const length = Math.hypot(...raw);
  return raw.map((value) => value / length);
}

describe.skipIf(!sidecarInstalled)("the embedding stage on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;
  let sourceItemId = "";
  let documentId = "";
  const chunks: Array<{ id: string; content: string; contentHash: string }> = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-embedding-stage-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_embedding_stage_test",
        user: "memora_embedding_stage_test",
        password: `embedding-stage-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    sourceItemId = randomUUID();
    documentId = randomUUID();
    await pool.query(
      "insert into source_items (id, type, title, content_hash) values ($1, 'Book', 'Source', $2)",
      [sourceItemId, sha(sourceItemId)]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Doc', 'text', $3)`,
      [documentId, sourceItemId, sha("text")]
    );
    for (let index = 0; index < 70; index += 1) {
      const id = randomUUID();
      const content = `Passage number ${index} about spaced retrieval.`;
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, documentId, sourceItemId, index, content, sha(content)]
      );
      chunks.push({ id, content, contentHash: sha(content) });
    }
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const stored = async () =>
    (
      await pool.query<{ target_id: string; strategy: string; content_hash: string }>(
        "select target_id, strategy, content_hash from embeddings_256 where target_type = 'chunk'"
      )
    ).rows;
  const clear = () => pool.query("delete from embeddings_256 where target_type = 'chunk'");

  /** A generator that records the batches it was asked for. */
  function generator(options: { spaceKey?: string; failAt?: number } = {}) {
    const batches: string[][] = [];
    const contexts: Array<Record<string, unknown>> = [];
    const generate: EmbeddingBatchGenerator = async (texts, _signal, context) => {
      if (batches.length === options.failAt) throw new Error("the model failed");
      batches.push(texts);
      contexts.push(context);
      return {
        embeddings: texts.map(vectorOf),
        provider: space.provider,
        model: space.model,
        runtime: space.runtime,
        spaceKey: options.spaceKey ?? space.spaceKey
      } satisfies EmbeddingBatch;
    };
    return { generate, batches, contexts };
  }

  const stage = (
    generate: EmbeddingBatchGenerator,
    routeSpaceKey?: () => Promise<string | null>
  ) => ({
    pool,
    signal: new AbortController().signal,
    generate,
    ...(routeSpaceKey ? { routeSpaceKey } : {}),
    validate: async (embedding: number[]) => embedding,
    context: { jobId: "job", ingestionRunId: "run", sourceItemId, documentId },
    chunks,
    render: (content: string) => `rendered: ${content}`
  });

  it("embeds the chunks in batches of at most 32, stores each, and keeps the order", async () => {
    await clear();
    const { generate, batches, contexts } = generator();
    const result = await embedChunkVectors(stage(generate, async () => space.spaceKey));
    expect(batches.map((batch) => batch.length)).toEqual([32, 32, 6]);
    expect(batches[0]![0]).toBe("rendered: Passage number 0 about spaced retrieval.");
    expect(contexts[2]).toMatchObject({
      stage: "embedding",
      embeddingInputType: "document",
      chunkIds: chunks.slice(64).map((chunk) => chunk.id)
    });
    expect(result).toMatchObject({ embedded: 70, reused: 0, identity: space });
    expect(result.vectors).toHaveLength(70);
    expect(result.vectors[69]).toEqual(vectorOf("rendered: " + chunks[69]!.content));
    const rows = await stored();
    expect(rows).toHaveLength(70);
    expect(new Set(rows.map((row) => row.strategy))).toEqual(new Set(["native-v2:space-a"]));
  });

  it("keeps the vector of a chunk whose text and space are unchanged", async () => {
    const { generate, batches } = generator();
    const result = await embedChunkVectors(stage(generate, async () => space.spaceKey));
    expect(batches).toEqual([]);
    expect(result).toMatchObject({ embedded: 0, reused: 70, identity: space });
    expect(result.vectors).toHaveLength(70);
    // The kept vectors are the stored ones, in the order of the chunks.
    expect(result.vectors[3]![0]).toBeCloseTo(vectorOf("rendered: " + chunks[3]!.content)[0]!, 6);
  });

  it("embeds only the chunks whose text changed", async () => {
    const changed = chunks[10]!;
    await pool.query("update chunks set content_hash = $2 where id = $1", [changed.id, sha("new")]);
    const { generate, batches } = generator();
    const result = await embedChunkVectors({
      ...stage(generate, async () => space.spaceKey),
      chunks: chunks.map((chunk) =>
        chunk.id === changed.id ? { ...chunk, contentHash: sha("new") } : chunk
      )
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(result).toMatchObject({ embedded: 1, reused: 69 });
    expect((await stored()).find((row) => row.target_id === changed.id)?.content_hash).toBe(
      sha("new")
    );
  });

  it("embeds everything again when the route writes to another space", async () => {
    const { generate, batches } = generator({ spaceKey: "space-b" });
    const result = await embedChunkVectors(stage(generate, async () => "space-b"));
    expect(batches.map((batch) => batch.length)).toEqual([32, 32, 6]);
    expect(result).toMatchObject({ embedded: 70, reused: 0 });
    expect(new Set((await stored()).map((row) => row.strategy))).toEqual(
      new Set(["native-v2:space-b"])
    );
  });

  it("reuses nothing when it does not know the route's space", async () => {
    await clear();
    const first = generator();
    await embedChunkVectors(stage(first.generate, async () => space.spaceKey));
    const second = generator();
    const result = await embedChunkVectors(stage(second.generate));
    expect(second.batches.map((batch) => batch.length)).toEqual([32, 32, 6]);
    expect(result.reused).toBe(0);
  });

  it("keeps the batches that were stored when a later one fails, and a retry skips them", async () => {
    await clear();
    const failing = generator({ failAt: 1 });
    await expect(
      embedChunkVectors(stage(failing.generate, async () => space.spaceKey))
    ).rejects.toThrow("the model failed");
    expect(await stored()).toHaveLength(32);
    const retry = generator();
    const result = await embedChunkVectors(stage(retry.generate, async () => space.spaceKey));
    expect(retry.batches.map((batch) => batch.length)).toEqual([32, 6]);
    expect(result).toMatchObject({ embedded: 38, reused: 32 });
    expect(await stored()).toHaveLength(70);
  });

  it("fails when the space changed while the document was being embedded", async () => {
    await clear();
    // The first 32 are stored in space-a; the route moves, and the next batch comes from space-b.
    let moved = false;
    const moving: EmbeddingBatchGenerator = async (texts, signal, context) => {
      const batch = await generator({ spaceKey: moved ? "space-b" : "space-a" }).generate(
        texts,
        signal,
        context
      );
      moved = true;
      return batch;
    };
    await expect(embedChunkVectors(stage(moving, async () => space.spaceKey))).rejects.toThrow(
      "errors.sourceRelations.configurationChanged"
    );
  });

  it("stops quietly when no embedding model is routed", async () => {
    await clear();
    const result = await embedChunkVectors(stage(async () => null));
    expect(result).toMatchObject({ vectors: [], identity: null, embedded: 0, reused: 0 });
  });

  it("does not look for stored vectors without chunks", async () => {
    const found = await createEmbeddingRepository(pool).findCurrentChunkVectors(
      [],
      "native-v2:space-a"
    );
    expect(found.size).toBe(0);
  });

  it("embeds the segments of a catalog header in batches, in the space of the chunks", async () => {
    const { generate, batches, contexts } = generator();
    const segments = Array.from({ length: 40 }, (_, index) => `Header segment ${index}`);
    const result = await embedHeaderVectors({
      ...stage(generate),
      segments,
      identity: space
    });
    expect(batches.map((batch) => batch.length)).toEqual([32, 8]);
    expect(contexts[0]).toMatchObject({ stage: "source_embedding" });
    expect(result.vectors).toHaveLength(40);
    expect(result.identity).toMatchObject({ spaceKey: "space-a" });
    await expect(
      embedHeaderVectors({
        ...stage(generator({ spaceKey: "space-b" }).generate),
        segments,
        identity: space
      })
    ).rejects.toThrow("errors.sourceRelations.configurationChanged");
  });
});
