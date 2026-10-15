import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError } from "@app/ai";
import type { JobLane, JobRecord, PgPool } from "@app/db";
import { JobSupervisor } from "./job-supervisor.js";
import type { LightJobRegistry } from "./job-lanes.js";

/** An in-memory jobs table that claims like the repository: lane, type set, due, priority order. */
const queue = vi.hoisted(() => {
  const jobs: JobRecord[] = [];
  const find = (id: string) => jobs.find((job) => job.id === id) ?? null;
  return {
    jobs,
    find,
    repository: {
      recoverInterrupted: async () => 0,
      findById: async (id: string) => find(id),
      reportProgress: async () => null,
      claimNext: async (workerId: string, types?: readonly string[], lane?: JobLane) => {
        const job = jobs
          .filter(
            (candidate) =>
              candidate.status === "queued" &&
              candidate.runAfter.getTime() <= Date.now() &&
              (!lane || candidate.lane === lane) &&
              (!types || types.includes(candidate.type))
          )
          .sort(
            (a, b) => b.priority - a.priority || a.runAfter.getTime() - b.runAfter.getTime()
          )[0];
        if (!job) return null;
        Object.assign(job, { status: "running", lockedBy: workerId, attempts: job.attempts + 1 });
        return { ...job };
      },
      update: async (id: string, input: Partial<JobRecord>) => {
        const job = find(id);
        if (job) Object.assign(job, input);
        return job ? { ...job } : null;
      }
    }
  };
});
const claims = vi.hoisted(() => [] as Array<{ workerId: string; types?: string[]; lane?: string }>);
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createJobRepository: () => ({
    ...queue.repository,
    claimNext: (workerId: string, types?: readonly string[], lane?: JobLane) => {
      claims.push({ workerId, ...(types ? { types: [...types] } : {}), ...(lane ? { lane } : {}) });
      return queue.repository.claimNext(workerId, types, lane);
    }
  }),
  createIngestionRunRepository: () => ({ recoverInterrupted: async () => 0 }),
  createHierarchicalIngestionRepository: () => ({ refreshBatch: async () => undefined })
}));

let sequence = 0;
function enqueue(type: string, lane: JobLane, payload: Record<string, unknown> = {}): JobRecord {
  const now = new Date();
  const job: JobRecord = {
    id: `job-${++sequence}`,
    type,
    status: "queued",
    priority: 0,
    payload,
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
    lane,
    dedupeKey: null,
    createdAt: now,
    updatedAt: now
  };
  queue.jobs.push(job);
  return job;
}
const statusOf = (job: JobRecord) => queue.find(job.id)?.status;

/** A model call that holds the single AI slot for `ms`, released early only by cancellation. */
function holdAiSlot(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Canceled.", "AbortError"));
    });
  });
}

const finishedAt = new Map<string, number>();
const topicJobs = (overrides: Partial<Record<string, LightJobRegistry[string]>> = {}) =>
  ({
    "topic-place": {
      needsModel: false,
      execute: async (job: JobRecord) => {
        finishedAt.set(job.id, Date.now());
        return { placed: 1 };
      }
    },
    "topic-gate": {
      needsModel: true,
      execute: async (job: JobRecord, signal: AbortSignal) => {
        await holdAiSlot(2_000, signal);
        finishedAt.set(job.id, Date.now());
        return { gated: 1 };
      }
    },
    ...overrides
  }) as LightJobRegistry;

let supervisor: JobSupervisor | undefined;
const pool = () => ({}) as PgPool;
beforeEach(() => {
  vi.useFakeTimers();
  queue.jobs.length = 0;
  claims.length = 0;
  finishedAt.clear();
});
afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  vi.useRealTimers();
});

describe("heavy and light lanes", () => {
  it("completes a light compute job within 100 ms while a model job holds the AI slot for 2 s", async () => {
    supervisor = new JobSupervisor({ getPool: pool, pollIntervalMs: 500, lightJobs: topicJobs() });
    await supervisor.start();
    const gate = enqueue("topic-gate", "light");
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(10);
    expect(statusOf(gate)).toBe("running");

    const enqueuedAt = Date.now();
    const place = enqueue("topic-place", "light");
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(100);
    expect(statusOf(place)).toBe("succeeded");
    expect(finishedAt.get(place.id)! - enqueuedAt).toBeLessThanOrEqual(100);
    expect(statusOf(gate)).toBe("running");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(statusOf(gate)).toBe("succeeded");
  });

  it("completes a light job within 100 ms while a heavy job runs for 2 s", async () => {
    supervisor = new JobSupervisor({ getPool: pool, pollIntervalMs: 500, lightJobs: topicJobs() });
    vi.spyOn(
      supervisor as never as {
        executeIngestion: (job: JobRecord, controller: AbortController) => Promise<unknown>;
      },
      "executeIngestion"
    ).mockImplementation(async (_job, controller) => {
      await holdAiSlot(2_000, controller.signal);
      return { ingested: true };
    });
    const heavy = enqueue("ingestion", "heavy", { ingestionRunId: "run" });
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(statusOf(heavy)).toBe("running");

    const enqueuedAt = Date.now();
    const place = enqueue("topic-place", "light");
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(100);
    expect(finishedAt.get(place.id)! - enqueuedAt).toBeLessThanOrEqual(100);
    expect(statusOf(heavy)).toBe("running");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(statusOf(heavy)).toBe("succeeded");
  });

  it("gives each loop its own lane and the light workers disjoint type sets", async () => {
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({
        "topic-sweep": { needsModel: false, execute: async () => ({}) },
        "topic-name": { needsModel: true, execute: async () => ({}) }
      })
    });
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    const heavy = claims.filter((claim) => claim.lane === "heavy");
    const compute = claims.filter((claim) => claim.workerId.endsWith(":light-compute"));
    const model = claims.filter((claim) => claim.workerId.endsWith(":light-model"));
    expect(heavy).toHaveLength(1);
    expect(heavy[0]!.types).toContain("ingestion");
    expect(heavy[0]!.types).not.toContain("organization");
    expect(heavy[0]!.types).not.toContain("maintenance");
    expect(heavy[0]!.types!.some((type) => type.startsWith("topic-"))).toBe(false);
    expect(compute).toEqual([
      expect.objectContaining({ lane: "light", types: ["topic-place", "topic-sweep"] })
    ]);
    expect(model).toEqual([
      expect.objectContaining({ lane: "light", types: ["topic-gate", "topic-name"] })
    ]);
    expect(claims).toHaveLength(3);
  });

  it("never claims the retired organization and maintenance job types", async () => {
    supervisor = new JobSupervisor({ getPool: pool, lightJobs: topicJobs() });
    const organization = enqueue("organization", "heavy", { organizationRunId: "run" });
    const maintenance = enqueue("maintenance", "heavy", { maintenanceRunId: "run" });
    await expect(supervisor.runOnce()).resolves.toBeNull();
    expect(statusOf(organization)).toBe("queued");
    expect(statusOf(maintenance)).toBe("queued");
  });

  it("keeps runOnce a heavy pass that never takes light work", async () => {
    supervisor = new JobSupervisor({ getPool: pool, lightJobs: topicJobs() });
    const place = enqueue("topic-place", "light");
    await expect(supervisor.runOnce()).resolves.toBeNull();
    expect(statusOf(place)).toBe("queued");
    expect(claims).toEqual([expect.objectContaining({ lane: "heavy" })]);
    await expect(supervisor.runLightOnce("compute")).resolves.toMatchObject({
      id: place.id,
      status: "succeeded",
      result: { placed: 1 }
    });
  });

  it("runs only the heavy loop when no light job type is registered", async () => {
    supervisor = new JobSupervisor({ getPool: pool, pollIntervalMs: 100 });
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.lane === "heavy")).toBe(true);
  });

  it("wakes one lane without running a pass of the other", async () => {
    supervisor = new JobSupervisor({ getPool: pool, pollIntervalMs: 500, lightJobs: topicJobs() });
    const heavyPass = vi.spyOn(supervisor, "runOnce");
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(heavyPass).toHaveBeenCalledTimes(1);
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(10);
    expect(heavyPass).toHaveBeenCalledTimes(1);
    supervisor.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(heavyPass).toHaveBeenCalledTimes(2);
  });

  it("awaits every loop on stop, including a light job still running", async () => {
    let release!: () => void;
    const slowPlace = vi.fn(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          release = () => resolve({});
        })
    );
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({ "topic-place": { needsModel: false, execute: slowPlace } })
    });
    await supervisor.start();
    const place = enqueue("topic-place", "light");
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(10);
    expect(statusOf(place)).toBe("running");

    let stopped = false;
    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    // The stop canceled it while it ran, so its result is not recorded as a success.
    expect(statusOf(place)).toBe("canceled");
    const claimsAfterStop = claims.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(claims).toHaveLength(claimsAfterStop);
  });

  it("releases local models only when every loop is idle", async () => {
    const releaseAiRuntime = vi.fn(async () => undefined);
    supervisor = new JobSupervisor({
      getPool: pool,
      pollIntervalMs: 500,
      releaseAiRuntime,
      lightJobs: topicJobs()
    });
    await supervisor.start();
    const gate = enqueue("topic-gate", "light");
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(10);
    expect(statusOf(gate)).toBe("running");
    releaseAiRuntime.mockClear();

    // The heavy loop and the compute worker poll idle while the model worker still runs.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(releaseAiRuntime).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(statusOf(gate)).toBe("succeeded");
    // The heavy loop's next idle poll releases them, once per poll as before the lanes.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(releaseAiRuntime).toHaveBeenCalledTimes(2);
  });

  it("queues a transient light failure again after a backoff and fails any other once", async () => {
    const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
    const execute = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(new Error("bad"));
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({ "topic-place": { needsModel: false, execute } })
    });
    const place = enqueue("topic-place", "light");
    const before = Date.now();
    await expect(supervisor.runLightOnce("compute")).resolves.toMatchObject({
      status: "queued",
      error: "busy",
      finishedAt: null
    });
    expect(queue.find(place.id)!.runAfter.getTime() - before).toBeGreaterThanOrEqual(2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(supervisor.runLightOnce("compute")).resolves.toMatchObject({
      status: "failed",
      error: "bad",
      attempts: 2
    });
  });

  it("refuses a light job type that the heavy lane already runs", () => {
    expect(
      () =>
        new JobSupervisor({
          getPool: pool,
          lightJobs: { ingestion: { needsModel: false, execute: async () => ({}) } }
        })
    ).toThrow("job_lane_conflict:ingestion");
  });

  it("leaves a held light type queued while its worker runs the others, then claims it", async () => {
    let held = true;
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({
        "topic-place": {
          needsModel: false,
          held: () => held,
          execute: async () => ({ placed: 1 })
        },
        "topic-sweep": { needsModel: false, execute: async () => ({ swept: true }) }
      })
    });
    const place = enqueue("topic-place", "light");
    const sweep = enqueue("topic-sweep", "light");
    await expect(supervisor.runLightOnce("compute")).resolves.toMatchObject({
      id: sweep.id,
      status: "succeeded"
    });
    await expect(supervisor.runLightOnce("compute")).resolves.toBeNull();
    expect(statusOf(place)).toBe("queued");
    expect(claims.at(-1)).toMatchObject({ lane: "light", types: ["topic-sweep"] });
    held = false;
    await expect(supervisor.runLightOnce("compute")).resolves.toMatchObject({
      id: place.id,
      status: "succeeded"
    });
  });
});
