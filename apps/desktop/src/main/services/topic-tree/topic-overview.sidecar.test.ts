import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createLibraryResetRepository,
  createObjectLocateRepository,
  createPgPool,
  createTopicTreeRepository,
  noteVectorStrategyPrefix,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  topicStatsWrites,
  type PgPool,
  type PostgresSidecarConnection,
  type TopicLoadSpace
} from "@app/db";
import { overviewEvidenceTokens, topicOverviewLimits, type TopicOverviewState } from "@app/domain";
import {
  createRng,
  createTopicTreeEditor,
  createTopicTreeState,
  getTopic,
  itemKey,
  liveTopicIds,
  placementRecord,
  recomputeSubtree,
  registerItem,
  topicRecordOf,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices, TopicTreeServicesOptions } from "./index.js";
import { ItemVectorStore } from "./topic-cache.js";
import { TopicOverviewService, topicOverviewSupportOperation } from "./topic-overview.js";

/**
 * The lazy overview against the real schema on a throwaway PostgreSQL sidecar, with a fake writer
 * and a fake ranker that read the prompt the way a model would: written on open from the central
 * notes and their passages, every citation resolving to the exact chunk and span, the audit
 * linked, the support check, a reopen with no call, a member change marking it stale, the cancel,
 * the evidence budget, a repair, the routes that are missing, and `objects.locate` citedBy.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-overview-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
const contentLanguage = "en";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

interface Evidence {
  n: number;
  title: string;
  idea: string;
  source: string;
  passage: string;
}
interface WriterCall {
  input: string;
  context: Record<string, unknown>;
  evidence: Evidence[];
}
type Writer = (call: WriterCall, attempt: number) => unknown;
interface RankCall {
  input: { query: string; documents: string[]; priority?: string; operation: string };
}

/** The evidence a prompt carries: the JSON after "Evidence:" up to a repair block. */
function evidenceOf(input: string): Evidence[] {
  const body = input.slice(input.lastIndexOf("\nEvidence:\n") + "\nEvidence:\n".length);
  const end = body.indexOf("\n\n");
  return JSON.parse(end < 0 ? body : body.slice(0, end)) as Evidence[];
}

/** The default writer: a paragraph per two evidence items, each sentence citing its own item. */
const citeInOrder: Writer = ({ evidence }) => {
  const paragraphs = [];
  for (let index = 0; index < Math.min(evidence.length, 4); index += 2) {
    const items = evidence.slice(index, index + 2);
    paragraphs.push({
      text: items.map((item) => `${item.title} matters here [${item.n}].`).join(" "),
      citations: items.map((item) => item.n)
    });
  }
  return { paragraphs };
};

const leafTitles = {
  A1: ["Retrieval practice", "Spaced retrieval", "Feedback after retrieval", "Frequent testing"],
  A2: ["Sleep consolidates memory", "Sleep deprivation", "Sleep cycles", "Short naps"],
  B1: ["Ocean currents carry heat", "Currents and climate", "Deep currents", "Surface currents"]
} as const;
type Leaf = keyof typeof leafTitles;

describe.skipIf(!sidecarAvailable)("topic overviews on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-overview-"));
    for (let attempt = 1; ; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecarPaths.binDir,
        dataDir: join(workDir, `database-${attempt}`),
        database: "memora_topic_overview_test",
        user: "memora_topic_overview_test",
        password: `topic-overview-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
        break;
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  interface World {
    services: TopicTreeServices;
    overview: TopicOverviewService;
    rootId: string;
    topics: Record<"A" | "B" | Leaf, string>;
    notes: Record<Leaf, string[]>;
    sources: Record<Leaf, string>;
    writes: WriterCall[];
    ranks: RankCall[];
    ai: { writer: boolean; ranker: boolean };
    setWriter(writer: Writer): void;
    gate: { current: Promise<void> | null };
    dispose(): void;
  }

  async function world(options: { longB1?: number } = {}): Promise<World> {
    await createLibraryResetRepository(pool).reset();
    const writes: WriterCall[] = [];
    const ranks: RankCall[] = [];
    const ai = { writer: true, ranker: true };
    const gate: World["gate"] = { current: null };
    let writer: Writer = citeInOrder;
    const fake = {
      runDefaultTask: vi.fn(
        async (
          task: string,
          input: string,
          context: Record<string, unknown> = {},
          signal?: AbortSignal
        ) => {
          if (task !== "structured-output") throw new Error(`unexpected task ${task}`);
          if (!ai.writer) return null;
          const call: WriterCall = { input, context, evidence: evidenceOf(input) };
          writes.push(call);
          if (gate.current) {
            const pending = gate.current;
            await new Promise<void>((done, fail) => {
              signal?.addEventListener("abort", () => fail(signal.reason), { once: true });
              void pending.then(done);
            });
          }
          const run = await pool.query<{ id: string }>(
            `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status)
             values ('structured-output', 'fixture', 'fixture-writer', 'remote', 1, 'succeeded')
             returning id`
          );
          return {
            taskType: "structured-output" as const,
            output: JSON.stringify(writer(call, Number(context.attempt ?? 0))),
            providerId: "fixture",
            modelId: "fixture-writer",
            runtime: "remote" as const,
            durationMs: 1,
            aiTaskRunId: run.rows[0]!.id,
            profileId: randomUUID(),
            outputLanguage: contentLanguage,
            inputTokens: 100,
            outputTokens: 40
          };
        }
      ),
      rank: vi.fn(async (input: RankCall["input"]) => {
        ranks.push({ input });
        // A passage supports a sentence when it carries the sentence's subject (its first words).
        const subject = input.query.split(" matters")[0]!.toLowerCase();
        const scores = input.documents.map((document) =>
          document.toLowerCase().includes(subject) ? 0.92 : 0.08
        );
        return {
          logOdds: scores.map((score) => Math.log(score / (1 - score))),
          scores,
          tokenCounts: input.documents.map(() => 40),
          truncated: input.documents.map(() => false),
          aiTaskRunId: randomUUID(),
          profileId: randomUUID(),
          localModelId: randomUUID(),
          provider: "local",
          modelId: "fixture-ranker",
          runtime: "mlx",
          durationMs: 1,
          queueMs: 0
        };
      }),
      decideRouteStatus: vi.fn(async () => (ai.ranker ? "ready" : "missing")),
      activeEmbeddingSpace: vi.fn(async () => null)
    };

    const services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: async () => ({ kind: "ready", space }) },
      env: {},
      isPackaged: false,
      logger: quiet,
      newTreeConfig: () =>
        topicTreeConfigWith({ jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 } }),
      ai: fake as unknown as NonNullable<TopicTreeServicesOptions["ai"]>,
      getContentLanguage: async () => contentLanguage
    });
    // The service of the factory reads the writer route from the database; this one is told.
    const overview = new TopicOverviewService({
      getPool: () => pool,
      ai: fake as never,
      getContentLanguage: async () => contentLanguage,
      aiMode: "full",
      writerReady: async () => ai.writer,
      logger: quiet
    });

    const ensured = await services.ensureActiveTree();
    if (ensured?.kind !== "ready") throw new Error("the tree was not created");
    const tree = ensured.tree;
    const rootId = tree.rootId;
    const rng = createRng(20261016);
    const live = createTopicTreeState({ dim, rootId });
    const editor = createTopicTreeEditor(live, { record: false });
    const store = new ItemVectorStore(dim);
    const topics = {} as World["topics"];
    for (const key of ["A", "B"] as const) {
      topics[key] = randomUUID();
      editor.createTopic(topics[key], rootId);
    }
    const notes = {} as World["notes"];
    const sources = {} as World["sources"];
    let axis = 0;
    for (const leaf of ["A1", "A2", "B1"] as const) {
      topics[leaf] = randomUUID();
      editor.createTopic(topics[leaf], leaf === "B1" ? topics.B : topics.A);
      const source = randomUUID();
      sources[leaf] = source;
      await pool.query(
        "insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)",
        [source, `Book ${leaf}`, sha(`book-${leaf}`)]
      );
      const document = randomUUID();
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, $3, 'seed', $4)`,
        [document, source, `Book ${leaf}`, sha(`document-${leaf}`)]
      );
      notes[leaf] = [];
      const titles: string[] =
        leaf === "B1" && options.longB1
          ? Array.from({ length: options.longB1 }, (_, n) => `Ocean topic ${n + 1}`)
          : [...leafTitles[leaf]];
      for (const [index, title] of titles.entries()) {
        const id = randomUUID();
        const chunk = randomUUID();
        const span = randomUUID();
        const passage =
          leaf === "B1" && options.longB1
            ? `${title}: ${"waves move heat across the basin and back again. ".repeat(40)}`
            : `${title}: the evidence passage number ${index + 1} of ${leaf}.`;
        await pool.query(
          `insert into source_spans (id, document_id, source_item_id, start_offset, end_offset)
           values ($1, $2, $3, $4, $5)`,
          [span, document, source, index * 100, index * 100 + passage.length]
        );
        await pool.query(
          `insert into chunks (id, document_id, source_item_id, source_span_id, chunk_index, content, content_hash)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [chunk, document, source, span, index, passage, sha(passage)]
        );
        await pool.query(
          `insert into atomic_notes (id, title, body_markdown, idea_statement, language, ownership,
             created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
             generation_runtime, generation_prompt_version, generation_key)
           values ($1, $2, 'Body', $3, 'en', 'source', $4, $5, 'test', 'test', 'test', 'test', $6)`,
          [id, title, `${title} is what this note says.`, source, chunk, `key-${id}`]
        );
        const vector = new Float32Array(dim);
        vector[axis] = 1;
        for (let k = 0; k < dim; k += 1) vector[k] = (vector[k] as number) + 0.08 * rng.gaussian();
        const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        for (let k = 0; k < dim; k += 1) vector[k] = (vector[k] as number) / length;
        const hash = sha(`note-${leaf}-${title}`);
        await pool.query(
          `insert into embeddings_256 (target_type, target_id, provider, model, runtime, usage,
             strategy, content_hash, embedding)
           values ('atomic_note', $1, $2, $3, $4, 'matching', $5, $6, $7::vector)`,
          [
            id,
            space.provider,
            space.model,
            space.runtime,
            `${noteVectorStrategyPrefix}${space.spaceKey}`,
            hash,
            `[${Array.from(vector).join(",")}]`
          ]
        );
        const key = itemKey("note", id);
        registerItem(live, {
          key,
          kind: "note",
          contentHash: hash,
          rootSource: itemKey("source", source)
        });
        store.set(key, vector);
        editor.placeItem(
          key,
          placementRecord(topics[leaf], { decidedBy: "build", itemFingerprint: hash })
        );
        notes[leaf].push(id);
      }
      axis += 1;
    }
    recomputeSubtree(live, store);
    const built = await createTopicTreeRepository(pool).bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: liveTopicIds(live)
        .filter((id) => id !== rootId)
        .map((id) => ({ ...topicRecordOf(getTopic(live, id)), ...namedOf(id) })),
      placements: [...live.placements].flatMap(([key, list]) =>
        list.map((placement) => ({ item: key, placement }))
      ),
      stats: topicStatsWrites(live, store, liveTopicIds(live)),
      clock: live.clock
    });
    if (built.kind !== "applied") throw new Error(`the tree was not seeded: ${built.kind}`);
    services.service.invalidate();

    function namedOf(id: string) {
      const entry = Object.entries(topics).find(([, value]) => value === id);
      if (!entry) return {};
      const title = { A: "Memory", B: "Oceans", A1: "Retrieval", A2: "Sleep", B1: "Currents" }[
        entry[0] as keyof typeof topics
      ];
      return { title, nameState: "named" as const, nameSource: "llm" as const, nameLanguage: "en" };
    }

    return {
      services,
      overview,
      rootId,
      topics,
      notes,
      sources,
      writes,
      ranks,
      ai,
      gate,
      setWriter: (next) => {
        writer = next;
      },
      dispose: () => {
        overview.dispose();
        services.dispose();
      }
    };
  }

  const ready = (state: TopicOverviewState) => {
    if (state.status !== "ready")
      throw new Error(`expected a ready overview, got ${JSON.stringify(state)}`);
    return state;
  };

  it("writes on open from the central notes; every citation resolves to its exact chunk and span", async () => {
    const w = await world();
    try {
      expect(await w.overview.state(w.topics.A1)).toEqual({ status: "absent", canWrite: true });
      const written = ready(await w.overview.overview({ id: w.topics.A1 }));
      expect(w.writes).toHaveLength(1);
      const [call] = w.writes;
      // The evidence: the topic's notes with their whole passages, in centrality order, no IDs.
      expect(call!.evidence.map((item) => item.n)).toEqual([1, 2, 3, 4]);
      expect(new Set(call!.evidence.map((item) => item.title))).toEqual(new Set(leafTitles.A1));
      expect(call!.evidence[0]!.passage).toMatch(/: the evidence passage number \d of A1\.$/u);
      expect(call!.input).toContain("English");
      expect(call!.input).toContain('"title":"Retrieval"');
      expect(call!.input).not.toMatch(uuidPattern);
      expect(call!.context).toMatchObject({
        operation: "topic_overview",
        workloadClass: "write-fast",
        priority: "P0",
        stage: "topic_overview",
        contentLanguage: "en",
        attempt: 0,
        sourceItemIds: [w.sources.A1]
      });
      expect(call!.context.chunkIds).toHaveLength(4);

      expect(written.stale).toBe(false);
      expect(written.paragraphs).toHaveLength(2);
      expect(written.citations.map((citation) => citation.n)).toEqual([1, 2, 3, 4]);
      expect(written.evidence).toEqual({ used: 4, total: 4 });
      expect(written.language).toBe("en");
      expect(written.model).toBe("fixture-writer");
      expect(written.citations.every((citation) => citation.available)).toBe(true);
      expect(written.citations.every((citation) => citation.sourceTitle === "Book A1")).toBe(true);
      expect(["checking", "verified"]).toContain(written.support.status);

      // 100% of citations resolve to the exact chunk and span of the cited note.
      const resolved = await pool.query<{ ok: boolean }>(
        `select (ch.id is not null and sp.id is not null and n.id is not null
                 and n.evidence_chunk_id = c.chunk_id
                 and coalesce(n.source_span_id, ch.source_span_id) = c.source_span_id
                 and sp.source_item_id = ch.source_item_id
                 and c.excerpt_hash = encode(sha256(convert_to(ch.content, 'UTF8')), 'hex')) as ok
           from topic_overview_citations c
           left join chunks ch on ch.id = c.chunk_id
           left join source_spans sp on sp.id = c.source_span_id
           left join atomic_notes n on n.id = c.note_id
          where c.topic_id = $1`,
        [w.topics.A1]
      );
      expect(resolved.rows).toHaveLength(4);
      expect(resolved.rows.every((row) => row.ok)).toBe(true);

      // The audit row of the call is linked, with the provenance of the writing.
      const stored = await pool.query<{
        runs: number;
        evidence: number;
        prompt: string;
        input: string;
        members: number;
      }>(
        `select (select count(*)::int from ai_task_runs r where r.id = o.ai_task_run_id) as runs,
                jsonb_array_length(o.evidence) as evidence, o.prompt_revision_id as prompt,
                o.input_hash as input, o.member_count as members
           from topic_overviews o where o.topic_id = $1`,
        [w.topics.A1]
      );
      expect(stored.rows[0]).toMatchObject({ runs: 1, evidence: 4, members: 4 });
      expect(stored.rows[0]!.prompt).toMatch(/^topic-overview-v1:[0-9a-f]{64}$/u);
      expect(stored.rows[0]!.input).toBe(sha(call!.input));

      // The support check ran on the ranker without holding the overview back.
      await w.overview.settled(w.topics.A1);
      expect(w.ranks.length).toBe(4);
      expect(w.ranks.every((rank) => rank.input.priority === "P0")).toBe(true);
      expect(w.ranks.every((rank) => rank.input.operation === topicOverviewSupportOperation)).toBe(
        true
      );
      const checked = ready(await w.overview.state(w.topics.A1));
      expect(checked.support).toEqual({
        status: "verified",
        unsupported: [],
        sentences: { checked: 4, supported: 4 }
      });
    } finally {
      w.dispose();
    }
  }, 60_000);

  it("makes no call when the page is opened again, and marks a member change stale with Update", async () => {
    const w = await world();
    try {
      ready(await w.overview.overview({ id: w.topics.A1 }));
      await w.overview.settled(w.topics.A1);
      const calls = { writes: w.writes.length, ranks: w.ranks.length };
      // Reopening: the page's state and the slot's request both read the cache.
      const reopened = ready(await w.overview.state(w.topics.A1));
      const requested = ready(await w.overview.overview({ id: w.topics.A1 }));
      expect(reopened).toEqual(requested);
      expect(reopened.stale).toBe(false);
      expect({ writes: w.writes.length, ranks: w.ranks.length }).toEqual(calls);

      // A note of A2 moves into A1: A1's members changed, A's did not.
      ready(await w.overview.overview({ id: w.topics.A }));
      await w.overview.settled(w.topics.A);
      await w.services.service.mutate({
        op: "placeItem",
        item: { kind: "note", id: w.notes.A2[0]! },
        topicId: w.topics.A1,
        role: "primary"
      });
      const stale = ready(await w.overview.state(w.topics.A1));
      expect(stale.stale).toBe(true);
      expect(stale.paragraphs).toEqual(reopened.paragraphs);
      expect(ready(await w.overview.state(w.topics.A)).stale).toBe(false);
      const before = w.writes.length;
      // Opening again shows the stale overview without writing; Update writes a new one.
      expect(ready(await w.overview.overview({ id: w.topics.A1 })).stale).toBe(true);
      expect(w.writes.length).toBe(before);
      const updated = ready(await w.overview.overview({ id: w.topics.A1, force: true }));
      expect(w.writes.length).toBe(before + 1);
      expect(updated.stale).toBe(false);
      expect(updated.evidence.total).toBe(5);
      expect(Date.parse(updated.writtenAt)).toBeGreaterThan(Date.parse(reopened.writtenAt));
    } finally {
      w.dispose();
    }
  }, 60_000);

  it("cancels a writing in progress: nothing is stored and the page can write again", async () => {
    const w = await world();
    try {
      let release!: () => void;
      w.gate.current = new Promise<void>((done) => {
        release = done;
      });
      const pending = w.overview.overview({ id: w.topics.A2 });
      while (w.writes.length === 0) await new Promise((done) => setTimeout(done, 5));
      expect(await w.overview.state(w.topics.A2)).toEqual({ status: "writing" });
      // A second request joins the writing instead of starting another one.
      const joined = w.overview.overview({ id: w.topics.A2 });
      expect(w.overview.cancel({ id: w.topics.A2 })).toBe(true);
      const canceled = {
        status: "absent",
        canWrite: true,
        reasonKey: "topics.overview.reasons.canceled"
      };
      expect(await pending).toEqual(canceled);
      expect(await joined).toEqual(canceled);
      release();
      expect(w.writes).toHaveLength(1);
      const rows = await pool.query("select 1 from topic_overviews where topic_id = $1", [
        w.topics.A2
      ]);
      expect(rows.rowCount).toBe(0);
      expect(await w.overview.state(w.topics.A2)).toEqual({ status: "absent", canWrite: true });
      expect(w.overview.cancel({ id: w.topics.A2 })).toBe(false);
    } finally {
      w.dispose();
    }
  }, 60_000);

  it("chooses whole evidence items within the token budget and never cuts a passage", async () => {
    const w = await world({ longB1: 20 });
    try {
      const written = ready(await w.overview.overview({ id: w.topics.B1 }));
      const [call] = w.writes;
      const evidence = call!.evidence;
      const tokens = evidence.reduce((sum, item) => sum + overviewEvidenceTokens(item), 0);
      expect(evidence.length).toBeGreaterThan(1);
      expect(evidence.length).toBeLessThan(20);
      expect(evidence.length).toBeLessThanOrEqual(topicOverviewLimits.maxEvidence);
      expect(tokens).toBeLessThanOrEqual(topicOverviewLimits.evidenceTokenBudget);
      // One more item would not have fit: the budget, not the cap, chose the evidence.
      expect(tokens + overviewEvidenceTokens(evidence[0]!)).toBeGreaterThan(
        topicOverviewLimits.evidenceTokenBudget
      );
      const passages = await pool.query<{ content: string }>(
        "select content from chunks where source_item_id = $1",
        [w.sources.B1]
      );
      const whole = new Set(passages.rows.map((row) => row.content));
      expect(evidence.every((item) => whole.has(item.passage))).toBe(true);
      expect(written.evidence).toEqual({ used: evidence.length, total: 20 });
    } finally {
      w.dispose();
    }
  }, 60_000);

  it("repairs an answer that cites outside the evidence once, then reports it", async () => {
    const w = await world();
    try {
      w.setWriter((call, attempt) =>
        attempt === 0
          ? { paragraphs: [{ text: "Something [9].", citations: [9] }] }
          : citeInOrder(call, attempt)
      );
      const repaired = ready(await w.overview.overview({ id: w.topics.B1 }));
      expect(w.writes).toHaveLength(2);
      expect(w.writes[1]!.context.attempt).toBe(1);
      expect(w.writes[1]!.input).toContain("cites [9], which is not in the evidence");
      expect(repaired.citations).toHaveLength(4);

      w.setWriter(() => ({ paragraphs: [{ text: "Nothing cited.", citations: [] }] }));
      expect(await w.overview.overview({ id: w.topics.B1, force: true })).toEqual({
        status: "failed",
        messageKey: "topics.overview.errors.invalid"
      });
      expect(w.writes).toHaveLength(4);
      // The earlier overview stays; the page shows it.
      expect(ready(await w.overview.state(w.topics.B1)).citations).toHaveLength(4);
    } finally {
      w.dispose();
    }
  }, 60_000);

  it("is unchecked without a ranker, partial when a cited passage does not support a sentence", async () => {
    const w = await world();
    try {
      w.ai.ranker = false;
      const unchecked = ready(await w.overview.overview({ id: w.topics.A1 }));
      expect(unchecked.support).toEqual({ status: "unchecked", unsupported: [] });
      await w.overview.settled(w.topics.A1);
      expect(w.ranks).toHaveLength(0);
      expect(ready(await w.overview.state(w.topics.A1)).support.status).toBe("unchecked");

      w.ai.ranker = true;
      // The second paragraph's first sentence cites the wrong passage.
      w.setWriter(({ evidence }) => ({
        paragraphs: [
          { text: `${evidence[0]!.title} matters here [1].`, citations: [1] },
          { text: `${evidence[1]!.title} matters here [3].`, citations: [3] }
        ]
      }));
      ready(await w.overview.overview({ id: w.topics.A2 }));
      await w.overview.settled(w.topics.A2);
      expect(ready(await w.overview.state(w.topics.A2)).support).toEqual({
        status: "partial",
        unsupported: [1],
        sentences: { checked: 2, supported: 1 }
      });
    } finally {
      w.dispose();
    }
  }, 60_000);

  it("writes nothing for the root, an empty topic or without a writer route", async () => {
    const w = await world();
    try {
      expect(await w.overview.state(w.rootId)).toEqual({
        status: "absent",
        canWrite: false,
        reasonKey: "topics.overview.reasons.root"
      });
      expect(await w.overview.overview({ id: w.rootId })).toMatchObject({ canWrite: false });
      w.ai.writer = false;
      expect(await w.overview.overview({ id: w.topics.A1 })).toEqual({
        status: "absent",
        canWrite: false,
        reasonKey: "topics.overview.reasons.noWriter"
      });
      expect(w.writes).toHaveLength(0);
      await expect(w.overview.overview({ id: randomUUID() })).rejects.toThrow(
        "topics.errors.notFound"
      );
      // The factory wires an overview service and installs it on the page reads.
      expect(w.services.overview).not.toBeNull();
    } finally {
      w.dispose();
    }
  }, 60_000);

  it("lists the citing topic in objects.locate citedBy and keeps a replaced passage readable", async () => {
    const w = await world();
    try {
      const written = ready(await w.overview.overview({ id: w.topics.B1 }));
      await w.overview.settled(w.topics.B1);
      const locate = createObjectLocateRepository(pool);
      const cited = written.citations[0]!;
      const byNote = await locate.locateNote(cited.noteId!);
      expect(byNote?.citedBy).toEqual([{ kind: "topic", id: w.topics.B1, title: "Currents" }]);
      expect(byNote?.counts.citedBy).toBe(1);
      const bySource = await locate.locateSource(w.sources.B1);
      expect(bySource?.citedBy).toContainEqual({
        kind: "topic",
        id: w.topics.B1,
        title: "Currents"
      });
      expect((await locate.locateSource(w.sources.A1))?.citedBy).toEqual([]);

      // The passage is replaced: the citation keeps its excerpt and reads as unavailable.
      await pool.query("delete from chunks where id = $1", [cited.chunkId]);
      const after = ready(await w.overview.state(w.topics.B1));
      const gone = after.citations.find((citation) => citation.n === cited.n)!;
      expect(gone.available).toBe(false);
      expect(gone.chunkId).toBeUndefined();
      expect(gone.excerpt).toBe(cited.excerpt);
    } finally {
      w.dispose();
    }
  }, 60_000);
});
