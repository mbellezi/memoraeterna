import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError } from "@app/ai";
import type { JobRecord, PgPool } from "@app/db";
import { JobSupervisor } from "./job-supervisor.js";
import type { KnowledgeService } from "./knowledge-service.js";

const mocks = vi.hoisted(() => ({
  jobs: {
    recoverInterrupted: vi.fn(),
    findById: vi.fn(),
    retry: vi.fn(),
    claimNext: vi.fn(),
    update: vi.fn(),
    activeIdsForBatch: vi.fn(),
    requestCancel: vi.fn()
  },
  runs: {
    recoverInterrupted: vi.fn(),
    findById: vi.fn(),
    fail: vi.fn(),
    findReleasableBatchRun: vi.fn(),
    listByBatch: vi.fn(),
    cancel: vi.fn()
  },
  hierarchy: { refreshBatch: vi.fn() }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createJobRepository: () => mocks.jobs,
  createIngestionRunRepository: () => mocks.runs,
  createHierarchicalIngestionRepository: () => mocks.hierarchy
}));
let supervisor: JobSupervisor | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.jobs.findById.mockResolvedValue({
    type: "ingestion",
    status: "canceled",
    payload: { ingestionRunId: "run" }
  });
  mocks.jobs.retry.mockResolvedValue({ id: "retry", status: "queued" });
  mocks.runs.findById.mockResolvedValue({ status: "canceled", stagesCheckpoint: {} });
});
afterEach(async () => {
  await supervisor?.stop();
  vi.useRealTimers();
});

describe("ingestion queue scheduling", () => {
  it("resumes polling after a database or admission failure", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool, pollIntervalMs: 100 });
    const run = vi
      .spyOn(supervisor, "runOnce")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(null);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps polling when idle model cleanup rejects", async () => {
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValue(undefined);
    supervisor = new JobSupervisor({
      getPool: () => ({}) as PgPool,
      pollIntervalMs: 100,
      releaseAiRuntime: release
    });
    const run = vi.spyOn(supervisor, "runOnce").mockResolvedValue(null);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("admits the vault projection on the compute worker and claims even when admission fails", async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error("missing projection clock"));
    supervisor = new JobSupervisor({
      getPool: () => ({}) as PgPool,
      obsidianSyncService: {
        projectSource: vi.fn(),
        wiki: { enqueue, execute: vi.fn() }
      } as unknown as NonNullable<
        ConstructorParameters<typeof JobSupervisor>[0]["obsidianSyncService"]
      >
    });
    mocks.jobs.claimNext.mockResolvedValue(null);
    // The heavy pass neither admits nor claims the projection: it is light work (D30, D33).
    await expect(supervisor.runOnce()).resolves.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(mocks.jobs.claimNext).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.not.arrayContaining(["obsidian-wiki"]),
      "heavy"
    );
    await expect(supervisor.runLightOnce("compute")).resolves.toBeNull();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(mocks.jobs.claimNext).toHaveBeenLastCalledWith(
      expect.any(String),
      ["obsidian-wiki"],
      "light"
    );
    // The model worker never admits or claims it.
    await expect(supervisor.runLightOnce("model")).resolves.toBeNull();
    expect(enqueue).toHaveBeenCalledOnce();
  });
  it("cancels the active jobs of a batch and its pending and running runs", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
    mocks.jobs.activeIdsForBatch.mockResolvedValue(["job-a", "job-b"]);
    mocks.jobs.requestCancel.mockImplementation(async (id: string) => ({
      id,
      type: "ingestion",
      status: "canceled",
      payload: {}
    }));
    mocks.runs.listByBatch.mockResolvedValue([
      { id: "run-1", status: "running" },
      { id: "run-2", status: "succeeded" },
      { id: "run-3", status: "pending" }
    ]);
    await expect(supervisor.cancelBatch("batch")).resolves.toBeNull();
    expect(mocks.jobs.activeIdsForBatch).toHaveBeenCalledWith("batch");
    expect(mocks.jobs.requestCancel.mock.calls.map(([id]) => id)).toEqual(["job-a", "job-b"]);
    expect(mocks.runs.cancel.mock.calls.map(([id]) => id)).toEqual(["run-1", "run-3"]);
    expect(mocks.hierarchy.refreshBatch).toHaveBeenCalledWith("batch");
  });
  it("fails a document without text with a localized error and does not retry it", async () => {
    // A web capture whose Defuddle result was empty used to fail here as "missing_markdown".
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
    mocks.jobs.claimNext.mockResolvedValue({
      id: "job",
      type: "ingestion",
      attempts: 1,
      maxAttempts: 3,
      payload: {
        ingestionRunId: "run",
        documentId: "document",
        sourceItemId: "source",
        markdown: "",
        processingMode: "content"
      }
    });
    mocks.jobs.update.mockResolvedValue({ id: "job", status: "failed" });
    await supervisor.runOnce();
    expect(mocks.runs.fail).toHaveBeenCalledWith("run", "errors.conversion.emptyResult");
    expect(mocks.jobs.update).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({ status: "failed", error: "errors.conversion.emptyResult" })
    );
  });
  describe("retrying a failed job", () => {
    const failing = (attempts = 1, maxAttempts = 3) => ({
      id: "job",
      type: "ingestion",
      attempts,
      maxAttempts,
      payload: { ingestionRunId: "run", documentId: "document", sourceItemId: "source" }
    });
    const fail = async (error: unknown, job = failing()) => {
      supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
      vi.spyOn(
        supervisor as never as { executeIngestion: () => Promise<unknown> },
        "executeIngestion"
      ).mockRejectedValue(error);
      mocks.jobs.claimNext.mockResolvedValue(job);
      mocks.jobs.update.mockResolvedValue({ id: "job" });
      await supervisor.runOnce();
      return mocks.jobs.update.mock.calls.at(-1)?.[1] as {
        status: string;
        error: string | null;
        runAfter: Date;
        finishedAt: Date | null;
      };
    };

    it("fails invalid model output once, with its real error, instead of retrying it", async () => {
      const update = await fail(new Error("knowledge_graph_output_invalid:schema_validation"));
      expect(update).toMatchObject({
        status: "failed",
        error: "knowledge_graph_output_invalid:schema_validation"
      });
      expect(update.finishedAt).toBeInstanceOf(Date);
      expect(mocks.runs.fail).toHaveBeenCalledWith(
        "run",
        "knowledge_graph_output_invalid:schema_validation"
      );
    });

    it.each([
      [
        "a rejected request",
        new AiProviderError("bad", { kind: "http", transient: false, status: 400 })
      ],
      [
        "a context overflow",
        new AiProviderError("long", { kind: "context_overflow", transient: false })
      ],
      ["an unclassified error", new Error("something unexpected")]
    ])("does not retry %s", async (_name, error) => {
      expect(await fail(error)).toMatchObject({ status: "failed" });
    });

    it("queues a transient provider failure again after a growing backoff", async () => {
      const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
      const before = Date.now();
      const first = await fail(busy, failing(1));
      expect(first).toMatchObject({ status: "queued", finishedAt: null });
      expect(first.runAfter.getTime() - before).toBeGreaterThanOrEqual(2_000);
      expect(first.runAfter.getTime() - before).toBeLessThan(3_000);
      const second = await fail(busy, failing(2));
      expect(second.runAfter.getTime() - before).toBeGreaterThanOrEqual(4_000);
    });

    it("waits at least as long as the provider asked with Retry-After", async () => {
      const limited = new AiProviderError("limited", {
        kind: "http",
        transient: true,
        status: 429,
        retryAfterMs: 90_000
      });
      const before = Date.now();
      const update = await fail(limited, failing(1));
      expect(update.status).toBe("queued");
      expect(update.runAfter.getTime() - before).toBeGreaterThanOrEqual(90_000);
    });

    it("stops retrying a transient failure when the attempts are used up", async () => {
      const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
      expect(await fail(busy, failing(3, 3))).toMatchObject({ status: "failed" });
    });

    it("keeps retrying a crashed worker", async () => {
      expect(await fail(new Error("Worker exited with code 1."))).toMatchObject({
        status: "queued"
      });
    });
  });
  describe("re-embedding an edited note", () => {
    const embeddingJob = (payload: Record<string, unknown> = {}, attempts = 1) => ({
      id: "job",
      type: "note-embedding",
      attempts,
      maxAttempts: 3,
      progress: 0,
      payload: { atomicNoteId: "note-1", sourceItemId: "source-1", ...payload } as Record<
        string,
        unknown
      >
    });
    const runWith = async (embedAtomicNote: ReturnType<typeof vi.fn>, job = embeddingJob()) => {
      supervisor = new JobSupervisor({
        getPool: () => ({}) as PgPool,
        knowledgeService: { embedAtomicNote } as unknown as KnowledgeService
      });
      mocks.jobs.claimNext.mockResolvedValue(job);
      mocks.jobs.update.mockResolvedValue({ id: "job" });
      await supervisor.runOnce();
      return mocks.jobs.update.mock.calls.at(-1)?.[1] as {
        status: string;
        error: string | null;
        result?: unknown;
        runAfter: Date;
      };
    };

    it("embeds the note with the embedding model and records the outcome", async () => {
      const embedAtomicNote = vi.fn().mockResolvedValue({ embedded: true });
      const update = await runWith(embedAtomicNote);
      expect(embedAtomicNote).toHaveBeenCalledOnce();
      expect(embedAtomicNote).toHaveBeenCalledWith(
        "note-1",
        expect.any(AbortSignal),
        expect.objectContaining({ jobId: "job", sourceItemId: "source-1" })
      );
      expect(update).toMatchObject({ status: "succeeded", result: { embedded: true } });
    });

    it("finishes without error when there is nothing to embed", async () => {
      const update = await runWith(
        vi.fn().mockResolvedValue({ embedded: false, reason: "note_not_current" })
      );
      expect(update).toMatchObject({
        status: "succeeded",
        result: { embedded: false, reason: "note_not_current" }
      });
    });

    it("queues a transient provider failure again like any other job", async () => {
      const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
      const update = await runWith(vi.fn().mockRejectedValue(busy));
      expect(update).toMatchObject({ status: "queued" });
      expect(update.runAfter.getTime()).toBeGreaterThan(Date.now());
    });

    it("fails once when the job does not name a note", async () => {
      const embedAtomicNote = vi.fn();
      const update = await runWith(embedAtomicNote, {
        ...embeddingJob(),
        payload: { sourceItemId: "source-1" }
      });
      expect(embedAtomicNote).not.toHaveBeenCalled();
      expect(update).toMatchObject({ status: "failed", error: "missing_atomicNoteId" });
    });
  });
  describe("a batch run that fails for good", () => {
    const failingJob = (attempts: number) => ({
      id: "job",
      type: "ingestion",
      attempts,
      maxAttempts: 3,
      payload: {
        ingestionRunId: "run",
        batchId: "batch",
        documentId: "document",
        sourceItemId: "source",
        markdown: "",
        processingMode: "content"
      }
    });

    it("queues the job of a sibling that parked its matching behind it", async () => {
      supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
      mocks.jobs.claimNext.mockResolvedValue(failingJob(1));
      mocks.jobs.update.mockResolvedValue({ id: "job", status: "failed" });
      mocks.runs.findReleasableBatchRun.mockResolvedValue({ runId: "parked", jobId: "parked-job" });
      mocks.jobs.retry.mockResolvedValue({ id: "parked-job", status: "queued" });
      await supervisor.runOnce();
      expect(mocks.runs.findReleasableBatchRun).toHaveBeenCalledWith("batch");
      expect(mocks.jobs.retry).toHaveBeenCalledWith("parked-job");
    });

    it("releases nothing while the failure is still going to be retried", async () => {
      supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
      // A provider that is briefly unavailable is not a deterministic failure: the job is queued again.
      vi.spyOn(
        supervisor as never as { executeIngestion: () => Promise<unknown> },
        "executeIngestion"
      ).mockRejectedValue(
        new AiProviderError("busy", { kind: "http", transient: true, status: 503 })
      );
      mocks.jobs.claimNext.mockResolvedValue(failingJob(1));
      mocks.jobs.update.mockResolvedValue({ id: "job", status: "queued" });
      await supervisor.runOnce();
      expect(mocks.jobs.update).toHaveBeenCalledWith(
        "job",
        expect.objectContaining({ status: "queued" })
      );
      expect(mocks.runs.findReleasableBatchRun).not.toHaveBeenCalled();
      expect(mocks.jobs.retry).not.toHaveBeenCalled();
    });

    it("keeps going when the release itself cannot be determined", async () => {
      const logger = { error: vi.fn(), warn: vi.fn() };
      supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool, logger });
      mocks.jobs.claimNext.mockResolvedValue(failingJob(1));
      mocks.jobs.update.mockResolvedValue({ id: "job", status: "failed" });
      mocks.runs.findReleasableBatchRun.mockRejectedValue(new Error("database restarting"));
      await expect(supervisor.runOnce()).resolves.toMatchObject({ status: "failed" });
      expect(logger.warn).toHaveBeenCalledWith("database restarting");
    });
  });
  it("coalesces retries during an active drain instead of starting overlapping ingestion", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
    let finish!: (job: JobRecord) => void;
    const pending = new Promise<JobRecord>((resolve) => {
      finish = resolve;
    });
    const run = vi
      .spyOn(supervisor, "runOnce")
      .mockImplementationOnce(() => pending)
      .mockResolvedValue(null);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await supervisor.retry("retry");
    await supervisor.retry("retry");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    finish({ id: "first" } as JobRecord);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("keeps idle polling and stops scheduling after shutdown", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool, pollIntervalMs: 100 });
    const run = vi.spyOn(supervisor, "runOnce").mockResolvedValue(null);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(3);
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
