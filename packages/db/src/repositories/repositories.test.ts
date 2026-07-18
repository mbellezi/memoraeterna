import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createSettingsRepository } from "./settingsRepository.js";
import { createSourceItemRepository } from "./sourceItemRepository.js";
import { createSourceSummaryRepository } from "./sourceSummaryRepository.js";
import { createLocalModelRepository } from "./localModelRepository.js";
import { createJobRepository } from "./jobRepository.js";
import { createAtomicNoteRepository } from "./atomicNoteRepository.js";
import { createAiConfigRepository } from "./aiConfigRepository.js";
import { createIngestionRunRepository } from "./ingestionRunRepository.js";
import { createLibraryRepository } from "./libraryRepository.js";
import type { Queryable } from "./types.js";

class FakeQueryable implements Queryable {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  private readonly rows: QueryResultRow[][];

  constructor(rows: QueryResultRow[][]) {
    this.rows = rows;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, values });
    const rows = (this.rows.shift() ?? []) as T[];
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows
    };
  }
}

class TransactionalSummaryPool implements Queryable {
  readonly queries: string[] = [];
  released = false;

  constructor(private readonly row: QueryResultRow) {}

  async connect() {
    return {
      query: this.query.bind(this),
      release: () => { this.released = true; }
    };
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text);
    const rows = text.startsWith("insert into source_summaries") ? [this.row as T] : [];
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
  }
}

describe("repositories", () => {
  it("creates source items with parameterized SQL and maps records", async () => {
    const now = new Date("2026-07-05T10:00:00.000Z");
    const db = new FakeQueryable([
      [
        {
          id: "source-1",
          type: "WebArticle",
          title: "Example",
          sourceUri: "https://example.test",
          externalId: null,
          metadata: { capturedBy: "test" },
          createdAt: now,
          updatedAt: now
        }
      ]
    ]);

    const repo = createSourceItemRepository(db);
    const record = await repo.create({
      type: "WebArticle",
      title: "Example",
      sourceUri: "https://example.test",
      metadata: { capturedBy: "test" }
    });

    expect(record.id).toBe("source-1");
    expect(db.queries[0]?.text).toContain("insert into source_items");
    expect(db.queries[0]?.text).toContain("$1");
    expect(db.queries[0]?.values).toEqual([
      "WebArticle",
      "Example",
      null,
      "manual",
      "https://example.test",
      null,
      null,
      null,
      "und",
      { capturedBy: "test" }
    ]);
  });

  it("exposes the latest materialized division position to the library", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    const db = new FakeQueryable([[
      {
        id: "source-1",
        parentSourceItemId: "root-1",
        structurePosition: 2,
        childCount: 0,
        hasDocument: true,
        type: "DocumentSection",
        title: "Third section",
        subtitle: null,
        sourceUri: null,
        language: "en",
        summary: null,
        metadata: {},
        processingStatus: "pending",
        currentStage: "queued",
        updatedAt: now
      }
    ]]);

    const sources = await createLibraryRepository(db).listSources();

    expect(sources[0]?.structurePosition).toBe(2);
    expect(db.queries[0]?.text).toContain("division.child_source_item_id = source.id");
    expect(db.queries[0]?.text).toContain("structure.status = 'materialized'");
    expect(db.queries[0]?.text).toContain("order by structure.revision desc");
  });

  it("upserts settings by key", async () => {
    const now = new Date("2026-07-05T10:00:00.000Z");
    const db = new FakeQueryable([
      [
        {
          key: "ui.locale",
          value: "pt-BR",
          updatedAt: now
        }
      ]
    ]);

    const repo = createSettingsRepository(db);
    const setting = await repo.set("ui.locale", "pt-BR");

    expect(setting).toEqual({
      key: "ui.locale",
      value: "pt-BR",
      updatedAt: now
    });
    expect(db.queries[0]?.text).toContain("on conflict (key) do update");
  });

  it("records traceable source summaries", async () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const db = new TransactionalSummaryPool({
        id: "summary-1",
        generationId: null,
        isCurrent: true,
        sourceItemId: "source-1",
        summary: "A concise summary.",
        language: "en",
        profileId: "profile-1",
        aiTaskRunId: "run-1",
        provider: "test",
        model: "mock-model",
        runtime: "remote",
        promptVersion: "summary-v1",
        inputHash: "a".repeat(64),
        outputHash: "b".repeat(64),
        generatedAt: now,
        metadata: { mapReduce: false },
        createdAt: now
      });
    const summary = await createSourceSummaryRepository(db).create({
      sourceItemId: "source-1",
      summary: "A concise summary.",
      provider: "test",
      model: "mock-model",
      runtime: "remote",
      promptVersion: "summary-v1",
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64)
    });
    expect(summary.profileId).toBe("profile-1");
    expect(db.queries.some((query) => query.startsWith("insert into source_summaries"))).toBe(true);
  });

  it("replaces the current summary in separate statements inside a source-scoped transaction", async () => {
    const now = new Date("2026-07-18T20:00:00.000Z");
    const db = new TransactionalSummaryPool({
      id: "summary-3", generationId: null, isCurrent: true, sourceItemId: "source-1",
      summary: "Aggregate summary.", language: "en", profileId: null, aiTaskRunId: null,
      provider: "test", model: "mock-model", runtime: "remote", promptVersion: "hierarchy-aggregate-v1",
      inputHash: "e".repeat(64), outputHash: "f".repeat(64), generatedAt: now, metadata: {}, createdAt: now
    });

    await createSourceSummaryRepository(db).create({
      sourceItemId: "source-1", summary: "Aggregate summary.", provider: "test", model: "mock-model",
      runtime: "remote", promptVersion: "hierarchy-aggregate-v1",
      inputHash: "e".repeat(64), outputHash: "f".repeat(64)
    });

    expect(db.queries).toEqual([
      "begin",
      "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      "update source_summaries set is_current = false where source_item_id = $1 and is_current = true",
      expect.stringContaining("insert into source_summaries"),
      "commit"
    ]);
    expect(db.released).toBe(true);
  });

  it("invalidates the current summary when an item no longer has summarizable content", async () => {
    const db = new FakeQueryable([[]]);

    await createSourceSummaryRepository(db as never).clearCurrent("source-1");

    expect(db.queries).toEqual([{
      text: "update source_summaries set is_current = false where source_item_id = $1 and is_current = true",
      values: ["source-1"]
    }]);
  });

  it("persists an immutable local model descriptor with parameterized SQL", async () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const db = new FakeQueryable([[
      {
        id: "model-1", catalogId: "mlx-test", modelId: "repo/model", displayName: "Model",
        family: "Test", variant: "4-bit", repository: "repo/model", revision: "a".repeat(40),
        runtime: "mlx", format: "safetensors", quantization: "4-bit", managedPath: null,
        expectedSizeBytes: 10, installedSizeBytes: 0, manifestHash: "b".repeat(64),
        capabilities: ["offline"], licenseName: "Test", licenseUrl: "https://example.test/license",
        licenseAcceptedAt: null, status: "not_downloaded", lastError: null, metadata: {},
        createdAt: now, updatedAt: now
      }
    ]]);
    const model = await createLocalModelRepository(db).upsertModel({
      catalogId: "mlx-test", modelId: "repo/model", displayName: "Model", family: "Test",
      variant: "4-bit", repository: "repo/model", revision: "a".repeat(40), runtime: "mlx",
      format: "safetensors", quantization: "4-bit", expectedSizeBytes: 10,
      manifestHash: "b".repeat(64), capabilities: ["offline"], licenseName: "Test",
      licenseUrl: "https://example.test/license"
    });
    expect(model.catalogId).toBe("mlx-test");
    expect(db.queries[0]?.text).toContain("on conflict (catalog_id) do update");
    expect(JSON.stringify(db.queries[0]?.values)).not.toContain("hf_");
  });

  it("starts a fresh attempt budget when manually retrying an exhausted job", async () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const db = new FakeQueryable([[
      {
        id: "job-1", type: "ingestion", status: "queued", priority: 0,
        payload: {}, result: null, error: null, progress: 0, attempts: 0,
        maxAttempts: 3, runAfter: now, lockedAt: null, lockedBy: null,
        finishedAt: null, cancelRequestedAt: null, createdAt: now, updatedAt: now
      }
    ]]);

    const retried = await createJobRepository(db).retry("job-1");

    expect(retried?.attempts).toBe(0);
    expect(db.queries[0]?.text).toContain("attempts = 0");
    expect(db.queries[0]?.text).toContain("status in ('failed', 'canceled', 'succeeded')");
    expect(db.queries[0]?.text).toContain("result = null");
    expect(db.queries[0]?.text).not.toContain("attempts < max_attempts");
  });

  it("immediately recovers every job left running by the previous process", async () => {
    const db = new FakeQueryable([[], [], [], []]);

    await createJobRepository(db).recoverInterrupted();

    expect(db.queries[0]?.text).toContain("where status = 'running'");
    expect(db.queries[0]?.text).toContain("attempts < max_attempts");
    expect(db.queries[0]?.text).not.toContain("locked_at <");
    expect(db.queries[0]?.values).toEqual([]);
  });

  it("removes false running state from interrupted ingestion checkpoints", async () => {
    const db = new FakeQueryable([[]]);

    await createIngestionRunRepository(db).recoverInterrupted();

    expect(db.queries[0]?.text).toContain("where interrupted.status = 'running'");
    expect(db.queries[0]?.text).toContain("left join jobs");
    expect(db.queries[0]?.text).toContain("when recovered.job_status = 'queued' then 'pending'");
    expect(db.queries[0]?.text).toContain("when recovered.job_status = 'canceled' then 'canceled'");
    expect(db.queries[0]?.text).toContain("'interruptedAt', now()");
  });

  it("serializes ingestion stage lists as JSON", async () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const requestedStages = ["conversion", "chunking"];
    const effectiveStages = ["conversion", "chunking", "embedding"];
    const db = new FakeQueryable([[
      {
        id: "run-1", sourceItemId: "source-1", jobId: null, batchId: "batch-1",
        runKind: "initial", requestedStages, effectiveStages, planVersion: "1",
        inputDocumentRevisionId: null, inputHashes: {}, supersedesRunId: null,
        previousArtifactPolicy: "reuse_valid", trigger: "interactive_import",
        status: "pending", currentStage: "queued", stagesCheckpoint: {}, error: null,
        startedAt: null, completedAt: null, createdAt: now, updatedAt: now
      }
    ]]);

    await createIngestionRunRepository(db).create({
      sourceItemId: "source-1",
      batchId: "batch-1",
      requestedStages,
      effectiveStages
    });

    expect(db.queries[0]?.values[4]).toBe(JSON.stringify(requestedStages));
    expect(db.queries[0]?.values[5]).toBe(JSON.stringify(effectiveStages));
  });

  it("marks the active ingestion checkpoint when the run fails or is canceled", async () => {
    const db = new FakeQueryable([[], []]);
    const runs = createIngestionRunRepository(db);

    await runs.fail("run-1", "errors.localModels.runtimeFailed");
    await runs.cancel("run-2");

    expect(db.queries[0]?.text).toContain("update ingestion_run_stages");
    expect(db.queries[1]?.text).toContain("jsonb_build_object('status', 'failed'");
    expect(db.queries[1]?.values).toEqual(["run-1", "errors.localModels.runtimeFailed"]);
    expect(db.queries[2]?.text).toContain("update ingestion_run_stages");
    expect(db.queries[3]?.text).toContain("jsonb_build_object('status', 'canceled'");
    expect(db.queries[3]?.values).toEqual(["run-2"]);
  });

  it("clears only completed or failed jobs", async () => {
    let queryText = "";
    const db: Queryable = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
        queryText = text;
        return {
          command: "DELETE",
          rowCount: 2,
          oid: 0,
          fields: [],
          rows: []
        };
      }
    };

    const deletedCount = await createJobRepository(db).clearCompletedOrFailed();

    expect(deletedCount).toBe(2);
    expect(queryText).toContain("status in ('succeeded', 'failed')");
    expect(queryText).not.toContain("canceled");
    expect(queryText).not.toContain("running");
  });

  it("attaches effective AI execution metadata to a running job", async () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const db = new FakeQueryable([[
      {
        id: "job-1", type: "summarization", status: "running", priority: 0,
        payload: { aiExecution: { provider: "google", modelId: "gemini-3.1-pro-preview", reasoningLevel: "low" } },
        result: null, error: null, progress: 2_000, attempts: 1, maxAttempts: 1,
        runAfter: now, lockedAt: now, lockedBy: "worker", finishedAt: null,
        cancelRequestedAt: null, createdAt: now, updatedAt: now
      }
    ]]);

    const updated = await createJobRepository(db).setAiExecution("job-1", {
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      reasoningLevel: "low"
    });

    expect(updated?.payload.aiExecution).toMatchObject({ modelId: "gemini-3.1-pro-preview", reasoningLevel: "low" });
    expect(db.queries[0]?.text).toContain("jsonb_set(payload, '{aiExecution}'");
  });

  it("deletes a remote model and clears linked profile model selections atomically", async () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const db = new FakeQueryable([[
      {
        id: "provider-1",
        provider: "openai-codex",
        displayName: "ChatGPT",
        credentialRef: "ai:secret",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        defaultParameters: {},
        status: "configured",
        metadata: { modelId: "gpt-test" },
        createdAt: now,
        updatedAt: now
      }
    ]]);

    const deleted = await createAiConfigRepository(db).deleteProvider("provider-1");

    expect(deleted?.id).toBe("provider-1");
    expect(db.queries[0]?.text).toContain("update ai_profile_sets");
    expect(db.queries[0]?.text).toContain("model_id = null");
    expect(db.queries[0]?.text).toContain("delete from ai_provider_configs");
    expect(db.queries[0]?.values).toEqual(["provider-1"]);
  });

  it("updates linked profiles when a remote model id changes", async () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const db = new FakeQueryable([[
      {
        id: "provider-1",
        provider: "openai-codex",
        displayName: "ChatGPT renamed",
        credentialRef: "ai:secret",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        defaultParameters: {},
        status: "configured",
        metadata: { modelId: "gpt-new", capabilities: ["text-generation"] },
        createdAt: now,
        updatedAt: now
      }
    ]]);

    await createAiConfigRepository(db).upsertProvider({
      id: "provider-1",
      provider: "openai-codex",
      displayName: "ChatGPT renamed",
      credentialRef: "ai:secret",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      metadata: { modelId: "gpt-new", capabilities: ["text-generation"] }
    });

    expect(db.queries[0]?.text).toContain("update ai_profile_sets");
    expect(db.queries[0]?.text).toContain("model_id = coalesce");
    expect(db.queries[0]?.text).toContain("capabilities = coalesce");
  });

  it("marks existing generative remote models and linked profiles for reranking", async () => {
    const db = new FakeQueryable([[{ count: "2" }]]);

    await expect(createAiConfigRepository(db).ensureRemoteRerankingCapabilities()).resolves.toBe(2);

    expect(db.queries[0]?.text).toContain("'google', 'openai-compatible', 'openai-codex'");
    expect(db.queries[0]?.text).toContain("'[\"reranking\"]'::jsonb");
    expect(db.queries[0]?.text).toContain("update ai_profile_sets");
  });

  it("records every source associated with an AI task run atomically", async () => {
    const db = new FakeQueryable([[{ id: "run-1" }]]);

    const runId = await createAiConfigRepository(db).recordTaskRun({
      taskType: "reranking",
      provider: "test",
      modelId: "test-model",
      runtime: "remote",
      durationMs: 12,
      status: "succeeded",
      sourceItemIds: ["source-1", "source-2", "source-1"]
    });

    expect(runId).toBe("run-1");
    expect(db.queries[0]?.text).toContain("insert into ai_task_run_sources");
    expect(db.queries[0]?.text).toContain("unnest($20::uuid[])");
    expect(db.queries[0]?.values[19]).toEqual(["source-1", "source-2"]);
  });

  it("loads atomic-note graph inputs with their complete chunk provenance", async () => {
    const db = new FakeQueryable([[
      {
        id: "note-1",
        title: "Atomic title",
        ideaStatement: "Atomic idea",
        bodyMarkdown: "Atomic body",
        evidenceChunkIds: ["chunk-1", "chunk-2"]
      }
    ]]);

    const notes = await createAtomicNoteRepository(db).listGraphInputsBySourceItem("source-1");

    expect(notes[0]?.evidenceChunkIds).toEqual(["chunk-1", "chunk-2"]);
    expect(db.queries[0]?.text).toContain("atomic_note_source_links");
    expect(db.queries[0]?.text).toContain("status <> 'rejected'");
  });

  it("retrieves atomic-note text and vector rankings independently", async () => {
    const db = new FakeQueryable([[], [], []]);
    const notes = createAtomicNoteRepository(db);

    await notes.findTextMatchingCandidates({ noteId: "note-1", limit: 30 });
    await notes.findVectorMatchingCandidates({
      noteId: "note-1",
      embedding: Array.from({ length: 256 }, () => 0),
      embeddingModel: "embedding-model",
      limit: 30
    });
    await notes.scoreMatchingCandidates({
      noteId: "note-1",
      candidateIds: ["00000000-0000-4000-8000-000000000001"]
    });

    expect(db.queries[0]?.text).toContain('order by "textScore" desc');
    expect(db.queries[1]?.text).toContain('order by "vectorScore" desc');
    expect(db.queries[1]?.text).toContain("join embeddings_256");
    expect(db.queries[2]?.text).toContain("candidate.id = any($2::uuid[])");
  });

  it("persists per-batch ingestion progress without replacing the stage checkpoint", async () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const db = new FakeQueryable([[], [
      {
        id: "run-1", sourceItemId: "source-1", jobId: "job-1", status: "running",
        currentStage: "knowledgeGraph", stagesCheckpoint: {
          knowledgeGraph: { status: "running", progress: 0.5, metadata: { completed: 1, total: 2 } }
        },
        error: null, startedAt: now, completedAt: null, createdAt: now, updatedAt: now
      }
    ]]);

    const run = await createIngestionRunRepository(db).updateStageProgress(
      "run-1",
      "knowledgeGraph",
      0.5,
      { completed: 1, total: 2 }
    );

    expect(run?.stagesCheckpoint.knowledgeGraph).toMatchObject({ progress: 0.5 });
    expect(db.queries[0]?.text).toContain("ingestion_run_stages");
    expect(db.queries[1]?.text).toContain("coalesce(stages_checkpoint -> $2");
    expect(db.queries[1]?.values).toEqual([
      "run-1", "knowledgeGraph", 0.5, { completed: 1, total: 2 }
    ]);
  });
});
