import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError } from "@app/ai";
import type { JobLane, JobRecord, PgPool } from "@app/db";
import { runShutdownSteps } from "./application-shutdown.js";
import { JobSupervisor, lightJobUpdate } from "./job-supervisor.js";
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
      releaseBlocks: async () => 0,
      findById: async (id: string) => find(id),
      reportProgress: async () => null,
      requestCancel: async (id: string) => {
        const job = find(id);
        if (job) job.cancelRequestedAt = new Date();
        return job ? { ...job } : null;
      },
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
    scopeKey: null,
    subjectKey: null,
    outcome: null,
    blockedClass: null,
    blockedReason: null,
    blockedAt: null,
    quarantinedAt: null,
    inputFingerprint: null,
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

  it("delivers the vault projection a page at a time on the compute worker, between placements", async () => {
    const order: string[] = [];
    const execute = vi.fn(async (job: JobRecord) => {
      order.push(`page:${String(job.payload.cursor ?? "start")}`);
      // A page re-enqueues its job with the next cursor, behind anything already waiting.
      return job.payload.cursor ? { done: true } : { done: false, continueWith: { cursor: "2:a" } };
    });
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({
        "topic-place": {
          needsModel: false,
          execute: async (job: JobRecord) => {
            order.push(`place:${job.id}`);
            return { placed: 1 };
          }
        }
      }),
      obsidianSyncService: {
        projectSource: vi.fn(),
        wiki: { enqueue: vi.fn().mockResolvedValue(null), execute }
      } as unknown as NonNullable<
        ConstructorParameters<typeof JobSupervisor>[0]["obsidianSyncService"]
      >
    });
    const first = enqueue("obsidian-wiki", "light");
    const place = enqueue("topic-place", "light");
    place.runAfter = new Date(Date.now() + 1);
    vi.advanceTimersByTime(5);
    for (let pass = 0; pass < 3; pass += 1) await supervisor.runLightOnce("compute");
    expect(order).toEqual(["page:start", `place:${place.id}`, "page:2:a"]);
    // One job for the whole pass: its last page finished it, with that page's result.
    expect(queue.jobs.filter((job) => job.type === "obsidian-wiki")).toHaveLength(1);
    expect(statusOf(first)).toBe("succeeded");
    expect(queue.find(first.id)).toMatchObject({
      payload: { cursor: "2:a" },
      result: { done: true }
    });
    expect(claims.every((claim) => claim.lane === "light")).toBe(true);
    expect(claims[0]?.types).toEqual(["obsidian-wiki", "topic-place"]);
    // Never on the heavy loop.
    await expect(supervisor.runOnce()).resolves.toBeNull();
  });

  it("refuses a second executor for the vault projection", () => {
    expect(
      () =>
        new JobSupervisor({
          getPool: pool,
          lightJobs: { "obsidian-wiki": { needsModel: false, execute: async () => ({}) } },
          obsidianSyncService: {
            projectSource: vi.fn(),
            wiki: { enqueue: vi.fn(), execute: vi.fn() }
          } as unknown as NonNullable<
            ConstructorParameters<typeof JobSupervisor>[0]["obsidianSyncService"]
          >
        })
    ).toThrow("job_lane_conflict:obsidian-wiki");
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

  it("leaves the quit path after its bound when a job ignores its cancellation, and names the job", async () => {
    let release!: () => void;
    const stubborn = vi.fn(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          release = () => resolve({});
        })
    );
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({ "topic-place": { needsModel: false, execute: stubborn } })
    });
    await supervisor.start();
    const place = enqueue("topic-place", "light");
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(10);
    expect(supervisor.inFlightJobIds()).toEqual([place.id]);

    const stopSupervisor = supervisor;
    const database = vi.fn();
    const warnings: string[] = [];
    const running = runShutdownSteps(
      [
        {
          name: "job supervisor",
          timeoutMs: 30_000,
          run: () => stopSupervisor.stop(),
          describe: () => `jobs in flight: ${stopSupervisor.inFlightJobIds().join(", ")}`
        },
        { name: "database", timeoutMs: 45_000, run: database }
      ],
      {
        logger: {
          info: () => undefined,
          warn: (line) => warnings.push(line),
          error: () => undefined
        }
      }
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const outcomes = await running;
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["timeout", "done"]);
    expect(database).toHaveBeenCalledOnce();
    expect(warnings.join(" ")).toContain(`jobs in flight: ${place.id}`);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(supervisor.inFlightJobIds()).toEqual([]);
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

  it("queues a light job again after a bare AbortError while its own signal is live (F4 D8)", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Local inference canceled.", "AbortError"))
      .mockResolvedValueOnce({ placed: 1 });
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({ "topic-place": { needsModel: false, execute } })
    });
    const place = enqueue("topic-place", "light");
    await expect(supervisor.runLightOnce("compute")).resolves.toMatchObject({
      status: "queued",
      finishedAt: null
    });
    expect(queue.find(place.id)!.error).toBe("Local inference canceled.");

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(supervisor.runLightOnce("compute")).resolves.toMatchObject({
      status: "succeeded",
      attempts: 2
    });
  });

  it("keeps a job canceled when its aborted signal ends it with an AbortError", async () => {
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({
        "topic-place": {
          needsModel: false,
          execute: async (_job: JobRecord, signal: AbortSignal) => {
            await holdAiSlot(60_000, signal);
            return { placed: 1 };
          }
        }
      })
    });
    const place = enqueue("topic-place", "light");
    const running = supervisor.runLightOnce("compute");
    await vi.advanceTimersByTimeAsync(10);
    expect(statusOf(place)).toBe("running");

    await supervisor.requestCancel(place.id);
    await expect(running).resolves.toMatchObject({ status: "canceled", error: null });
    // Canceled for good: nothing is queued to run again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusOf(place)).toBe("canceled");
  });

  it("cancels, and never retries, a job the quit path stops with an AbortError", async () => {
    supervisor = new JobSupervisor({
      getPool: pool,
      lightJobs: topicJobs({
        "topic-place": {
          needsModel: false,
          execute: async (_job: JobRecord, signal: AbortSignal) => {
            await holdAiSlot(60_000, signal);
            return { placed: 1 };
          }
        }
      })
    });
    await supervisor.start();
    const place = enqueue("topic-place", "light");
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(10);
    expect(statusOf(place)).toBe("running");

    const stopping = supervisor.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    expect(queue.find(place.id)).toMatchObject({ status: "canceled", error: null });
    const claimsAfterStop = claims.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claims).toHaveLength(claimsAfterStop);
    expect(statusOf(place)).toBe("canceled");
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

describe("lightJobUpdate", () => {
  const job = () =>
    ({
      ...enqueue("obsidian-wiki", "light", {
        cursor: "1:a",
        promptPin: { stage: "x" },
        errorHistory: [{ message: "earlier" }]
      }),
      status: "running",
      attempts: 2
    }) as JobRecord;

  it("finishes a job whose step returned no continuation", () => {
    expect(lightJobUpdate(job(), { done: true })).toMatchObject({
      status: "succeeded",
      result: { done: true },
      progress: 1
    });
  });

  it("queues the same job again with its next payload, due now, attempts counted afresh", () => {
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const update = lightJobUpdate(job(), { done: false, continueWith: { cursor: "1:b" } });
    expect(update).toEqual({
      status: "queued",
      payload: { cursor: "1:b", promptPin: { stage: "x" } },
      result: { done: false },
      error: null,
      attempts: 0,
      runAfter: new Date("2026-10-15T12:00:00Z"),
      lockedAt: null,
      lockedBy: null,
      finishedAt: null
    });
  });

  it("does not continue a job that was stopped", () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      lightJobUpdate(job(), { continueWith: { cursor: "1:b" } }, controller.signal)
    ).toMatchObject({ status: "canceled", result: {} });
  });
});
