import { describe, expect, it } from "vitest";

import type { SoakSample } from "./soak-records.js";
import {
  deriveWorkerStates,
  retryGapMs,
  stateOfRunningJob,
  workerOfJob,
  workerPredicateVersion
} from "./soak-workers.js";

const now = Date.parse("2026-10-30T12:00:00Z");
const capacity = { heavy: 1, compute: 1, model: 1, relations: 2 };

type Job = SoakSample["jobs"][number];
type Lane = SoakSample["lanes"][number];

const job = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  type: "topic-name",
  lane: "light",
  status: "running",
  sourceItemId: null,
  attempts: 1,
  updatedAt: now - 5_000,
  runAfter: now - 60_000,
  lockedAt: now - 60_000,
  scopeKey: "tree:t1:names",
  ...overrides
});

const lane = (overrides: Partial<Lane> = {}): Lane => ({
  lane: "remote:codex-1",
  limit: 2,
  running: 0,
  held: 0,
  waiting: { P0: 0, P1: 0, P2: 0, P3: 0 },
  rateLimits: 0,
  breaker: "closed",
  pausedForMs: null,
  ...overrides
});

describe("the worker of a job", () => {
  it("is named by the kind table, and null for work that runs inside another job or by itself", () => {
    expect(workerOfJob({ type: "topic-place", lane: "light" })).toBe("compute");
    expect(workerOfJob({ type: "topic-name", lane: "light" })).toBe("model");
    expect(workerOfJob({ type: "relation-link", lane: "light" })).toBe("relations");
    expect(workerOfJob({ type: "ingestion", lane: "heavy" })).toBe("heavy");
    expect(workerOfJob({ type: "summarization", lane: "heavy" })).toBeNull();
    expect(workerOfJob({ type: "local-model-download", lane: "light" })).toBeNull();
    // A type the table does not know falls back on its lane column.
    expect(workerOfJob({ type: "future-kind", lane: "heavy" })).toBe("heavy");
    expect(workerOfJob({ type: "future-kind", lane: "light" })).toBe("compute");
  });
});

describe("the state of a running job", () => {
  it("is executing while a call runs on a lane it uses, whatever else the lanes hold", () => {
    const lanes = [lane({ running: 1, pausedForMs: 5_000 })];
    expect(stateOfRunningJob(job(), lanes, now)).toEqual({ state: "executing" });
  });

  it("needs no call for deterministic work: placement is executing even when every lane is quiet", () => {
    expect(
      stateOfRunningJob(job({ type: "topic-place", updatedAt: now - 3_600_000 }), [lane()], now)
    ).toEqual({ state: "executing" });
  });

  it("waits for a pause, an open breaker, a lane permit, or a retry backoff, in that order of evidence", () => {
    expect(stateOfRunningJob(job(), [lane({ pausedForMs: 4_000 })], now)).toEqual({
      state: "waiting",
      why: "pause"
    });
    expect(stateOfRunningJob(job(), [lane({ breaker: "open" })], now)).toEqual({
      state: "waiting",
      why: "breaker"
    });
    expect(
      stateOfRunningJob(job(), [lane({ waiting: { P0: 0, P1: 0, P2: 1, P3: 0 } })], now)
    ).toEqual({ state: "waiting", why: "permit" });
    expect(stateOfRunningJob(job({ updatedAt: now - retryGapMs - 1 }), [lane()], now)).toEqual({
      state: "waiting",
      why: "retry"
    });
    // Quiet lanes and a recent change: the job is between two calls.
    expect(stateOfRunningJob(job(), [lane()], now)).toEqual({ state: "executing" });
  });

  it("looks only at the lanes the job's kind uses: a remote writer is not helped by a local call", () => {
    const lanes = [lane({ pausedForMs: 4_000 }), lane({ lane: "local", running: 1 })];
    expect(stateOfRunningJob(job({ type: "topic-name" }), lanes, now)).toEqual({
      state: "waiting",
      why: "pause"
    });
    // Placement's ranker runs locally.
    expect(stateOfRunningJob(job({ type: "topic-gate" }), lanes, now)).toEqual({
      state: "executing"
    });
  });
});

describe("every worker's state", () => {
  it("lists one entry per running job and one idle entry per free slot, the relations pool included", () => {
    const states = deriveWorkerStates(
      {
        jobs: [
          job(),
          job({ id: "link-1", type: "relation-link", scopeKey: "root:r1" }),
          job({ id: "queued", status: "queued" }),
          job({ id: "stage", type: "summarization", lane: "heavy", scopeKey: null })
        ],
        lanes: [lane({ running: 1 })]
      },
      now,
      capacity
    );
    expect(states.map((entry) => `${entry.worker}:${entry.state}`).sort()).toEqual([
      "compute:idle",
      "heavy:idle",
      "model:executing",
      "relations:executing",
      "relations:idle"
    ]);
    expect(states.find((entry) => entry.jobId === "link-1")).toMatchObject({
      scopeKey: "root:r1"
    });
  });

  it("reports every slot idle when nothing runs", () => {
    expect(deriveWorkerStates({ jobs: [], lanes: [] }, now, capacity)).toHaveLength(5);
    expect(workerPredicateVersion).toBe(1);
  });
});
