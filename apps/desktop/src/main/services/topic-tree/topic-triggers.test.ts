import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnqueueDedupedInput, PgPool, Queryable } from "@app/db";

import { TopicTriggers, immediateDebounce } from "./topic-triggers.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const tree = uuid(1);
const rootA = uuid(10);
const rootB = uuid(11);

/** The repositories a trigger reads and writes, recorded by the database they were given. */
const db = vi.hoisted(() => ({
  activeTree: null as string | null,
  /** Whether a cascade left inexact statistics, as `topic_stats.dirty` reports it. */
  dirtyStats: false,
  dirtyChecks: [] as Array<{ text: string; values: unknown[] | undefined; db: unknown }>,
  owners: new Map<string, { kind: "note" | "source"; rootSourceId: string | null }>(),
  enqueued: [] as Array<{ input: EnqueueDedupedInput; db: unknown }>,
  queued: new Map<string, string>()
}));

vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createTopicTreeRepository: () => ({
    activeTree: async () => (db.activeTree ? { id: db.activeTree } : null)
  }),
  createTopicTreeLoadRepository: () => ({
    itemOwners: async (input: { noteIds?: string[]; sourceIds?: string[] }) => {
      const notes = new Map();
      const sources = new Map();
      for (const id of input.noteIds ?? []) {
        const owner = db.owners.get(id);
        if (owner?.kind === "note")
          notes.set(id, { id, current: true, rootSourceId: owner.rootSourceId });
      }
      for (const id of input.sourceIds ?? []) {
        const owner = db.owners.get(id);
        if (owner?.kind === "source") {
          sources.set(id, { id, rootSourceId: owner.rootSourceId, contentHash: null });
        }
      }
      return { notes, sources };
    }
  }),
  createJobRepository: (database: unknown) => ({
    // One queued job per key, as the partial unique index admits.
    enqueueDeduped: async (input: EnqueueDedupedInput) => {
      db.enqueued.push({ input, db: database });
      const existing = db.queued.get(input.dedupeKey);
      const id = existing ?? `job-${db.queued.size + 1}`;
      db.queued.set(input.dedupeKey, id);
      return {
        job: { id, type: input.type, dedupeKey: input.dedupeKey, payload: input.payload },
        created: !existing
      };
    }
  })
}));

/** Both the pool and a caller's transaction answer the dirty-statistics read the same way. */
function fakeDatabase(): Queryable {
  const self: { query: ReturnType<typeof vi.fn> } = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      db.dirtyChecks.push({ text, values, db: self });
      return { rows: [{ dirty: db.dirtyStats }] };
    })
  };
  return self as unknown as Queryable;
}
const pool = fakeDatabase() as unknown as PgPool;
const debounce = { delayMs: 10_000, maxDelayMs: 60_000 };

function triggers(registered = ["topic-place", "topic-sweep"]) {
  const wake = vi.fn();
  const onEnqueued = vi.fn();
  return {
    wake,
    onEnqueued,
    triggers: new TopicTriggers({
      getPool: () => pool,
      isRegistered: (type) => registered.includes(type),
      debounce: () => debounce,
      onEnqueued,
      wake
    })
  };
}

beforeEach(() => {
  db.activeTree = tree;
  db.owners = new Map([
    [uuid(100), { kind: "note", rootSourceId: rootA }],
    [uuid(101), { kind: "note", rootSourceId: rootA }],
    [uuid(102), { kind: "note", rootSourceId: rootB }],
    [uuid(103), { kind: "note", rootSourceId: null }],
    [uuid(200), { kind: "source", rootSourceId: rootB }]
  ]);
  db.enqueued = [];
  db.queued = new Map();
  db.dirtyStats = false;
  db.dirtyChecks = [];
});

describe("topic triggers", () => {
  it("enqueue one deduped, debounced light PLACE per root, and per note without a root", async () => {
    const { triggers: api, wake } = triggers();
    await api.notesChanged([uuid(100), uuid(101), uuid(102), uuid(103)]);
    await api.notesChanged([uuid(101)]);
    expect(db.enqueued.map((entry) => entry.input.dedupeKey)).toEqual([
      `topic-place:${tree}:${rootA}`,
      `topic-place:${tree}:${rootB}`,
      `topic-place:${tree}:note:${uuid(103)}`,
      `topic-place:${tree}:${rootA}`
    ]);
    // The second request for rootA joined the queued job instead of adding one.
    expect([...db.queued.keys()]).toHaveLength(3);
    for (const { input } of db.enqueued) {
      expect(input).toMatchObject({ type: "topic-place", lane: "light", debounce });
    }
    expect(db.enqueued[0]?.input.payload).toEqual({
      treeId: tree,
      rootSourceId: rootA,
      sourceItemId: rootA
    });
    expect(db.enqueued[2]?.input.payload).toEqual({ treeId: tree, noteId: uuid(103) });
    expect(wake).toHaveBeenCalledTimes(4);
  });

  it("place the root of a source whose vector was written", async () => {
    const { triggers: api } = triggers();
    await api.sourcesChanged([uuid(200)]);
    expect(db.enqueued.map((entry) => entry.input.dedupeKey)).toEqual([
      `topic-place:${tree}:${rootB}`
    ]);
  });

  it("enqueue in the caller's transaction and leave waking to the commit", async () => {
    const { triggers: api, wake } = triggers();
    const client = { query: vi.fn() } as unknown as Queryable;
    await api.notesChanged([uuid(100)], { client });
    expect(db.enqueued[0]?.db).toBe(client);
    expect(wake).not.toHaveBeenCalled();
  });

  it("send a deleted note's tree to the sweep (D32) and sweep first when no tree exists", async () => {
    const { triggers: api } = triggers();
    await api.notesChanged([uuid(100), uuid(999)]);
    expect(db.enqueued.map((entry) => entry.input.dedupeKey)).toEqual([
      `topic-place:${tree}:${rootA}`,
      `topic-sweep:${tree}`
    ]);
    db.activeTree = null;
    db.enqueued = [];
    await api.notesChanged([uuid(100)]);
    expect(db.enqueued.map((entry) => entry.input)).toMatchObject([
      { dedupeKey: "topic-sweep:none", payload: { treeId: null, reason: "requested" } }
    ]);
  });

  it("skip job types nobody executes and report every enqueued job", async () => {
    const { triggers: api, onEnqueued } = triggers();
    await expect(api.request("topic-gate", tree, { rootSourceId: rootA })).resolves.toEqual([]);
    await expect(api.request("topic-build", tree)).resolves.toEqual([]);
    expect(db.enqueued).toEqual([]);
    const registered = triggers(["topic-place", "topic-sweep", "topic-gate"]);
    const [gate] = await registered.triggers.request("topic-gate", tree, { rootSourceId: rootA });
    expect(gate?.job.dedupeKey).toBe(`topic-gate:${tree}:${rootA}`);
    expect(registered.onEnqueued).toHaveBeenCalledWith(gate);
    expect(onEnqueued).not.toHaveBeenCalled();
  });

  it("sweep with the given debounce, naming the reason", async () => {
    const { triggers: api } = triggers();
    await api.sweep("startup", { debounce: immediateDebounce });
    expect(db.enqueued[0]?.input).toMatchObject({
      type: "topic-sweep",
      dedupeKey: `topic-sweep:${tree}`,
      payload: { treeId: tree, reason: "startup" },
      debounce: immediateDebounce
    });
  });

  describe("repair after a cascade (D32)", () => {
    const withRebalance = ["topic-place", "topic-sweep", "topic-rebalance"];

    it("enqueues the sweep and the rebalance of the tree while statistics are dirty", async () => {
      db.dirtyStats = true;
      const { triggers: api } = triggers(withRebalance);
      const jobs = await api.repair();
      expect(jobs.map((entry) => entry.type)).toEqual(["topic-sweep", "topic-rebalance"]);
      expect(db.enqueued.map((entry) => entry.input)).toMatchObject([
        {
          type: "topic-sweep",
          lane: "light",
          dedupeKey: `topic-sweep:${tree}`,
          payload: { treeId: tree, reason: "dirty_stats" },
          debounce
        },
        {
          type: "topic-rebalance",
          lane: "light",
          dedupeKey: `topic-rebalance:${tree}`,
          payload: { treeId: tree },
          debounce
        }
      ]);
      // The read is scoped to the active tree.
      expect(db.dirtyChecks[0]?.values).toEqual([tree]);
    });

    it("enqueues nothing when no placed item was removed", async () => {
      const { triggers: api } = triggers(withRebalance);
      await expect(api.repair()).resolves.toEqual([]);
      expect(db.enqueued).toEqual([]);
      expect(db.dirtyChecks).toHaveLength(1);
    });

    it("enqueues nothing without an active tree, and skips a rebalance nobody executes", async () => {
      db.dirtyStats = true;
      db.activeTree = null;
      const { triggers: api } = triggers(withRebalance);
      await expect(api.repair()).resolves.toEqual([]);
      expect(db.dirtyChecks).toEqual([]);
      db.activeTree = tree;
      const only = triggers();
      const jobs = await only.triggers.repair();
      expect(jobs.map((entry) => entry.type)).toEqual(["topic-sweep"]);
    });

    it("reads and enqueues in the caller's transaction, where the cascade is visible", async () => {
      db.dirtyStats = true;
      const { triggers: api, wake } = triggers(withRebalance);
      const client = fakeDatabase();
      await api.repair({ client });
      expect(db.dirtyChecks[0]?.db).toBe(client);
      expect(db.enqueued.map((entry) => entry.db)).toEqual([client, client]);
      expect(wake).not.toHaveBeenCalled();
    });

    it("joins the repair already queued instead of adding another", async () => {
      db.dirtyStats = true;
      const { triggers: api } = triggers(withRebalance);
      await api.repair();
      await api.repair();
      expect([...db.queued.keys()].sort()).toEqual([
        `topic-rebalance:${tree}`,
        `topic-sweep:${tree}`
      ]);
    });
  });
});
