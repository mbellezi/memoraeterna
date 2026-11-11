import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createPgPool,
  createRelationTypeRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool,
  type RelationTypeVector
} from "@app/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AiTaskLogContext } from "./ai-service.js";
import { confirmMatchGroup } from "./relation-type-resolution.js";
import { SourceDeletionService } from "./source-deletion-service.js";

// Soak jobs 1499439c and 44e3ea32 on a real database: a relation type's jsonb `sourceItemIds` kept
// the id of a deleted source, the confirmation call named it, and the audit row's provenance insert
// failed its foreign key (23503), which rolled the run back and failed the graph stage. The audit
// row now keeps the live sources only, and a source's deletion strips its id from the catalog.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const vector = (index: number): RelationTypeVector => ({
  embedding: Array.from({ length: 256 }, (_, i) => (i === index ? 1 : 0)),
  spaceKey: "provenance-test:256:canonical",
  contentHash: `hash-${index}`,
  provider: "test",
  model: "test-embedding",
  runtime: "test",
  metadata: {}
});

describe.skipIf(!sidecarInstalled)("relation-type provenance on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-relation-provenance-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_relation_provenance_test",
        user: "memora_relation_provenance_test",
        password: `relation-provenance-${randomUUID()}`,
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
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const source = async (title: string) => {
    const id = randomUUID();
    await db().query("insert into source_items (id, type, title) values ($1, 'Book', $2)", [
      id,
      title
    ]);
    return id;
  };

  /** A catalog type whose metadata names `sourceItemIds`, as relation-type resolution commits it. */
  const relationType = async (predicate: string, index: number, sourceItemIds: string[]) => {
    const repository = createRelationTypeRepository(db());
    const committed = await repository.commit(
      [
        {
          predicate,
          definition: `${predicate} definition`,
          target: null,
          vector: vector(index),
          metadata: { sourceItemIds, method: "new_type", promptVersion: "test" }
        }
      ],
      await repository.revision()
    );
    return committed!.get(predicate)!.id;
  };

  const runSources = async (runId: string) =>
    (
      await db().query<{ id: string }>(
        "select source_item_id::text as id from ai_task_run_sources where ai_task_run_id = $1 order by 1",
        [runId]
      )
    ).rows.map((row) => row.id);

  /**
   * The relation-type confirmation of the graph stage, its audit row written by the repository the
   * AI service uses, with the sources the call's context names (`taskSourceItemIds`).
   */
  const confirmAgainstCatalog = async (index: number, importedSourceId: string) => {
    const candidates = await createRelationTypeRepository(db()).candidates(vector(index), 0.9);
    expect(candidates).toHaveLength(1);
    const runIds: string[] = [];
    const ai = {
      runDefaultTask: async (taskType: string, _prompt: string, context: AiTaskLogContext) => {
        const id = await createAiConfigRepository(db()).recordTaskRun({
          taskType,
          provider: "test",
          modelId: "test-model",
          runtime: "remote",
          durationMs: 1,
          status: "succeeded",
          sourceItemIds: [
            ...new Set([
              ...(context.sourceItemId ? [context.sourceItemId] : []),
              ...(context.sourceItemIds ?? [])
            ])
          ]
        });
        runIds.push(id);
        return { output: { matches: [["r1", "c1"]] }, aiTaskRunId: id };
      }
    };
    const decisions = await confirmMatchGroup({
      ai: ai as never,
      group: [
        {
          key: "r1",
          predicate: "quotes",
          definition: "quotes definition",
          candidates: [{ ...candidates[0]!, key: "c1" }]
        }
      ],
      entityIdentity: false,
      context: { sourceItemId: importedSourceId },
      promptVersion: "test",
      stage: "relation_type_resolution",
      pinned: false,
      invalidOutputError: "errors.relationTypes.invalidOutput"
    });
    return { candidates, decisions, runIds };
  };

  it("keeps the confirmation's audit row when a candidate names a source deleted before the fix", async () => {
    const kept = await source("Kept");
    const gone = await source("Gone");
    const imported = await source("Imported");
    await relationType("cites", 1, [kept, gone]);
    // The deletion before this fix left the catalog's jsonb list as it was.
    await db().query("delete from source_items where id = $1", [gone]);

    const { candidates, decisions, runIds } = await confirmAgainstCatalog(1, imported);

    expect(candidates[0]!.sourceItemIds).toEqual([kept, gone]);
    expect(decisions.get("r1")).toEqual({ candidate: "c1", aiTaskRunId: runIds[0] });
    expect(runIds).toHaveLength(1);
    expect(await runSources(runIds[0]!)).toEqual([imported, kept].sort());
  });

  it("writes exactly the listed provenance rows when every source is live", async () => {
    const first = await source("First");
    const second = await source("Second");
    const repository = createAiConfigRepository(db());
    const audit = (sourceItemIds: string[]) =>
      repository.recordTaskRun({
        taskType: "knowledge-graph-generation",
        provider: "test",
        modelId: "test-model",
        runtime: "remote",
        durationMs: 5,
        status: "succeeded",
        sourceItemIds
      });

    const listed = await audit([second, first, second]);
    expect(await runSources(listed)).toEqual([first, second].sort());
    const none = await audit([]);
    expect(await runSources(none)).toEqual([]);
    const rows = await db().query<{ id: string; durationMs: number; status: string }>(
      `select id, duration_ms as "durationMs", status from ai_task_runs where id = any($1::uuid[]) order by id`,
      [[listed, none]]
    );
    expect(rows.rows).toEqual(
      [listed, none].sort().map((id) => ({ id, durationMs: 5, status: "succeeded" }))
    );
  });

  it("strips a deleted source from the catalog's types and aliases in the deleting transaction", async () => {
    const kept = await source("Kept for deletion");
    const deleted = await source("Deleted");
    const imported = await source("Imported after deletion");
    const shared = await relationType("refutes", 2, [kept, deleted]);
    const only = await relationType("extends", 3, [deleted]);
    const untouched = await relationType("summarizes", 4, [kept]);
    const before = await db().query<{ id: string; metadata: unknown; version: string }>(
      `select id, metadata, xmin::text as version from relation_types where id = $1`,
      [untouched]
    );

    const result = await new SourceDeletionService({
      getPool: () => db(),
      getStorageSettings: async () =>
        ({ obsidianVaultPath: null, managedRoot: "", uploadCopiesFolderPath: workDir }) as never,
      userDataPath: workDir,
      removeGraphProjections: async () => undefined
    }).delete(deleted);
    expect(result.deletedSources).toBe(1);

    const metadata = async (table: string, column: string, id: string) =>
      (
        await db().query<{ metadata: Record<string, unknown> }>(
          `select metadata from ${table} where ${column} = $1`,
          [id]
        )
      ).rows.map((row) => row.metadata);
    for (const table of ["relation_types", "relation_type_aliases"]) {
      const column = table === "relation_types" ? "id" : "relation_type_id";
      expect(await metadata(table, column, shared)).toEqual([
        { sourceItemIds: [kept], method: "new_type", promptVersion: "test" }
      ]);
      expect(await metadata(table, column, only)).toEqual([
        { sourceItemIds: [], method: "new_type", promptVersion: "test" }
      ]);
      expect(await metadata(table, column, untouched)).toEqual([
        { sourceItemIds: [kept], method: "new_type", promptVersion: "test" }
      ]);
    }
    // A type that never named the deleted source is not rewritten.
    const after = await db().query<{ id: string; metadata: unknown; version: string }>(
      `select id, metadata, xmin::text as version from relation_types where id = $1`,
      [untouched]
    );
    expect(after.rows).toEqual(before.rows);

    const { candidates, runIds } = await confirmAgainstCatalog(2, imported);
    expect(candidates[0]!.sourceItemIds).toEqual([kept]);
    expect(await runSources(runIds[0]!)).toEqual([imported, kept].sort());
  });
});
