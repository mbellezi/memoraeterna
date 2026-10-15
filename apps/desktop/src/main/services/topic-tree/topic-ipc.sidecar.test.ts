import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { IpcMain } from "electron";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  createTopicTreeRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import type { TopicsChangedEvent } from "@app/domain";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import { ipcChannels } from "../../../shared/ipc.js";
import { TopicReadService } from "./topic-read-service.js";
import { createTopicsChangedPublisher, registerTopicIpc } from "./topic-ipc.js";

// The registered handlers against a real PostgreSQL database: what the renderer's calls return, and
// the rule that makes `topicsChanged` safe: a window that hears of generation g reads at least g.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = { tree: u(1), root: u(2), area: u(3), leaf: u(4), other: u(5) };
const note = (n: number): string => u(300 + n);
const dimensions = 256;

describe.skipIf(!sidecarInstalled)("topic IPC against a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let generation = 0;
  const pushed: TopicsChangedEvent[] = [];
  const windows: Array<{
    isDestroyed: () => boolean;
    send: (channel: string, payload: unknown) => void;
  }> = [];
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const call = async (channel: string, payload?: unknown) => handlers.get(channel)!({}, payload);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-ipc-"));
    // Parallel test files pick free ports the same way; a lost race needs only a fresh attempt.
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_topic_ipc_test",
        user: "memora_topic_ipc_test",
        password: `topic-ipc-${randomUUID()}`,
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
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });

    await pool.query("insert into source_items (id, type, title) values ($1, 'Book', 'A book')", [
      u(100)
    ]);
    const document = randomUUID();
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'seed', 'hash')`,
      [document, u(100)]
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Passage', 'chunk')`,
      [u(400), document, u(100)]
    );
    for (let n = 1; n <= 5; n += 1) {
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
           ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
           generation_provider, generation_model, generation_runtime, generation_prompt_version, generation_key)
         values ($1, $2, 'Body', $3, 'active', 'current', 'source', $4, $4, $5, 'seed', 'seed', 'local', 'seed', $6)`,
        [note(n), `Note ${n}`, `Idea ${n}`, u(100), u(400), `key-${n}`]
      );
    }
    const repo = createTopicTreeRepository(pool);
    await repo.createTree({
      id: ids.tree,
      rootId: ids.root,
      spaceKey: "local:test:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions,
      config: {},
      configHash: "hash",
      seed: 1
    });
    const ls = new Float64Array(dimensions);
    ls[0] = 2.4;
    const built = await repo.bootstrapSnapshot({
      treeId: ids.tree,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics: [
        topicRecord(ids.area, ids.root, {
          role: "topic",
          title: "Area",
          nameState: "named",
          nameSource: "llm",
          nameLanguage: "en",
          position: 0
        }),
        topicRecord(ids.leaf, ids.area, {
          role: "topic",
          title: "Leaf",
          nameState: "named",
          nameSource: "llm",
          nameLanguage: "en",
          position: 0
        })
      ],
      placements: [1, 2, 3].map((n) => ({
        item: itemKey("note", note(n)),
        placement: placementRecord(ids.leaf)
      })),
      stats: [ids.root, ids.area, ids.leaf].map((topicId) => ({
        topicId,
        n: 3,
        ls,
        cosSqSum: 1.92,
        lowCosPercentiles: []
      }))
    });
    expect(built).toMatchObject({ kind: "applied", generation: 1 });
    generation = 1;

    registerTopicIpc(
      {
        handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) =>
          handlers.set(channel, handler)
      } as unknown as IpcMain,
      { read: new TopicReadService({ getPool: () => pool ?? null }) }
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("answers the reads of the screens with validated, bounded contracts", async () => {
    const tree = (await call(ipcChannels.topicsTree, {})) as {
      generation: number;
      parent: { id: string; items: number };
      nodes: Array<{ id: string; title: string; items: number }>;
    };
    expect(tree.generation).toBe(1);
    expect(tree.parent).toMatchObject({ id: ids.root, items: 3 });
    expect(tree.nodes).toMatchObject([{ id: ids.area, title: "Area", items: 3 }]);

    const page = (await call(ipcChannels.topicsPage, { id: ids.leaf })) as {
      counts: unknown;
      centralNotes: unknown[];
      overview: unknown;
      path: unknown[];
    };
    expect(page.counts).toEqual({ notes: 3, sources: 1, subtopics: 0 });
    expect(page.centralNotes).toHaveLength(3);
    expect(page.path).toHaveLength(3);
    expect(page.overview).toEqual({ status: "absent", canWrite: false });

    const notes = (await call(ipcChannels.topicsNotes, { id: ids.area, scope: "subtree" })) as {
      items: unknown[];
    };
    expect(notes.items).toHaveLength(3);
    expect(await call(ipcChannels.topicsPath, { id: ids.leaf })).toMatchObject({
      resolvedId: ids.leaf
    });
    expect(await call(ipcChannels.topicsShape, undefined)).toMatchObject({
      summary: { items: 3, topics: 2, reachable: 1 }
    });
    expect(await call(ipcChannels.topicsStatus)).toMatchObject({
      phase: "active",
      counts: { items: 5 + 1, placed: 3, pending: 3 }
    });
    expect(await call(ipcChannels.topicsPage, { id: u(9999) })).toBeNull();
    await expect(call(ipcChannels.topicsPage, { id: "nope" })).rejects.toThrow();
  });

  it("makes a pushed generation readable the moment the window hears of it", async () => {
    const publish = createTopicsChangedPublisher(() => windows);
    windows.push({
      isDestroyed: () => false,
      send: (_channel, payload) => pushed.push(payload as TopicsChangedEvent)
    });
    const repo = createTopicTreeRepository(pool!);
    const client = await pool!.connect();
    const before = generation;
    let changeSetId = "";
    try {
      await client.query("begin");
      const applied = await repo.applyChangeSet(
        {
          treeId: ids.tree,
          expectedGeneration: generation,
          origin: "place",
          titleKey: "topics.changeSets.place",
          events: [
            {
              op: "item.place",
              item: itemKey("note", note(4)),
              topicId: ids.leaf,
              before: null,
              after: placementRecord(ids.leaf)
            }
          ]
        },
        { client }
      );
      expect(applied.kind).toBe("applied");
      if (applied.kind === "applied") {
        generation = applied.generation;
        changeSetId = applied.changeSetId;
      }
      // Not committed yet: a read still sees the old tree, so nothing may be pushed.
      expect(((await call(ipcChannels.topicsTree, {})) as { generation: number }).generation).toBe(
        before
      );
      expect(pushed).toEqual([]);
      await client.query("commit");
    } finally {
      client.release();
    }
    // The service pushes after the commit, as T15's coalescer does.
    publish({ treeId: ids.tree, generation, topicIds: [ids.leaf], changeSetId });
    expect(pushed).toHaveLength(1);
    const read = (await call(ipcChannels.topicsTree, {})) as { generation: number };
    expect(read.generation).toBeGreaterThanOrEqual(pushed[0]!.generation);
    const page = (await call(ipcChannels.topicsPage, { id: ids.leaf })) as {
      lastChange: { changeSetId: string; undo: string } | null;
      topic: { newThisWeek: number; items: number };
    };
    expect(page.lastChange).toMatchObject({ changeSetId, undo: "available" });
    expect(page.topic).toMatchObject({ items: 4, newThisWeek: 1 });
    const detail = (await call(ipcChannels.topicsChangeSet, { id: changeSetId })) as {
      after: { items: Array<{ id: string }> };
    };
    expect(detail.after.items.map((item) => item.id)).toEqual([note(4)]);
  });

  it("pages leaves with an opaque cursor that a reload can start over from", async () => {
    const first = (await call(ipcChannels.topicsNotes, { id: ids.leaf, limit: 2 })) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (await call(ipcChannels.topicsNotes, {
      id: ids.leaf,
      limit: 2,
      cursor: first.nextCursor
    })) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    expect(second.nextCursor).toBeNull();
    await expect(
      call(ipcChannels.topicsNotes, {
        id: ids.leaf,
        cursor: Buffer.from("[1]").toString("base64url")
      })
    ).rejects.toThrow("topics.errors.stale");
  });
});
