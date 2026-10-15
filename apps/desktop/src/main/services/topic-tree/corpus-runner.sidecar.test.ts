import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createPgPool,
  createSettingsRepository,
  createTopicTreeRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";
import type { PgPool, PostgresSidecarConnection } from "@app/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JobSupervisor } from "../job-supervisor.js";
import type { KnowledgeService } from "../knowledge-service.js";
import { writeFixtureCorpus } from "./corpus-fixture.js";
import { CorpusRunner, corpusMarkerSettingKey, readCorpusConfig } from "./corpus-runner.js";
import type { CorpusConfig, CorpusRunSummary } from "./corpus-runner.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import { createStoredVectorSpaceResolver } from "./topic-space.js";

/**
 * The ENV-C corpus runner against the real schema on a throwaway PostgreSQL sidecar: a fixture
 * corpus of four articles seeds an empty measurement profile, the app's own `note-embedding` jobs
 * (run by the job supervisor with a stand-in for the embedding route) give every note a vector,
 * the topic barrier is released for the build stage, a held-out article arrives, and every refusal
 * leaves the library alone.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const spaceKey = "corpus-runner-test-space";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A unit vector that is a function of the text: the stand-in for the embedding route. */
function vectorOf(text: string): number[] {
  const values: number[] = [];
  let block = createHash("sha256").update(text).digest();
  while (values.length < dim) {
    for (const byte of block) values.push(byte / 255 - 0.5);
    block = createHash("sha256").update(block).digest();
  }
  const used = values.slice(0, dim);
  const norm = Math.sqrt(used.reduce((total, value) => total + value * value, 0));
  return used.map((value) => value / norm);
}

/** The heavy lane embeds with a stand-in for the route: the same job, a deterministic vector. */
function knowledgeStub(getPool: () => PgPool): KnowledgeService {
  return {
    embedAtomicNote: async (noteId: string) => {
      const pool = getPool();
      const note = await pool.query<{ title: string; idea: string; body: string }>(
        "select title, idea_statement as idea, body_markdown as body from atomic_notes where id = $1",
        [noteId]
      );
      const row = note.rows[0]!;
      const text = `${row.title}\n${row.idea}\n${row.body}`;
      await pool.query(
        `insert into embeddings_256 (target_type, target_id, provider, model, runtime, usage, strategy,
           content_hash, embedding)
         values ('atomic_note', $1, 'test', 'synthetic-256', 'none', 'matching', $2, $3, $4::vector)`,
        [noteId, `native-v2:${spaceKey}`, sha(text), `[${vectorOf(text).join(",")}]`]
      );
      // The AI service audits every call; the stand-in leaves the same trace.
      await pool.query(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, adapter, quantization,
           duration_ms, status)
         values ('embedding', 'local', 'synthetic-256', 'gguf', 'node-llama-cpp', 'Q8_0', 1, 'succeeded')`
      );
      return { embedded: true };
    }
  } as unknown as KnowledgeService;
}

async function startSidecar(workDir: string) {
  for (let attempt = 1; ; attempt += 1) {
    const manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, `database-${attempt}`),
      database: "memora_corpus_runner_test",
      user: "memora_corpus_runner_test",
      password: `corpus-runner-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    try {
      return { manager, connection: await manager.start() };
    } catch (error) {
      await manager.stop().catch(() => undefined);
      if (attempt >= 3) throw error;
    }
  }
}

describe.skipIf(!sidecarAvailable)("the ENV-C corpus runner on the PostgreSQL sidecar", () => {
  let workDir = "";
  let workspace = "";
  let profile = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  let services: TopicTreeServices;
  const supervisors: JobSupervisor[] = [];
  const pools: PgPool[] = [];
  const quits: string[] = [];

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    MEMORA_WORKSPACE_ROOT: workspace,
    MEMORA_USER_DATA_DIR: profile,
    MEMORA_TOPIC_CORPUS: "1",
    MEMORA_AI_CASSETTE: "replay",
    ...extra
  });

  async function count(sql: string, values: unknown[] = [], on: PgPool = pool): Promise<number> {
    const result = await on.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  /** A second database of the cluster, migrated, with its own services and job supervisor. */
  async function freshInstance(name: string) {
    await pool.query(`create database ${name}`);
    const url = new URL(connection.connectionString);
    url.pathname = `/${name}`;
    const own = createPgPool({ connectionString: url.toString(), max: 4 });
    pools.push(own);
    await runMigrations(own, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    const instance = createTopicTreeServices({
      getPool: () => own,
      spaceResolver: createStoredVectorSpaceResolver(() => own),
      env: {},
      isPackaged: false,
      logger: quiet,
      budgetStore: { read: async () => null, write: async () => undefined }
    });
    const supervisor = new JobSupervisor({
      getPool: () => own,
      knowledgeService: knowledgeStub(() => own),
      lightJobs: instance.jobs,
      pollIntervalMs: 20,
      logger: quiet
    });
    supervisors.push(supervisor);
    return { pool: own, services: instance, supervisor };
  }

  function runner(
    extra: Record<string, string>,
    options: {
      on?: { pool: PgPool; services: TopicTreeServices };
      sleep?: (ms: number) => Promise<void>;
    } = {}
  ): CorpusRunner {
    const target = options.on ?? { pool, services };
    const config = readCorpusConfig(env(extra), { isPackaged: false, workspaceRoot: workspace });
    return new CorpusRunner({
      config: config as CorpusConfig,
      getPool: () => target.pool,
      service: target.services.service,
      triggers: target.services.triggers,
      spaceResolver: createStoredVectorSpaceResolver(() => target.pool),
      logger: quiet,
      pollIntervalMs: 20,
      quit: () => {
        quits.push("quit");
      },
      // The factory's own run writes to the default folder; these runs keep their summaries apart.
      summaryDirectory: join(workDir, "other-runs"),
      ...(options.sleep ? { sleep: options.sleep } : {})
    });
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-corpus-runner-"));
    workspace = join(workDir, "workspace");
    profile = join(workspace, ".cache", "profiles", "env-c");
    await mkdir(join(profile, "database"), { recursive: true });
    await writeFile(
      join(profile, "database", "dev-connection.json"),
      JSON.stringify({ developmentOnly: true })
    );
    await writeFile(
      join(profile, "profile.json"),
      JSON.stringify({ format: "memora-measurement-profile", version: 1, kind: "env-c" })
    );
    await writeFixtureCorpus(join(workspace, ".cache", "corpus"));
    await writeFile(join(workDir, "held.json"), JSON.stringify(["pt:Contraponto"]));

    ({ manager, connection } = await startSidecar(workDir));
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    pools.push(pool);
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: createStoredVectorSpaceResolver(() => pool),
      env: {},
      isPackaged: false,
      logger: quiet,
      budgetStore: { read: async () => null, write: async () => undefined }
    });
  }, 120_000);

  afterAll(async () => {
    for (const supervisor of supervisors) await supervisor.stop().catch(() => undefined);
    services?.dispose();
    for (const own of pools) await closePgPool(own).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("refuses a profile that is not an env-c measurement profile, before touching the library", async () => {
    // Outside .cache/profiles: the owner's own profile can never be seeded.
    const result = await runner({ MEMORA_USER_DATA_DIR: join(workDir, "owner-profile") }).run();
    expect(result).toMatchObject({ outcome: "refused" });
    expect(result.reason).toMatch(/^outsideProfiles:/u);
    expect(quits).toHaveLength(1);

    // A profile of another kind (ENV-G) is refused, a profile with no DEV database too.
    const other = join(workspace, ".cache", "profiles", "env-g");
    await mkdir(join(other, "database"), { recursive: true });
    await writeFile(
      join(other, "database", "dev-connection.json"),
      JSON.stringify({ developmentOnly: true })
    );
    await writeFile(
      join(other, "profile.json"),
      JSON.stringify({ format: "memora-measurement-profile", version: 1, kind: "env-g" })
    );
    expect((await runner({ MEMORA_USER_DATA_DIR: other }).run()).reason).toMatch(
      /^notEnvCProfile:/u
    );
    const bare = join(workspace, ".cache", "profiles", "bare");
    await mkdir(bare, { recursive: true });
    expect((await runner({ MEMORA_USER_DATA_DIR: bare }).run()).reason).toMatch(
      /^notDevelopmentDatabase:/u
    );

    // A build or arrive start on a library that was never seeded.
    expect((await runner({ MEMORA_TOPIC_CORPUS_STAGE: "build" }).run()).reason).toMatch(
      /^notSeeded:/u
    );
    expect(await count("select count(*) from source_items")).toBe(0);
  });

  it("refuses to fill a library next to a synchronizing Obsidian vault", async () => {
    await pool.query(
      `insert into storage_settings (id, obsidian_vault_path, obsidian_managed_root, obsidian_sync_enabled)
       values ('default', $1, 'Memora', true)
       on conflict (id) do update set obsidian_vault_path = excluded.obsidian_vault_path,
         obsidian_sync_enabled = true`,
      [join(workDir, "vault")]
    );
    try {
      const result = await runner({ MEMORA_TOPIC_CORPUS_STAGE: "seed" }).run();
      expect(result.reason).toMatch(/^vaultSynchronizing:/u);
      expect(await count("select count(*) from source_items")).toBe(0);
    } finally {
      await pool.query("delete from storage_settings where id = 'default'");
    }
  });

  it("starts through the factory with the barrier up, then seeds, embeds, builds and takes an arrival", async () => {
    const summaryDirectory = join(workspace, ".cache", "topics", "corpus-runs");
    const started = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: createStoredVectorSpaceResolver(() => pool),
      env: env({ MEMORA_TOPIC_CORPUS_HOLDOUT: `file:${join(workDir, "held.json")}` }),
      isPackaged: false,
      logger: quiet,
      budgetStore: { read: async () => null, write: async () => undefined }
    });
    await started.start();
    // `start()` returned before any job could run: the topic jobs are already held.
    expect(started.service.isHeld()).toBe(true);
    // The job supervisor starts afterwards, as in main/index.ts, with this factory's light lane.
    const supervisor = new JobSupervisor({
      getPool: () => pool,
      knowledgeService: knowledgeStub(() => pool),
      lightJobs: started.jobs,
      pollIntervalMs: 20,
      logger: quiet
    });
    supervisors.push(supervisor);
    await supervisor.start();
    services = started;

    // The run ends on its own; its summary file is the record.
    let summaryPath: string | null = null;
    for (let attempt = 0; attempt < 600 && summaryPath === null; attempt += 1) {
      const files = await readdir(summaryDirectory).catch(() => [] as string[]);
      const done = files.find((file) => file.endsWith(".json"));
      if (done) summaryPath = join(summaryDirectory, done);
      else await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    expect(summaryPath).not.toBeNull();
    const summary = JSON.parse(await readFile(summaryPath!, "utf8")) as CorpusRunSummary;

    expect(summary).toMatchObject({
      format: "memora-topic-corpus-run",
      outcome: "completed",
      reason: null,
      corpus: { name: "Test corpus", articles: 4, notes: 12 },
      seed: { articles: 3, notes: 10, chunks: 10, held: 1 },
      embedding: { notes: 10, failedJobs: 0, spaceCheck: "same" },
      topicJobsLeftHeld: false
    });
    expect(summary.embedding?.space).toMatchObject({ spaceKey, dimensions: dim });
    // The audit says which route embedded the notes (GGUF here) and how many calls it took.
    expect(summary.embedding?.routes).toEqual([
      {
        provider: "local",
        model: "synthetic-256",
        runtime: "gguf",
        adapter: "node-llama-cpp",
        quantization: "Q8_0",
        calls: 10
      }
    ]);
    expect(summary.build).not.toBeNull();
    expect(summary.arrivals).toHaveLength(1);
    expect(summary.arrivals[0]).toMatchObject({ article: "pt:Contraponto", notes: 2 });
    expect(summary.ai).toMatchObject({ cassette: "replay", liveTokens: 0, remoteCalls: 0 });
    // The seed and embedding times are recorded (the proof asks for them).
    expect(summary.seed!.ms).toBeGreaterThanOrEqual(0);
    expect(summary.embedding!.ms).toBeGreaterThan(0);
    expect(started.service.isHeld()).toBe(false);

    // The barrier (D23): no topic job ran before the base notes all had their vectors.
    const order = await pool.query<{ firstTopic: Date; lastEmbedding: Date }>(
      `select (select min(finished_at) from jobs where type::text like 'topic-%') as "firstTopic",
              (select max(finished_at) from (
                 select finished_at from jobs where type::text = 'note-embedding'
                 order by created_at, id limit 10) base) as "lastEmbedding"`
    );
    expect(order.rows[0]!.firstTopic.getTime()).toBeGreaterThan(
      order.rows[0]!.lastEmbedding.getTime()
    );

    // The library: four roots with attribution, a document each, one chunk and note per piece.
    expect(
      await count("select count(*) from source_items where parent_source_item_id is null")
    ).toBe(4);
    expect(await count("select count(*) from documents")).toBe(4);
    expect(await count("select count(*) from chunks")).toBe(12);
    expect(await count("select count(*) from atomic_notes where status = 'active'")).toBe(12);
    expect(
      await count("select count(*) from embeddings_256 where target_type = 'atomic_note'")
    ).toBe(12);
    const root = await pool.query<{
      source_uri: string;
      external_id: string;
      language: string;
      metadata: { corpus: Record<string, unknown> };
    }>(
      "select source_uri, external_id, language, metadata from source_items where title = 'Photosynthesis'"
    );
    expect(root.rows[0]).toMatchObject({
      source_uri: "https://en.wikipedia.org/w/index.php?title=Photosynthesis&oldid=1379238357",
      external_id: "wikipedia:en:24544",
      language: "en"
    });
    expect(root.rows[0]!.metadata.corpus).toMatchObject({
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      pageId: 24544,
      revisionId: 1379238357
    });
    expect(String(root.rows[0]!.metadata.corpus.attribution)).toContain("revision 1379238357");
    // Notes use the notitle title (empty for an introduction), idea and body of the corpus.
    const titles = await pool.query<{ title: string }>(
      `select a.title from atomic_notes a join source_items s on s.id = a.created_from_source_item_id
       where s.title = 'Photosynthesis'`
    );
    expect(titles.rows.map((row) => row.title).sort()).toEqual(
      ["", "Calvin cycle", "Evolution", "Light reactions"].sort()
    );
    expect(
      await count(
        `select count(*) from atomic_notes a join chunks c on c.id = a.evidence_chunk_id
         where a.ownership = 'source' and c.source_item_id = a.created_from_source_item_id`
      )
    ).toBe(12);
    // The arrival came after the base: its root is the newest source.
    const newest = await pool.query<{ title: string }>(
      "select title from source_items where parent_source_item_id is null order by created_at desc limit 1"
    );
    expect(newest.rows[0]!.title).toBe("Contraponto");

    // The marker records where the library stands.
    const marker =
      await createSettingsRepository(pool).get<Record<string, unknown>>(corpusMarkerSettingKey);
    expect(marker).toMatchObject({
      corpus: "Test corpus",
      notes: 10,
      held: ["pt:Contraponto"],
      arrived: ["pt:Contraponto"]
    });
    expect(marker?.embeddedAt).not.toBeNull();
    expect(marker?.builtAt).not.toBeNull();
    // The sweep created the tree in the vectors' space (D39).
    expect(await createTopicTreeRepository(pool).activeTree()).toMatchObject({
      spaceKey,
      dimensions: dim
    });
  }, 120_000);

  it("is refused on a library that is not empty, and says so", async () => {
    const result = await runner({ MEMORA_TOPIC_CORPUS_STAGE: "seed" }).run();
    expect(result.outcome).toBe("refused");
    expect(result.reason).toMatch(/^libraryNotEmpty:.*already seeded/u);
    expect(
      await count("select count(*) from source_items where parent_source_item_id is null")
    ).toBe(4);
  });

  it("stops at the live token cap and leaves the topic jobs held", async () => {
    // Calls before the run, and cassette replays, are not live tokens of this run.
    await pool.query(
      `insert into ai_task_runs (task_type, provider, model_id, runtime, input_tokens, output_tokens,
         duration_ms, status, adapter, started_at)
       values ('structured-output', 'openai-codex', 'gpt', 'remote', 90000, 30000, 10, 'succeeded',
               'openai-codex', now() - interval '1 hour'),
              ('structured-output', 'openai-codex', 'gpt', 'remote', 5000, 5000, 10, 'succeeded',
               'cassette-replay', now())`
    );
    let polls = 0;
    const capped = runner(
      {
        MEMORA_TOPIC_CORPUS_STAGE: "build",
        MEMORA_AI_CASSETTE: "record",
        MEMORA_TOPIC_CORPUS_MAX_TOKENS: "1000"
      },
      {
        // The naming job would make this call while the lane drains: 1,200 live tokens.
        sleep: async () => {
          polls += 1;
          if (polls === 1)
            await pool.query(
              `insert into ai_task_runs (task_type, provider, model_id, runtime, input_tokens,
                 output_tokens, duration_ms, status, adapter)
               values ('structured-output', 'openai-codex', 'gpt', 'remote', 900, 300, 10, 'succeeded',
                       'openai-codex')`
            );
        }
      }
    );
    const result = await capped.run();
    expect(result.outcome).toBe("token_limit");
    expect(result.reason).toMatch(/token cap/u);
    expect(result.ai).toMatchObject({
      cassette: "record",
      maxTokens: 1000,
      liveTokens: 1200,
      remoteCalls: 1
    });
    expect(result.topicJobsLeftHeld).toBe(true);
    expect(services.service.isHeld()).toBe(true);
  }, 60_000);

  it("runs the stages in separate starts: a seed-only start leaves the topic jobs held for the next", async () => {
    const second = await freshInstance("memora_corpus_runner_staged");
    await second.supervisor.start();
    const on = { pool: second.pool, services: second.services };
    const succeededTopicJobs = () =>
      count(
        "select count(*) from jobs where type::text like 'topic-%' and status = 'succeeded'",
        [],
        second.pool
      );

    // Start 1 (cassette off: the seed stage makes no topic AI call): seed and embed only.
    second.services.holdTopicJobs();
    const seeded = await runner(
      {
        MEMORA_TOPIC_CORPUS_STAGE: "seed",
        MEMORA_AI_CASSETTE: "off",
        MEMORA_TOPIC_CORPUS_HOLDOUT: `file:${join(workDir, "held.json")}`
      },
      { on }
    ).run();
    expect(seeded).toMatchObject({
      outcome: "completed",
      stages: ["seed"],
      seed: { articles: 3, notes: 10 },
      embedding: { notes: 10, spaceCheck: "same" },
      build: null,
      topicJobsLeftHeld: true
    });
    expect(second.services.service.isHeld()).toBe(true);
    // No tree, no topic work: the notes wait for the one bootstrap build.
    expect(await createTopicTreeRepository(second.pool).activeTree()).toBeNull();
    expect(await succeededTopicJobs()).toBe(0);
    const afterSeed = await createSettingsRepository(second.pool).get<{ builtAt: string | null }>(
      corpusMarkerSettingKey
    );
    expect(afterSeed?.builtAt).toBeNull();

    // Start 2 (a new session, the cassette now on): build, then the held-out article arrives.
    const built = await runner({ MEMORA_TOPIC_CORPUS_STAGE: "build,arrive" }, { on }).run();
    expect(built).toMatchObject({ outcome: "completed", stages: ["build", "arrive"] });
    expect(built.build).not.toBeNull();
    expect(built.arrivals.map((arrival) => arrival.article)).toEqual(["pt:Contraponto"]);
    expect(built.topicJobsLeftHeld).toBe(false);
    expect(await createTopicTreeRepository(second.pool).activeTree()).not.toBeNull();
    expect(await count("select count(*) from atomic_notes", [], second.pool)).toBe(12);

    // Start 3: nothing is left to arrive, and a second seed is refused.
    const again = await runner({ MEMORA_TOPIC_CORPUS_STAGE: "arrive" }, { on }).run();
    expect(again).toMatchObject({ outcome: "completed", arrivals: [] });
    const reseed = await runner(
      { MEMORA_TOPIC_CORPUS_STAGE: "seed", MEMORA_AI_CASSETTE: "off" },
      { on }
    ).run();
    expect(reseed.outcome).toBe("refused");
  }, 120_000);

  it("queues the embedding jobs again for notes whose jobs were lost, and fails when it cannot", async () => {
    const third = await freshInstance("memora_corpus_runner_requeue");
    const on = { pool: third.pool, services: third.services };
    // The supervisor is not running: a lost job (here, every one) leaves the notes without vectors.
    let polls = 0;
    const lost = runner(
      { MEMORA_TOPIC_CORPUS_STAGE: "seed", MEMORA_AI_CASSETTE: "off" },
      {
        on,
        sleep: async () => {
          polls += 1;
          if (polls === 1) {
            await third.pool.query("delete from jobs where type = 'note-embedding'");
            // The route comes back: the jobs queued again are served.
            await third.supervisor.start();
          }
        }
      }
    );
    const recovered = await lost.run();
    expect(recovered).toMatchObject({ outcome: "completed" });
    expect(recovered.embedding?.requeued).toBeGreaterThan(0);
    expect(recovered.embedding?.notes).toBe(12);
    expect(await count("select count(*) from embeddings_256", [], third.pool)).toBe(12);
    await third.supervisor.stop();

    // With no route at all, the second round gives up and says what is wrong.
    const fourth = await freshInstance("memora_corpus_runner_noroute");
    const broken = await runner(
      { MEMORA_TOPIC_CORPUS_STAGE: "seed", MEMORA_AI_CASSETTE: "off" },
      {
        on: { pool: fourth.pool, services: fourth.services },
        sleep: async () => {
          await fourth.pool.query("delete from jobs where type = 'note-embedding'");
        }
      }
    ).run();
    expect(broken.outcome).toBe("failed");
    expect(broken.reason).toMatch(/12 notes have no vector and no note-embedding job is left/u);
    expect(broken.topicJobsLeftHeld).toBe(true);
  }, 120_000);
});
