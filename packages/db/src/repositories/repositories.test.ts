import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createSettingsRepository } from "./settingsRepository.js";
import { createSourceItemRepository, emptyContentHash } from "./sourceItemRepository.js";
import { createSourceSummaryRepository } from "./sourceSummaryRepository.js";
import { createLocalModelRepository } from "./localModelRepository.js";
import { createJobRepository } from "./jobRepository.js";
import { createAtomicNoteRepository } from "./atomicNoteRepository.js";
import { createAiConfigRepository } from "./aiConfigRepository.js";
import { createAiBudgetRepository } from "./aiBudgetRepository.js";
import { createIngestionRunRepository } from "./ingestionRunRepository.js";
import {
  createLibraryRepository,
  librarySemanticCandidateFloor,
  librarySemanticStandaloneFloor,
  qualifiesLibrarySemanticMatch
} from "./libraryRepository.js";
import { createEmbeddingRepository } from "./embeddingRepository.js";
import type { Queryable } from "./types.js";
import { librarySearchEvaluationCases } from "./__fixtures__/library-search-evaluation.js";

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
      release: () => {
        this.released = true;
      }
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

  describe("duplicate lookup by content", () => {
    const emptyHash = createHash("sha256").update("").digest("hex");
    const otherHash = createHash("sha256").update("Some text.").digest("hex");

    it("never matches on the hash of empty content", async () => {
      const db = new FakeQueryable([]);
      const repo = createSourceItemRepository(db);

      // Content with no text hashes to one value for every source, so it says nothing about identity.
      expect(emptyContentHash).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
      expect(emptyHash).toBe(emptyContentHash);
      expect(await repo.findDuplicate({ contentHash: emptyHash })).toBeNull();
      expect(await repo.findDuplicate({ sourceUri: null, contentHash: emptyHash })).toBeNull();
      expect(db.queries).toEqual([]);
    });

    it("still matches on the address when the content is empty", async () => {
      const db = new FakeQueryable([[]]);
      await createSourceItemRepository(db).findDuplicate({
        sourceUri: "file:///library/a.html",
        contentHash: emptyHash
      });

      expect(db.queries).toHaveLength(1);
      expect(db.queries[0]?.values).toEqual(["file:///library/a.html", null]);
    });

    it("matches on the hash of content that has text", async () => {
      const db = new FakeQueryable([[]]);
      await createSourceItemRepository(db).findDuplicate({ contentHash: otherHash });

      expect(db.queries[0]?.values).toEqual([null, otherHash]);
    });
  });

  it("invalidates source-level embeddings when searchable source data changes", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const db = new FakeQueryable([
      [
        {
          id: "00000000-0000-4000-8000-000000000001",
          type: "PersonalNote",
          title: "Updated source",
          subtitle: null,
          sourceOrigin: "manual",
          sourceUri: null,
          externalId: null,
          parentSourceItemId: null,
          contentHash: null,
          language: "en",
          summary: null,
          summaryGeneratedAt: null,
          metadata: {},
          createdAt: now,
          updatedAt: now
        }
      ],
      [],
      [],
      []
    ]);

    await createSourceItemRepository(db).update("00000000-0000-4000-8000-000000000001", {
      title: "Updated source"
    });

    expect(db.queries.slice(1)).toHaveLength(3);
    expect(
      db.queries.slice(1).every((query) => query.text.includes("target_type = 'source_item'"))
    ).toBe(true);
  });

  it("exposes the latest materialized division position to the library", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    const db = new FakeQueryable([
      [
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
      ]
    ]);

    const sources = await createLibraryRepository(db).listSources();

    expect(sources[0]?.structurePosition).toBe(2);
    expect(db.queries[0]?.text).toContain("division.child_source_item_id = source.id");
    expect(db.queries[0]?.text).toContain("structure.status = 'materialized'");
    expect(db.queries[0]?.text).toContain("order by structure.revision desc");
  });

  it("combines traditional and source-embedding signals in library search", async () => {
    const db = new FakeQueryable([[]]);
    await createLibraryRepository(db).listSources({
      query: "semantic memory",
      queryEmbedding: Array.from({ length: 256 }, (_, index) => (index === 0 ? 1 : 0)),
      embeddingModel: "embedding-model"
    });

    expect(db.queries[0]?.text).toContain("source_embedding.target_type = 'source_item'");
    expect(db.queries[0]?.text).toContain("limit 3");
    expect(db.queries[0]?.text).toContain("entity_mentions");
    expect(db.queries[0]?.text).toContain("chunk_scores.best_score * 0.7");
    expect(db.queries[0]?.text).toContain('as "rankingScore"');
    expect(db.queries[0]?.values[2]).toBe("semantic memory");
    expect(db.queries[0]?.values[8]).toBe("embedding-model");
    expect(db.queries[0]?.values[9]).toBe(librarySemanticStandaloneFloor);
    expect(db.queries[0]?.values[10]).toBe(librarySemanticCandidateFloor);
  });

  it("keeps the synthetic library-search calibration set correctly classified", () => {
    expect(librarySearchEvaluationCases).toHaveLength(30);
    for (const evaluation of librarySearchEvaluationCases) {
      expect(
        qualifiesLibrarySemanticMatch(evaluation.embeddingScore, evaluation.corroborated),
        `${evaluation.query} -> ${evaluation.candidate}`
      ).toBe(evaluation.expectedRelevant);
    }
  });

  it("reads stored source embeddings for hierarchical aggregation", async () => {
    const db = new FakeQueryable([
      [
        {
          targetId: "00000000-0000-4000-8000-000000000001",
          embedding: "[0.25,-0.5,0.75]"
        }
      ]
    ]);
    const rows = await createEmbeddingRepository(db).listSourceEmbeddings(
      ["00000000-0000-4000-8000-000000000001"],
      "embedding-model",
      256
    );

    expect(rows[0]?.embedding).toEqual([0.25, -0.5, 0.75]);
    expect(db.queries[0]?.text).toContain("target_type = 'source_item'");
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

  it("replaces a setting only while it still holds the value that was read", async () => {
    const db = new FakeQueryable([[{ key: "ui.locale" }], []]);
    const repo = createSettingsRepository(db);

    expect(await repo.replaceIfUnchanged("ui.locale", { a: 1 }, { a: 2 })).toBe(true);
    expect(await repo.replaceIfUnchanged("ui.locale", { a: 1 }, { a: 2 })).toBe(false);
    expect(db.queries[0]?.text).toContain("where key = $1 and value = $2::jsonb");
    expect(db.queries[0]?.values).toEqual(["ui.locale", '{"a":1}', '{"a":2}']);
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
      id: "summary-3",
      generationId: null,
      isCurrent: true,
      sourceItemId: "source-1",
      summary: "Aggregate summary.",
      language: "en",
      profileId: null,
      aiTaskRunId: null,
      provider: "test",
      model: "mock-model",
      runtime: "remote",
      promptVersion: "hierarchy-aggregate-v1",
      inputHash: "e".repeat(64),
      outputHash: "f".repeat(64),
      generatedAt: now,
      metadata: {},
      createdAt: now
    });

    await createSourceSummaryRepository(db).create({
      sourceItemId: "source-1",
      summary: "Aggregate summary.",
      provider: "test",
      model: "mock-model",
      runtime: "remote",
      promptVersion: "hierarchy-aggregate-v1",
      inputHash: "e".repeat(64),
      outputHash: "f".repeat(64)
    });

    expect(db.queries).toEqual([
      "begin",
      "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      "update source_summaries set is_current = false where source_item_id = $1 and is_current = true",
      expect.stringContaining("insert into source_summaries"),
      "update source_items set metadata = metadata - 'summaryStale' where id = $1",
      "commit"
    ]);
    expect(db.released).toBe(true);
  });

  it("invalidates the current summary when an item no longer has summarizable content", async () => {
    const db = new FakeQueryable([[]]);

    await createSourceSummaryRepository(db as never).clearCurrent("source-1");

    expect(db.queries).toEqual([
      {
        text: "update source_summaries set is_current = false where source_item_id = $1 and is_current = true",
        values: ["source-1"]
      }
    ]);
  });

  it("persists an immutable local model descriptor with parameterized SQL", async () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const db = new FakeQueryable([
      [
        {
          id: "model-1",
          catalogId: "mlx-test",
          modelId: "repo/model",
          displayName: "Model",
          family: "Test",
          variant: "4-bit",
          repository: "repo/model",
          revision: "a".repeat(40),
          runtime: "mlx",
          format: "safetensors",
          quantization: "4-bit",
          managedPath: null,
          expectedSizeBytes: 10,
          installedSizeBytes: 0,
          manifestHash: "b".repeat(64),
          capabilities: ["offline"],
          licenseName: "Test",
          licenseUrl: "https://example.test/license",
          licenseAcceptedAt: null,
          status: "not_downloaded",
          lastError: null,
          metadata: {},
          createdAt: now,
          updatedAt: now
        }
      ]
    ]);
    const model = await createLocalModelRepository(db).upsertModel({
      catalogId: "mlx-test",
      modelId: "repo/model",
      displayName: "Model",
      family: "Test",
      variant: "4-bit",
      repository: "repo/model",
      revision: "a".repeat(40),
      runtime: "mlx",
      format: "safetensors",
      quantization: "4-bit",
      expectedSizeBytes: 10,
      manifestHash: "b".repeat(64),
      capabilities: ["offline"],
      licenseName: "Test",
      licenseUrl: "https://example.test/license"
    });
    expect(model.catalogId).toBe("mlx-test");
    expect(db.queries[0]?.text).toContain("on conflict (catalog_id) do update");
    expect(JSON.stringify(db.queries[0]?.values)).not.toContain("hf_");
  });

  it("starts a fresh attempt budget when manually retrying an exhausted job", async () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const db = new FakeQueryable([
      [
        {
          id: "job-1",
          type: "ingestion",
          status: "queued",
          priority: 0,
          payload: {},
          result: null,
          error: null,
          progress: 0,
          attempts: 0,
          maxAttempts: 3,
          runAfter: now,
          lockedAt: null,
          lockedBy: null,
          finishedAt: null,
          cancelRequestedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ]
    ]);

    const retried = await createJobRepository(db).retry("job-1");

    expect(retried?.attempts).toBe(0);
    expect(db.queries[0]?.text).toContain("attempts = 0");
    expect(db.queries[0]?.text).toContain("status in ('failed', 'canceled', 'succeeded')");
    expect(db.queries[0]?.text).toContain("result = null");
    expect(db.queries[0]?.text).not.toContain("attempts < max_attempts");
  });

  it("immediately recovers every job left running by the previous process", async () => {
    const db = new FakeQueryable([[], [{ id: "job-1", dedupeKey: "key-1" }], [{ id: "job-1" }]]);

    expect(await createJobRepository(db).recoverInterrupted()).toBe(1);

    // Canceled and exhausted jobs end; the others are listed with the key their claim dropped and
    // queued again with it.
    expect(db.queries[0]?.text).toContain("where status = 'running'");
    expect(db.queries[0]?.text).toContain("attempts >= max_attempts");
    expect(db.queries[0]?.text).not.toContain("locked_at <");
    expect(db.queries[0]?.values).toEqual([]);
    expect(db.queries[1]?.text).toContain("payload ->> 'claimedDedupeKey'");
    expect(db.queries[1]?.text).not.toContain("locked_at <");
    expect(db.queries[2]?.text).toContain("dedupe_key = $2");
    expect(db.queries[2]?.values).toEqual(["job-1", "key-1"]);
  });

  it("recovers only the running jobs whose lock went stale", async () => {
    const db = new FakeQueryable([[], []]);

    expect(await createJobRepository(db).recoverStale(90)).toBe(0);

    expect(db.queries[0]?.text).toContain("locked_at < now() - make_interval");
    expect(db.queries[0]?.values).toEqual([90]);
    expect(db.queries[1]?.text).toContain("locked_at < now() - make_interval");
    expect(db.queries[1]?.values).toEqual([90]);
  });

  it("removes false running state from interrupted ingestion checkpoints", async () => {
    const db = new FakeQueryable([[]]);

    await createIngestionRunRepository(db).recoverInterrupted();

    expect(db.queries[1]?.text).toContain("where interrupted.status = 'running'");
    expect(db.queries[1]?.text).toContain("left join jobs");
    expect(db.queries[1]?.text).toContain("when recovered.job_status = 'queued' then 'pending'");
    expect(db.queries[1]?.text).toContain("when recovered.job_status = 'canceled' then 'canceled'");
    expect(db.queries[1]?.text).toContain("'interruptedAt', now()");
  });

  it("ends the open stage attempts of interrupted runs before they resume", async () => {
    const db = new FakeQueryable([[]]);

    await createIngestionRunRepository(db).recoverInterrupted();

    const text = db.queries[0]?.text ?? "";
    expect(text).toContain("update ingestion_run_stages");
    expect(text).toContain("set ended_at = now()");
    expect(text).toContain("job.status is distinct from 'running'");
    expect(text).toContain("stage.status = 'running'");
    expect(text).toContain("stage.ended_at is null");
  });

  it("opens a stage attempt only when a stage enters running from another state", async () => {
    const db = new FakeQueryable([[], []]);
    const runs = createIngestionRunRepository(db);

    await runs.beginStage("run-1", "summarization");
    await runs.updateStageProgress("run-1", "atomicNoteMatching", 0.5);

    const inserts = db.queries.filter((q) => q.text.includes("insert into ingestion_run_stages"));
    expect(inserts).toHaveLength(2);
    for (const query of inserts) {
      expect(query.text).toContain("attempts, attempt_started_at");
      expect(query.text).toContain("ingestion_run_stages.status = 'running'");
      expect(query.text).toContain("ingestion_run_stages.ended_at is null");
      expect(query.text).toContain("ingestion_run_stages.attempts + 1");
      expect(query.text).toContain("ended_at = null");
      expect(query.text).toContain("started_at = coalesce(ingestion_run_stages.started_at, now())");
    }
  });

  it("stamps the end of a stage attempt whatever its outcome", async () => {
    const db = new FakeQueryable([]);
    const runs = createIngestionRunRepository(db);

    await runs.completeStage("run-1", "summarization");
    await runs.skipStage("run-1", "embedding", "reason");
    await runs.failStage("run-1", "knowledgeGraph", "failed");
    await runs.fail("run-2", "failed");
    await runs.cancel("run-3");

    const stageWrites = db.queries.filter((q) =>
      /(insert into|update) ingestion_run_stages/.test(q.text)
    );
    expect(stageWrites).toHaveLength(5);
    for (const query of stageWrites) expect(query.text).toContain("ended_at");
    // Completion and skipping always end the attempt; failure and cancellation end only open ones.
    expect(stageWrites[0]?.text).toContain("ended_at = now()");
    expect(stageWrites[1]?.text).toContain("ended_at = now()");
    for (const query of stageWrites.slice(2)) {
      expect(query.text).toMatch(
        /case when \S+\.status = 'running' and \S+\.ended_at is null then now\(\)/
      );
    }
  });

  it("parks a source stage for its link job and keeps parked runs out of crash recovery", async () => {
    const db = new FakeQueryable([[], [], [], []]);
    const runs = createIngestionRunRepository(db);

    await runs.parkForLinking("run-1", { rootId: "root-1" });
    await runs.recoverInterrupted();

    const [stage, checkpoint, recoverStages, recoverRuns] = db.queries.map((query) => query.text);
    // The parked stage waits with reason `linking`; its attempt stays open for the link job.
    expect(stage).toContain("'waiting_for_review'");
    expect(db.queries[0]?.values).toEqual(["run-1", { rootId: "root-1" }, "linking"]);
    expect(stage).toContain("ingestion_run_stages.attempts + 1");
    expect(checkpoint).toContain("'parkedAt', clock_timestamp()");
    expect(checkpoint).toContain("current_stage = 'sourceMatching'");
    // A parked run's ingestion job ended on purpose: recovery leaves it to its link job.
    for (const text of [recoverStages, recoverRuns])
      expect(text).toContain("parked.skip_reason = 'linking'");
  });

  it("reopens stages for the stage-level retry, keeping what a failed stage had finished", async () => {
    const db = new FakeQueryable([[{ id: "run-1" }], []]);
    const runs = createIngestionRunRepository(db);

    expect(await runs.reopenStages("run-1", [])).toBeNull();
    await runs.reopenStages("run-1", ["knowledgeGraph"]);

    const [run, stages] = db.queries;
    // Only a finished run is reopened, and it goes back to pending for its job to resume.
    expect(run?.text).toContain("status in ('succeeded', 'failed', 'canceled')");
    expect(run?.text).toContain("set status = 'pending'");
    expect(run?.values).toEqual(["run-1", ["knowledgeGraph"]]);
    // A failed stage keeps its metadata (the graph's completed batches); a skipped one starts clean.
    expect(run?.text).toContain("failed.value ->> 'status' = 'failed'");
    expect(run?.text).toContain("jsonb_build_object('metadata', failed.value -> 'metadata')");
    expect(stages?.text).toContain("metadata = case when status = 'failed' then metadata");
    expect(stages?.values).toEqual(["run-1", ["knowledgeGraph"]]);
  });

  it("counts only the live runs of a batch that have a stage still to finish", async () => {
    const db = new FakeQueryable([[{ count: "2" }]]);
    const runs = createIngestionRunRepository(db);

    expect(await runs.countIncompleteBatchStage("batch-1", "summarization")).toBe(2);

    const [count] = db.queries.map((query) => query.text);
    // Only stages that can still progress are waited on; a failed or canceled stage is settled
    // unless its job is queued or running again.
    expect(count).toContain("stage_state.status in ('pending', 'running', 'waiting_for_review')");
    expect(count).toContain(
      "stage_state.status in ('failed', 'canceled') and job.status in ('queued', 'running')"
    );
    // A run is abandoned when it or its job failed or was canceled and no job can retry it.
    expect(count).toContain("left join jobs");
    expect(count).toMatch(
      /\.status in \('failed', 'canceled'\) or \w+\.status in \('failed', 'canceled'\)/
    );
    expect(count).toMatch(/coalesce\(\w+\.status::text, ''\) not in \('queued', 'running'\)/);
    expect(db.queries.map((query) => query.values)).toEqual([["batch-1", "summarization"]]);
  });

  it("serializes ingestion stage lists as JSON", async () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const requestedStages = ["conversion", "chunking"];
    const effectiveStages = ["conversion", "chunking", "embedding"];
    const db = new FakeQueryable([
      [
        {
          id: "run-1",
          sourceItemId: "source-1",
          jobId: null,
          batchId: "batch-1",
          runKind: "initial",
          requestedStages,
          effectiveStages,
          planVersion: "1",
          inputDocumentRevisionId: null,
          inputHashes: {},
          supersedesRunId: null,
          previousArtifactPolicy: "reuse_valid",
          trigger: "interactive_import",
          status: "pending",
          currentStage: "queued",
          stagesCheckpoint: {},
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ]
    ]);

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

  it("dismisses terminal jobs and task history without deleting audit records", async () => {
    let queryText = "";
    const db: Queryable = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string
      ): Promise<QueryResult<T>> {
        queryText = text;
        return {
          command: "UPDATE",
          rowCount: 2,
          oid: 0,
          fields: [],
          rows: []
        };
      }
    };

    const deletedCount = await createJobRepository(db).clearCompletedOrFailed();

    expect(deletedCount).toBe(2);
    expect(queryText).toContain("j.status in ('succeeded', 'failed', 'canceled')");
    expect(queryText).toContain("dashboardDismissedAt");
    expect(queryText).not.toContain("delete from");
    expect(queryText).not.toContain("type not in");
    expect(queryText).toContain("insert into settings");
    expect(queryText).not.toMatch(/organization_runs|maintenance_runs/);
    expect(queryText).toContain("not exists(select 1 from ingestion_runs");
  });

  it("attaches effective AI execution metadata to a running job", async () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const db = new FakeQueryable([
      [
        {
          id: "job-1",
          type: "summarization",
          status: "running",
          priority: 0,
          payload: {
            aiExecution: {
              provider: "google",
              modelId: "gemini-3.1-pro-preview",
              reasoningLevel: "low"
            }
          },
          result: null,
          error: null,
          progress: 2_000,
          attempts: 1,
          maxAttempts: 1,
          runAfter: now,
          lockedAt: now,
          lockedBy: "worker",
          finishedAt: null,
          cancelRequestedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ]
    ]);

    const updated = await createJobRepository(db).setAiExecution("job-1", {
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      reasoningLevel: "low"
    });

    expect(updated?.payload.aiExecution).toMatchObject({
      modelId: "gemini-3.1-pro-preview",
      reasoningLevel: "low"
    });
    expect(db.queries[0]?.text).toContain("jsonb_set(payload, '{aiExecution}'");
  });

  it("deletes a remote model and clears linked profile model selections atomically", async () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const db = new FakeQueryable([
      [
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
      ]
    ]);

    const deleted = await createAiConfigRepository(db).deleteProvider("provider-1");

    expect(deleted?.id).toBe("provider-1");
    expect(db.queries[0]?.text).toContain("update ai_profile_sets");
    expect(db.queries[0]?.text).toContain("model_id = null");
    expect(db.queries[0]?.text).toContain("delete from ai_provider_configs");
    expect(db.queries[0]?.values).toEqual(["provider-1"]);
  });

  it("updates linked profiles when a remote model id changes", async () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const db = new FakeQueryable([
      [
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
      ]
    ]);

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

  it("seeds a missing task route and its profile task without touching existing ones", async () => {
    const db = new FakeQueryable([[{ count: "1" }], [{ count: "0" }]]);
    const repository = createAiConfigRepository(db);

    await expect(repository.seedTaskRoute("summarization", "profile-1")).resolves.toBe(true);
    await expect(repository.seedTaskRoute("summarization", "profile-2")).resolves.toBe(false);

    const statement = db.queries[0]?.text ?? "";
    expect(statement).toContain("insert into ai_profile_tasks");
    expect(statement).toContain("on conflict (profile_id, task) do nothing");
    expect(statement).toContain("insert into ai_task_profile_routes");
    expect(statement).toContain("on conflict (task) do nothing");
    expect(db.queries[0]?.values).toEqual(["summarization", "profile-1"]);
  });

  it("no longer rewrites provider capabilities to mark generative models as rerankers", () => {
    expect(createAiConfigRepository(new FakeQueryable([]))).not.toHaveProperty(
      "ensureRemoteRerankingCapabilities"
    );
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
    // Only sources that still exist get a provenance row: a deleted id never fails the audit row.
    expect(db.queries[0]?.text).toContain(
      "select id from source_items where id = any($20::uuid[]) order by id for key share"
    );
    expect(db.queries[0]?.values[19]).toEqual(["source-1", "source-2"]);
  });

  it("records the queue wait and the retry index of an AI task run, or null when unknown", async () => {
    const db = new FakeQueryable([[{ id: "run-1" }], [{ id: "run-2" }], [{ id: "run-3" }]]);
    const repository = createAiConfigRepository(db);
    const base = {
      taskType: "reranking",
      provider: "test",
      modelId: "test-model",
      runtime: "remote",
      durationMs: 12,
      status: "succeeded"
    };

    await repository.recordTaskRun({ ...base, queueMs: 1_234.4, attempt: 1 });
    await repository.recordTaskRun(base);
    await repository.recordTaskRun({ ...base, queueMs: -5, attempt: Number.NaN });

    expect(db.queries[0]?.text).toContain("queue_ms, attempt, finished_at");
    expect(db.queries[0]?.values.slice(21, 23)).toEqual([1_234, 1]);
    expect(db.queries[1]?.values.slice(21, 23)).toEqual([null, null]);
    expect(db.queries[2]?.values.slice(21, 23)).toEqual([null, null]);
  });

  it("stores the real start of an AI task run: the end of the call minus its measured duration", async () => {
    const db = new FakeQueryable([[{ id: "run-1" }]]);

    await createAiConfigRepository(db).recordTaskRun({
      taskType: "reranking",
      provider: "test",
      modelId: "test-model",
      runtime: "remote",
      durationMs: 2_900,
      status: "succeeded"
    });

    const statement = db.queries[0]?.text.replace(/\s+/g, " ") ?? "";
    // The start is the end minus the measured duration, no longer the same instant as the end.
    expect(statement).toContain("queue_ms, attempt, finished_at, started_at");
    expect(statement).toContain("now() - ($17::integer * interval '1 millisecond')");
    expect(db.queries[0]?.values[16]).toBe(2_900);
    // The legacy organization and maintenance step tables are gone (migration 0063).
    expect(statement).not.toMatch(/organization_steps|maintenance_steps/);
    expect(db.queries[0]?.values).toHaveLength(35);
  });

  it("records the scheduler's lane, class, priority, deadline and waits, or null when unknown", async () => {
    const db = new FakeQueryable([[{ id: "run-1" }], [{ id: "run-2" }], [{ id: "run-3" }]]);
    const repository = createAiConfigRepository(db);
    const base = {
      taskType: "reranking",
      provider: "test",
      modelId: "test-model",
      runtime: "remote",
      durationMs: 12,
      status: "succeeded"
    };

    await repository.recordTaskRun({
      ...base,
      lane: "remote:provider-1",
      workloadClass: "decide",
      priority: 2,
      deadlineMs: 45_000.4,
      deadlineOutcome: "met",
      isRepair: true,
      schemaMode: "json",
      retryWaitMs: 812.6,
      requeueMs: 0
    });
    // Rows that predate the scheduler, or callers that know nothing of it, stay unknown.
    await repository.recordTaskRun(base);
    await repository.recordTaskRun({
      ...base,
      priority: 4,
      deadlineMs: 0,
      retryWaitMs: -1,
      requeueMs: Number.NaN
    });

    expect(db.queries[0]?.text.replace(/\s+/g, " ")).toContain(
      "lane, workload_class, priority, deadline_ms, deadline_outcome, is_repair, schema_mode, retry_wait_ms, requeue_ms"
    );
    expect(db.queries[0]?.values.slice(23, 32)).toEqual([
      "remote:provider-1",
      "decide",
      2,
      45_000,
      "met",
      true,
      "json",
      813,
      0
    ]);
    expect(db.queries[1]?.values.slice(23, 32)).toEqual([
      null,
      null,
      null,
      null,
      null,
      false,
      null,
      null,
      null
    ]);
    expect(db.queries[2]?.values.slice(25, 28)).toEqual([null, null, null]);
    expect(db.queries[2]?.values.slice(30, 32)).toEqual([null, null]);
  });

  it("records the budget class, the job and the admission estimate, or null when unknown (F4 D14)", async () => {
    const db = new FakeQueryable([[{ id: "run-1" }], [{ id: "run-2" }], [{ id: "run-3" }]]);
    const repository = createAiConfigRepository(db);
    const base = {
      taskType: "summarization",
      provider: "openai-compatible",
      modelId: "gpt-5",
      runtime: "remote",
      durationMs: 12,
      status: "succeeded"
    };
    const jobId = "00000000-0000-4000-8000-0000000000b1";
    await repository.recordTaskRun({
      ...base,
      budgetClass: "background",
      jobId,
      budgetEstimateUsd: 0.25
    });
    await repository.recordTaskRun(base);
    await repository.recordTaskRun({ ...base, jobId: "job-label", budgetEstimateUsd: -1 });

    expect(db.queries[0]?.text.replace(/\s+/g, " ")).toContain(
      "retry_wait_ms, requeue_ms, budget_class, job_id, budget_estimate_usd"
    );
    expect(db.queries[0]?.values.slice(32)).toEqual(["background", jobId, 0.25]);
    expect(db.queries[1]?.values.slice(32)).toEqual([null, null, null]);
    expect(db.queries[2]?.values.slice(32)).toEqual([null, null, null]);
  });

  it("reads the monthly ledger of background remote spend per provider and model (F4 D14)", async () => {
    const db = new FakeQueryable([
      [
        {
          provider: "openai-compatible",
          modelId: "gpt-5",
          calls: "3",
          inputTokens: "1000",
          outputTokens: "500",
          estimatedCalls: "1",
          estimateUsd: 0.25,
          unestimatedCalls: "1",
          unestimatedInputTokens: "0",
          unestimatedOutputTokens: "16384"
        }
      ]
    ]);
    const window = { start: new Date(2026, 9, 1), end: new Date(2026, 10, 1) };
    const ledger = await createAiBudgetRepository(db).monthLedger(window);
    expect(ledger).toEqual([
      {
        provider: "openai-compatible",
        modelId: "gpt-5",
        calls: 3,
        inputTokens: 1_000,
        outputTokens: 500,
        estimatedCalls: 1,
        estimateUsd: 0.25,
        unestimatedCalls: 1,
        unestimatedInputTokens: 0,
        unestimatedOutputTokens: 16_384
      }
    ]);
    const statement = db.queries[0]?.text.replace(/\s+/g, " ") ?? "";
    // The row filter repeats the partial index's predicate so the planner can use it (0061).
    expect(statement).toContain(
      "where lane like 'remote:%' and (budget_class = 'background' or (budget_class is null and priority between 2 and 3))"
    );
    expect(statement).toContain("adapter is distinct from 'cassette-replay'");
    expect(db.queries[0]?.values).toEqual([window.start, window.end]);
  });

  it("loads atomic-note graph inputs with their complete chunk provenance", async () => {
    const db = new FakeQueryable([
      [
        {
          id: "note-1",
          title: "Atomic title",
          ideaStatement: "Atomic idea",
          bodyMarkdown: "Atomic body",
          evidenceChunkIds: ["chunk-1", "chunk-2"]
        }
      ]
    ]);

    const notes = await createAtomicNoteRepository(db).listGraphInputsBySourceItem("source-1");

    expect(notes[0]?.evidenceChunkIds).toEqual(["chunk-1", "chunk-2"]);
    expect(db.queries[0]?.text).toContain("atomic_note_source_links");
    expect(db.queries[0]?.text).toContain("status <> 'rejected'");
  });

  describe("notes are active at birth and optional to review", () => {
    const now = new Date("2026-10-14T10:00:00.000Z");
    const noteRow = (status: string) => ({
      id: "note-1",
      generationId: null,
      supersessionStatus: "current",
      ownership: "source",
      title: "Title",
      bodyMarkdown: "Body",
      ideaStatement: "Idea",
      language: "en",
      status,
      createdFromSourceItemId: "source-1",
      sourceSpanId: null,
      evidenceChunkId: "chunk-1",
      generationProfileId: null,
      aiTaskRunId: null,
      generationProvider: "test",
      generationModel: "test",
      generationRuntime: "test",
      generationPromptVersion: "atomic-note-v4",
      generationKey: "key",
      metadata: {},
      reviewedAt: null,
      createdAt: now,
      updatedAt: now
    });
    /** Answers for the statements `review` runs on an edit, in order. */
    const reviewRows = (status: string, queuesJob: boolean) => [
      [], // begin
      [noteRow(status)], // lock and read the note
      [noteRow(status)], // update
      [], // audit event
      [], // delete the 256-dimension vector
      [], // delete the 768-dimension vector
      [], // delete the 1024-dimension vector
      ...(queuesJob ? [[], [{ id: "job-1" }]] : []), // queue lock, deduplicated insert
      [], // revision
      [] // commit
    ];
    const jobQueries = (db: FakeQueryable) =>
      db.queries.filter((query) => /insert into jobs|pg_advisory_xact_lock/.test(query.text));

    it("inserts generated notes as active and regenerates only notes nobody reviewed or edited", async () => {
      const db = new FakeQueryable([[], [], [noteRow("active")], [], []]);
      await createAtomicNoteRepository(db).upsertGenerated({
        generationId: "00000000-0000-4000-8000-000000000001",
        title: "Title",
        bodyMarkdown: "Body",
        ideaStatement: "Idea",
        sourceItemId: "source-1",
        evidenceChunkId: "chunk-1",
        evidenceLinks: [{ chunkId: "chunk-1" }],
        generationProvider: "test",
        generationModel: "test",
        generationRuntime: "test",
        generationPromptVersion: "atomic-note-v4",
        generationKey: "key"
      });
      const insert = db.queries.find((query) => query.text.includes("insert into atomic_notes"));
      // The status is the column default (active since migration 0045), never a literal here.
      expect(insert?.text.slice(0, insert.text.indexOf("values"))).not.toContain("status");
      expect(insert?.text).not.toContain("'pending_review',");
      expect(insert?.text).toContain("atomic_notes.status::text in ('active', 'pending_review')");
      expect(insert?.text).toContain("humanProtected' is distinct from 'true'");
    });

    describe("what an upsert reports it did", () => {
      const generated = {
        generationId: "00000000-0000-4000-8000-000000000001",
        title: "Title",
        bodyMarkdown: "Body",
        ideaStatement: "Idea",
        sourceItemId: "source-1",
        evidenceChunkId: "chunk-1",
        evidenceLinks: [{ chunkId: "chunk-1" }],
        generationProvider: "test",
        generationModel: "test",
        generationRuntime: "test",
        generationPromptVersion: "atomic-note-v4",
        generationKey: "key"
      };

      it("says created for an inserted row and updated for a rewritten one, without leaking the flag", async () => {
        for (const [inserted, outcome] of [
          [true, "created"],
          [false, "updated"]
        ] as const) {
          const db = new FakeQueryable([[], [{ ...noteRow("active"), inserted }], [], []]);
          const stored = await createAtomicNoteRepository(db).upsertGeneratedWithOutcome(generated);
          expect(stored.outcome).toBe(outcome);
          expect(stored.note).not.toHaveProperty("inserted");
          expect(
            db.queries.find((query) => query.text.includes("insert into atomic_notes"))?.text
          ).toContain("(xmax = 0) as inserted");
        }
      });

      it("says unchanged for a protected row the conflict update skipped, and writes no evidence links", async () => {
        const db = new FakeQueryable([[], [], [noteRow("active")], []]);
        const stored = await createAtomicNoteRepository(db).upsertGeneratedWithOutcome(generated);
        expect(stored.outcome).toBe("unchanged");
        expect(db.queries.some((query) => query.text.includes("atomic_note_source_links"))).toBe(
          false
        );
      });
    });

    it("offers every unreviewed note for the optional review", async () => {
      const db = new FakeQueryable([[noteRow("active"), noteRow("pending_review")]]);
      const pending = await createAtomicNoteRepository(db).listPending(10);
      expect(pending.map((note) => note.status)).toEqual(["active", "pending_review"]);
      expect(db.queries[0]?.text).toContain("status in ('active', 'pending_review')");
    });

    it("queues one deduplicated embedding job per edited note, in the editing transaction", async () => {
      const db = new FakeQueryable(reviewRows("active", true));
      const edited = await createAtomicNoteRepository(db).review({
        id: "note-1",
        action: "edit",
        bodyMarkdown: "Edited body"
      });
      expect(edited?.status).toBe("active");
      const texts = db.queries.map((query) => query.text);
      const lock = texts.findIndex((text) => text.includes("pg_advisory_xact_lock"));
      expect(lock).toBeGreaterThan(texts.findLastIndex((text) => text.includes("delete from")));
      expect(texts[lock + 1]).toContain("insert into jobs");
      expect(texts[lock + 1]).toContain("where not exists");
      expect(texts[lock + 1]).toContain("status = 'queued'");
      expect(db.queries[lock + 1]?.values).toEqual(["note-embedding", 10, "note-1", "source-1"]);
      expect(texts.at(-1)).toBe("commit");
    });

    it.each([
      ["approve", "active"],
      ["discard", "active"]
    ] as const)("queues nothing when the note is %sd", async (action, status) => {
      const rows = reviewRows(status, false);
      rows.splice(4, 3);
      const db = new FakeQueryable(rows);
      await createAtomicNoteRepository(db).review({ id: "note-1", action });
      expect(jobQueries(db)).toEqual([]);
    });

    it.each(["rejected", "archived"])(
      "does not rebuild the vector of a %s note",
      async (status) => {
        const db = new FakeQueryable(reviewRows(status, false));
        await createAtomicNoteRepository(db).review({
          id: "note-1",
          action: "edit",
          bodyMarkdown: "Edited body"
        });
        expect(jobQueries(db)).toEqual([]);
      }
    );

    it("reports whether a job was queued or one already waited", async () => {
      const queued = new FakeQueryable([[], [{ id: "job" }]]);
      const waiting = new FakeQueryable([[], []]);
      const input = { atomicNoteId: "note-1", sourceItemId: "source-1" };
      expect(await createJobRepository(queued).enqueueNoteEmbedding(input)).toBe(true);
      expect(await createJobRepository(waiting).enqueueNoteEmbedding(input)).toBe(false);
      // A running job may have read the text before the edit, so only a queued one deduplicates.
      expect(waiting.queries[1]?.text).toContain("status = 'queued'");
      expect(waiting.queries[1]?.text).not.toContain("'running'");
    });

    it("recognizes a vector built from the current text of a note", async () => {
      const db = new FakeQueryable([[], [], [{ "?column?": 1 }]]);
      expect(await createEmbeddingRepository(db).hasContentHash("atomic_note", "note-1", "h")).toBe(
        true
      );
      expect(db.queries.map((query) => query.text.includes("embeddings_"))).toEqual([
        true,
        true,
        true
      ]);
      const none = new FakeQueryable([[], [], []]);
      expect(await createEmbeddingRepository(none).hasContentHash("atomic_note", "n", "h")).toBe(
        false
      );
      // A re-embedding after a space change counts only a vector of the new space (D26).
      const space = new FakeQueryable([[], [], []]);
      expect(
        await createEmbeddingRepository(space).hasContentHash(
          "atomic_note",
          "n",
          "h",
          "native-v2:b"
        )
      ).toBe(false);
      expect(space.queries.map((query) => query.values[3])).toEqual([
        "native-v2:b",
        "native-v2:b",
        "native-v2:b"
      ]);
      expect(none.queries.map((query) => query.values[3])).toEqual([null, null, null]);
    });

    it("queues the re-embedding of many notes in one statement, naming the space (D26)", async () => {
      const db = new FakeQueryable([[{}, {}]]);
      const notes = [
        { atomicNoteId: "note-1", sourceItemId: "source-1" },
        { atomicNoteId: "note-2", sourceItemId: "source-1" }
      ];
      expect(await createJobRepository(db).enqueueNoteEmbeddings(notes, { spaceKey: "b" })).toBe(2);
      expect(db.queries).toHaveLength(1);
      expect(db.queries[0]?.text).toContain("status = 'queued'");
      // A job queued for another space does not hold a note back: it ends without a call.
      expect(db.queries[0]?.text).toContain("payload->>'spaceKey' is not distinct from $5");
      expect(db.queries[0]?.values).toEqual([
        "note-embedding",
        10,
        ["note-1", "note-2"],
        ["source-1", "source-1"],
        "b"
      ]);
      expect(await createJobRepository(new FakeQueryable([])).enqueueNoteEmbeddings([])).toBe(0);
    });

    it("tells whether a re-embedding job of a space is still queued or running (D26)", async () => {
      const db = new FakeQueryable([[{ open: true }], [{ open: false }]]);
      const jobs = createJobRepository(db);
      expect(await jobs.hasOpenSpaceEmbeddings("b")).toBe(true);
      expect(await jobs.hasOpenSpaceEmbeddings("c")).toBe(false);
      expect(db.queries[0]?.text).toContain("status in ('queued', 'running')");
      expect(db.queries.map((query) => query.values)).toEqual([
        ["note-embedding", "b"],
        ["note-embedding", "c"]
      ]);
    });
  });

  it("finds the newest vector of each note built from its current text, in any dimension", async () => {
    const note = "00000000-0000-4000-8000-000000000001";
    const row = (model: string, createdAt: string, embedding: string) => ({
      targetId: note,
      embedding,
      model,
      provider: "local",
      runtime: "mlx",
      strategy: `native-v2:${model}`,
      createdAt: new Date(createdAt)
    });
    const db = new FakeQueryable([
      [row("old-model", "2026-10-01T00:00:00Z", "[1,2]")],
      [],
      [row("new-model", "2026-10-02T00:00:00Z", "[3,4]")]
    ]);

    const found = await createEmbeddingRepository(db).findCurrentNoteVectors([
      { id: note, contentHash: "hash" },
      { id: "00000000-0000-4000-8000-000000000002", contentHash: "other" }
    ]);

    expect([...found.keys()]).toEqual([note]);
    expect(found.get(note)).toEqual({
      targetId: note,
      embedding: [3, 4],
      model: "new-model",
      provider: "local",
      runtime: "mlx",
      strategy: "native-v2:new-model"
    });
    expect(db.queries).toHaveLength(3);
    expect(db.queries[0]?.text).toContain("e.content_hash");
    expect(db.queries[0]?.text).toContain("e.target_type = 'atomic_note'");
    expect(db.queries[0]?.values).toEqual([
      [note, "00000000-0000-4000-8000-000000000002"],
      ["hash", "other"]
    ]);
    const none = new FakeQueryable([]);
    expect((await createEmbeddingRepository(none).findCurrentNoteVectors([])).size).toBe(0);
    expect(none.queries).toHaveLength(0);
  });

  it("tells a scored candidate that has no vector from one that is dissimilar", async () => {
    const db = new FakeQueryable([[], []]);
    const notes = createAtomicNoteRepository(db);

    await notes.scoreMatchingCandidates({
      noteId: "note-1",
      candidateIds: ["00000000-0000-4000-8000-000000000001"],
      embedding: Array.from({ length: 256 }, () => 0),
      embeddingModel: "embedding-model",
      embeddingSpaceKey: "space",
      embeddingProvider: "local",
      embeddingRuntime: "mlx"
    });
    await notes.scoreMatchingCandidates({
      noteId: "note-1",
      candidateIds: ["00000000-0000-4000-8000-000000000001"]
    });

    expect(db.queries[0]?.text).toContain('(e.embedding is not null) as "hasVector"');
    expect(db.queries[1]?.text).toContain('false as "hasVector"');
  });

  it("retrieves atomic-note text and vector rankings independently", async () => {
    // The vector query first sets the HNSW scan settings for its transaction.
    const db = new FakeQueryable([[], [], [], []]);
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
    expect(db.queries[1]?.text).toContain("hnsw.iterative_scan");
    expect(db.queries[2]?.text).toContain('order by "vectorScore" desc');
    expect(db.queries[2]?.text).toContain("from embeddings_256 e");
    expect(db.queries[3]?.text).toContain("candidate.id = any($2::uuid[])");
  });

  it("persists per-batch ingestion progress without replacing the stage checkpoint", async () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const db = new FakeQueryable([
      [],
      [
        {
          id: "run-1",
          sourceItemId: "source-1",
          jobId: "job-1",
          status: "running",
          currentStage: "knowledgeGraph",
          stagesCheckpoint: {
            knowledgeGraph: {
              status: "running",
              progress: 0.5,
              metadata: { completed: 1, total: 2 }
            }
          },
          error: null,
          startedAt: now,
          completedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ]
    ]);

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
      "run-1",
      "knowledgeGraph",
      0.5,
      { completed: 1, total: 2 }
    ]);
  });
});
