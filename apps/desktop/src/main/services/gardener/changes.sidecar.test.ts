import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { IpcMain } from "electron";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAtomicNoteRelationRepository,
  createPgPool,
  createRelationMatchRunRepository,
  createSourceItemRepository,
  createTopicOverviewRepository,
  createTopicTreeRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool,
  type SaveTopicOverviewInput
} from "@app/db";
import type { TopicReviewInput, TopicUndoInput } from "@app/domain";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import { ipcChannels } from "../../../shared/ipc.js";
import { relationPromoteDedupeKey } from "../relations/relation-link.js";
import { registerChangesIpc } from "./changes-ipc.js";
import { ChangesService, type TopicChangeHandlers } from "./changes-service.js";

// F4 D10 on a real PostgreSQL database: one IPC undoes and reviews a change-set of every store
// through that store's own writer (the topic engine's handlers, the relation event log, the
// overview versions), re-promotes the roots a relation revert touched (I-R10), and refuses what
// the view says cannot be undone.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

type Handler = (event: unknown, payload?: unknown) => unknown;

describe.skipIf(!sidecarInstalled)("changes.* on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const handlers = new Map<string, Handler>();
  const call = (channel: string, payload?: unknown) => handlers.get(channel)!({}, payload);
  const topics = {
    undo: vi.fn<TopicChangeHandlers["undo"]>(),
    review: vi.fn<TopicChangeHandlers["review"]>()
  };
  const relationsChanged = vi.fn<(noteIds: string[]) => void>();
  const overviewChanged = vi.fn<(topicId: string) => void>();
  const changed = vi.fn();
  let treeId = "";
  let buildId = "";
  let topicId = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-changes-ipc-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_changes_ipc_test",
        user: "memora_changes_ipc_test",
        password: `changes-ipc-${randomUUID()}`,
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
    const source = await createSourceItemRepository(pool).create({ type: "Book", title: "Sleep" });
    const trees = createTopicTreeRepository(pool);
    const rootId = randomUUID();
    topicId = randomUUID();
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:changes:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    const built = await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        topicRecord(topicId, rootId, {
          role: "topic",
          title: "Sleep",
          nameState: "provisional",
          nameSource: "tfidf",
          nameLanguage: "en"
        })
      ],
      placements: [{ item: itemKey("source", source.id), placement: placementRecord(topicId) }]
    });
    treeId = tree.id;
    buildId = (built as { changeSetId: string }).changeSetId;
    const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
    registerChangesIpc(
      ipc as unknown as IpcMain,
      new ChangesService({
        getPool: () => pool ?? null,
        topics: () => topics,
        relationsChanged,
        overviewChanged,
        changed
      })
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  /** A source with a chunk, and a note on it with current evidence. */
  const seedNote = async (title: string) => {
    const db = pool!;
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID(),
      id = randomUUID();
    await db.query(`insert into source_items (id, type, title) values ($1, 'PersonalNote', $2)`, [
      sourceId,
      title
    ]);
    await db.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    await db.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, 'pending_review', 'current', 'source', $5, $5, $6, 'seed', 'seed',
               'local', 'seed', $7)`,
      [id, title, `${title} body.`, `${title} idea.`, sourceId, chunkId, `key-${id}`]
    );
    return { id, sourceId };
  };

  /** A finished pass that suggested one typed relation between two fresh notes. */
  const seedPass = async (pendingReview = false) => {
    const notes = [await seedNote("Retrieval"), await seedNote("Feedback")].sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    const runs = createRelationMatchRunRepository(pool!);
    const run = await runs.start({ kind: "match", pendingReview });
    const written = await createAtomicNoteRelationRepository(pool!).upsert({
      loAtomicNoteId: notes[0]!.id,
      hiAtomicNoteId: notes[1]!.id,
      direction: "lo_to_hi",
      relationType: "supports",
      band: "suggest",
      probability: 0.6,
      finalScore: 0.6,
      explanation: "knowledge.relations.explanations.reranked",
      runId: run.id
    });
    await runs.finish(run.id, { outcome: "completed" });
    return { runId: run.id, relationId: written.relation.id, notes };
  };

  it("undoes a relation pass exactly, re-promotes both roots and tells open pages", async () => {
    const pass = await seedPass();
    expect(await call(ipcChannels.changesUndo, { kind: "relation", id: pass.runId })).toEqual({
      status: "undone",
      kind: "relation",
      id: pass.runId
    });
    const row = await pool!.query("select 1 from atomic_note_relations where id = $1", [
      pass.relationId
    ]);
    expect(row.rowCount).toBe(0);
    expect(relationsChanged).toHaveBeenLastCalledWith(pass.notes.map((note) => note.id).sort());
    const promoted = await pool!.query<{ dedupeKey: string }>(
      `select dedupe_key as "dedupeKey" from jobs where type = 'relation-promote' order by dedupe_key`
    );
    expect(promoted.rows.map((job) => job.dedupeKey)).toEqual(
      pass.notes.map((note) => relationPromoteDedupeKey(note.sourceId)).sort()
    );
    expect(changed).toHaveBeenLastCalledWith({ kind: "relation", id: pass.runId });
    // A second undo is refused by the view: the pass reads undone.
    expect(await call(ipcChannels.changesUndo, { kind: "relation", id: pass.runId })).toEqual({
      status: "blocked",
      blockers: [{ code: "not_applied", changeSet: null }],
      more: 0
    });
  });

  it("keeps or dismisses a pass that waits for review; a human pass is not a change-set", async () => {
    const kept = await seedPass(true);
    expect(
      await call(ipcChannels.changesReview, { kind: "relation", id: kept.runId, verdict: "apply" })
    ).toEqual({ status: "applied" });
    expect(
      (await pool!.query("select 1 from atomic_note_relations where id = $1", [kept.relationId]))
        .rowCount
    ).toBe(1);
    const dropped = await seedPass(true);
    expect(
      await call(ipcChannels.changesReview, {
        kind: "relation",
        id: dropped.runId,
        verdict: "dismiss"
      })
    ).toEqual({ status: "dismissed" });
    expect(
      (await pool!.query("select 1 from atomic_note_relations where id = $1", [dropped.relationId]))
        .rowCount
    ).toBe(0);
    // A second verdict answers the first one's.
    expect(
      await call(ipcChannels.changesReview, {
        kind: "relation",
        id: kept.runId,
        verdict: "dismiss"
      })
    ).toEqual({ status: "applied" });
    const human = await createRelationMatchRunRepository(pool!).start({ kind: "review" });
    await expect(call(ipcChannels.changesUndo, { kind: "relation", id: human.id })).rejects.toThrow(
      "changes.errors.notFound"
    );
  });

  it("hands topic change-sets to the topic engine and refuses a build", async () => {
    const trees = createTopicTreeRepository(pool!);
    const records = await trees.readTreeRecords(treeId);
    const topic = records.topics.find((entry) => entry.id === topicId)!;
    const before = {
      title: topic.title,
      nameState: topic.nameState,
      nameSource: topic.nameSource,
      nameLanguage: topic.nameLanguage,
      namedChangeSetId: topic.namedChangeSetId,
      aliases: topic.aliases
    };
    const tree = (await trees.tree(treeId))!;
    const renamed = await trees.applyChangeSet({
      treeId,
      expectedGeneration: tree.generation,
      origin: "rebalance",
      titleKey: "topics.changeSets.rebalance",
      events: [{ op: "topic.rename", topicId, before, after: { ...before, title: "Rest" } }]
    });
    const changeSetId = (renamed as { changeSetId: string }).changeSetId;
    topics.undo.mockResolvedValueOnce({
      status: "blocked",
      blockers: [{ kind: "changeSet", changeSetId: buildId, objects: [] }]
    });
    expect(await call(ipcChannels.changesUndo, { kind: "topic", id: changeSetId })).toEqual({
      status: "blocked",
      blockers: [{ code: "later_change", changeSet: { kind: "topic", id: buildId } }],
      more: 0
    });
    topics.undo.mockResolvedValueOnce({
      status: "undone",
      changeSetId: randomUUID(),
      generation: 9
    });
    expect(await call(ipcChannels.changesUndo, { kind: "topic", id: changeSetId })).toEqual({
      status: "undone",
      kind: "topic",
      id: changeSetId
    });
    expect(topics.undo.mock.calls.map(([input]) => input)).toEqual<TopicUndoInput[]>([
      { changeSetId },
      { changeSetId }
    ]);
    expect(await call(ipcChannels.changesUndo, { kind: "topic", id: buildId })).toEqual({
      status: "blocked",
      blockers: [{ code: "not_undoable", changeSet: null }],
      more: 0
    });
    expect(topics.undo).toHaveBeenCalledTimes(2);

    const proposal = await trees.applyChangeSet({
      treeId,
      expectedGeneration: (await trees.tree(treeId))!.generation,
      origin: "rebalance",
      titleKey: "topics.changeSets.proposal",
      status: "pending_review",
      events: [
        {
          op: "topic.rename",
          topicId,
          before: { ...before, title: "Rest" },
          after: { ...before, title: "Proposed" }
        }
      ]
    });
    const proposalId = (proposal as { changeSetId: string }).changeSetId;
    topics.review.mockResolvedValueOnce({ status: "dismissed" });
    expect(
      await call(ipcChannels.changesReview, { kind: "topic", id: proposalId, verdict: "dismiss" })
    ).toEqual({ status: "dismissed" });
    expect(topics.review.mock.calls.map(([input]) => input)).toEqual<TopicReviewInput[]>([
      { changeSetId: proposalId, decision: "dismiss" }
    ]);
  });

  it("restores an overview write, applies a proposal and reads a moved one as stale", async () => {
    const overviews = createTopicOverviewRepository(pool!);
    const input = (text: string): SaveTopicOverviewInput => ({
      topicId,
      paragraphs: [{ text, citations: [] }],
      evidence: [],
      memberFingerprint: "m",
      memberCount: 1,
      inputHash: `i-${text}`,
      promptRevisionId: "p",
      provider: "test",
      model: "test",
      runtime: "none",
      aiTaskRunId: null,
      language: "en",
      support: { status: "unchecked", unsupported: [] },
      citations: []
    });
    await overviews.write(input("First."));
    const second = await overviews.write(input("Second."));
    if (second.kind !== "written" || !second.changeSetId) throw new Error("not written");
    expect(
      await call(ipcChannels.changesUndo, { kind: "overview", id: second.changeSetId })
    ).toEqual({ status: "undone", kind: "overview", id: second.changeSetId });
    expect(overviewChanged).toHaveBeenLastCalledWith(topicId);
    expect((await overviews.readContext(topicId))?.stored?.paragraphs[0]?.text).toBe("First.");
    const diff = (await call(ipcChannels.changesDiff, {
      kind: "overview",
      id: second.changeSetId
    })) as {
      before: { paragraphs: Array<{ text: string }> };
      after: { paragraphs: Array<{ text: string }> };
    };
    expect([diff.before.paragraphs[0]?.text, diff.after.paragraphs[0]?.text]).toEqual([
      "First.",
      "Second."
    ]);

    const applied = await overviews.propose(input("Proposed."));
    const moved = await overviews.propose(input("Moved."));
    if (applied.kind !== "proposed" || moved.kind !== "proposed") throw new Error("not proposed");
    expect(
      await call(ipcChannels.changesReview, { kind: "overview", id: applied.id, verdict: "apply" })
    ).toEqual({ status: "applied" });
    expect((await overviews.readContext(topicId))?.stored?.paragraphs[0]?.text).toBe("Proposed.");
    expect(
      await call(ipcChannels.changesReview, { kind: "overview", id: moved.id, verdict: "apply" })
    ).toEqual({ status: "stale" });
    const counts = (await call(ipcChannels.changesPendingCounts)) as {
      byKind: { overview: number };
    };
    expect(counts.byKind.overview).toBe(1);
  });
});
