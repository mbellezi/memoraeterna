import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobLane, JobRecord, PgPool } from "@app/db";
import {
  BackgroundBlockedError,
  defaultKnowledgeControls,
  gardenerBlocker,
  type GardenerBlocker,
  type KnowledgeControls
} from "@app/domain";

import { BackgroundGate } from "./gardener/background-gate.js";
import type { JobBackgroundPolicy } from "./gardener/job-background-policy.js";
import { JobSupervisor } from "./job-supervisor.js";
import type { LightJobRegistry } from "./job-lanes.js";

// T75 in the job supervisor: the kinds a global gate holds are never claimed (attempts and dedupe
// keys untouched), blocked rows are re-gated before the workers start, and a task that meets a
// blocker after its claim goes back to the queue with it instead of failing.

const queue = vi.hoisted(() => {
  const jobs: JobRecord[] = [];
  const find = (id: string) => jobs.find((job) => job.id === id) ?? null;
  return {
    jobs,
    find,
    events: [] as string[],
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
        Object.assign(job, {
          status: "running",
          lockedBy: workerId,
          attempts: job.attempts + 1,
          dedupeKey: null
        });
        return { ...job };
      },
      update: async (id: string, input: Partial<JobRecord>) => {
        const job = find(id);
        if (job) Object.assign(job, input);
        return job ? { ...job } : null;
      },
      // T74's job state: the startup and due releases of set-aside jobs, and the job's last write
      // (its outcome cache is the real repository's; here only the job row matters).
      releaseBlocks: async (filter?: { due?: boolean }) => {
        if (!filter?.due) queue.events.push("releaseAll");
        return 0;
      },
      finish: async (id: string, input: Partial<JobRecord>) => {
        const job = find(id);
        if (job) Object.assign(job, input);
        return job ? { ...job } : null;
      }
    }
  };
});
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createJobRepository: () => ({
    ...queue.repository,
    claimNext: (workerId: string, types?: readonly string[], lane?: JobLane) => {
      queue.events.push(`claim:${lane}`);
      return queue.repository.claimNext(workerId, types, lane);
    }
  }),
  createIngestionRunRepository: () => ({ recoverInterrupted: async () => 0 }),
  createHierarchicalIngestionRepository: () => ({ refreshBatch: async () => undefined })
}));

let sequence = 0;
function enqueue(type: string, lane: JobLane = "light"): JobRecord {
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
    maxAttempts: 3,
    runAfter: now,
    lockedAt: null,
    lockedBy: null,
    finishedAt: null,
    cancelRequestedAt: null,
    lane,
    dedupeKey: `${type}:key`,
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
const stored = (job: JobRecord) => queue.find(job.id)!;

const controls = { value: { ...defaultKnowledgeControls } as KnowledgeControls };
const gate = new BackgroundGate({
  controls: () => controls.value,
  power: () => ({ active: false, onBattery: false, idleMs: 3_600_000, overridden: false })
});
const blocked = new Map<string, GardenerBlocker>();
const policy: JobBackgroundPolicy = {
  heldKinds: (types) => gate.heldKinds(types),
  regate: async () => {
    queue.events.push("regate");
  },
  takeAdmissionBlock: (jobId) => gate.takeAdmissionBlock(jobId),
  // The repository's per-task block: the claim's attempt back, the key restored, blocked.
  blockTask: async (job, blocker) => {
    const row = queue.find(job.id)!;
    Object.assign(row, {
      status: "queued",
      attempts: row.attempts - 1,
      dedupeKey: `${row.type}:key`,
      runAfter: new Date(Date.now() + 3_600_000)
    });
    blocked.set(job.id, blocker);
    return true;
  }
};

const ended = vi.fn(async () => undefined);
const executed: string[] = [];
const light = (execute: (job: JobRecord) => Promise<Record<string, unknown>>) => ({
  needsModel: true,
  execute: async (job: JobRecord) => {
    executed.push(job.type);
    return (await execute(job)) as never;
  },
  ended
});
const jobs: LightJobRegistry = {
  "topic-place": { needsModel: false, execute: async () => ({ placed: 1 }) },
  // Naming as it runs under Off: its call is refused at admission and it names provisionally.
  "topic-name": light(async (job) => {
    const refusal = gate.admit({
      lane: "remote:codex",
      priority: "P3",
      workloadClass: "write-fast",
      budgetClass: "background",
      label: "topic_naming",
      jobId: job.id
    });
    return { status: "named", provisional: refusal ? 2 : 0, llmNamed: refusal ? 0 : 2 };
  }),
  "topic-overview": light(async () => ({ status: "applied" })),
  "topic-areas": light(async () => {
    throw new BackgroundBlockedError(gardenerBlocker("paused", "user_pause"));
  }),
  // An executor that swallows the refusal of its call and ends as if the call had failed.
  "topic-label-embed": light(async (job) => {
    const refusal = gate.admit({
      lane: "local",
      priority: "P3",
      workloadClass: "embed",
      budgetClass: "background",
      label: "labels",
      jobId: job.id
    });
    return { status: refusal ? "call_failed" : "embedded" };
  })
};

let supervisor: JobSupervisor | undefined;
const pool = () => ({}) as PgPool;
const start = async () => {
  supervisor = new JobSupervisor({
    getPool: pool,
    pollIntervalMs: 500,
    lightJobs: jobs,
    backgroundPolicy: policy
  });
  await supervisor.start();
};

beforeEach(() => {
  vi.useFakeTimers();
  queue.jobs.length = 0;
  queue.events.length = 0;
  executed.length = 0;
  blocked.clear();
  ended.mockClear();
  controls.value = { ...defaultKnowledgeControls };
});
afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  vi.useRealTimers();
});

describe("background policy in the job supervisor", () => {
  it("re-gates blocked rows before any worker claims", async () => {
    await start();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.events[0]).toBe("regate");
    expect(queue.events.slice(1).every((event) => event.startsWith("claim:"))).toBe(true);
    // The policy's re-gate keeps time-bound waits and gated rows: nothing releases every block.
    expect(queue.events).not.toContain("releaseAll");
  });

  it("never claims a held kind: its attempts and dedupe key are untouched, and Off still places", async () => {
    controls.value = { ...controls.value, autonomy: "off" };
    const overview = enqueue("topic-overview");
    const place = enqueue("topic-place");
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored(place).status).toBe("succeeded");
    expect(stored(overview)).toMatchObject({
      status: "queued",
      attempts: 0,
      dedupeKey: "topic-overview:key"
    });
    controls.value = { ...controls.value, autonomy: "auto" };
    supervisor!.wake("light");
    await vi.advanceTimersByTimeAsync(10);
    expect(stored(overview).status).toBe("succeeded");
  });

  it("names provisionally under Off: the refused call ends the naming job as done, not set aside", async () => {
    controls.value = { ...controls.value, autonomy: "off" };
    const name = enqueue("topic-name");
    await start();
    await vi.advanceTimersByTimeAsync(10);
    expect(stored(name)).toMatchObject({
      status: "succeeded",
      result: { status: "named", provisional: 2, llmNamed: 0 }
    });
    expect(blocked.size).toBe(0);
    expect(gate.takeAdmissionBlock(name.id)).toBeUndefined();
  });

  it("still sets naming aside when a pause meets its call after the claim", async () => {
    const name = enqueue("topic-name");
    const original = jobs["topic-name"]!.execute;
    jobs["topic-name"]!.execute = async (job, signal) => {
      controls.value = { ...controls.value, paused: true };
      return original(job, signal);
    };
    try {
      await start();
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      jobs["topic-name"]!.execute = original;
    }
    expect(stored(name)).toMatchObject({ status: "queued", attempts: 0, result: null });
    expect(blocked.get(name.id)?.reason).toBe("user_pause");
  });

  it("holds every Gardener kind while paused, and never ingestion", async () => {
    controls.value = { ...controls.value, paused: true };
    const place = enqueue("topic-place");
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored(place)).toMatchObject({ status: "queued", attempts: 0 });
    expect(queue.events.some((event) => event === "claim:heavy")).toBe(true);
  });

  it("sets a task aside when its call is refused at admission, without failing or ending it", async () => {
    const areas = enqueue("topic-areas");
    await start();
    await vi.advanceTimersByTimeAsync(10);
    expect(stored(areas)).toMatchObject({ status: "queued", attempts: 0, error: null });
    expect(blocked.get(areas.id)).toEqual({ class: "paused", reason: "user_pause" });
    expect(ended).not.toHaveBeenCalled();
  });

  it("sets a task aside even when its executor swallowed the refusal", async () => {
    controls.value = { ...controls.value, onlyOnAc: false, paused: false };
    const labels = enqueue("topic-label-embed");
    // The kind is not held at claim (pause off); the pause starts while its call is admitted.
    const original = jobs["topic-label-embed"]!.execute;
    jobs["topic-label-embed"]!.execute = async (job, signal) => {
      controls.value = { ...controls.value, paused: true };
      return original(job, signal);
    };
    try {
      await start();
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      jobs["topic-label-embed"]!.execute = original;
    }
    expect(executed).toContain("topic-label-embed");
    expect(stored(labels)).toMatchObject({ status: "queued", attempts: 0, result: null });
    expect(blocked.get(labels.id)?.reason).toBe("user_pause");
  });

  it("finishes a task normally when nothing held its calls", async () => {
    const labels = enqueue("topic-label-embed");
    await start();
    await vi.advanceTimersByTimeAsync(10);
    expect(stored(labels)).toMatchObject({ status: "succeeded", result: { status: "embedded" } });
    expect(blocked.size).toBe(0);
  });
});
