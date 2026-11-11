import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { TopicShapeSchema, topicReadLimits } from "@app/domain";
import { topicRecord } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  TopicHistoryError,
  createTopicHistoryRepository,
  type TopicHistoryRepository
} from "./topicHistoryRepository.js";
import { createTopicReadRepository } from "./topicReadRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// `topics.history` on a real PostgreSQL (F5 T134, D20): arrivals per topic and day from the
// structure events of applied change-sets only, as primary placements of content arriving.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

/** Noon UTC on 2026-11-11: every test day below is counted back from it. */
const now = new Date("2026-11-11T12:00:00.000Z");
const at = (day: string, time = "10:00:00") => new Date(`${day}T${time}.000Z`);

describe.skipIf(!sidecarInstalled)("topic history on a real database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let history: TopicHistoryRepository;
  let treeId = "";
  let generation = 0;
  const rootId = randomUUID();
  /** Six levels below the root (depths 1 to 6); the bulk of the topics hangs from the last. */
  const chain = Array.from({ length: 6 }, () => randomUUID());
  const bulk = Array.from({ length: topicReadLimits.shapeNodesMax + 100 }, () => randomUUID());

  const topic = { a: randomUUID(), b: randomUUID(), quiet: randomUUID(), unknown: randomUUID() };

  type Status = "applied" | "pending_review" | "dismissed" | "undone";
  interface Event {
    op?: string;
    topic: string;
    rank?: number;
  }

  /** One change-set with its events; `appliedAt` is set only where the status says it was applied. */
  async function changeSet(input: {
    origin?: string;
    status?: Status;
    appliedAt: Date;
    events: Event[];
  }) {
    const status = input.status ?? "applied";
    const applied = status === "applied" || status === "undone";
    const id = randomUUID();
    generation += 1;
    await pool.query(
      `insert into topic_change_sets (id, tree_id, origin, status, title_key, generation, created_at,
         applied_at, undone_at)
       values ($1, $2, $3, $4, 'topics.changeSets.test', $5, $6, $7, $8)`,
      [
        id,
        treeId,
        input.origin ?? "place",
        status,
        applied ? generation : null,
        new Date(input.appliedAt.getTime() - 60_000),
        applied ? input.appliedAt : null,
        status === "undone" ? input.appliedAt : null
      ]
    );
    for (const [seq, event] of input.events.entries()) {
      const op = event.op ?? "item.place";
      await pool.query(
        `insert into topic_structure_events (change_set_id, seq, op, topic_id, item_kind, item_id, before, after)
         values ($1, $2, $3, $4, 'note', $5, $6::jsonb, $7::jsonb)`,
        [
          id,
          seq,
          op,
          event.topic,
          randomUUID(),
          op === "item.place" ? null : JSON.stringify({ rank: event.rank ?? 0 }),
          JSON.stringify({ topicId: event.topic, rank: event.rank ?? 0 })
        ]
      );
    }
    return id;
  }

  const place = (topicId: string, rank = 0): Event => ({ topic: topicId, rank });
  const counts = (series: { daily: { arrivals: number }[] } | undefined) =>
    series?.daily.map((entry) => entry.arrivals);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-history-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_topic_history_test",
        user: "memora_topic_history_test",
        password: `topic-history-${randomUUID()}`,
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
    await runMigrations(pool, migrationsFolder);
    history = createTopicHistoryRepository(pool);
    const tree = await createTopicTreeRepository(pool).createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:history:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    treeId = tree.id;
    // A tree of 2,107 topics whose deepest 2,100 are at depth 7: more than a read can list.
    const built = await createTopicTreeRepository(pool).bootstrapSnapshot({
      treeId,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        ...chain.map((id, index) =>
          topicRecord(id, index === 0 ? rootId : chain[index - 1]!, { role: "topic" })
        ),
        ...bulk.map((id, index) => topicRecord(id, chain[5]!, { role: "topic", position: index }))
      ],
      placements: []
    });
    expect(built.kind).toBe("applied");
    generation = built.kind === "applied" ? built.generation : tree.generation;

    // Topic A: two arrivals today, one yesterday, one three days ago (two in one change-set).
    await changeSet({
      appliedAt: at("2026-11-11", "09:00:00"),
      events: [place(topic.a), place(topic.a)]
    });
    await changeSet({ origin: "gate", appliedAt: at("2026-11-10"), events: [place(topic.a)] });
    await changeSet({ origin: "human", appliedAt: at("2026-11-08"), events: [place(topic.a)] });
    // What does not count, all on days inside the window: a proposal that waits, one the person
    // dismissed, one that was undone, the tree being built, a secondary placement and a move.
    await changeSet({
      status: "pending_review",
      appliedAt: at("2026-11-09"),
      events: [place(topic.a), place(topic.a)]
    });
    await changeSet({ status: "dismissed", appliedAt: at("2026-11-09"), events: [place(topic.a)] });
    await changeSet({ status: "undone", appliedAt: at("2026-11-09"), events: [place(topic.a)] });
    await changeSet({ origin: "build", appliedAt: at("2026-11-09"), events: [place(topic.a)] });
    await changeSet({ origin: "rebuild", appliedAt: at("2026-11-09"), events: [place(topic.a)] });
    await changeSet({
      appliedAt: at("2026-11-09"),
      events: [place(topic.a, 1), place(topic.a, 2)]
    });
    await changeSet({
      appliedAt: at("2026-11-09"),
      events: [
        { op: "item.move", topic: topic.a },
        { op: "item.unplace", topic: topic.a }
      ]
    });
    // Old arrivals: outside a 7-day window, inside a 30-day one.
    await changeSet({ appliedAt: at("2026-10-20"), events: [place(topic.a)] });

    // Topic B: the day boundaries. In UTC these are 11-09 (23:30) and 11-10 (00:30); in São Paulo
    // (UTC-3 in November) both are on 11-09.
    await changeSet({ appliedAt: at("2026-11-09", "23:30:00"), events: [place(topic.b)] });
    await changeSet({ appliedAt: at("2026-11-10", "00:30:00"), events: [place(topic.b)] });
    // The first instant of the oldest day of a 3-day window counts; the instant before does not.
    await changeSet({ appliedAt: at("2026-11-09", "00:00:00"), events: [place(topic.b)] });
    await changeSet({ appliedAt: at("2026-11-08", "23:59:59"), events: [place(topic.b)] });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("counts the primary arrivals of applied change-sets per day, oldest day first", async () => {
    const [a] = await history.readHistory(
      { topicIds: [topic.a], days: 7 },
      { now, timeZone: "UTC" }
    );
    expect(a!.topicId).toBe(topic.a);
    expect(a!.daily.map((entry) => entry.day)).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11"
    ]);
    // 11-08 human 1; 11-09 nothing that counts (pending, dismissed, undone, build, rebuild,
    // secondary and move are all that day); 11-10 gate 1; 11-11 place 2.
    expect(counts(a)).toEqual([0, 0, 0, 1, 0, 1, 2]);
  });

  it("does not count a pending change-set whose time is inside the window", async () => {
    const withPending = await pool.query(
      `select count(*)::int as n from topic_structure_events e
         join topic_change_sets cs on cs.id = e.change_set_id
        where cs.status = 'pending_review' and e.topic_id = $1`,
      [topic.a]
    );
    expect(withPending.rows[0].n).toBe(2);
    const [a] = await history.readHistory(
      { topicIds: [topic.a], days: 3 },
      { now, timeZone: "UTC" }
    );
    expect(counts(a)).toEqual([0, 1, 2]);
  });

  it("holds the window to its days and keeps older arrivals for a longer one", async () => {
    const [short] = await history.readHistory(
      { topicIds: [topic.a], days: 1 },
      { now, timeZone: "UTC" }
    );
    expect(counts(short)).toEqual([2]);
    const [long] = await history.readHistory(
      { topicIds: [topic.a], days: 30 },
      { now, timeZone: "UTC" }
    );
    expect(long!.daily).toHaveLength(30);
    expect(long!.daily.at(-1)).toEqual({ day: "2026-11-11", arrivals: 2 });
    expect(long!.daily.find((entry) => entry.day === "2026-10-20")?.arrivals).toBe(1);
    expect(long!.daily.reduce((sum, entry) => sum + entry.arrivals, 0)).toBe(5);
    const [max] = await history.readHistory(
      { topicIds: [topic.a], days: topicReadLimits.historyDaysMax },
      { now, timeZone: "UTC" }
    );
    expect(max!.daily).toHaveLength(90);
  });

  it("cuts the days where the person's day starts", async () => {
    const [utc] = await history.readHistory(
      { topicIds: [topic.b], days: 3 },
      { now, timeZone: "UTC" }
    );
    // 11-08 23:59:59 is before the window; 11-09 has 00:00:00 and 23:30; 11-10 has 00:30.
    expect(utc!.daily.map((entry) => entry.day)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11"
    ]);
    expect(counts(utc)).toEqual([2, 1, 0]);
    // In São Paulo (UTC-3) the window opens at 03:00 UTC on 11-09: the 00:00 instant is before it
    // and the two late ones are on 11-09 (20:30 and 21:30 local).
    const [local] = await history.readHistory(
      { topicIds: [topic.b], days: 3 },
      { now, timeZone: "America/Sao_Paulo" }
    );
    expect(local!.daily.map((entry) => entry.day)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11"
    ]);
    expect(counts(local)).toEqual([2, 0, 0]);
  });

  it("answers every requested topic once, in the order asked, with zeros for a quiet one", async () => {
    const series = await history.readHistory(
      { topicIds: [topic.quiet, topic.a, topic.unknown, topic.quiet, topic.b], days: 2 },
      { now, timeZone: "UTC" }
    );
    expect(series.map((entry) => entry.topicId)).toEqual([
      topic.quiet,
      topic.a,
      topic.unknown,
      topic.b
    ]);
    expect(counts(series[0])).toEqual([0, 0]);
    expect(counts(series[1])).toEqual([1, 2]);
    expect(counts(series[2])).toEqual([0, 0]);
    expect(counts(series[3])).toEqual([1, 0]);
    expect(await history.readHistory({ topicIds: [], days: 7 }, { now })).toEqual([]);
  });

  it("takes 200 topics and 90 days and refuses more", async () => {
    const ids = Array.from({ length: topicReadLimits.historyTopicsMax }, () => randomUUID());
    const series = await history.readHistory({ topicIds: ids, days: 90 }, { now, timeZone: "UTC" });
    expect(series).toHaveLength(200);
    await expect(
      history.readHistory({ topicIds: [...ids, randomUUID()], days: 7 })
    ).rejects.toThrow(TopicHistoryError);
    for (const days of [0, 91, 1.5, Number.NaN]) {
      await expect(history.readHistory({ topicIds: [topic.a], days })).rejects.toThrow(
        TopicHistoryError
      );
    }
  });

  describe("the Shape read at depth 7", () => {
    const shape = (input: { depth: number; nodeLimit: number; rootId?: string | null }) =>
      createTopicReadRepository(pool).readShape({ rootId: null, ...input }, { now });

    it("lists no more than the node limit of a depth-7 tree and says it cut the rest", async () => {
      const read = await shape({ depth: 7, nodeLimit: topicReadLimits.shapeNodesMax });
      expect(read!.nodes).toHaveLength(topicReadLimits.shapeNodesMax);
      expect(read!.truncated).toBe(true);
      expect(read!.summary.topics).toBe(chain.length + bulk.length);
      // The cells come level by level: every level down to 7 is reached before the cut.
      expect(Math.max(...read!.nodes.map((node) => node.depth))).toBe(7);
      expect(read!.nodes.filter((node) => node.depth < 7)).toHaveLength(chain.length + 1);
      expect(TopicShapeSchema.safeParse(read).success).toBe(true);
    });

    it("cuts by depth with the same flag and reaches the last level only at depth 7", async () => {
      const six = await shape({ depth: 6, nodeLimit: topicReadLimits.shapeNodesMax });
      expect(six!.nodes).toHaveLength(chain.length + 1);
      expect(six!.truncated).toBe(true);
      const seven = await shape({ depth: 7, nodeLimit: 10 });
      expect(seven!.nodes).toHaveLength(10);
      expect(seven!.truncated).toBe(true);
      // A branch counts depth from its own root: the last chain topic holds the leaves at depth 1.
      const branch = await shape({ depth: 1, nodeLimit: 50, rootId: chain[5]! });
      expect(branch!.nodes).toHaveLength(50);
      expect(branch!.nodes[0]).toMatchObject({ id: chain[5], parentId: null, depth: 0 });
    });
  });
});
