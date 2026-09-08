import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord, PgPool } from "@app/db";
import { JobSupervisor } from "./job-supervisor.js";

const mocks = vi.hoisted(() => ({ jobs: { recoverInterrupted: vi.fn(), findById: vi.fn(), retry: vi.fn() }, runs: { recoverInterrupted: vi.fn(), findById: vi.fn() } }));
vi.mock("@app/db", async (original) => ({ ...await original<typeof import("@app/db")>(), createJobRepository: () => mocks.jobs, createIngestionRunRepository: () => mocks.runs }));
let supervisor: JobSupervisor | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  mocks.jobs.findById.mockResolvedValue({ type: "ingestion", status: "canceled", payload: { ingestionRunId: "run" } });
  mocks.jobs.retry.mockResolvedValue({ id: "retry", status: "queued" });
  mocks.runs.findById.mockResolvedValue({ status: "canceled", stagesCheckpoint: {} });
});
afterEach(async () => { await supervisor?.stop(); vi.useRealTimers(); });

describe("ingestion queue scheduling", () => {
  it("coalesces retries during an active drain instead of starting overlapping ingestion", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
    let finish!: (job: JobRecord) => void;
    const pending = new Promise<JobRecord>((resolve) => { finish = resolve; });
    const run = vi.spyOn(supervisor, "runOnce").mockImplementationOnce(() => pending).mockResolvedValue(null);
    await supervisor.start(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await supervisor.retry("retry"); await supervisor.retry("retry");
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
    await supervisor.start(); await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(3);
    await supervisor.stop(); await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
