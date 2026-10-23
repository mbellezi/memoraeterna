import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createGardenerStatusRepository, gardenerStatusSql } from "./gardenerStatusRepository.js";
import { createTopicOverviewRepository, topicOverviewSql } from "./topicOverviewRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe("the status statements", () => {
  it("only read", () => {
    for (const [name, statement] of Object.entries(gardenerStatusSql))
      expect(statement, name).not.toMatch(
        /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|alter\s+table)\b/iu
      );
  });

  it("count the unfinished tasks without a blocker, probing the running scope through its index", () => {
    expect(gardenerStatusSql.tasks).toContain("j.blocked_class is null");
    expect(gardenerStatusSql.tasks).toContain("r.status = 'running' and r.scope_key = j.scope_key");
  });
});

describe.skipIf(!sidecarInstalled)("the status reads on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;
  let treeId = "";
  let spaceKey = "";
  const topicA = randomUUID();
  const topicB = randomUUID();
  const topicC = randomUUID();
  const topicD = randomUUID();
  const notes: Array<{ id: string; sourceId: string }> = [];

  const seedNote = async (title: string, status = "pending_review", supersession = "current") => {
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID(),
      id = randomUUID();
    await db().query(`insert into source_items (id, type, title) values ($1, 'PersonalNote', $2)`, [
      sourceId,
      title
    ]);
    await db().query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    await db().query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    await db().query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, $5, $6, 'source', $7, $7, $8, 'seed', 'seed', 'local', 'seed', $9)`,
      [
        id,
        title,
        `${title} body.`,
        `${title} idea.`,
        status,
        supersession,
        sourceId,
        chunkId,
        `key-${id}`
      ]
    );
    return { id, sourceId };
  };

  const insertJob = async (input: {
    type: string;
    status?: "queued" | "running";
    scopeKey?: string | null;
    attempts?: number;
    runAfterSeconds?: number;
    blocked?: [string, string];
  }) =>
    (
      await db().query<{ id: string }>(
        `insert into jobs (type, status, lane, payload, scope_key, attempts, run_after,
                           blocked_class, blocked_reason, blocked_at, locked_at)
         values ($1, $2::job_status, 'light', '{}', $3, $4, now() + make_interval(secs => $5), $6, $7,
                 case when $6::text is null then null else now() end,
                 case when $2::job_status = 'running' then now() - interval '5 seconds' end)
         returning id`,
        [
          input.type,
          input.status ?? "queued",
          input.scopeKey ?? null,
          input.attempts ?? 0,
          input.runAfterSeconds ?? 0,
          input.blocked?.[0] ?? null,
          input.blocked?.[1] ?? null
        ]
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-gardener-status-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_gardener_status",
      user: "memora_gardener_status",
      password: `gardener-status-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });

    // Five notes: three placed (two in B, one in A), one not placed, one rejected and placed.
    for (const title of ["Sleep", "Memory", "Focus", "Unplaced"]) notes.push(await seedNote(title));
    notes.push(await seedNote("Rejected", "rejected"));
    notes.push(await seedNote("Superseded", "approved", "superseded"));
    const trees = createTopicTreeRepository(db());
    const rootId = randomUUID();
    spaceKey = "test:status:256";
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey,
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    treeId = tree.id;
    const named = { nameState: "provisional", nameSource: "tfidf", nameLanguage: "en" } as const;
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        topicRecord(topicA, rootId, { role: "topic", title: "Rest", ...named }),
        topicRecord(topicB, topicA, { role: "topic", title: "Sleep habits", ...named }),
        topicRecord(topicC, rootId, { role: "topic", title: "Work", ...named }),
        topicRecord(topicD, rootId, { role: "topic", title: "Empty", ...named })
      ],
      placements: [
        {
          item: itemKey("note", notes[0]!.id),
          placement: placementRecord(topicB, { itemFingerprint: "fp-sleep" })
        },
        {
          item: itemKey("note", notes[1]!.id),
          placement: placementRecord(topicB, { itemFingerprint: "fp-memory" })
        },
        {
          item: itemKey("note", notes[2]!.id),
          placement: placementRecord(topicA, { itemFingerprint: "fp-focus" })
        },
        {
          item: itemKey("note", notes[4]!.id),
          placement: placementRecord(topicC, { itemFingerprint: "fp-rejected" })
        }
      ]
    });
    // Matching state: two notes in the tree's space, one in another space.
    for (const [index, space] of [spaceKey, spaceKey, "other:space:256"].entries())
      await db().query(
        `insert into note_match_state (note_id, decider_key, space_key) values ($1, 'test', $2)`,
        [notes[index]!.id, space]
      );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("counts the current notes, those placed in the active tree and those matched in its space", async () => {
    const counts = await createGardenerStatusRepository(db()).coverage();
    // The rejected and the superseded notes are not counted; the placed rejected one neither.
    expect(counts).toMatchObject({ notes: 4, placedNotes: 3, matchedNotes: 2 });
  });

  const saveOverview = async (topicId: string, memberFingerprint: string) => {
    const written = await createTopicOverviewRepository(db()).write({
      topicId,
      paragraphs: [{ text: "An overview.", citations: [] }],
      evidence: [],
      memberFingerprint,
      memberCount: 1,
      inputHash: `input-${topicId}`,
      promptRevisionId: "p",
      provider: "test",
      model: "test",
      runtime: "none",
      aiTaskRunId: null,
      language: "en",
      support: { status: "unchecked", unsupported: [] },
      citations: []
    });
    expect(written.kind).toBe("written");
  };

  it("reads an overview as fresh while its subtree's members are unchanged, with the formula the overview uses", async () => {
    // The fingerprint the overview service stores for topic A (its subtree holds B's notes too).
    const members = await db().query<{ fingerprint: string }>(topicOverviewSql.members, [
      topicA,
      treeId
    ]);
    const current = members.rows[0]!.fingerprint;
    await saveOverview(topicA, current);
    await saveOverview(topicB, "an older fingerprint");
    const counts = await createGardenerStatusRepository(db()).coverage();
    expect(counts).toMatchObject({ overviews: 2, freshOverviews: 1 });
    // A member that moves away makes the overview of the parent stale.
    await db().query("update topic_placements set item_fingerprint = 'moved' where note_id = $1", [
      notes[2]!.id
    ]);
    expect(await createGardenerStatusRepository(db()).coverage()).toMatchObject({
      overviews: 2,
      freshOverviews: 0
    });
    // An overview of a topic with no members is fresh when its stored fingerprint is that of none.
    const empty = await db().query<{ fingerprint: string }>(topicOverviewSql.members, [
      topicD,
      treeId
    ]);
    await saveOverview(topicD, empty.rows[0]!.fingerprint);
    expect(await createGardenerStatusRepository(db()).coverage()).toMatchObject({
      overviews: 3,
      freshOverviews: 1
    });
  });

  it("counts nothing for an empty library", async () => {
    const empty = await createGardenerStatusRepository(db()).taskCounts([]);
    expect(empty).toEqual([]);
  });

  it("counts the unfinished tasks of a type by what holds them back", async () => {
    await db().query("delete from jobs");
    // topic-build holds the scope "tree:t:structure" while it runs.
    await insertJob({ type: "topic-build", status: "running", scopeKey: "tree:t:structure" });
    await insertJob({ type: "topic-place", scopeKey: "tree:t:structure" });
    await insertJob({ type: "topic-place", scopeKey: "tree:other:structure" });
    await insertJob({ type: "topic-place" });
    await insertJob({ type: "topic-place", runAfterSeconds: 3_600, attempts: 1 });
    await insertJob({ type: "topic-place", runAfterSeconds: 120 });
    // Housekeeping due tomorrow is not work in progress.
    await insertJob({ type: "topic-place", runAfterSeconds: 86_400 });
    await insertJob({ type: "topic-place", blocked: ["paused", "user_pause"] });
    await insertJob({ type: "ingestion" });
    const rows = await createGardenerStatusRepository(db()).taskCounts([
      "topic-place",
      "topic-build",
      "topic-name"
    ]);
    expect(rows).toEqual([
      { type: "topic-build", running: 1, ready: 0, sameScope: 0, retrying: 0, scheduled: 0 },
      { type: "topic-place", running: 0, ready: 2, sameScope: 1, retrying: 1, scheduled: 1 }
    ]);
  });

  it("lists the running jobs with the time they were claimed", async () => {
    const running = await createGardenerStatusRepository(db()).runningJobs([
      "topic-build",
      "topic-place"
    ]);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ type: "topic-build" });
    expect(Date.now() - running[0]!.lockedAt!.getTime()).toBeGreaterThan(4_000);
    expect(await createGardenerStatusRepository(db()).runningJobs([])).toEqual([]);
  });

  it("tells how a job that stopped running ended and when", async () => {
    const repository = createGardenerStatusRepository(db());
    const [job] = await repository.runningJobs(["topic-build"]);
    await db().query(
      "update jobs set status = 'succeeded', finished_at = now(), locked_at = null where id = $1",
      [job!.id]
    );
    expect(await repository.runningJobs(["topic-build"])).toEqual([]);
    const ends = await repository.jobEnds([job!.id, randomUUID()]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ id: job!.id, status: "succeeded" });
    expect(ends[0]!.finishedAt).toBeInstanceOf(Date);
    expect(await repository.jobEnds([])).toEqual([]);
  });
});
