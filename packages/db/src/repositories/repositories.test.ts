import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createSettingsRepository } from "./settingsRepository.js";
import { createSourceItemRepository } from "./sourceItemRepository.js";
import { createSourceSummaryRepository } from "./sourceSummaryRepository.js";
import { createLocalModelRepository } from "./localModelRepository.js";
import { createJobRepository } from "./jobRepository.js";
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
    const db = new FakeQueryable([[
      {
        id: "summary-1",
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
      }
    ]]);
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
    expect(db.queries[0]?.text).toContain("insert into source_summaries");
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
});
