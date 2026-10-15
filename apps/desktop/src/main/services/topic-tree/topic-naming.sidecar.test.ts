import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createLibraryResetRepository,
  createPgPool,
  createTopicNamingRepository,
  createTopicTreeRepository,
  noteVectorStrategyPrefix,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  topicStatsWrites,
  type JobRecord,
  type PgPool,
  type PostgresSidecarConnection,
  type TopicLoadSpace
} from "@app/db";
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
  topicLabelText,
  topicRecordOf,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import type { StructureEvent, TopicTreeConfig } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JobSupervisor } from "../job-supervisor.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices, TopicTreeServicesOptions } from "./index.js";
import { ItemVectorStore, loadTopicTreeCache } from "./topic-cache.js";
import { topicLabelHash } from "./topic-labels.js";
import { treeSpace } from "./topic-space.js";
import { immediateDebounce } from "./topic-triggers.js";

/**
 * Topic naming and label vectors against the real schema on a throwaway PostgreSQL sidecar, with a
 * fake model that reads the prompt's notes the way a writer would: top-down levels, packed calls,
 * the language rules and their repair, the TF-IDF fallback, human names, drift renames, the daily
 * cap, a missing route, the deterministic golden mode and the label vectors.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-naming-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
const contentLanguage = "pt-BR";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function configWith(overrides: Parameters<typeof topicTreeConfigWith>[0] = {}): TopicTreeConfig {
  return topicTreeConfigWith({
    // The supervisor is never started: only a test runs a job, and the jobs that the
    // `topicsChanged` listener queues stay an hour away (see `makeDue`).
    jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 },
    ...overrides
  });
}

interface WorldNote {
  title: string;
  idea: string;
  language: string;
}
interface WorldLeaf {
  key: "A1" | "A2" | "B1" | "B2";
  parent: "A" | "B";
  notes: WorldNote[];
}
const pt = (title: string, idea: string): WorldNote => ({ title, idea, language: "pt-BR" });
const en = (title: string, idea: string): WorldNote => ({ title, idea, language: "en" });

/** Two areas of two leaves each; B2 is written in English only, B1 in both languages. */
const leaves: WorldLeaf[] = [
  {
    key: "A1",
    parent: "A",
    notes: [
      pt(
        "Prática de recuperação melhora a memória",
        "Recuperar o conteúdo ativamente fortalece a memória."
      ),
      pt(
        "Recuperação espaçada e esquecimento",
        "Espaçar as tentativas de recuperação reduz o esquecimento."
      ),
      pt("Feedback após a recuperação", "O feedback corrige erros e consolida a recuperação."),
      pt(
        "Testes frequentes e aprendizagem",
        "Testes frequentes aumentam a recuperação no longo prazo."
      )
    ]
  },
  {
    key: "A2",
    parent: "A",
    notes: [
      pt("Sono e consolidação da memória", "Durante o sono profundo as memórias são consolidadas."),
      pt("Privação de sono e atenção", "Dormir pouco reduz a atenção e a memória de trabalho."),
      pt("Ciclos do sono e aprendizagem", "Os ciclos do sono organizam o que foi aprendido."),
      pt(
        "Sonecas curtas melhoram o desempenho",
        "Sonecas curtas melhoram a atenção depois do sono noturno."
      )
    ]
  },
  {
    key: "B1",
    parent: "B",
    notes: [
      pt(
        "Correntes oceânicas transportam calor",
        "As correntes oceânicas transportam calor pelo oceano."
      ),
      pt("Correntes oceânicas e clima", "As correntes oceânicas regulam o clima das costas."),
      pt("Correntes oceânicas profundas", "As correntes oceânicas profundas levam calor ao fundo."),
      en("Ocean currents carry heat", "Ocean currents carry heat across the basins."),
      en("Ocean currents and climate", "Ocean currents shape the climate of the coasts.")
    ]
  },
  {
    key: "B2",
    parent: "B",
    notes: [
      en("Tides and the moon", "The moon pulls the tides twice a day."),
      en("Spring tides and neap tides", "Spring tides follow the new and full moon."),
      en("Tidal range on the coast", "Tidal range depends on the shape of the coast."),
      en("Tide tables for sailors", "Tide tables tell sailors when the tide turns.")
    ]
  }
];

/** What the fake model answers for a topic, keyed by the words of its notes. */
const names = {
  area: [
    { match: /sono|recuper|mem[óo]ria/iu, title: "Memória e aprendizagem" },
    { match: /ocean|corrente|tide|moon/iu, title: "Mares e oceanos" }
  ],
  leaf: [
    { match: /sono/iu, title: "Sono e memória" },
    { match: /recuper/iu, title: "Prática de recuperação" },
    { match: /corrente|ocean/iu, title: "Correntes oceânicas" },
    { match: /tide|moon/iu, title: "Marés e a lua" }
  ]
};

interface PromptTopic {
  alias: string;
  current_title?: string;
  notes: Array<{ title: string; idea?: string }>;
}
interface PromptGroup {
  parent: string | null;
  named_siblings: string[];
  topics: PromptTopic[];
}
interface Call {
  task: string;
  input: string;
  context: Record<string, unknown>;
  groups: PromptGroup[];
}

/** The groups a naming prompt carries: the JSON after "Topics:" up to the repair block. */
function groupsOf(input: string): PromptGroup[] {
  const body = input.slice(input.lastIndexOf("\nTopics:\n") + "\nTopics:\n".length);
  const end = body.indexOf("\n\n");
  return JSON.parse(end < 0 ? body : body.slice(0, end)) as PromptGroup[];
}

function item(topic: PromptTopic, group: PromptGroup, language = contentLanguage) {
  const text = topic.notes.map((note) => `${note.title} ${note.idea ?? ""}`).join(" ");
  const table = group.parent === null ? names.area : names.leaf;
  const found = table.find((entry) => entry.match.test(text));
  return {
    alias: topic.alias,
    title: found?.title ?? "Assunto geral",
    description: `Reúne as notas sobre ${(found?.title ?? "o assunto").toLowerCase()} e o que elas dizem.`,
    aliases: ["Tema relacionado"],
    language
  };
}

type Responder = (call: Call, attempt: number) => unknown | Promise<unknown>;

describe.skipIf(!sidecarAvailable)("topic naming on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-naming-"));
    for (let attempt = 1; ; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecarPaths.binDir,
        dataDir: join(workDir, `database-${attempt}`),
        database: "memora_topic_naming_test",
        user: "memora_topic_naming_test",
        password: `topic-naming-${randomUUID()}`,
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

  // -------------------------------------------------------------------------
  // A fresh library, tree and services for every test

  interface World {
    services: TopicTreeServices;
    supervisor: JobSupervisor;
    treeId: string;
    topics: Record<"A" | "B" | "A1" | "A2" | "B1" | "B2", string>;
    notes: Record<string, string[]>;
    sources: Record<string, string>;
    calls: Call[];
    embeddings: Array<{ text: string; context: Record<string, unknown> }>;
    clock: { now: number };
    pushed: Array<{ topicIds: readonly string[] | null; changeSetId: string | null }>;
    setResponder(responder: Responder | null): void;
    gate: { current: Promise<void> | null };
    ai: {
      route: boolean;
      embeddingLocal: boolean;
      /** The space key the embedding calls report. */
      embeddingSpaceKey: string;
      /** The space key the embedding route is in. */
      routeSpaceKey: string;
    };
    dispose(): Promise<void>;
  }

  async function world(
    options: {
      config?: TopicTreeConfig;
      env?: Record<string, string | undefined>;
      budgetCalls?: { calls: number };
    } = {}
  ): Promise<World> {
    await createLibraryResetRepository(pool).reset();
    const config = options.config ?? configWith();
    const calls: Call[] = [];
    const embeddings: World["embeddings"] = [];
    const clock = { now: Date.parse("2026-10-15T12:00:00.000Z") };
    const gate: World["gate"] = { current: null };
    const ai: World["ai"] = {
      route: true,
      embeddingLocal: true,
      embeddingSpaceKey: space.spaceKey,
      routeSpaceKey: space.spaceKey
    };
    let responder: Responder | null = null;
    const budget = options.budgetCalls ?? { calls: 0 };

    const fake = {
      runDefaultTask: vi.fn(
        async (
          task: string,
          input: string,
          context: Record<string, unknown> = {},
          signal?: AbortSignal
        ) => {
          void signal;
          if (!ai.route) return null;
          const base = {
            providerId: "fixture",
            modelId: "fixture-writer",
            runtime: "remote" as const,
            durationMs: 1,
            aiTaskRunId: randomUUID(),
            profileId: randomUUID(),
            outputLanguage: contentLanguage,
            inputTokens: 100,
            outputTokens: 40
          };
          if (task === "embedding") {
            embeddings.push({ text: input, context });
            const rng = createRng(parseInt(sha(input).slice(0, 8), 16));
            const vector = Array.from({ length: dim }, () => rng.gaussian());
            return {
              ...base,
              taskType: "embedding" as const,
              output: vector,
              embeddingSpaceKey: ai.embeddingSpaceKey
            };
          }
          const groups = groupsOf(input);
          const call: Call = { task, input, context, groups };
          calls.push(call);
          if (gate.current) await gate.current;
          const attempt = Number(context.attempt ?? 0);
          const output = responder
            ? await responder(call, attempt)
            : {
                topics: groups.flatMap((group) => group.topics.map((topic) => item(topic, group)))
              };
          return { ...base, taskType: "structured-output" as const, output };
        }
      ),
      activeEmbeddingSpace: vi.fn(async () => ({
        spaceKey: ai.routeSpaceKey,
        profileId: randomUUID(),
        provider: space.provider,
        modelId: space.model,
        local: ai.embeddingLocal,
        dimensions: dim,
        newestNoteSpaceKey: space.spaceKey,
        confirmed: true
      }))
    };

    const services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: async () => ({ kind: "ready", space }) },
      env: options.env ?? {},
      isPackaged: false,
      logger: quiet,
      newTreeConfig: () => config,
      budgetStore: {
        read: async () => ({ day: "2026-10-15", calls: budget.calls }),
        write: async (record) => {
          budget.calls = record.calls;
        }
      },
      ai: fake as unknown as NonNullable<TopicTreeServicesOptions["ai"]>,
      getContentLanguage: async () => contentLanguage,
      now: () => new Date(clock.now)
    });
    const supervisor = new JobSupervisor({
      getPool: () => pool,
      lightJobs: services.jobs,
      pollIntervalMs: 20,
      logger: quiet
    });
    const pushed: World["pushed"] = [];
    services.changes.subscribe((event) => {
      pushed.push({ topicIds: event.topicIds, changeSetId: event.changeSetId });
    });

    // The library: one source per leaf, its notes with 256-d vectors that cluster by leaf.
    const ensured = await services.ensureActiveTree();
    if (ensured?.kind !== "ready") throw new Error("the tree was not created");
    const tree = ensured.tree;
    const rng = createRng(20261015);
    const topics = {} as World["topics"];
    const notes: Record<string, string[]> = {};
    const sources: Record<string, string> = {};
    const store = new ItemVectorStore(dim);
    const rootId = tree.rootId;
    const live = createTopicTreeState({ dim, rootId });
    const liveEditor = createTopicTreeEditor(live, { record: false });
    for (const key of ["A", "B"] as const) {
      topics[key] = randomUUID();
      liveEditor.createTopic(topics[key], rootId);
    }
    let leafIndex = 0;
    for (const leaf of leaves) {
      topics[leaf.key] = randomUUID();
      liveEditor.createTopic(topics[leaf.key], topics[leaf.parent]);
      const source = randomUUID();
      sources[leaf.key] = source;
      await pool.query(
        "insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)",
        [source, `Book ${leaf.key}`, sha(`book-${leaf.key}`)]
      );
      const document = randomUUID();
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, $3, 'seed', $4)`,
        [document, source, `Book ${leaf.key}`, sha(`document-${leaf.key}`)]
      );
      notes[leaf.key] = [];
      for (const [index, note] of leaf.notes.entries()) {
        const id = randomUUID();
        const chunk = randomUUID();
        await pool.query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           values ($1, $2, $3, $4, 'Passage', $5)`,
          [chunk, document, source, index, sha(`chunk-${chunk}`)]
        );
        await pool.query(
          `insert into atomic_notes (id, title, body_markdown, idea_statement, language, ownership,
             created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
             generation_runtime, generation_prompt_version, generation_key)
           values ($1, $2, 'Body', $3, $4, 'source', $5, $6, 'test', 'test', 'test', 'test', $7)`,
          [id, note.title, note.idea, note.language, source, chunk, `key-${id}`]
        );
        // The vector clusters by leaf: a leaf axis plus noise, unit length.
        const vector = new Float32Array(dim);
        vector[leafIndex] = 1;
        for (let k = 0; k < dim; k += 1) vector[k] = (vector[k] as number) + 0.08 * rng.gaussian();
        const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        for (let k = 0; k < dim; k += 1) vector[k] = (vector[k] as number) / length;
        const hash = sha(`note-${note.title}`);
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
        liveEditor.placeItem(
          key,
          placementRecord(topics[leaf.key], { decidedBy: "build", itemFingerprint: hash })
        );
        notes[leaf.key]!.push(id);
      }
      leafIndex += 1;
    }
    recomputeSubtree(live, store);
    const repository = createTopicTreeRepository(pool);
    const built = await repository.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: liveTopicIds(live)
        .filter((id) => id !== rootId)
        .map((id) => topicRecordOf(getTopic(live, id))),
      placements: [...live.placements].flatMap(([key, list]) =>
        list.map((placement) => ({ item: key, placement }))
      ),
      stats: topicStatsWrites(live, store, liveTopicIds(live)),
      clock: live.clock
    });
    if (built.kind !== "applied") throw new Error(`the tree was not seeded: ${built.kind}`);
    services.service.invalidate();
    // The creation of the tree was pushed too; the tests look at what naming pushes.
    services.changes.flush();
    pushed.length = 0;

    return {
      services,
      supervisor,
      treeId: tree.id,
      topics,
      notes,
      sources,
      calls,
      embeddings,
      clock,
      pushed,
      gate,
      ai,
      setResponder: (next) => {
        responder = next;
      },
      dispose: async () => {
        await supervisor.stop().catch(() => undefined);
        services.dispose();
      }
    };
  }

  /**
   * Makes the queued jobs of one type due and parks the others a day away, so a test runs only
   * the job it asks for: a debounce never moves a job earlier, and the `topicsChanged` listener
   * queues naming jobs of its own.
   */
  async function makeDue(type: string): Promise<void> {
    await pool.query(
      `update jobs set run_after = case when type = $1 then now() else now() + interval '1 day' end
        where status = 'queued'`,
      [type]
    );
  }

  /**
   * Runs the queued job of a type on the model worker. A request from the `topicsChanged`
   * listener can land between making the job due and claiming it and push it an hour away
   * again, so the job is made due again until it is claimed.
   */
  async function runDue(w: World, type: string): Promise<JobRecord> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await makeDue(type);
      const job = await w.supervisor.runLightOnce("model");
      if (job?.type === type) return job;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`no ${type} job ran`);
  }

  /** Requests the naming job and runs it on the light lane's model worker. */
  async function runNaming(w: World): Promise<JobRecord> {
    await w.services.triggers.request("topic-name", w.treeId, null, {
      debounce: immediateDebounce
    });
    return runDue(w, "topic-name");
  }

  async function runLabels(w: World): Promise<JobRecord> {
    await w.services.triggers.request("topic-label-embed", w.treeId, null, {
      debounce: immediateDebounce
    });
    return runDue(w, "topic-label-embed");
  }

  /** A person names a topic (it becomes human-managed) or pins it, through the engine. */
  async function byHand(
    w: World,
    key: keyof World["topics"],
    change: { title: string } | { pin: true }
  ): Promise<void> {
    const repository = createTopicTreeRepository(pool);
    const tree = (await repository.tree(w.treeId))!;
    const id = w.topics[key];
    const current = (await createTopicNamingRepository(pool).topicRows(w.treeId, [id])).topics.get(
      id
    )!;
    const events: StructureEvent[] =
      "title" in change
        ? [
            {
              op: "topic.rename",
              topicId: id,
              before: {
                title: current.title,
                nameState: current.nameState,
                nameSource: current.nameSource,
                nameLanguage: current.nameLanguage,
                namedChangeSetId: current.namedChangeSetId,
                aliases: current.aliases
              },
              after: {
                title: change.title,
                nameState: "named",
                nameSource: "human",
                nameLanguage: contentLanguage,
                namedChangeSetId: null,
                aliases: []
              }
            },
            {
              op: "topic.manage",
              topicId: id,
              before: { management: current.management },
              after: { management: "human" }
            }
          ]
        : [
            {
              op: "topic.manage",
              topicId: id,
              before: { management: current.management },
              after: { management: "pinned" }
            }
          ];
    const result = await repository.applyChangeSet({
      treeId: w.treeId,
      expectedGeneration: tree.generation,
      origin: "human",
      titleKey: "topics.changeSets.rename",
      events
    });
    if (result.kind !== "applied") throw new Error(`the change was not applied: ${result.kind}`);
  }

  interface Row {
    id: string;
    title: string | null;
    state: string;
    source: string | null;
    language: string | null;
    description: string | null;
    aliases: string[];
    namedBy: string | null;
    management: string;
  }
  async function rows(w: World): Promise<Record<string, Row>> {
    const result = await pool.query<{
      id: string;
      title: string | null;
      state: string;
      source: string | null;
      language: string | null;
      description: string | null;
      aliases: string[];
      namedBy: string | null;
      management: string;
    }>(
      `select id, title, name_state as state, name_source as source, name_language as language,
              description, aliases, named_change_set_id as "namedBy", management
         from topics where tree_id = $1 and role = 'topic'`,
      [w.treeId]
    );
    const byKey: Record<string, Row> = {};
    for (const [key, id] of Object.entries(w.topics)) {
      byKey[key] = result.rows.find((row) => row.id === id) as Row;
    }
    return byKey;
  }

  async function count(sql: string, values: unknown[] = []): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  // -------------------------------------------------------------------------

  it("names every level top-down in the content language, one packed call per level", async () => {
    const w = await world();
    try {
      const job = await runNaming(w);
      expect(job.status).toBe("succeeded");
      expect(job.result).toMatchObject({
        status: "named",
        candidates: 6,
        llmNamed: 6,
        provisional: 0,
        stillUnnamed: 0,
        calls: 2,
        repairCalls: 0,
        changeSets: 2
      });
      const named = await rows(w);
      expect(named.A).toMatchObject({
        title: "Memória e aprendizagem",
        state: "named",
        source: "llm",
        language: contentLanguage,
        aliases: ["Tema relacionado"]
      });
      expect(named.B?.title).toBe("Mares e oceanos");
      expect(named.A1?.title).toBe("Prática de recuperação");
      expect(named.A2?.title).toBe("Sono e memória");
      expect(named.B1?.title).toBe("Correntes oceânicas");
      // The English-only leaf is named in the content language like the rest.
      expect(named.B2).toMatchObject({ title: "Marés e a lua", language: contentLanguage });
      expect(named.A2?.description).toContain("sono e memória");

      // Level 1 is one call about the two areas, level 2 one call with both groups.
      expect(w.calls).toHaveLength(2);
      expect(w.calls[0]!.groups).toHaveLength(1);
      expect(w.calls[0]!.groups[0]!.parent).toBeNull();
      expect(w.calls[0]!.groups[0]!.topics).toHaveLength(2);
      expect(w.calls[1]!.groups.map((g) => g.parent).sort()).toEqual([
        "Mares e oceanos",
        "Memória e aprendizagem"
      ]);
      // Every call is audited: operation, class, queue class, language, participating sources.
      for (const call of w.calls) {
        expect(call.task).toBe("structured-output");
        expect(call.context).toMatchObject({
          operation: "topic_name",
          workloadClass: "write-fast",
          priority: "background",
          contentLanguage,
          stage: "topic_naming"
        });
        expect((call.context.sourceItemIds as string[]).length).toBeGreaterThan(0);
        expect(call.context.sourceItemIds).toEqual(
          [...(call.context.sourceItemIds as string[])].sort()
        );
      }
      // The prompt carries no IDs.
      for (const call of w.calls) {
        expect(call.input).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u);
        expect(call.input).toContain("Brazilian Portuguese");
      }

      // Two naming change-sets; each name points at its own and keeps the membership sketches.
      const changeSets = await pool.query<{
        id: string;
        origin: string;
        title_key: string;
        ai_task_run_ids: string[];
        summary: { sketches: Record<string, { n: number }>; llm: number };
      }>(
        `select id, origin, title_key, ai_task_run_ids, summary from topic_change_sets
          where origin = 'naming' order by created_at`
      );
      expect(changeSets.rows).toHaveLength(2);
      expect(changeSets.rows.every((row) => row.title_key === "topics.changeSets.naming")).toBe(
        true
      );
      expect(changeSets.rows.map((row) => row.summary.llm)).toEqual([2, 4]);
      // Each level records the audit of its own call and what it asked of the model.
      const [first, second] = changeSets.rows as [
        (typeof changeSets.rows)[number],
        (typeof changeSets.rows)[number]
      ];
      expect(first.ai_task_run_ids).toHaveLength(1);
      expect(second.ai_task_run_ids).toHaveLength(1);
      expect(first.ai_task_run_ids[0]).not.toBe(second.ai_task_run_ids[0]);
      expect(first.summary).toMatchObject({
        calls: 1,
        repairCalls: 0,
        asked: 2,
        firstTryAccepted: 2,
        repairAccepted: 0,
        inputTokens: 100,
        outputTokens: 40,
        language: contentLanguage
      });
      expect(second.summary).toMatchObject({ calls: 1, asked: 4, firstTryAccepted: 4 });
      expect(
        await count("select naming_calls as count from topic_daily_metrics where tree_id = $1", [
          w.treeId
        ])
      ).toBe(2);
      expect(named.A?.namedBy).toBe(changeSets.rows[0]!.id);
      expect(named.A1?.namedBy).toBe(changeSets.rows[1]!.id);
      expect(changeSets.rows[0]!.summary.sketches[w.topics.A]?.n).toBe(8);
      expect(changeSets.rows[1]!.summary.sketches[w.topics.B1]?.n).toBe(5);

      // The push reports both commits, and naming asked for label vectors.
      w.services.changes.flush();
      // Both commits were pushed (coalesced into one event when they fell in one window).
      const pushedTopics = new Set(w.pushed.flatMap((event) => event.topicIds ?? []));
      expect(w.pushed.length).toBeGreaterThan(0);
      for (const id of Object.values(w.topics)) expect(pushedTopics.has(id)).toBe(true);
      expect(
        await count(
          "select count(*) from jobs where type = 'topic-label-embed' and status = 'queued'"
        )
      ).toBe(1);
      // Nothing is left to name, and asking again calls no model.
      const again = await runNaming(w);
      expect(again.result).toMatchObject({ status: "nothing_to_name" });
      expect(w.calls).toHaveLength(2);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("sends the same prompts for the same content with other IDs, so cassettes replay (D22)", async () => {
    const prompts: string[][] = [];
    for (let run = 0; run < 2; run += 1) {
      const w = await world();
      try {
        await runNaming(w);
        prompts.push(w.calls.map((call) => call.input));
        expect(w.calls.map((call) => call.context.sourceItemIds)).not.toEqual([]);
      } finally {
        await w.dispose();
      }
    }
    // The topic, note and source IDs differ between the two libraries; the prompts do not.
    expect(prompts[0]).toHaveLength(2);
    expect(prompts[1]).toEqual(prompts[0]);
  }, 60_000);

  it("rejects a name in another language, asks again for that topic only and keeps the rest", async () => {
    const w = await world();
    try {
      w.setResponder((call, attempt) => ({
        topics: call.groups.flatMap((group) =>
          group.topics.map((topic) => {
            const answer = item(topic, group);
            const isTides = topic.notes.some((note) => /tide|moon/iu.test(note.title));
            if (attempt === 0 && isTides) {
              return { ...answer, title: "Tides and the moon", language: "en" };
            }
            return answer;
          })
        )
      }));
      const job = await runNaming(w);
      expect(job.result).toMatchObject({
        llmNamed: 6,
        calls: 2,
        repairCalls: 1,
        stillUnnamed: 0
      });
      expect((await rows(w)).B2?.title).toBe("Marés e a lua");
      // First-try validity and the repair rate are in the leaf level's change-set.
      const leafLevel = await pool.query<{ summary: Record<string, number> }>(
        `select summary from topic_change_sets where origin = 'naming' order by created_at desc limit 1`
      );
      expect(leafLevel.rows[0]!.summary).toMatchObject({
        calls: 1,
        repairCalls: 1,
        asked: 4,
        firstTryAccepted: 3,
        repairAccepted: 1
      });
      // The repair call carries the one rejected topic and the reason.
      const repair = w.calls.find((call) => call.context.attempt === 1)!;
      expect(repair.groups.flatMap((group) => group.topics)).toHaveLength(1);
      expect(repair.input).toContain("the name is not in the content language");
      expect(repair.input).toContain("was rejected");
      // Its siblings' names are already taken in the repair.
      expect(repair.groups[0]!.named_siblings).toContain("Correntes oceânicas");
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("falls back to a content-language TF-IDF name and leaves an empty-handed topic unnamed", async () => {
    const w = await world();
    try {
      // The model never gets the ocean leaves right: English titles under the right language code.
      w.setResponder((call) => ({
        topics: call.groups.flatMap((group) =>
          group.topics.map((topic) => {
            const answer = item(topic, group);
            const ocean = topic.notes.some((note) => /tide|moon|ocean|corrente/iu.test(note.title));
            return ocean && group.parent !== null ? { ...answer, language: "en" } : answer;
          })
        )
      }));
      const job = await runNaming(w);
      expect(job.result).toMatchObject({
        llmNamed: 4,
        provisional: 1,
        stillUnnamed: 1,
        repairCalls: 1
      });
      const named = await rows(w);
      // B1 has Portuguese notes: a provisional name from those notes only.
      expect(named.B1).toMatchObject({
        state: "provisional",
        source: "tfidf",
        language: contentLanguage
      });
      expect(named.B1?.title?.startsWith("Mares e oceanos › ")).toBe(true);
      expect(named.B1?.title).toMatch(/corrente/u);
      expect(named.B1?.title).not.toMatch(/ocean currents|heat|climate|basins/iu);
      expect(named.B1?.description).toBeNull();
      // B2 has no Portuguese note: no title is stored.
      expect(named.B2).toMatchObject({ title: null, state: "unnamed", source: null });
      expect(named.A1?.state).toBe("named");

      // A topic that failed lately is not asked again at once, and asking does not loop.
      const callsBefore = w.calls.length;
      const again = await runNaming(w);
      expect(again.result).toMatchObject({ status: "nothing_to_name" });
      expect(w.calls).toHaveLength(callsBefore);
      await w.services.naming!.requestIfNeeded(w.treeId);
      expect(
        await count("select count(*) from jobs where type = 'topic-name' and status = 'queued'")
      ).toBe(0);

      // Later, with the model answering well, the provisional and the unnamed topics are named.
      w.setResponder(null);
      w.clock.now += 30 * 60_000;
      const later = await runNaming(w);
      expect(later.result).toMatchObject({ llmNamed: 2, provisional: 0 });
      const final = await rows(w);
      expect(final.B1).toMatchObject({
        title: "Correntes oceânicas",
        state: "named",
        source: "llm"
      });
      expect(final.B2?.title).toBe("Marés e a lua");
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("never replaces a human name or names a protected topic", async () => {
    const w = await world();
    try {
      await byHand(w, "A1", { title: "Minha prática" });
      await byHand(w, "B2", { pin: true });
      const job = await runNaming(w);
      expect(job.result).toMatchObject({ status: "named", candidates: 4, llmNamed: 4 });
      const named = await rows(w);
      expect(named.A1).toMatchObject({
        title: "Minha prática",
        source: "human",
        management: "human"
      });
      expect(named.B2).toMatchObject({ title: null, state: "unnamed", management: "pinned" });
      // The human name is a sibling title the model must not repeat, never a topic to name.
      const leafCall = w.calls[1]!;
      const memoryGroup = leafCall.groups.find(
        (group) => group.parent === "Memória e aprendizagem"
      )!;
      expect(memoryGroup.named_siblings).toEqual(["Minha prática"]);
      expect(memoryGroup.topics).toHaveLength(1);
      // The pinned topic is in no prompt.
      expect(w.calls.some((call) => /tide|moon/iu.test(call.input))).toBe(false);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("renames an LLM-named topic only after its membership drifted by renameDrift", async () => {
    const w = await world();
    try {
      await runNaming(w);
      const first = await rows(w);
      // One of four notes leaves A1: a drift of 0.25, below the 0.3 threshold.
      await pool.query("delete from atomic_notes where id = $1", [w.notes.A1![0]]);
      w.clock.now += 2 * 60 * 60_000;
      w.services.service.invalidate();
      const callsBefore = w.calls.length;
      const quietRun = await runNaming(w);
      expect(quietRun.result).toMatchObject({ status: "nothing_to_name" });
      expect(w.calls).toHaveLength(callsBefore);
      // A second note leaves: half of the original members are gone.
      await pool.query("delete from atomic_notes where id = $1", [w.notes.A1![1]]);
      w.clock.now += 2 * 60 * 60_000;
      w.setResponder((call) => ({
        topics: call.groups.flatMap((group) =>
          group.topics.map((topic) => ({
            ...item(topic, group),
            title: "Testes e recuperação"
          }))
        )
      }));
      const drifted = await runNaming(w);
      expect(drifted.result).toMatchObject({ status: "named", candidates: 1, llmNamed: 1 });
      const drift = w.calls.at(-1)!;
      // The model sees the title it may keep.
      expect(drift.groups[0]!.topics[0]!.current_title).toBe("Prática de recuperação");
      const second = await rows(w);
      expect(second.A1?.title).toBe("Testes e recuperação");
      expect(second.A1?.namedBy).not.toBe(first.A1?.namedBy);
      // The other topics keep their names and their naming change-sets.
      expect(second.A2).toMatchObject({ title: first.A2?.title, namedBy: first.A2?.namedBy });
      expect(second.A?.title).toBe(first.A?.title);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("keeps provisional names and reports the cap once D34's daily calls are spent", async () => {
    const w = await world({ config: configWith({ ai: { maxBackgroundCallsPerDay: 1 } }) });
    try {
      const job = await runNaming(w);
      expect(job.result).toMatchObject({
        status: "named",
        calls: 1,
        capReached: true,
        llmNamed: 2
      });
      const named = await rows(w);
      expect(named.A?.state).toBe("named");
      // The leaves got provisional names from their Portuguese notes, B2 none.
      expect(named.A1).toMatchObject({ state: "provisional", source: "tfidf" });
      expect(named.A1?.title?.startsWith("Memória e aprendizagem › ")).toBe(true);
      expect(named.B2?.state).toBe("unnamed");
      await expect(w.services.service.status()).resolves.toMatchObject({ dailyCapReached: true });
      expect(w.calls).toHaveLength(1);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("names provisionally when no model route exists, and does not ask again until it may", async () => {
    const w = await world();
    try {
      w.ai.route = false;
      const job = await runNaming(w);
      expect(job.result).toMatchObject({ status: "named", noRoute: true, llmNamed: 0 });
      const named = await rows(w);
      expect(named.A1).toMatchObject({ state: "provisional", source: "tfidf" });
      expect(named.A1?.title).not.toMatch(/ocean|heat/iu);
      expect(named.B2?.state).toBe("unnamed");
      // The route is back, but the topics were tried lately: no call and no new job.
      w.ai.route = true;
      await w.services.naming!.requestIfNeeded(w.treeId);
      expect(
        await count("select count(*) from jobs where type = 'topic-name' and status = 'queued'")
      ).toBe(0);
      const again = await runNaming(w);
      expect(again.result).toMatchObject({ status: "nothing_to_name" });
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("names nothing in a deterministic golden run (G1) and asks for nothing", async () => {
    const w = await world({ env: { MEMORA_GOLDEN_RUN: "1" } });
    try {
      expect(w.services.aiMode).toBe("deterministic");
      await w.services.naming!.requestIfNeeded(w.treeId);
      expect(await count("select count(*) from jobs where type = 'topic-name'")).toBe(0);
      const job = await runNaming(w).catch(() => null);
      // The executor is registered, so a job can still be claimed; it does nothing.
      if (job) expect(job.result).toMatchObject({ status: "skipped", reason: "deterministic" });
      expect(w.calls).toHaveLength(0);
      expect((await rows(w)).A?.state).toBe("unnamed");
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("holds neither the engine nor a transaction while the model call is pending (D10)", async () => {
    const w = await world();
    try {
      let release!: () => void;
      w.gate.current = new Promise<void>((done) => {
        release = done;
      });
      await w.services.triggers.request("topic-name", w.treeId, null, {
        debounce: immediateDebounce
      });
      const running = runDue(w, "topic-name");
      const deadline = Date.now() + 10_000;
      while (w.calls.length === 0) {
        if (Date.now() > deadline) throw new Error("the model was never called");
        await new Promise((done) => setTimeout(done, 10));
      }
      // The engine still serves PLACE, and the tree takes writes, while the call waits.
      await expect(w.services.service.exclusive(async () => "free")).resolves.toBe("free");
      const idle = await pool.query<{ count: string }>(
        "select count(*) from pg_stat_activity where state = 'idle in transaction'"
      );
      expect(Number(idle.rows[0]?.count)).toBe(0);
      release();
      const job = await running;
      expect(job?.result).toMatchObject({ status: "named" });
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("drops a name whose topic a person renamed while the model was answering", async () => {
    const w = await world();
    try {
      let renamed = false;
      w.setResponder(async (call) => {
        // A person renames A2 between the snapshot and the write of the leaf level.
        if (!renamed && call.groups.some((group) => group.parent !== null)) {
          renamed = true;
          await byHand(w, "A2", { title: "Sono e descanso" });
        }
        return {
          topics: call.groups.flatMap((group) => group.topics.map((topic) => item(topic, group)))
        };
      });
      const job = await runNaming(w);
      expect(job.result).toMatchObject({ status: "named", llmNamed: 5, dropped: 1 });
      const named = await rows(w);
      expect(named.A2).toMatchObject({ title: "Sono e descanso", source: "human" });
      expect(named.A1?.title).toBe("Prática de recuperação");
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("requests naming after a committed change that left topics without a name", async () => {
    const w = await world();
    try {
      w.services.changes.record({
        treeId: w.treeId,
        generation: 1,
        topicIds: null,
        changeSetId: null
      });
      w.services.changes.flush();
      const deadline = Date.now() + 5_000;
      while (
        (await count(
          "select count(*) from jobs where type = 'topic-name' and status = 'queued'"
        )) === 0
      ) {
        if (Date.now() > deadline) throw new Error("naming was never requested");
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(
        await count("select count(*) from jobs where type = 'topic-name' and dedupe_key = $1", [
          `topic-name:${w.treeId}`
        ])
      ).toBe(1);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Label vectors

  it("embeds each named topic's label in the tree's space and attaches it to the cache", async () => {
    const w = await world();
    try {
      await runNaming(w);
      const job = await runLabels(w);
      expect(job.result).toMatchObject({ status: "embedded", embedded: 6, remaining: 0 });
      const stored = await pool.query<{
        target_id: string;
        strategy: string;
        content_hash: string;
        usage: string;
        model: string;
      }>(
        `select target_id, strategy, content_hash, usage, model from embeddings_256
          where target_type = 'topic_label'`
      );
      expect(stored.rows).toHaveLength(6);
      expect(new Set(stored.rows.map((row) => row.strategy))).toEqual(
        new Set([`topic-label-v1:${space.spaceKey}`])
      );
      const a1 = (await loadTopicTreeCache(pool, w.treeId))!;
      const node = getTopic(a1.state, w.topics.A1);
      const text = topicLabelText(node)!;
      expect(text).toBe(
        "Prática de recuperação · Tema relacionado · Reúne as notas sobre prática de recuperação e o que elas dizem."
      );
      expect(stored.rows.find((row) => row.target_id === w.topics.A1)?.content_hash).toBe(
        topicLabelHash(text)
      );
      // Every named topic has a unit label vector in the cache.
      for (const id of [
        w.topics.A,
        w.topics.B,
        w.topics.A1,
        w.topics.A2,
        w.topics.B1,
        w.topics.B2
      ]) {
        const label = getTopic(a1.state, id).label;
        expect(label).not.toBeNull();
        expect(label!.vector).toHaveLength(dim);
        expect(Math.hypot(...label!.vector)).toBeCloseTo(1, 4);
      }
      // A local embedding route costs nothing against the daily cap.
      expect(w.embeddings).toHaveLength(6);
      expect(w.embeddings[0]!.context).toMatchObject({
        operation: "topic_label_embedding",
        embeddingInputType: "document",
        priority: "background"
      });
      // Nothing is stale, so another run embeds nothing.
      const again = await runLabels(w);
      expect(again.result).toMatchObject({ status: "current" });
      expect(w.embeddings).toHaveLength(6);

      // A rename makes its label stale: the cache drops it until the label is embedded again.
      await pool.query("update topics set title = 'Recuperação ativa' where id = $1", [
        w.topics.A1
      ]);
      const stale = (await loadTopicTreeCache(pool, w.treeId))!;
      expect(getTopic(stale.state, w.topics.A1).label).toBeNull();
      expect(getTopic(stale.state, w.topics.A2).label).not.toBeNull();
      const refreshed = await runLabels(w);
      expect(refreshed.result).toMatchObject({ status: "embedded", embedded: 1 });
      const fresh = (await loadTopicTreeCache(pool, w.treeId))!;
      expect(getTopic(fresh.state, w.topics.A1).label).not.toBeNull();
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("never stores a vector made in another space, and counts remote label calls against the cap", async () => {
    const w = await world({ config: configWith({ ai: { maxBackgroundCallsPerDay: 2 } }) });
    try {
      await pool.query(
        `update topics set title = 'Um', name_state = 'named', name_source = 'llm' where id = $1`,
        [w.topics.A]
      );
      await pool.query(
        `update topics set title = 'Dois', name_state = 'named', name_source = 'llm' where id = $1`,
        [w.topics.B]
      );
      await pool.query(
        `update topics set title = 'Três', name_state = 'named', name_source = 'llm' where id = $1`,
        [w.topics.A1]
      );
      // A vector from another space is refused.
      w.ai.embeddingSpaceKey = "another-space";
      const wrong = await runLabels(w);
      expect(wrong.result).toMatchObject({ status: "embedded", embedded: 0 });
      expect(
        await count("select count(*) from embeddings_256 where target_type = 'topic_label'")
      ).toBe(0);
      w.ai.embeddingSpaceKey = space.spaceKey;
      // A remote route pays from the same daily budget as naming.
      w.ai.embeddingLocal = false;
      const capped = await runLabels(w);
      expect(capped.result).toMatchObject({ status: "embedded", embedded: 2, capReached: true });
      expect(
        await count("select count(*) from embeddings_256 where target_type = 'topic_label'")
      ).toBe(2);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("leaves labels alone when the embedding route moved to another space", async () => {
    const w = await world();
    try {
      await pool.query(
        `update topics set title = 'Um', name_state = 'named', name_source = 'llm' where id = $1`,
        [w.topics.A]
      );
      const tree = await createTopicTreeRepository(pool).tree(w.treeId);
      expect(treeSpace(tree!)).toEqual(space);
      w.ai.routeSpaceKey = "another-space";
      const job = await runLabels(w);
      expect(job.result).toMatchObject({ status: "space_changed" });
      expect(w.embeddings).toHaveLength(0);
      expect(
        await count("select count(*) from embeddings_256 where target_type = 'topic_label'")
      ).toBe(0);
    } finally {
      await w.dispose();
    }
  }, 60_000);
});
