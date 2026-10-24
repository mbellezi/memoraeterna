import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createLocalModelRepository,
  createPgPool,
  createSettingsRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import {
  defaultPriceTable,
  presetCatalogIds,
  relationsDecisionsSettingKey,
  type BudgetSnapshot
} from "@app/domain";

import { createSoakHooks } from "./soak-hooks.js";
import { createMoneyPort, moneyProviderName, soakPriceTable } from "./soak-money.js";
import { plannedEntryTokens } from "./soak-budget.js";
import {
  pickEditableNoteInRoot,
  pickNotesToReembed,
  pickTopicToOpen,
  readFinishedJobs,
  readJobs,
  readLockWaits,
  readOutcomeChanges,
  readTaskRuns
} from "./soak-queries.js";
import { decisionsOptInProblem, realWriterProblems } from "./soak-real-writer.js";
import {
  MemoryEventSink,
  jobDoneSchema,
  outcomeSchema,
  taskRunRecordSchema
} from "./soak-records.js";
import { findRealRemoteReach } from "./soak-routes.js";
import { prepareSoak } from "./soak-startup.js";

// The F4 harness's SQL and writes on a real PostgreSQL database with the product's schema (T89):
// the ledgers the report is computed from, the topic and note pickers, the real-writer checks, the
// two DEV hooks and the money window's routes and queue.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("the F4 soak harness on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-soak-f4-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_soak_f4_test",
        user: "memora_soak_f4_test",
        password: `soak-f4-${randomUUID()}`,
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
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query("delete from jobs");
    await pool.query("delete from gardener_outcomes");
    await pool.query("delete from topic_placements");
    await pool.query("delete from topics where parent_id is not null");
    await pool.query("delete from topics");
    await pool.query("delete from topic_trees");
    await pool.query("delete from atomic_note_relations");
    await pool.query("delete from atomic_notes");
    await pool.query("delete from source_items");
    await pool.query("delete from ai_task_runs");
    await pool.query("delete from ai_task_profile_routes");
    await pool.query("delete from ai_profile_tasks");
    await pool.query("delete from ai_profile_sets");
    await pool.query("delete from ai_provider_configs");
    await pool.query("delete from local_models");
    await pool.query("delete from settings where key like 'relations.%' or key like 'ai.%'");
  });

  const seedNote = async (title: string, rootId?: string) => {
    const sourceId = rootId ?? randomUUID();
    if (!rootId)
      await pool.query(
        `insert into source_items (id, type, title) values ($1, 'PersonalNote', $2)`,
        [sourceId, title]
      );
    const documentId = randomUUID();
    const chunkId = randomUUID();
    const id = randomUUID();
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, 'active', 'current', 'source', $5, $5, $6, 'seed', 'seed', 'local', 'seed', $7)`,
      [id, title, `${title} body.`, `${title} idea.`, sourceId, chunkId, `key-${id}`]
    );
    return { id, sourceId };
  };

  it("reads the token columns, the budget class and the job of an audit row", async () => {
    const job = randomUUID();
    await pool.query(
      `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, started_at,
         finished_at, lane, workload_class, priority, deadline_ms, deadline_outcome, is_repair,
         input_tokens, output_tokens, budget_class, job_id, budget_estimate_usd)
       values ('text-generation', 'openai-codex', 'gpt-5.6-luna', 'remote', 900, 'succeeded',
         now() - interval '2 seconds', now() - interval '1 second', 'remote:abc', 'write-fast', 3, 120000,
         'met', false, 5400, 700, 'background', $1::uuid, 0.0123),
        ('text-generation', 'local-mlx', 'writer', 'local', 90, 'succeeded', now() - interval '3 seconds',
         now() - interval '2 seconds', 'local', 'write-fast', 3, 120000, 'met', false, null, null, null, null, null)`,
      [job]
    );
    const rows = await readTaskRuns(pool, Date.now() - 60_000);
    for (const row of rows) taskRunRecordSchema.parse(row);
    expect(
      rows.map((row) => [row.lane, row.inputTokens, row.outputTokens, row.budgetClass])
    ).toEqual([
      ["local", null, null, null],
      ["remote:abc", 5400, 700, "background"]
    ]);
    expect(rows[1]).toMatchObject({ jobId: job, budgetEstimateUsd: 0.0123 });
  });

  it("reads the jobs that ended and the outcome rows that changed, for E2 and E3", async () => {
    await pool.query(
      `insert into jobs (type, status, lane, payload, attempts, scope_key, subject_key, outcome,
         finished_at, created_at, result)
       values ('topic-name', 'succeeded', 'light', '{}'::jsonb, 1, 'tree:t:names', 'tree:t', 'done',
               now(), now() - interval '5 minutes', '{"status":"named"}'::jsonb),
              ('relation-link', 'succeeded', 'light', '{}'::jsonb, 1, null, null, null, now(),
               now() - interval '9 minutes', '{"status":"judged"}'::jsonb),
              ('topic-audit', 'failed', 'light', '{}'::jsonb, 3, null, 'tree:t', null, now(),
               now() - interval '2 minutes', null),
              ('topic-place', 'queued', 'light', '{}'::jsonb, 0, null, null, null, null, now(), null)`
    );
    await pool.query(`update jobs set quarantined_at = now() where type = 'topic-audit'`);
    const done = await readFinishedJobs(pool, Date.now() - 60_000);
    expect(done.map((job) => [job.jobType, job.status, job.outcome, job.resultStatus])).toEqual(
      expect.arrayContaining([
        ["topic-name", "succeeded", "done", "named"],
        ["relation-link", "succeeded", null, "judged"],
        ["topic-audit", "failed", null, null]
      ])
    );
    expect(done).toHaveLength(3);
    for (const job of done) jobDoneSchema.parse(job);
    expect(done.find((job) => job.jobType === "topic-audit")?.quarantinedAt).not.toBeNull();
    expect(done.map((job) => job.cancelCause)).toEqual([null, null, null]);
    expect(await readFinishedJobs(pool, Date.now() + 60_000)).toEqual([]);

    // Why a job was canceled (E3 counts a supersession only): merged, its source gone, or asked.
    await pool.query(
      `insert into jobs (type, status, lane, payload, attempts, finished_at, created_at, result)
       values ('topic-overview', 'canceled', 'light', '{}'::jsonb, 0, now(), now(),
               '{"mergedInto":"00000000-0000-4000-8000-000000000001"}'::jsonb),
              ('relation-link', 'canceled', 'light',
               '{"sourceItemId":"00000000-0000-4000-8000-0000000000ff"}'::jsonb, 0, now(), now(), null),
              ('topic-name', 'canceled', 'light', '{}'::jsonb, 0, now(), now(), null)`
    );
    const causes = Object.fromEntries(
      (await readFinishedJobs(pool, Date.now() - 60_000))
        .filter((job) => job.status === "canceled")
        .map((job) => [job.jobType, job.cancelCause])
    );
    expect(causes).toEqual({
      "topic-overview": "merged",
      "relation-link": "source_deleted",
      "topic-name": "requested"
    });

    await pool.query(
      `insert into gardener_outcomes (kind, subject_key, last_outcome, last_fingerprint,
         failed_fingerprint, consecutive_failures, last_error_class, quarantined_at)
       values ('topic-audit', 'tree:t', 'failed', 'a', 'a', 2, 'error:x', now())`
    );
    const outcomes = await readOutcomeChanges(pool, Date.now() - 60_000);
    expect(outcomes).toHaveLength(1);
    outcomeSchema.parse(outcomes[0]);
    expect(outcomes[0]).toMatchObject({ kind: "topic-audit", consecutiveFailures: 2 });
  });

  it("reads the created time of a queued job and the locks being waited on", async () => {
    await pool.query(
      `insert into jobs (type, status, lane) values ('topic-place', 'queued', 'light')`
    );
    const { jobs } = await readJobs(pool);
    expect(jobs[0]!.createdAt).toBeGreaterThan(0);
    expect(await readLockWaits(pool)).toEqual({ waiting: 0, longestMs: 0 });
  });

  it("picks six notes in six roots for the burst's edits, a root by its position, wrapping around", async () => {
    const roots = [];
    for (let index = 0; index < 3; index += 1) roots.push(await seedNote(`Root ${index}`));
    const picks = [0, 1, 2, 3].map((position) => pickEditableNoteInRoot(pool, 7, 0, position));
    const notes = await Promise.all(picks);
    expect(notes.every((note) => note !== null)).toBe(true);
    const sources = notes.map((note) => note!.id);
    // Three distinct roots, and the fourth position wraps to the first.
    expect(new Set(sources.slice(0, 3)).size).toBe(3);
    expect(sources[3]).toBe(sources[0]);
    // A second note of a root never hides another root.
    await seedNote("Second of root 0", roots[0]!.sourceId);
    const again = await Promise.all(
      [0, 1, 2].map((position) => pickEditableNoteInRoot(pool, 7, 0, position))
    );
    expect(new Set(again.map((note) => note!.id)).size).toBe(3);
  });

  it("picks the notes to embed again with their sources", async () => {
    const note = await seedNote("Reembed me");
    expect(await pickNotesToReembed(pool, 1, 0, 5)).toEqual([
      { atomicNoteId: note.id, sourceItemId: note.sourceId }
    ]);
  });

  it("picks a placed topic of the active tree with enough notes, and none without a tree", async () => {
    expect(await pickTopicToOpen(pool, 1, 0)).toBeNull();
    const tree = randomUUID();
    const root = randomUUID();
    const topic = randomUUID();
    await pool.query(
      `insert into topic_trees (id, status, space_key, embedding_provider, embedding_model,
         embedding_runtime, dimensions, config, config_hash, seed, activated_at)
       values ($1, 'active', 'space', 'p', 'm', 'r', 256, '{}'::jsonb, 'h', 1, now())`,
      [tree]
    );
    await pool.query(
      `insert into topics (id, tree_id, parent_id, role, title, name_state, name_source, management)
       values ($1, $3, null, 'root', null, 'unnamed', null, 'human'),
              ($2, $3, $1, 'topic', 'Memory', 'named', 'human', 'human')`,
      [root, topic, tree]
    );
    expect(await pickTopicToOpen(pool, 1, 0)).toBeNull();
    for (let index = 0; index < 3; index += 1) {
      const note = await seedNote(`Placed ${index}`);
      await pool.query(
        `insert into topic_placements (tree_id, item_kind, note_id, topic_id, role, rank, decided_by)
         values ($1, 'note', $2, $3, 'primary', 0, 'build')`,
        [tree, note.id, topic]
      );
    }
    expect(await pickTopicToOpen(pool, 1, 0)).toEqual({
      id: topic,
      title: "Memory",
      hasOverview: false
    });
  });

  describe("the real writer", () => {
    async function codexConfig(provider = "openai-codex", withCredential = true) {
      return createAiConfigRepository(pool).upsertProvider({
        provider: provider as "openai-codex",
        displayName: `${provider} writer`,
        ...(withCredential ? { credentialRef: "ai:real" } : {}),
        baseUrl: "https://chatgpt.com/backend-api/codex",
        metadata: {
          modelId: "gpt-5.6-luna",
          capabilities: ["text-generation", "structured-output"]
        }
      });
    }

    it("admits a Codex configuration with a sign-in, and names the problem of any other", async () => {
      const codex = await codexConfig();
      expect(await realWriterProblems(pool, { providerConfigId: codex.id })).toEqual([]);
      expect(await realWriterProblems(pool, { providerConfigId: randomUUID() })).toEqual([
        expect.stringContaining("names no provider configuration")
      ]);
      const compatible = await createAiConfigRepository(pool).upsertProvider({
        provider: "openai-compatible",
        displayName: "An API key provider",
        credentialRef: "ai:key",
        baseUrl: "https://api.openai.com/v1",
        metadata: { modelId: "gpt-5", capabilities: ["text-generation"] }
      });
      expect(
        (await realWriterProblems(pool, { providerConfigId: compatible.id })).join(" ")
      ).toContain("only a Codex (ChatGPT OAuth) one is admitted");
      const signedOut = await codexConfig("openai-codex", false);
      expect(await realWriterProblems(pool, { providerConfigId: signedOut.id })).toEqual(
        expect.arrayContaining([expect.stringContaining("holds no sign-in")])
      );
    });

    it("lets the reach check through for exactly the writer's configuration and refuses every other real provider", async () => {
      const repository = createAiConfigRepository(pool);
      const codex = await codexConfig();
      const other = await repository.upsertProvider({
        provider: "openai-compatible",
        displayName: "Another real provider",
        credentialRef: "ai:other",
        baseUrl: "https://api.openai.com/v1",
        metadata: { modelId: "gpt-5", capabilities: ["text-generation", "structured-output"] }
      });
      const profileOf = async (name: string, configId: string, isDefault: boolean) => {
        const profile = await repository.createProfile({
          name,
          isDefault,
          privacyMode: "allow_remote",
          outputLanguage: "ui"
        });
        await repository.updateProfile({
          id: profile.id,
          providerConfigId: configId,
          modelId: "m",
          runtime: "remote",
          capabilities: ["text-generation", "structured-output"]
        });
        return profile.id;
      };
      const writer = await profileOf("Codex writer", codex.id, true);
      const stray = await profileOf("Stray", other.id, false);
      await repository.setProfileTask({ profileId: writer, task: "class:write-fast" });
      await repository.setTaskRoute("class:write-fast", writer);
      // Only the writer's configuration is reachable: allowed.
      expect((await findRealRemoteReach(pool, [codex.id])).reachable).toEqual([]);
      // A second real provider on a route is still refused, the writer allowed or not.
      await repository.setProfileTask({ profileId: stray, task: "class:answer" });
      await repository.setTaskRoute("class:answer", stray);
      const reach = await findRealRemoteReach(pool, [codex.id]);
      expect(reach.reachable).toEqual([expect.stringContaining("Stray (openai-compatible)")]);
      expect((await findRealRemoteReach(pool, [])).reachable).toHaveLength(2);
    });

    it("refuses a library whose Decisions opt-in is on, unless the run admits it", async () => {
      expect(await decisionsOptInProblem(pool, false)).toBeNull();
      await createSettingsRepository(pool).set(relationsDecisionsSettingKey, { enabled: true });
      expect(await decisionsOptInProblem(pool, false)).toContain("Decisions decider switched on");
      expect(await decisionsOptInProblem(pool, true)).toBeNull();
    });
  });

  describe("the two DEV hooks", () => {
    async function installModels() {
      const models = createLocalModelRepository(pool);
      const install = async (
        catalogId: string,
        runtime: "gguf" | "mlx",
        capabilities: string[]
      ) => {
        const model = await models.upsertModel({
          catalogId,
          modelId: catalogId,
          displayName: `${catalogId} model`,
          family: "test",
          variant: "test",
          repository: "test/test",
          revision: "0".repeat(40),
          runtime,
          format: runtime === "mlx" ? "safetensors" : "gguf",
          quantization: "4-bit",
          expectedSizeBytes: 1_000,
          manifestHash: "hash",
          capabilities,
          licenseName: "MIT",
          licenseUrl: "https://example.test/license"
        });
        await models.updateModel(model.id, {
          status: "ready",
          metadata: capabilities.includes("reranking")
            ? { decideValidation: { runtimeBuild: "build-1", validatedAt: "2026-10-01T00:00:00Z" } }
            : {}
        });
        return model.id;
      };
      const embedder = await install(presetCatalogIds.embedding, "gguf", ["embedding", "offline"]);
      const ranker = await install(presetCatalogIds.rankerMlx, "mlx", ["reranking", "offline"]);
      const repository = createAiConfigRepository(pool);
      const profile = await repository.createProfile({
        name: "Ranker",
        privacyMode: "offline_only",
        outputLanguage: "ui"
      });
      await repository.updateProfile({
        id: profile.id,
        modelId: presetCatalogIds.rankerMlx,
        capabilities: ["reranking", "offline"],
        localModelId: ranker,
        runtime: "mlx"
      });
      return { embedder, ranker, profile: profile.id };
    }

    it("takes a ranker's validation and capability away and puts them back, the profile's included", async () => {
      const { ranker, profile } = await installModels();
      const hooks = createSoakHooks({ pool, logger: { info: vi.fn(), error: vi.fn() } });
      await hooks.invalidateRanker();
      const invalid = (
        await pool.query<{ metadata: Record<string, unknown>; capabilities: string[] }>(
          "select metadata, capabilities from local_models where id = $1",
          [ranker]
        )
      ).rows[0]!;
      expect(invalid.metadata).not.toHaveProperty("decideValidation");
      expect(invalid.capabilities).not.toContain("reranking");
      expect(
        (
          await pool.query<{ capabilities: string[] }>(
            "select capabilities from ai_profile_sets where id = $1",
            [profile]
          )
        ).rows[0]!.capabilities
      ).toEqual(["offline"]);
      // A second call while invalid does nothing more.
      await hooks.invalidateRanker();
      await hooks.restoreRanker();
      const restored = (
        await pool.query<{
          metadata: { decideValidation?: { runtimeBuild: string } };
          capabilities: string[];
        }>("select metadata, capabilities from local_models where id = $1", [ranker])
      ).rows[0]!;
      expect(restored.metadata.decideValidation?.runtimeBuild).toBe("build-1");
      expect(restored.capabilities).toContain("reranking");
      expect(
        (
          await pool.query<{ capabilities: string[] }>(
            "select capabilities from ai_profile_sets where id = $1",
            [profile]
          )
        ).rows[0]!.capabilities
      ).toEqual(["reranking", "offline"]);
    });

    it("refuses to invalidate a ranker that is not installed", async () => {
      const hooks = createSoakHooks({ pool });
      await expect(hooks.invalidateRanker()).rejects.toThrow(/no validated ranker/u);
    });

    it("marks the embedder verifying, announces it, and restores its status", async () => {
      const { embedder } = await installModels();
      const published: unknown[] = [];
      const hooks = createSoakHooks({
        pool,
        publishModelDownload: (event) => published.push(event)
      });
      await hooks.markEmbedderVerifying();
      expect(
        (
          await pool.query<{ status: string }>("select status from local_models where id = $1", [
            embedder
          ])
        ).rows[0]!.status
      ).toBe("verifying");
      await hooks.clearEmbedderVerifying();
      expect(
        (
          await pool.query<{ status: string }>("select status from local_models where id = $1", [
            embedder
          ])
        ).rows[0]!.status
      ).toBe("ready");
      expect(published).toEqual([
        expect.objectContaining({
          type: "model.download",
          status: "verifying",
          catalogId: presetCatalogIds.embedding
        }),
        expect.objectContaining({ type: "model.download", status: "ready" })
      ]);
    });
  });

  describe("the money window", () => {
    const snapshot = (state: "open" | "paused" | "exhausted", spentUsd = 0.3): BudgetSnapshot =>
      ({
        month: "2026-11",
        day: "2026-11-01",
        money: {
          spentUsd,
          reservedUsd: 0,
          capUsd: 5,
          pauseShare: 0.8,
          continued: false,
          state,
          priceTableVersion: "v"
        },
        calls: { usedCalls: 0, reservedCalls: 0, capCalls: 800, state: "open" }
      }) as BudgetSnapshot;

    it("prices the fake's model like a paid route in the soak's copy of the price table", () => {
      const table = soakPriceTable(
        defaultPriceTable,
        { model: "dev-fake-priced-1", inputUsdPerM: 1, outputUsdPerM: 4, latencyMs: 10 },
        "2026-10-28"
      );
      expect(table.version).toBe(`${defaultPriceTable.version}+soak-money`);
      expect(table.entries.at(-1)).toMatchObject({
        provider: "openai-compatible",
        model: "dev-fake-priced-1",
        billing: "per_token",
        outputUsdPerM: 4
      });
      expect(defaultPriceTable.entries.some((entry) => entry.model === "dev-fake-priced-1")).toBe(
        false
      );
      expect(
        plannedEntryTokens(
          { kind: "explain_burst" },
          {
            article: 1,
            typing_fault: 1,
            source_reimport: 1,
            ask: 1,
            explain: 1,
            explain_burst: 5,
            topic_open: 1,
            note_edit: 1,
            burst_edit: 1,
            contention_burst: 0,
            backgroundPerHour: 1
          }
        )
      ).toBe(5);
    });

    it("routes the explanation to the fake and puts the old route back, and queues the pass as the product queues one", async () => {
      const repository = createAiConfigRepository(pool);
      const codex = await repository.upsertProvider({
        provider: "openai-codex",
        displayName: "Codex",
        credentialRef: "ai:real",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        metadata: { modelId: "gpt-5.6-luna", capabilities: ["text-generation"] }
      });
      const profile = await repository.createProfile({
        name: "Writer",
        privacyMode: "allow_remote",
        outputLanguage: "ui"
      });
      await repository.updateProfile({
        id: profile.id,
        providerConfigId: codex.id,
        modelId: "gpt-5.6-luna",
        runtime: "remote",
        capabilities: ["text-generation"]
      });
      await repository.setProfileTask({ profileId: profile.id, task: "op:relation_explanation" });
      await repository.setTaskRoute("op:relation_explanation", profile.id);
      const port = createMoneyPort({
        pool,
        credentials: { save: async (_secret, existing) => existing ?? `ai:${randomUUID()}` },
        budget: {
          snapshot: async () => snapshot("paused"),
          continuePastPause: async () => undefined
        },
        controls: { current: () => ({ monthlyCapUsd: 5 }) },
        money: { model: "dev-fake-priced-1", inputUsdPerM: 1, outputUsdPerM: 4, latencyMs: 5 },
        seed: 1,
        sink: new MemoryEventSink(),
        jobs: { wake: vi.fn() }
      });
      try {
        const fake = await port.routeToFake();
        expect(fake.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
        const routed = (await repository.listTaskRoutes()).find(
          (route) => route.task === "op:relation_explanation"
        );
        const routedProfile = (await repository.listProfiles()).find(
          (entry) => entry.id === routed!.profileId
        );
        expect(routedProfile?.name).toBe(moneyProviderName);
        expect(routedProfile?.modelId).toBe("dev-fake-priced-1");
        // The fake answers an explanation prompt with a sentence naming the notes.
        const answer = await fetch(`${fake.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: "Bearer dev-fake-remote-api-key",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: "dev-fake-priced-1",
            messages: [{ role: "user", content: "How do n1 and n2 relate?" }]
          })
        });
        const body = (await answer.json()) as {
          choices: Array<{ message: { content: string } }>;
          usage: { prompt_tokens: number };
        };
        expect(body.choices[0]!.message.content).toMatch(/n1|n2/u);
        expect(body.usage.prompt_tokens).toBeGreaterThan(0);
        await port.restoreRoute();
        const back = (await repository.listTaskRoutes()).find(
          (route) => route.task === "op:relation_explanation"
        );
        expect(back?.profileId).toBe(profile.id);
        expect(await port.state()).toBe("paused");
        expect(await port.spentUsd()).toBe(0.3);
        expect(port.monthlyCapUsd()).toBe(5);
      } finally {
        await port.stop();
      }
    });
  });

  describe("the start of the 7-day soak", () => {
    const planPath = join(workspace, "scripts", "soak", "plan.json");

    async function prepared(writer: string) {
      const worktree = await mkdtemp(join(tmpdir(), "soak7-worktree-"));
      const dataRoot = await mkdtemp(join(tmpdir(), "soak7-data-"));
      mkdirSync(join(worktree, "scripts", "soak"), { recursive: true });
      writeFileSync(join(worktree, "scripts", "soak", "plan.json"), readFileSync(planPath, "utf8"));
      mkdirSync(join(dataRoot, "profiles", "env-soak7"), { recursive: true });
      const soak = prepareSoak({
        env: {
          MEMORA_SOAK: "scripts/soak/plan.json",
          MEMORA_SOAK_PROFILE: "soak7",
          MEMORA_SOAK_DATA_ROOT: dataRoot,
          MEMORA_SOAK_REAL_WRITER: writer,
          MEMORA_SOAK_RUN: "soak7-test"
        },
        isPackaged: false,
        workspaceRoot: worktree,
        userDataPath: join(dataRoot, "profiles", "env-soak7"),
        logger: { error: vi.fn(), info: vi.fn() }
      })!;
      const deps = {
        pool,
        credentials: { save: async () => "ai:x" },
        setAnswerRoute: async () => undefined
      };
      return {
        soak,
        deps,
        lock: join(dataRoot, "f2", "LOCAL_MODEL_BUSY"),
        cleanup: () =>
          Promise.all([
            rm(worktree, { recursive: true, force: true }),
            rm(dataRoot, { recursive: true, force: true })
          ])
      };
    }

    const codex = async (withCredential = true) =>
      createAiConfigRepository(pool).upsertProvider({
        provider: "openai-codex",
        displayName: "Codex writer",
        ...(withCredential ? { credentialRef: "ai:real" } : {}),
        baseUrl: "https://chatgpt.com/backend-api/codex",
        metadata: {
          modelId: "gpt-5.6-luna",
          capabilities: ["text-generation", "structured-output"]
        }
      });

    it("takes the data root's local-model lock for the run, starts no fake, and gives the lock up at the end", async () => {
      const writer = await codex();
      const { soak, deps, lock, cleanup } = await prepared(writer.id);
      try {
        await soak.startFakes(deps);
        expect(readFileSync(lock, "utf8")).toMatch(/^soak:soak7 pid \d+ run soak7-test\n$/u);
        // The 7-day profile has no fake provider: nothing was written to the AI configuration.
        expect(
          (await createAiConfigRepository(pool).listProviders()).map((p) => p.displayName)
        ).toEqual(["Codex writer"]);
        await soak.stop();
        expect(existsSync(lock)).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("refuses to start while the lock is another holder's, a writer that is not in the profile, or a second real provider on a route", async () => {
      const writer = await codex();
      const held = await prepared(writer.id);
      try {
        mkdirSync(join(held.lock, ".."), { recursive: true });
        writeFileSync(held.lock, "T69 pid 5\n");
        await expect(held.soak.startFakes(held.deps)).rejects.toThrow(/held by: T69 pid 5/u);
      } finally {
        await held.cleanup();
      }
      const missing = await prepared(randomUUID());
      try {
        await expect(missing.soak.startFakes(missing.deps)).rejects.toThrow(
          /names no provider configuration/u
        );
        // A refused start quits at once: the slot it took is given back first.
        expect(existsSync(missing.lock)).toBe(false);
      } finally {
        await missing.cleanup();
      }
      const repository = createAiConfigRepository(pool);
      const stray = await repository.upsertProvider({
        provider: "openai-compatible",
        displayName: "Stray",
        credentialRef: "ai:stray",
        baseUrl: "https://api.openai.com/v1",
        metadata: { modelId: "gpt-5", capabilities: ["text-generation", "structured-output"] }
      });
      const profile = await repository.createProfile({
        name: "Stray",
        privacyMode: "allow_remote",
        outputLanguage: "ui"
      });
      await repository.updateProfile({
        id: profile.id,
        providerConfigId: stray.id,
        modelId: "gpt-5",
        runtime: "remote",
        capabilities: ["text-generation", "structured-output"]
      });
      await repository.setProfileTask({ profileId: profile.id, task: "class:answer" });
      await repository.setTaskRoute("class:answer", profile.id);
      const reach = await prepared(writer.id);
      try {
        await expect(reach.soak.startFakes(reach.deps)).rejects.toThrow(
          /still reaches a real remote provider.*Stray/su
        );
      } finally {
        await reach.cleanup();
      }
    });
  });
});
