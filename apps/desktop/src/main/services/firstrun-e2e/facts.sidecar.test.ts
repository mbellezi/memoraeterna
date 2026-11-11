import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PostgresSidecarManager,
  closePgPool,
  createJobRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";
import type { PgPool } from "@app/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedArticle } from "../topic-tree/corpus-library.js";
import type { SeededArticle } from "../topic-tree/corpus-library.js";
import { syntheticArticle, syntheticCorpus } from "../topics-e2e/synthetic.js";
import { readBoundary, readPipelineBusy } from "./facts.js";
import { topicReleaseJob } from "./topic-release.js";

/**
 * What a release boundary (a2, E6A2) reads on a real database: the root of the source whose heavy
 * job ended and that root's notes, counted over its divisions (the live record's `current` count)
 * or over the notes whose embedding ran (the self-test's `embedded` count); and the pipeline is not
 * busy while only a release job runs (it waits for the ranker: D's clock).
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

describe.skipIf(!sidecarAvailable)("the release boundary reads on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let root: SeededArticle;
  let division: SeededArticle;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-firstrun-facts-"));
    manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, "database"),
      database: "memora_firstrun_facts",
      user: "memora_firstrun_facts",
      password: `facts-${Math.random().toString(36).slice(2)}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    // A root with 6 notes and one division of it with 3 more (3 themes x 2, 3 themes x 1).
    root = await seedArticle(pool, syntheticCorpus, syntheticArticle("pt", 2));
    division = await seedArticle(pool, syntheticCorpus, {
      ...syntheticArticle("pt", 1),
      key: "pt:division",
      title: "Uma divisão",
      pageId: 9,
      revisionId: 9,
      notes: syntheticArticle("pt", 1).notes.map((note) => ({ ...note, id: `division-${note.id}` }))
    });
    await pool.query("update source_items set parent_source_item_id = $1 where id = $2", [
      root.rootSourceId,
      division.rootSourceId
    ]);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }, 120_000);

  it("counts the current notes of the whole root from the end of a division or of the root", async () => {
    expect(root.noteIds).toHaveLength(6);
    expect(division.noteIds).toHaveLength(3);
    for (const id of [division.rootSourceId, root.rootSourceId])
      await expect(readBoundary(pool, id, "current")).resolves.toEqual({
        rootId: root.rootSourceId,
        notes: 9
      });
    // A rejected note is not a current note.
    await pool.query("update atomic_notes set status = 'rejected' where id = $1", [
      division.noteIds[0]
    ]);
    await expect(readBoundary(pool, division.rootSourceId, "current")).resolves.toMatchObject({
      notes: 8
    });
    await expect(
      readBoundary(pool, "00000000-0000-4000-8000-000000000000", "current")
    ).resolves.toBeNull();
  });

  it("counts the embedded notes of the root: the embedding jobs that ran or are running", async () => {
    await expect(readBoundary(pool, root.rootSourceId, "embedded")).resolves.toEqual({
      rootId: root.rootSourceId,
      notes: 0
    });
    const ids = (
      await pool.query<{ id: string; source: string }>(
        `select id::text, payload->>'sourceItemId' as source from jobs
         where type = 'note-embedding' order by created_at, id`
      )
    ).rows;
    expect(ids).toHaveLength(9);
    const rootJob = ids.find((row) => row.source === root.rootSourceId)!.id;
    const divisionJob = ids.find((row) => row.source === division.rootSourceId)!.id;
    await pool.query("update jobs set status = 'succeeded' where id = $1", [rootJob]);
    await pool.query("update jobs set status = 'running' where id = $1", [divisionJob]);
    await expect(readBoundary(pool, division.rootSourceId, "embedded")).resolves.toEqual({
      rootId: root.rootSourceId,
      notes: 2
    });
  });

  it("does not count a release job as the pipeline's work", async () => {
    await pool.query("update jobs set status = 'succeeded' where type = 'note-embedding'");
    await expect(readPipelineBusy(pool)).resolves.toBe(false);
    const release = await createJobRepository(pool).create({
      type: topicReleaseJob,
      lane: "heavy",
      priority: 1_000,
      maxAttempts: 1,
      payload: { source: "first", division: 1, notes: 9 }
    });
    // Queued with no scope, so no import or link job of the root can keep it from being claimed.
    const row = (
      await pool.query<{ scope: string | null }>(
        "select scope_key as scope from jobs where id = $1",
        [release.id]
      )
    ).rows[0];
    expect(row).toEqual({ scope: null });
    await pool.query("update jobs set status = 'running' where id = $1", [release.id]);
    await expect(readPipelineBusy(pool)).resolves.toBe(true);
    await expect(readPipelineBusy(pool, [topicReleaseJob])).resolves.toBe(false);
  });
});
