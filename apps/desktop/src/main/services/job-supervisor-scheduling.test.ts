import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord, PgPool } from "@app/db";
import { JobSupervisor } from "./job-supervisor.js";

const mocks = vi.hoisted(() => ({
  jobs: {
    recoverInterrupted: vi.fn(),
    findById: vi.fn(),
    retry: vi.fn(),
    claimNext: vi.fn(),
    nextQueuedOfType: vi.fn(),
    update: vi.fn()
  },
  runs: {
    recoverInterrupted: vi.fn(),
    findById: vi.fn(),
    fail: vi.fn(),
    findReleasableBatchRun: vi.fn()
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

  it("attempts foreground claims even when wiki and maintenance admission fail", async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error("missing projection clock"));
    const maintenanceTick = vi.fn().mockRejectedValue(new Error("maintenance unavailable"));
    supervisor = new JobSupervisor({
      getPool: () => ({}) as PgPool,
      maintenanceTick,
      obsidianSyncService: { projectSource: vi.fn(), wiki: { enqueue } } as unknown as NonNullable<
        ConstructorParameters<typeof JobSupervisor>[0]["obsidianSyncService"]
      >
    });
    mocks.jobs.claimNext.mockResolvedValue(null);
    mocks.jobs.nextQueuedOfType.mockResolvedValue(null);
    await expect(supervisor.runOnce()).resolves.toBeNull();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(maintenanceTick).toHaveBeenCalledOnce();
    expect(mocks.jobs.claimNext).toHaveBeenCalledOnce();
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
      // An unreadable payload is not a deterministic document failure: the job is queued again.
      mocks.jobs.claimNext.mockResolvedValue({
        ...failingJob(1),
        payload: { batchId: "batch", sourceItemId: "source" }
      });
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
