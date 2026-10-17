import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobLane, JobRecord, PgPool } from "@app/db";
import { JobSupervisor } from "./job-supervisor.js";
import type { HeavyJobRegistry, LightJobRegistry } from "./job-lanes.js";

// DEV heavy job types (F3 T52b): the re-match harness runs as a heavy job, claimed by the heavy loop
// one at a time like ingestion and never by a light worker.
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
        const job = jobs.find(
          (candidate) =>
            candidate.status === "queued" &&
            candidate.runAfter.getTime() <= Date.now() &&
            (!lane || candidate.lane === lane) &&
            (!types || types.includes(candidate.type))
        );
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
const claims = vi.hoisted(() => [] as Array<{ types?: string[]; lane?: string; workerId: string }>);
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
function enqueue(type: string, lane: JobLane, maxAttempts = 3): JobRecord {
  const now = new Date();
  const job: JobRecord = {
    id: `job-${++sequence}`,
    type,
    status: "queued",
    priority: 0,
    payload: {},
    result: null,
    error: null,
    progress: 0,
    attempts: 0,
    maxAttempts,
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

let supervisor: JobSupervisor | undefined;
const pool = () => ({}) as PgPool;
beforeEach(() => {
  vi.useFakeTimers();
  queue.jobs.length = 0;
  claims.length = 0;
});
afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  vi.useRealTimers();
});

describe("DEV heavy jobs", () => {
  it("are claimed by the heavy loop beside the built-in types and run with the job and its signal", async () => {
    const seen: Array<{ id: string; signal: AbortSignal }> = [];
    const devHeavyJobs: HeavyJobRegistry = {
      "relation-rematch": {
        execute: async (job, signal) => {
          seen.push({ id: job.id, signal });
          return { outcome: "completed" };
        }
      }
    };
    supervisor = new JobSupervisor({ getPool: pool, pollIntervalMs: 500, devHeavyJobs });
    const job = enqueue("relation-rematch", "heavy", 1);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.find(job.id)).toMatchObject({
      status: "succeeded",
      result: { outcome: "completed" }
    });
    expect(seen).toEqual([{ id: job.id, signal: expect.any(AbortSignal) }]);
    const heavy = claims.filter((claim) => claim.lane === "heavy");
    expect(heavy[0]!.types).toEqual(expect.arrayContaining(["ingestion", "relation-rematch"]));
  });

  it("are never offered to a light worker, and light jobs do not wait for them", async () => {
    const gate = Promise.withResolvers<void>();
    const lightJobs: LightJobRegistry = {
      "topic-place": { needsModel: false, execute: async () => ({ placed: 1 }) }
    };
    supervisor = new JobSupervisor({
      getPool: pool,
      pollIntervalMs: 500,
      lightJobs,
      devHeavyJobs: {
        "relation-rematch": { execute: async () => (await gate.promise, { outcome: "completed" }) }
      }
    });
    const heavy = enqueue("relation-rematch", "heavy", 1);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.find(heavy.id)?.status).toBe("running");
    const place = enqueue("topic-place", "light");
    supervisor.wake("light");
    await vi.advanceTimersByTimeAsync(50);
    expect(queue.find(place.id)?.status).toBe("succeeded");
    for (const claim of claims.filter((entry) => entry.lane === "light"))
      expect(claim.types).not.toContain("relation-rematch");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.find(heavy.id)?.status).toBe("succeeded");
  });

  it("run one at a time, in the order they were queued", async () => {
    const order: string[] = [];
    let active = 0;
    let maximum = 0;
    supervisor = new JobSupervisor({
      getPool: pool,
      pollIntervalMs: 500,
      devHeavyJobs: {
        "relation-rematch": {
          execute: async (job) => {
            active += 1;
            maximum = Math.max(maximum, active);
            order.push(job.id);
            await new Promise((resolve) => setTimeout(resolve, 100));
            active -= 1;
            return {};
          }
        }
      }
    });
    const first = enqueue("relation-rematch", "heavy", 1);
    const second = enqueue("relation-rematch", "heavy", 1);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual([first.id, second.id]);
    expect(maximum).toBe(1);
  });

  it("fail for good when the executor throws and the job allows one attempt", async () => {
    supervisor = new JobSupervisor({
      getPool: pool,
      pollIntervalMs: 500,
      devHeavyJobs: {
        "relation-rematch": {
          execute: async () => {
            throw new Error("errors.ai.providerUnavailable");
          }
        }
      }
    });
    const job = enqueue("relation-rematch", "heavy", 1);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(queue.find(job.id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("cannot take the type of a built-in or a light job", () => {
    const executor = { execute: async () => ({}) };
    expect(
      () => new JobSupervisor({ getPool: pool, devHeavyJobs: { ingestion: executor } })
    ).toThrow("job_lane_conflict:ingestion");
    expect(
      () =>
        new JobSupervisor({
          getPool: pool,
          lightJobs: { "topic-place": { needsModel: false, execute: async () => ({}) } },
          devHeavyJobs: { "topic-place": executor }
        })
    ).toThrow("job_lane_conflict:topic-place");
  });

  it("tell supportsJobType which types have an executor", () => {
    const executor = { execute: async () => ({}) };
    const withRematch = new JobSupervisor({
      getPool: pool,
      lightJobs: { "topic-place": { needsModel: false, execute: async () => ({}) } },
      devHeavyJobs: { "relation-rematch": executor }
    });
    expect(withRematch.supportsJobType("ingestion")).toBe(true);
    expect(withRematch.supportsJobType("topic-place")).toBe(true);
    expect(withRematch.supportsJobType("relation-rematch")).toBe(true);
    expect(withRematch.supportsJobType("relation-link")).toBe(false);
    expect(new JobSupervisor({ getPool: pool }).supportsJobType("relation-rematch")).toBe(false);
  });
});
