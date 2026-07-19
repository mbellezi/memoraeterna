import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { PgPool } from "../client.js";
import { createProcessingTaskRepository } from "./processingTaskRepository.js";

class FakeProcessingTaskPool {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;

  constructor(private readonly hasTarget = true) {}

  async connect() {
    return {
      query: this.query.bind(this),
      release: () => { this.released = true; }
    };
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, values });
    const normalized = text.trim();
    const rows = normalized.startsWith("select run.id") && this.hasTarget
      ? [{ runId: "run-1", batchId: "batch-1" }]
      : normalized.startsWith("select count(*)")
        ? [{ count: 0 }]
        : [];
    const rowCount = normalized.startsWith("delete from jobs") ? 3
      : normalized.startsWith("delete from ingestion_runs") ? 1
      : normalized.startsWith("delete from processing_batches") ? 1
      : rows.length;
    return {
      command: "SELECT",
      rowCount,
      oid: 0,
      fields: [],
      rows: rows as T[]
    };
  }
}

describe("processing task repository", () => {
  it("atomically deletes a user-canceled run, all child jobs, and its orphaned batch", async () => {
    const pool = new FakeProcessingTaskPool();
    const result = await createProcessingTaskRepository(pool as unknown as PgPool)
      .deleteCanceledHierarchy("job-1");

    expect(result).toEqual({
      deletedJobs: 3,
      deletedRuns: 1,
      batchId: "batch-1",
      deletedBatch: true
    });
    expect(pool.queries.map((query) => query.text.trim())).toEqual([
      "begin",
      expect.stringContaining("job.status = 'canceled'"),
      expect.stringContaining("delete from jobs"),
      expect.stringContaining("delete from ingestion_runs"),
      expect.stringContaining("select count(*)::int as count"),
      expect.stringContaining("delete from processing_batches"),
      "commit"
    ]);
    expect(pool.queries[1]?.text).toContain("job.cancel_requested_at is not null");
    expect(pool.queries[2]?.text).toContain("payload->>'ingestionRunId' = $2");
    expect(pool.released).toBe(true);
  });

  it("does not delete a task that fails the canceled-by-user guard", async () => {
    const pool = new FakeProcessingTaskPool(false);
    const result = await createProcessingTaskRepository(pool as unknown as PgPool)
      .deleteCanceledHierarchy("job-1");

    expect(result).toBeNull();
    expect(pool.queries.map((query) => query.text.trim())).toEqual([
      "begin",
      expect.stringContaining("job.cancel_requested_at is not null"),
      "commit"
    ]);
    expect(pool.released).toBe(true);
  });
});
