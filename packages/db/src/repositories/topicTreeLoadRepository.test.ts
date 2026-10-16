import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import {
  TopicLoadError,
  TopicSkeletonUnstableError,
  createTopicTreeLoadRepository,
  decodeFloat64Vector,
  encodeFloat64Vector,
  noteVectorStrategyPrefix,
  topicPendingReasons,
  sourceVectorStrategyPrefix,
  topicLoadDefaults,
  topicLoadSql
} from "./topicTreeLoadRepository.js";
import type { TopicLoadSpace } from "./topicTreeLoadRepository.js";
import type { Queryable } from "./types.js";

// The statements run against a real database in `npm run db:topic-load:verify` (answers, latency and
// EXPLAIN); these tests pin how rows become the skeleton and the matrix, the paging, the stale and
// missing rules and that the repository can only read.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space: TopicLoadSpace = {
  spaceKey: "space-a",
  provider: "local",
  model: "embed-4",
  runtime: "mlx",
  dimensions: 256
};

type Handler = (values: readonly unknown[]) => QueryResultRow[];

/** A database stub that answers each statement by its text. */
function stub(handlers: Map<string, Handler>) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    const handler = handlers.get(text);
    if (!handler) throw new Error(`Unexpected statement: ${text.slice(0, 60)}`);
    return { rows: handler(values) } as unknown as QueryResult<QueryResultRow>;
  });
  return { db: { query } as unknown as Queryable, calls, query };
}

const treeRow = (overrides: Record<string, unknown> = {}) => ({
  id: id(1),
  status: "active",
  spaceKey: space.spaceKey,
  provider: space.provider,
  model: space.model,
  runtime: space.runtime,
  dimensions: 256,
  config: { version: 1 },
  configHash: "hash",
  // bigint columns arrive as strings
  seed: "42",
  generation: "7",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  activatedAt: new Date("2026-10-01T00:00:01Z"),
  retiredAt: null,
  ...overrides
});

const placementRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: id(1000 + n),
  itemKind: "note",
  itemId: id(100 + n),
  topicId: id(10),
  rank: 0,
  management: "ai",
  decidedBy: "build",
  itemFingerprint: `fp-${n}`,
  score: 0.5,
  margin: 0.1,
  centrality: 0.9,
  needsGate: false,
  needsSplitCheck: false,
  needsVector: false,
  movedFromTopicId: null,
  movedAt: null,
  changeSetId: id(500),
  ...overrides
});

const topicRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: id(n),
  parentId: n === 10 ? null : id(10),
  role: n === 10 ? "root" : "topic",
  title: n === 10 ? null : `Topic ${n}`,
  nameState: n === 10 ? "unnamed" : "named",
  nameSource: n === 10 ? null : "llm",
  nameLanguage: n === 10 ? null : "en",
  namedChangeSetId: null,
  description: null,
  aliases: ["alias"],
  management: "ai",
  position: n,
  retiredAt: null,
  redirectTo: null,
  createdChangeSetId: null,
  statsTopicId: id(n),
  statsSpaceKey: space.spaceKey,
  n: 3,
  ls: encodeFloat64Vector(Float64Array.from({ length: 256 }, (_, k) => k + n)),
  cosSqSum: 2.5,
  lowCosPercentiles: [0.1, 0.2],
  coherence: 0.8,
  directItems: 3,
  children: 0,
  health: "good",
  violations: [],
  dirty: false,
  lastRepairAt: null,
  repairClock: "4",
  computedAt: new Date("2026-10-01T01:00:00Z"),
  ...overrides
});

/** What pgvector's `vector_send` returns: int16 dimensions, int16 unused, big-endian float32. */
function vectorSend(values: ArrayLike<number>): Buffer {
  const buffer = Buffer.alloc(4 + values.length * 4);
  buffer.writeInt16BE(values.length, 0);
  for (let k = 0; k < values.length; k += 1) buffer.writeFloatBE(values[k] as number, 4 + k * 4);
  return buffer;
}

const seeded = (seed: number, dim = 256) =>
  Float32Array.from({ length: dim }, (_, k) => Math.sin(seed * 31 + k * 0.37) + 0.1);

describe("statistics bytes", () => {
  it("round-trips a float64 vector, also from an unaligned buffer", () => {
    const values = Float64Array.from({ length: 8 }, (_, k) => k * 1.5 - 3.25);
    const stored = encodeFloat64Vector(values);
    expect(Array.from(decodeFloat64Vector(stored, 8))).toEqual(Array.from(values));
    // A driver buffer is a slice of a larger pool, rarely aligned to 8 bytes.
    const pooled = Buffer.concat([Buffer.from([1, 2, 3]), stored]).subarray(3);
    expect(pooled.byteOffset % 8).not.toBe(0);
    expect(Array.from(decodeFloat64Vector(pooled, 8))).toEqual(Array.from(values));
  });

  it("reads an empty value as the zero vector and refuses a wrong length", () => {
    expect(Array.from(decodeFloat64Vector(new Uint8Array(0), 4))).toEqual([0, 0, 0, 0]);
    expect(() => decodeFloat64Vector(new Uint8Array(24), 4)).toThrow(TopicLoadError);
  });
});

describe("loadSkeleton", () => {
  function skeletonStub(options: {
    placements: Array<Record<string, unknown>>;
    topics: Array<Record<string, unknown>>;
    generations?: string[];
    tree?: Record<string, unknown> | null;
  }) {
    const generations = [...(options.generations ?? ["7"])];
    return stub(
      new Map<string, Handler>([
        [topicLoadSql.tree, () => (options.tree === null ? [] : [options.tree ?? treeRow()])],
        [
          topicLoadSql.generation,
          () => [{ generation: generations.length > 1 ? generations.shift() : generations[0] }]
        ],
        [
          topicLoadSql.placements,
          (values) => {
            // The cursor is (kind, item, rank): return what follows it.
            const after = values[2] as string | null;
            const rank = values[3] as number | null;
            const rows = options.placements.filter(
              (row) =>
                after === null ||
                (row.itemId as string) > after ||
                (row.itemId === after && (row.rank as number) > (rank ?? -1))
            );
            return rows.slice(0, values[4] as number);
          }
        ],
        [
          topicLoadSql.topics,
          (values) => {
            const after = values[1] as string | null;
            return options.topics
              .filter((row) => after === null || (row.id as string) > after)
              .slice(0, values[2] as number);
          }
        ]
      ])
    );
  }

  it("decodes the tree, placements and topics with their statistics", async () => {
    const { db } = skeletonStub({
      placements: [
        placementRow(1),
        placementRow(2, { rank: 0, needsGate: true, movedAt: new Date("2026-10-02T00:00:00Z") })
      ],
      topics: [topicRow(10), topicRow(11)]
    });
    const skeleton = await createTopicTreeLoadRepository(db).loadSkeleton(id(1));
    expect(skeleton?.tree).toMatchObject({
      id: id(1),
      status: "active",
      space,
      seed: 42,
      generation: 7,
      activatedAt: "2026-10-01T00:00:01.000Z",
      retiredAt: null
    });
    expect(skeleton?.placements.map((placement) => placement.key)).toEqual([
      `note:${id(101)}`,
      `note:${id(102)}`
    ]);
    expect(skeleton?.placements[1]).toMatchObject({
      rank: 0,
      needsGate: true,
      movedAt: "2026-10-02T00:00:00.000Z",
      decidedBy: "build",
      itemFingerprint: "fp-2"
    });
    const topic = skeleton?.topics[1];
    expect(topic).toMatchObject({
      id: id(11),
      title: "Topic 11",
      aliases: ["alias"],
      parentId: id(10)
    });
    expect(topic?.stats).toMatchObject({
      spaceKey: space.spaceKey,
      n: 3,
      cosSqSum: 2.5,
      repairClock: 4,
      dirty: false,
      health: "good"
    });
    expect(topic?.stats?.ls).toBeInstanceOf(Float64Array);
    expect(topic?.stats?.ls.length).toBe(256);
    expect(topic?.stats?.ls[5]).toBe(16);
    expect(Array.from(topic?.stats?.lowCosPercentiles ?? [])).toEqual([
      Math.fround(0.1),
      Math.fround(0.2)
    ]);
  });

  it("leaves stats null for a topic without a statistics row", async () => {
    const { db } = skeletonStub({
      placements: [],
      topics: [topicRow(10, { statsTopicId: null, ls: null, n: null })]
    });
    const skeleton = await createTopicTreeLoadRepository(db).loadSkeleton(id(1));
    expect(skeleton?.topics[0]?.stats).toBeNull();
    expect(skeleton?.placements).toEqual([]);
  });

  it("keeps a repair clock that was never set null, not 0", async () => {
    const { db } = skeletonStub({ placements: [], topics: [topicRow(10, { repairClock: null })] });
    const skeleton = await createTopicTreeLoadRepository(db).loadSkeleton(id(1));
    expect(skeleton?.topics[0]?.stats?.repairClock).toBeNull();
  });

  it("pages placements by keyset and topics by id", async () => {
    const placements = [1, 2, 3, 4, 5].map((n) => placementRow(n));
    const topics = [10, 11, 12, 13, 14].map((n) => topicRow(n));
    const { db, calls } = skeletonStub({ placements, topics });
    const skeleton = await createTopicTreeLoadRepository(db).loadSkeleton(id(1), {
      placementPageSize: 2,
      topicPageSize: 2
    });
    expect(skeleton?.placements).toHaveLength(5);
    expect(skeleton?.topics.map((topic) => topic.id)).toEqual([10, 11, 12, 13, 14].map(id));
    const placementCalls = calls.filter((call) => call.text === topicLoadSql.placements);
    // 5 rows in pages of 2: three statements, the last one short.
    expect(placementCalls.map((call) => call.values)).toEqual([
      [id(1), null, null, null, 2],
      [id(1), "note", id(102), 0, 2],
      [id(1), "note", id(104), 0, 2]
    ]);
    const topicCalls = calls.filter((call) => call.text === topicLoadSql.topics);
    expect(topicCalls.map((call) => call.values[1])).toEqual([null, id(11), id(13)]);
  });

  it("reads placements before topics and the generation last, so statistics are never older", async () => {
    const { db, calls } = skeletonStub({ placements: [placementRow(1)], topics: [topicRow(10)] });
    await createTopicTreeLoadRepository(db).loadSkeleton(id(1));
    expect(calls.map((call) => call.text)).toEqual([
      topicLoadSql.tree,
      topicLoadSql.placements,
      topicLoadSql.topics,
      topicLoadSql.generation
    ]);
  });

  it("reads again when a change-set committed during the read", async () => {
    const { db, calls } = skeletonStub({
      placements: [placementRow(1)],
      topics: [topicRow(10)],
      generations: ["8", "7"]
    });
    const skeleton = await createTopicTreeLoadRepository(db).loadSkeleton(id(1));
    expect(skeleton?.tree.generation).toBe(7);
    expect(calls.filter((call) => call.text === topicLoadSql.tree)).toHaveLength(2);
  });

  it("gives up when the tree keeps changing", async () => {
    const { db } = skeletonStub({
      placements: [],
      topics: [topicRow(10)],
      generations: ["8", "9", "10", "11"]
    });
    await expect(
      createTopicTreeLoadRepository(db).loadSkeleton(id(1), { attempts: 3 })
    ).rejects.toBeInstanceOf(TopicSkeletonUnstableError);
  });

  it("returns null for a tree that does not exist", async () => {
    const { db, query } = skeletonStub({ placements: [], topics: [], tree: null });
    expect(await createTopicTreeLoadRepository(db).loadSkeleton(id(9))).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a stored statistic of the wrong size instead of guessing", async () => {
    const { db } = skeletonStub({
      placements: [],
      topics: [topicRow(10, { ls: Buffer.alloc(16) })]
    });
    await expect(createTopicTreeLoadRepository(db).loadSkeleton(id(1))).rejects.toBeInstanceOf(
      TopicLoadError
    );
  });

  it("rejects page sizes outside the bounds", async () => {
    const { db } = skeletonStub({ placements: [], topics: [] });
    const repository = createTopicTreeLoadRepository(db);
    await expect(repository.loadSkeleton(id(1), { topicPageSize: 0 })).rejects.toBeInstanceOf(
      TopicLoadError
    );
    await expect(repository.loadSkeleton(id(1), { placementPageSize: 1.5 })).rejects.toBeInstanceOf(
      TopicLoadError
    );
  });
});

describe("loadItemVectors", () => {
  const sql = topicLoadSql.itemVectors(256);

  /** Stored vectors by target type and id; the stub honours the id list and the strategy. */
  function vectorStub(
    stored: Array<{
      type: string;
      id: string;
      hash: string;
      values: ArrayLike<number>;
      strategy?: string;
    }>
  ) {
    return stub(
      new Map<string, Handler>([
        [
          sql,
          (values) => {
            const [type, ids, model, strategy] = values as [string, string[], string, string];
            expect(model).toBe(space.model);
            return (
              stored
                .filter(
                  (row) =>
                    row.type === type &&
                    ids.includes(row.id) &&
                    (row.strategy ?? strategy) === strategy
                )
                .map((row) => ({
                  id: row.id,
                  contentHash: row.hash,
                  vector: vectorSend(row.values)
                }))
                // The database returns them in any order.
                .reverse()
            );
          }
        ]
      ])
    );
  }

  it("loads the vectors in request order with exact float32 values, paged", async () => {
    const notes = [1, 2, 3, 4, 5];
    const { db, calls } = vectorStub(
      notes.map((n) => ({ type: "atomic_note", id: id(n), hash: `h${n}`, values: seeded(n) }))
    );
    const result = await createTopicTreeLoadRepository(db).loadItemVectors(
      space,
      notes.map((n) => ({ kind: "note", id: id(n) })),
      { pageSize: 2, normalize: false }
    );
    expect(result.keys).toEqual(notes.map((n) => `note:${id(n)}`));
    expect(result.contentHashes).toEqual(notes.map((n) => `h${n}`));
    expect(result.matrix.count).toBe(5);
    expect(result.matrix.dim).toBe(256);
    for (const [row, n] of notes.entries()) {
      const stored = seeded(n);
      expect(Array.from(result.matrix.data.subarray(row * 256, (row + 1) * 256))).toEqual(
        Array.from(stored)
      );
    }
    expect(calls).toHaveLength(3);
    expect(calls[0]?.values).toEqual([
      "atomic_note",
      [id(1), id(2)],
      space.model,
      `${noteVectorStrategyPrefix}${space.spaceKey}`
    ]);
    expect(result.missing).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("normalizes rows to unit length by default", async () => {
    const { db } = vectorStub([
      { type: "atomic_note", id: id(1), hash: "h1", values: seeded(1).map((v) => v * 40) }
    ]);
    const result = await createTopicTreeLoadRepository(db).loadItemVectors(space, [
      { kind: "note", id: id(1) }
    ]);
    const row = result.matrix.data.subarray(0, 256);
    expect(Math.hypot(...Array.from(row))).toBeCloseTo(1, 5);
  });

  it("reports missing items and stale vectors instead of guessing", async () => {
    const { db } = vectorStub([
      { type: "atomic_note", id: id(1), hash: "current", values: seeded(1) },
      { type: "atomic_note", id: id(2), hash: "old", values: seeded(2) }
    ]);
    const result = await createTopicTreeLoadRepository(db).loadItemVectors(space, [
      { kind: "note", id: id(1), contentHash: "current" },
      { kind: "note", id: id(2), contentHash: "edited" },
      { kind: "note", id: id(3), contentHash: "never-embedded" }
    ]);
    expect(result.keys).toEqual([`note:${id(1)}`]);
    expect(result.stale).toEqual([`note:${id(2)}`]);
    expect(result.missing).toEqual([`note:${id(3)}`]);
    expect(result.matrix.count).toBe(1);
    expect(result.matrix.data.length).toBe(256);
  });

  it("treats a vector of another space as missing, since the strategy carries the space key", async () => {
    const { db } = vectorStub([
      {
        type: "atomic_note",
        id: id(1),
        hash: "h",
        values: seeded(1),
        strategy: `${noteVectorStrategyPrefix}other-space`
      },
      {
        type: "atomic_note",
        id: id(2),
        hash: "h",
        values: seeded(2),
        strategy: "native-unidentified"
      }
    ]);
    const result = await createTopicTreeLoadRepository(db).loadItemVectors(space, [
      { kind: "note", id: id(1) },
      { kind: "note", id: id(2) }
    ]);
    expect(result.keys).toEqual([]);
    expect(result.missing).toEqual([`note:${id(1)}`, `note:${id(2)}`]);
  });

  it("drops a zero vector from the matrix and reports it missing", async () => {
    const { db } = vectorStub([
      { type: "atomic_note", id: id(1), hash: "a", values: seeded(1) },
      { type: "atomic_note", id: id(2), hash: "b", values: new Float32Array(256) },
      { type: "atomic_note", id: id(3), hash: "c", values: seeded(3) }
    ]);
    const result = await createTopicTreeLoadRepository(db).loadItemVectors(space, [
      { kind: "note", id: id(1) },
      { kind: "note", id: id(2) },
      { kind: "note", id: id(3) }
    ]);
    expect(result.keys).toEqual([`note:${id(1)}`, `note:${id(3)}`]);
    expect(result.contentHashes).toEqual(["a", "c"]);
    expect(result.missing).toEqual([`note:${id(2)}`]);
    expect(result.matrix.count).toBe(2);
    // The kept rows moved up: row 1 is item 3, normalized.
    const expected = seeded(3);
    const scale = 1 / Math.hypot(...Array.from(expected));
    expect(result.matrix.data[256 + 7]).toBeCloseTo((expected[7] as number) * scale, 6);
  });

  it("reads source composites from their own target type and strategy", async () => {
    const { db, calls } = vectorStub([
      {
        type: "source_item",
        id: id(7),
        hash: "composite",
        values: seeded(7),
        strategy: `${sourceVectorStrategyPrefix}${space.spaceKey}`
      },
      { type: "atomic_note", id: id(1), hash: "note", values: seeded(1) }
    ]);
    const result = await createTopicTreeLoadRepository(db).loadItemVectors(space, [
      { kind: "source", id: id(7) },
      { kind: "note", id: id(1) }
    ]);
    expect(result.keys).toEqual([`source:${id(7)}`, `note:${id(1)}`]);
    const targets = calls.map((call) => [call.values[0], call.values[3]]);
    expect(targets).toContainEqual([
      "source_item",
      `${sourceVectorStrategyPrefix}${space.spaceKey}`
    ]);
    expect(targets).toContainEqual(["atomic_note", `${noteVectorStrategyPrefix}${space.spaceKey}`]);
  });

  it("loads each requested item once and issues no statement for no items", async () => {
    const { db, query } = vectorStub([
      { type: "atomic_note", id: id(1), hash: "h", values: seeded(1) }
    ]);
    const repository = createTopicTreeLoadRepository(db);
    const twice = await repository.loadItemVectors(space, [
      { kind: "note", id: id(1) },
      { kind: "note", id: id(1).toUpperCase() }
    ]);
    expect(twice.keys).toHaveLength(1);
    query.mockClear();
    const none = await repository.loadItemVectors(space, []);
    expect(none.matrix.count).toBe(0);
    expect(none.keys).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a stored vector with the wrong number of dimensions", async () => {
    const { db } = vectorStub([
      { type: "atomic_note", id: id(1), hash: "h", values: seeded(1, 128) }
    ]);
    await expect(
      createTopicTreeLoadRepository(db).loadItemVectors(space, [{ kind: "note", id: id(1) }])
    ).rejects.toBeInstanceOf(TopicLoadError);
  });
});

describe("pendingItems", () => {
  const notes = topicLoadSql.pendingNotes(256, "library");
  const sources = topicLoadSql.pendingSources(256, "library");

  type Table = Array<{ id: string; reason: string | null }>;

  /** The id window of a table after a cursor, the way the statement answers: items, then the cursor row. */
  function pendingStub(noteTable: Table, sourceTable: Table) {
    const answer = (table: Table, root: boolean) => (values: readonly unknown[]) => {
      const after = values[3] as string | null;
      const window = table
        .filter((row) => after === null || row.id > after)
        .slice(0, values[4] as number);
      const last = window[window.length - 1];
      return [
        ...window
          .filter((row) => row.reason !== null)
          .map((row) => ({
            part: "item",
            id: row.id,
            reason: row.reason,
            topicId: null,
            rootSourceId: root ? id(900) : row.id,
            examined: null
          })),
        {
          part: "cursor",
          id: last?.id ?? null,
          reason: null,
          topicId: null,
          rootSourceId: null,
          examined: window.length
        }
      ];
    };
    return stub(
      new Map<string, Handler>([
        [notes, answer(noteTable, true)],
        [topicLoadSql.pendingNotes(256, "root"), answer(noteTable, true)],
        [topicLoadSql.pendingNotes(256, "ids"), answer(noteTable, true)],
        [sources, answer(sourceTable, false)],
        [topicLoadSql.pendingSources(256, "root"), answer(sourceTable, false)]
      ])
    );
  }

  it("lists notes first, then root sources, and continues from the cursor", async () => {
    const { db, calls } = pendingStub(
      [
        { id: id(1), reason: "unplaced" },
        { id: id(2), reason: "stale" }
      ],
      [{ id: id(50), reason: "needs_vector" }]
    );
    const repository = createTopicTreeLoadRepository(db);
    const first = await repository.pendingItems(id(1), space, { limit: 2 });
    expect(first.items.map((item) => [item.key, item.reason])).toEqual([
      [`note:${id(1)}`, "unplaced"],
      [`note:${id(2)}`, "stale"]
    ]);
    expect(first.next).toBe(`note:${id(2)}`);
    // A full window does not reach the sources yet.
    expect(calls.map((call) => call.text)).toEqual([notes]);

    const second = await repository.pendingItems(id(1), space, { limit: 2, after: first.next });
    expect(second.items.map((item) => item.key)).toEqual([`source:${id(50)}`]);
    expect(second.items[0]).toMatchObject({ kind: "source", rootSourceId: id(50) });
    expect(second.next).toBeNull();
    // The notes window found nothing after the cursor; the sources one took the whole budget.
    expect(calls.slice(1).map((call) => [call.text, call.values[3], call.values[4]])).toEqual([
      [notes, id(2), 2],
      [sources, null, 2]
    ]);
  });

  it("continues past windows that hold no pending item", async () => {
    // Only the fifth note is pending: the windows of 2 return nothing until the third call.
    const table = [1, 2, 3, 4, 5].map((n) => ({ id: id(n), reason: n === 5 ? "unplaced" : null }));
    const { db } = pendingStub(table, []);
    const repository = createTopicTreeLoadRepository(db);
    const found: string[] = [];
    let after: string | null = null;
    let calls = 0;
    do {
      const page: { items: Array<{ key: string }>; next: string | null } =
        await repository.pendingItems(id(1), space, { limit: 2, after });
      found.push(...page.items.map((item) => item.key));
      after = page.next;
      calls += 1;
    } while (after);
    expect(found).toEqual([`note:${id(5)}`]);
    // Notes 1-2, 3-4, 5 (short window: the sources follow in the same call).
    expect(calls).toBe(3);
  });

  it("spends one budget across the notes and the sources of a call", async () => {
    const { db, calls } = pendingStub(
      [{ id: id(1), reason: "unplaced" }],
      [
        { id: id(50), reason: "unplaced" },
        { id: id(51), reason: "unplaced" }
      ]
    );
    const page = await createTopicTreeLoadRepository(db).pendingItems(id(1), space, { limit: 2 });
    expect(page.items.map((item) => item.key)).toEqual([`note:${id(1)}`, `source:${id(50)}`]);
    expect(calls.map((call) => call.values[4])).toEqual([2, 1]);
    expect(page.next).toBe(`source:${id(50)}`);
  });

  it("starts at the sources when the cursor is a source", async () => {
    const { db, calls } = pendingStub(
      [{ id: id(1), reason: "unplaced" }],
      [
        { id: id(50), reason: "unplaced" },
        { id: id(51), reason: "unplaced" }
      ]
    );
    const page = await createTopicTreeLoadRepository(db).pendingItems(id(1), space, {
      after: `source:${id(50)}`
    });
    expect(page.items.map((item) => item.id)).toEqual([id(51)]);
    expect(page.next).toBeNull();
    expect(calls.map((call) => call.text)).toEqual([sources]);
  });

  it("passes the space, the reasons and the scope to the statements", async () => {
    const { db, calls } = pendingStub([], []);
    await createTopicTreeLoadRepository(db).pendingItems(id(1), space, {
      limit: 10,
      rootSourceId: id(30),
      reasons: ["unplaced", "needs_gate"]
    });
    // Notes of the root through the source index, then the root itself; the reasons come before the scope.
    expect(calls.map((call) => call.text)).toEqual([
      topicLoadSql.pendingNotes(256, "root"),
      topicLoadSql.pendingSources(256, "root")
    ]);
    expect(calls[0]?.values).toEqual([
      id(1),
      space.model,
      `${noteVectorStrategyPrefix}${space.spaceKey}`,
      null,
      10,
      ["unplaced", "needs_gate"],
      id(30)
    ]);
    expect(calls[1]?.values[2]).toBe(`${sourceVectorStrategyPrefix}${space.spaceKey}`);
    expect(calls[1]?.values[6]).toBe(id(30));
  });

  it("scans only the listed notes when note ids are given", async () => {
    const { db, calls } = pendingStub(
      [{ id: id(1), reason: "unplaced" }],
      [{ id: id(50), reason: "unplaced" }]
    );
    const page = await createTopicTreeLoadRepository(db).pendingItems(id(1), space, {
      noteIds: [id(1).toUpperCase()]
    });
    expect(page.items.map((item) => item.kind)).toEqual(["note"]);
    expect(page.next).toBeNull();
    expect(calls.map((call) => call.text)).toEqual([topicLoadSql.pendingNotes(256, "ids")]);
    expect(calls[0]?.values[6]).toEqual([id(1)]);
  });

  it("refuses a scope by root source and by note ids at once", async () => {
    const { db, query } = pendingStub([], []);
    await expect(
      createTopicTreeLoadRepository(db).pendingItems(id(1), space, {
        rootSourceId: id(30),
        noteIds: [id(1)]
      })
    ).rejects.toBeInstanceOf(TopicLoadError);
    expect(query).not.toHaveBeenCalled();
  });

  it("defaults to every reason and the default window", async () => {
    const { db, calls } = pendingStub([], []);
    await createTopicTreeLoadRepository(db).pendingItems(id(1), space);
    expect(calls[0]?.values[4]).toBe(topicLoadDefaults.pendingLimit);
    expect(calls[0]?.values[5]).toEqual([...topicPendingReasons]);
  });

  it("rejects a malformed cursor", async () => {
    const { db } = pendingStub([], []);
    await expect(
      createTopicTreeLoadRepository(db).pendingItems(id(1), space, { after: "note:not-a-uuid" })
    ).rejects.toBeInstanceOf(TopicLoadError);
  });
});

describe("itemOwners", () => {
  it("reads notes and sources in pages and reports only the ids that exist", async () => {
    const { db, calls } = stub(
      new Map<string, Handler>([
        [
          topicLoadSql.noteOwners,
          (values) =>
            (values[0] as string[])
              .filter((noteId) => noteId !== id(3))
              .map((noteId) => ({
                id: noteId,
                current: noteId !== id(2),
                rootSourceId: noteId === id(4) ? null : id(30)
              }))
        ],
        [
          topicLoadSql.sourceOwners,
          (values) =>
            (values[0] as string[]).map((sourceId) => ({
              id: sourceId,
              contentHash: sourceId === id(31) ? null : "hash-30",
              rootSourceId: id(30)
            }))
        ]
      ])
    );
    const owners = await createTopicTreeLoadRepository(db).itemOwners(
      { noteIds: [id(1), id(2), id(3), id(4), id(1)], sourceIds: [id(30), id(31)] },
      { pageSize: 2 }
    );
    expect([...owners.notes.values()]).toEqual([
      { id: id(1), current: true, rootSourceId: id(30) },
      { id: id(2), current: false, rootSourceId: id(30) },
      { id: id(4), current: true, rootSourceId: null }
    ]);
    expect(owners.sources.get(id(31))).toEqual({
      id: id(31),
      rootSourceId: id(30),
      contentHash: null
    });
    // Duplicates are read once; four notes make two pages, two sources one.
    expect(calls.map((call) => (call.values[0] as string[]).length)).toEqual([2, 2, 2]);
  });

  it("issues no statement for no ids", async () => {
    const { db, query } = stub(new Map());
    const owners = await createTopicTreeLoadRepository(db).itemOwners({});
    expect(owners.notes.size + owners.sources.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("walks a note's owning source and a source's parents up to their root, bounded", () => {
    expect(topicLoadSql.noteOwners).toContain("h.id = a.owning_source_item_id");
    expect(topicLoadSql.sourceOwners).toContain("h.id = s.id");
    expect(topicLoadSql.noteOwners).toContain("up.depth < 64");
  });
});

describe("newestNoteVectorSpace", () => {
  it("reads the space key from the newest note vector's strategy", async () => {
    const { db } = stub(
      new Map<string, Handler>([
        [
          topicLoadSql.newestNoteSpace,
          () => [
            {
              provider: "local",
              model: "embed-4",
              runtime: "mlx",
              strategy: `${noteVectorStrategyPrefix}space-a`,
              dimensions: 256
            }
          ]
        ]
      ])
    );
    await expect(createTopicTreeLoadRepository(db).newestNoteVectorSpace()).resolves.toEqual(space);
  });

  it("returns null without a note vector that names its space", async () => {
    const { db } = stub(new Map<string, Handler>([[topicLoadSql.newestNoteSpace, () => []]]));
    await expect(createTopicTreeLoadRepository(db).newestNoteVectorSpace()).resolves.toBeNull();
    expect(topicLoadSql.newestNoteSpace).toContain(
      `starts_with(strategy, '${noteVectorStrategyPrefix}')`
    );
    for (const table of ["embeddings_256", "embeddings_768", "embeddings_1024"]) {
      expect(topicLoadSql.newestNoteSpace).toContain(table);
    }
  });
});

describe("recentlyPlacedItems", () => {
  it("returns the item keys of primary automatic placements made since a time", async () => {
    const since = new Date("2026-10-15T12:00:00.000Z");
    const { db, calls } = stub(
      new Map<string, Handler>([
        [
          topicLoadSql.recentlyPlaced,
          () => [
            { itemKind: "note", itemId: id(3).toUpperCase() },
            { itemKind: "source", itemId: id(4) }
          ]
        ]
      ])
    );
    await expect(
      createTopicTreeLoadRepository(db).recentlyPlacedItems(id(1), since)
    ).resolves.toEqual([`note:${id(3)}`, `source:${id(4)}`]);
    expect(calls[0]?.values).toEqual([id(1), since]);
    expect(topicLoadSql.recentlyPlaced).toContain("p.rank = 0 and p.management = 'ai'");
    expect(topicLoadSql.recentlyPlaced).toContain("p.placed_at >= $2");
  });
});

describe("statements", () => {
  const statements = [
    topicLoadSql.tree,
    topicLoadSql.activeTree,
    topicLoadSql.recentlyPlaced,
    topicLoadSql.generation,
    topicLoadSql.placements,
    topicLoadSql.topics,
    topicLoadSql.noteOwners,
    topicLoadSql.sourceOwners,
    topicLoadSql.newestNoteSpace,
    ...[256, 768, 1024].flatMap((dimensions) => [
      topicLoadSql.itemVectors(dimensions),
      ...(["library", "root", "ids"] as const).map((scope) =>
        topicLoadSql.pendingNotes(dimensions, scope)
      ),
      ...(["library", "root"] as const).map((scope) =>
        topicLoadSql.pendingSources(dimensions, scope)
      )
    ])
  ];

  it("can only read", () => {
    for (const text of statements) {
      expect(text.trimStart()).toMatch(/^(select|with)\b/i);
      expect(text).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create|set_config)\b/i);
    }
  });

  it("reads the embedding table of the tree's dimensions and no other", () => {
    expect(topicLoadSql.itemVectors(768)).toContain("from embeddings_768 e");
    expect(topicLoadSql.pendingNotes(1024, "library")).toContain("embeddings_1024");
    expect(topicLoadSql.pendingSources(768, "root")).toContain("embeddings_768");
    expect(() => topicLoadSql.itemVectors(512)).toThrow(TopicLoadError);
  });
});
