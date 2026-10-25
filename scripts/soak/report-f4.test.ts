import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildTimeline } from "../../apps/desktop/src/main/services/dev/soak-driver.ts";
import { readSoakPlan } from "../../apps/desktop/src/main/services/dev/soak-plan.ts";
import { expandWindows } from "../../apps/desktop/src/main/services/dev/soak-plan-f4.ts";
import type {
  BreakerRecord,
  ExchangeRecord,
  GroundTruthRecord,
  JobDoneRecord,
  OutcomeRecord,
  SoakEvent,
  SoakMeta,
  SoakSample,
  TaskRunRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import {
  computeE1,
  computeE5,
  e1Check,
  e2Check,
  e3Check,
  e4Check,
  e5Affected,
  e5Check,
  e5LaneFaults,
  f4Report,
  injectionCheck,
  loadCheck,
  tokensCheck
} from "./report-f4.ts";
import { analyzeRun, renderReport, type LoadedRun } from "./report.ts";

const start = Date.parse("2026-10-28T00:00:00.000Z");
const minute = 60_000;
const hour = 60 * minute;
const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();
const writerConfig = "5a1d2f50-3c1e-4d7a-9b38-0d2f2f6a7c11";
const codexLane = `remote:${writerConfig}`;

function metaOf(hours: number, overrides: Partial<SoakMeta> = {}): SoakMeta {
  return {
    format: "memora-soak-run",
    version: 1,
    run: "soak7-test",
    profile: "soak7",
    seed: 20261028,
    startedAt: at(0),
    endedAt: at(hours * hour),
    endReason: "duration",
    durationMs: hours * hour,
    warmupMs: 30 * minute,
    sampleIntervalMs: minute,
    host: { platform: "darwin", arch: "arm64", totalMemoryMb: 32768 },
    catalogHeader: { refresh: "on", reason: null },
    bounds: { connectMs: 10_000, firstByteMs: 30_000, stallMs: 20_000 },
    providers: [
      { provider: "openai-codex", providerConfigId: writerConfig, baseUrl: "https://chatgpt.com" }
    ],
    plan: {},
    relations: {
      discoveryNeighbours: 1,
      judgeMode: "ranker",
      sourceJudge: { mode: "perRoot", maxPairsPerCall: 12 }
    },
    dataRoot: "/data/.cache",
    realWriter: {
      providerConfigId: writerConfig,
      provider: "openai-codex",
      modelId: "gpt-5.6-luna"
    },
    f4: {
      codex: { expected: 3_200_000, cap: 4_700_000, dropFromHour0: 0 },
      windows: [],
      predicates: { workerStates: 1 }
    },
    ...overrides
  };
}

type Job = SoakSample["jobs"][number];
const job = (id: string, type: string, overrides: Partial<Job> = {}): Job => ({
  id,
  type,
  lane: "light",
  status: "queued",
  sourceItemId: null,
  attempts: 0,
  updatedAt: start,
  runAfter: start,
  lockedAt: null,
  scopeKey: null,
  ...overrides
});

const lane = (running = 0): SoakSample["lanes"][number] => ({
  lane: codexLane,
  limit: 2,
  running,
  held: 0,
  waiting: { P0: 0, P1: 0, P2: 0, P3: 0 },
  rateLimits: 0,
  breaker: "closed",
  pausedForMs: null
});

function sampleAt(offsetMs: number, overrides: Partial<SoakSample> = {}): SoakSample {
  return {
    at: at(offsetMs),
    elapsedMs: offsetMs,
    lanes: [lane()],
    jobs: [],
    jobCounts: {},
    helper: null,
    appRssMb: 800,
    pageouts: 0,
    pageSizeBytes: 16_384,
    eventLoopLagP99Ms: 3,
    dbPool: { total: 4, idle: 4, waiting: 0 },
    ...overrides
  };
}

const idle = (worker: string) => ({ worker, state: "idle" as const });
const executing = (worker: string, scopeKey: string) => ({
  worker,
  state: "executing" as const,
  jobId: `run-${worker}`,
  scopeKey
});
const waiting = (worker: string, scopeKey: string) => ({
  worker,
  state: "waiting" as const,
  why: "pause" as const,
  jobId: `run-${worker}`,
  scopeKey
});

function runOf(
  hours: number,
  parts: {
    samples?: SoakSample[];
    events?: SoakEvent[];
    rows?: TaskRunRecord[];
    meta?: Partial<SoakMeta>;
  }
): LoadedRun {
  return {
    meta: metaOf(hours, parts.meta),
    events: parts.events ?? [],
    samples: parts.samples ?? [],
    rows: parts.rows ?? [],
    invalid: {}
  };
}

/** `count` samples a minute from `from`, built by `make(index)`. */
const minutes = (from: number, count: number, make: (index: number) => Partial<SoakSample>) =>
  Array.from({ length: count }, (_, index) => sampleAt(from + index * minute, make(index)));

describe("E1 blocked by another", () => {
  const model = (scope: string) => job("model-job", "topic-name", { scopeKey: scope });

  it("is 0 while the worker executes another scope's task, however long a due task waits behind it", () => {
    const samples = minutes(0, 60, () => ({
      jobs: [
        job("running", "topic-name", { status: "running", scopeKey: "tree:t:names" }),
        job("due", "topic-areas", { scopeKey: "tree:u:names", runAfter: start })
      ],
      workers: [
        executing("model", "tree:t:names"),
        idle("compute"),
        idle("heavy"),
        idle("relations"),
        idle("relations")
      ]
    }));
    const result = computeE1(runOf(1, { samples }));
    expect(result.events).toEqual([]);
    expect(result.queueWaits).toEqual({});
  });

  it("flags a due task that waits 15 minutes while its worker is idle", () => {
    const samples = minutes(0, 20, () => ({
      jobs: [model("tree:t:names")],
      workers: [idle("model"), idle("compute"), idle("heavy"), idle("relations"), idle("relations")]
    }));
    const result = computeE1(runOf(1, { samples }));
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      jobId: "model-job",
      worker: "model",
      held: "an idle worker"
    });
    expect(result.events[0]!.minutes).toBeGreaterThanOrEqual(14);
  });

  it("does not flag the same wait before 15 minutes, nor after the worker took the task", () => {
    const short = minutes(0, 14, () => ({
      jobs: [model("tree:t:names")],
      workers: [idle("model"), idle("compute"), idle("heavy"), idle("relations"), idle("relations")]
    }));
    expect(computeE1(runOf(1, { samples: short })).events).toEqual([]);
  });

  it("flags a task held up by workers that hold tasks of another scope that do not execute", () => {
    const samples = minutes(0, 20, () => ({
      jobs: [
        model("tree:t:names"),
        job("holder", "topic-name", { status: "running", scopeKey: "tree:other:names" })
      ],
      workers: [
        waiting("model", "tree:other:names"),
        idle("compute"),
        idle("heavy"),
        idle("relations"),
        idle("relations")
      ]
    }));
    const result = computeE1(runOf(1, { samples }));
    expect(result.events[0]).toMatchObject({
      worker: "model",
      held: "workers held by tasks that are not executing"
    });
  });

  it("counts a wait for a running task of the same scope apart: it is no event", () => {
    const samples = minutes(0, 30, () => ({
      jobs: [
        job("running", "topic-name", { status: "running", scopeKey: "tree:t:names" }),
        job("due", "topic-name", { scopeKey: "tree:t:names" })
      ],
      workers: [
        waiting("model", "tree:t:names"),
        idle("compute"),
        idle("heavy"),
        idle("relations"),
        idle("relations")
      ]
    }));
    // The first job ends, the second starts: the same-scope wait is recorded.
    samples.push(
      sampleAt(30 * minute, {
        jobs: [job("due", "topic-name", { status: "running", scopeKey: "tree:t:names" })],
        workers: [
          executing("model", "tree:t:names"),
          idle("compute"),
          idle("heavy"),
          idle("relations"),
          idle("relations")
        ]
      })
    );
    const result = computeE1(runOf(1, { samples }));
    expect(result.events).toEqual([]);
    expect(result.sameScopeWaits.model).toEqual([30]);
  });

  it("leaves out a task a blocker set aside: it waits for its blocker, not for a worker", () => {
    const samples = minutes(0, 30, () => ({
      jobs: [
        { ...model("tree:t:names"), blockedClass: "cap", blockedReason: "subscription_daily" }
      ],
      workers: [idle("model"), idle("compute"), idle("heavy"), idle("relations"), idle("relations")]
    }));
    expect(computeE1(runOf(1, { samples })).events).toEqual([]);
  });

  it("derives the worker states from the jobs and lanes of an older sample", () => {
    const samples = minutes(0, 20, () => ({ jobs: [model("tree:t:names")] }));
    const result = computeE1(runOf(1, { samples }));
    expect(result.derivedWorkerStates).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it("counts a lock wait as long as a blocked task as an event of its own", () => {
    const samples = minutes(0, 20, (index) => ({
      workers: [
        idle("model"),
        idle("compute"),
        idle("heavy"),
        idle("relations"),
        idle("relations")
      ],
      lockWaits: { waiting: 1, longestMs: (index + 1) * minute }
    }));
    expect(computeE1(runOf(1, { samples })).lockEvents).toHaveLength(1);
  });

  it("reads 'not exercised' below 120 lane-minutes of exposure a day, and passes at or above it with 0 events", () => {
    const busy = (from: number, count: number) =>
      minutes(from, count, () => ({
        jobs: [
          job("running", "topic-name", { status: "running", scopeKey: "tree:t:names" }),
          job("a", "topic-areas", { scopeKey: "tree:u:names" }),
          job("b", "topic-name", { scopeKey: "tree:v:names" })
        ],
        workers: [
          executing("model", "tree:t:names"),
          idle("compute"),
          idle("heavy"),
          idle("relations"),
          idle("relations")
        ]
      }));
    const quiet = e1Check(
      runOf(24, { samples: [...busy(0, 60), ...minutes(60 * minute, 60, () => ({ workers: [] }))] })
    );
    expect(quiet.check.status).toBe("review");
    expect(quiet.check.value).toContain("not exercised");
    const enough = e1Check(runOf(24, { samples: busy(0, 130) }));
    expect(enough.check.status).toBe("pass");
    expect(enough.check.value).toContain("130");
    expect(enough.table[0]).toMatchObject({ day: 1, model: 130 });
  });

  it("fails the check on an event", () => {
    const samples = minutes(0, 20, () => ({
      jobs: [model("tree:t:names")],
      workers: [idle("model"), idle("compute"), idle("heavy"), idle("relations"), idle("relations")]
    }));
    const { check } = e1Check(runOf(1, { samples }));
    expect(check.status).toBe("fail");
    expect(check.details[0]).toContain("topic-name model-jo");
  });
});

const done = (id: string, overrides: Partial<JobDoneRecord> = {}): JobDoneRecord => ({
  type: "job_done",
  id,
  jobType: "topic-name",
  lane: "light",
  status: "succeeded",
  outcome: "done",
  scopeKey: null,
  subjectKey: `tree:${id}`,
  attempts: 1,
  createdAt: at(hour),
  finishedAt: at(hour + 5 * minute),
  quarantinedAt: null,
  resultStatus: "named",
  inputFingerprint: "f",
  ...overrides
});

const outcome = (kind: string, subjectKey: string, quarantined: boolean): OutcomeRecord => ({
  type: "outcome",
  at: at(2 * hour),
  kind,
  subjectKey,
  lastOutcome: quarantined ? "failed" : "done",
  lastFingerprint: null,
  failedFingerprint: quarantined ? "f" : null,
  consecutiveFailures: quarantined ? 2 : 0,
  lastErrorClass: quarantined ? "error:x" : null,
  quarantinedAt: quarantined ? at(2 * hour) : null
});

describe("E2 quarantine", () => {
  it("is quarantined inputs over distinct inputs with a non-skipped attempt, at most 1 %", () => {
    const jobs = Array.from({ length: 200 }, (_, index) => done(`n${index}`));
    const pass = e2Check(runOf(30, { events: [...jobs, outcome("topic-name", "tree:n3", true)] }), {
      injected: new Map(),
      injectedJobs: new Map()
    });
    expect(pass.status).toBe("pass");
    expect(pass.value).toContain("1 quarantined of 200");
    const fail = e2Check(
      runOf(30, {
        events: [
          ...jobs,
          outcome("topic-name", "tree:n3", true),
          outcome("topic-name", "tree:n4", true),
          outcome("topic-name", "tree:n5", true)
        ]
      }),
      { injected: new Map(), injectedJobs: new Map() }
    );
    expect(fail.status).toBe("fail");
  });

  it("leaves skipped attempts out and the inputs whose failures were all injected out of both counts", () => {
    const jobs = [
      ...Array.from({ length: 10 }, (_, index) => done(`n${index}`)),
      done("skip", { outcome: "skipped" }),
      done("fault-1", { status: "failed", outcome: null, subjectKey: "tree:fault" }),
      done("fault-2", { status: "failed", outcome: null, subjectKey: "tree:fault" })
    ];
    const check = e2Check(
      runOf(30, { events: [...jobs, outcome("topic-name", "tree:fault", true)] }),
      {
        injected: new Map(),
        injectedJobs: new Map([
          ["fault-1", "rate_limit"],
          ["fault-2", "rate_limit"]
        ])
      }
    );
    expect(check.status).toBe("pass");
    expect(check.value).toContain("0 quarantined of 10");
    expect(check.value).toContain("1 injected-only");
  });

  it("counts each (kind, subject, fingerprint) as its own input, as the quarantine does (D8)", () => {
    // One topic's name, decided again for twelve different member sets: twelve inputs, one quarantined.
    const jobs = Array.from({ length: 12 }, (_, index) =>
      done(`r${index}`, { subjectKey: "tree:t1", inputFingerprint: `f${index}` })
    );
    const failed = [
      done("bad-1", {
        status: "failed",
        outcome: null,
        subjectKey: "tree:t1",
        inputFingerprint: "fx"
      }),
      done("bad-2", {
        status: "failed",
        outcome: null,
        subjectKey: "tree:t1",
        inputFingerprint: "fx",
        quarantinedAt: at(2 * hour)
      })
    ];
    const check = e2Check(runOf(30, { events: [...jobs, ...failed] }), {
      injected: new Map(),
      injectedJobs: new Map()
    });
    expect(check.value).toContain("1 quarantined of 13");
    // A job cancelled before it ran made no attempt: it is no input.
    const cancelled = e2Check(
      runOf(30, {
        events: [
          ...jobs,
          ...failed,
          done("gone", { status: "canceled", outcome: null, attempts: 0 })
        ]
      }),
      { injected: new Map(), injectedJobs: new Map() }
    );
    expect(cancelled.value).toContain("1 quarantined of 13");
  });

  it("is a review when no input was attempted", () => {
    expect(e2Check(runOf(30, {}), { injected: new Map(), injectedJobs: new Map() }).status).toBe(
      "review"
    );
  });
});

describe("E3 within 24 h", () => {
  const created = 2 * hour;
  const job24 = (
    id: string,
    finishedAfterHours: number | null,
    overrides: Partial<JobDoneRecord> = {}
  ) =>
    done(id, {
      createdAt: at(created),
      finishedAt: finishedAfterHours === null ? null : at(created + finishedAfterHours * hour),
      ...overrides
    });

  it("is the share of tasks created in the window that were completed within 24 h, at least 95 %", () => {
    const events: JobDoneRecord[] = [
      ...Array.from({ length: 19 }, (_, index) => job24(`a${index}`, 3)),
      job24("slow", 30)
    ];
    const result = e3Check(runOf(72, { events }));
    expect(result.check.value).toContain("19 of 20 = 95.00 %");
    expect(result.check.status).toBe("pass");
    const failing = e3Check(runOf(72, { events: [...events, job24("slow2", 40)] }));
    expect(failing.check.status).toBe("fail");
  });

  it("counts done, no change, a pending review and a cancel by supersession as completed; a quarantine and a failure as not", () => {
    const canceled = (id: string, cancelCause: JobDoneRecord["cancelCause"]) =>
      job24(id, 1, { status: "canceled", outcome: null, resultStatus: null, cancelCause });
    const events = [
      job24("done", 1),
      job24("nochange", 1, { outcome: "no_change" }),
      job24("review", 1, { outcome: "done", resultStatus: "pending_review" }),
      // Superseded: merged into a queued duplicate (D7) or its source deleted.
      canceled("merged", "merged"),
      canceled("deleted", "source_deleted"),
      // A cancel someone asked for, or one recorded without a cause, completes nothing.
      canceled("requested", "requested"),
      canceled("unknown", undefined),
      job24("failed", 1, { status: "failed", outcome: null, resultStatus: null }),
      job24("quarantined", 1, {
        status: "failed",
        outcome: null,
        quarantinedAt: at(created + hour)
      })
    ];
    expect(e3Check(runOf(72, { events })).check.value).toContain("5 of 9");
  });

  it("sets aside a task an injected fault or the harness cap failed (D3), and reports how many", () => {
    const failed = (id: string) =>
      job24(id, 1, { status: "failed", outcome: null, resultStatus: null });
    const events = [
      ...Array.from({ length: 19 }, (_, index) => job24(`a${index}`, 3)),
      failed("by-401"),
      failed("by-cap"),
      failed("product")
    ];
    const injectedJobs = new Map([
      ["by-401", "unauthorized"],
      ["by-cap", "harness cap"]
    ]);
    const check = e3Check(runOf(72, { events }), { injectedJobs }).check;
    expect(check.value).toContain("19 of 20 = 95.00 %");
    expect(check.value).toContain("2 failed by an injected fault or the harness cap set aside");
    expect(check.status).toBe("pass");
    // Without the ledger every failure counts.
    expect(e3Check(runOf(72, { events })).check.value).toContain("19 of 22");
  });

  it("reports skipped tasks and rows from before 0060 apart", () => {
    const events = [
      job24("done", 1),
      job24("skipped", 0, { outcome: "skipped" }),
      job24("legacy", 1, { outcome: null, resultStatus: null })
    ];
    const check = e3Check(runOf(72, { events })).check;
    expect(check.value).toContain("1 of 1");
    expect(check.value).toContain("1 skipped and 1 legacy apart");
  });

  it("measures a deferred chain from its first creation", () => {
    const events = [
      job24("first", 1, { resultStatus: "deferred", outcome: "no_change" }),
      // The re-request is created an hour later and ends 25 h after the chain began.
      done("second", {
        subjectKey: "tree:first",
        createdAt: at(created + hour),
        finishedAt: at(created + 25 * hour)
      })
    ];
    const check = e3Check(runOf(100, { events })).check;
    expect(check.value).toContain("0 of 1");
    const shorter = e3Check(
      runOf(100, {
        events: [
          job24("first", 1, { resultStatus: "deferred", outcome: "no_change" }),
          done("second", {
            subjectKey: "tree:first",
            createdAt: at(created + hour),
            finishedAt: at(created + 5 * hour)
          })
        ]
      })
    ).check;
    expect(shorter.value).toContain("1 of 1");
  });

  it("counts a task still open at the end of the run as not completed", () => {
    const samples = [
      sampleAt(71 * hour, {
        jobs: [{ ...job("open", "topic-name"), createdAt: start + created }]
      })
    ];
    const check = e3Check(runOf(72, { events: [job24("done", 1)], samples })).check;
    expect(check.value).toContain("1 of 2");
  });

  it("reads the tasks a window set aside, by window", () => {
    const meta = {
      f4: {
        codex: { expected: 1, cap: 2, dropFromHour0: 0 },
        windows: [
          {
            id: "w1",
            kind: "autonomy_off",
            startMinute: 60,
            durationMinutes: 120,
            settleMinutes: 2,
            settleEndMinutes: 2
          }
        ],
        predicates: {}
      }
    };
    const samples = [
      sampleAt(90 * minute, {
        jobs: [
          { ...job("held", "topic-name"), blockedClass: "paused", blockedReason: "autonomy_off" }
        ]
      })
    ];
    const result = e3Check(runOf(72, { events: [job24("held", 3)], samples, meta }));
    expect(result.table).toContainEqual({
      window: "w1",
      "tasks set aside": 1,
      "ended within 24 h": 1
    });
  });
});

const truth = (
  id: string,
  phase: "start" | "end",
  offset: number,
  settleMinutes: number,
  expectation?: [string, string],
  kind = "usage_limit"
): GroundTruthRecord => ({
  type: "ground_truth",
  id,
  kind,
  phase,
  at: at(offset),
  ...(expectation ? { expect: { class: expectation[0], reason: expectation[1] } } : {}),
  settleUntil: at(offset + settleMinutes * minute),
  detail: {}
});

const statusOf = (cls: string | undefined, reason?: string) => ({
  state: cls ? "blocked" : "running",
  ...(cls ? { class: cls } : {}),
  ...(reason ? { reason } : {}),
  params: {}
});

describe("E5 status coverage", () => {
  const window = [
    truth("w30", "start", 10 * minute, 2, ["waiting", "provider_rate_limit"]),
    truth("w30", "end", 40 * minute, 2)
  ];
  // A remote Gardener task due all along: the provider windows' condition affects it (E5 v3).
  const remoteTask = [job("match", "relation-match")];

  it("passes when the sentence follows the window after the settle of its start and of its end", () => {
    const samples = minutes(0, 60, (index) => ({
      jobs: remoteTask,
      status:
        index >= 12 && index < 40
          ? statusOf("waiting", "provider_rate_limit")
          : index < 10 || index >= 42
            ? statusOf(undefined)
            : // The settles: whatever the sentence is, it is not checked.
              statusOf("waiting", "retry_backoff")
    }));
    const result = computeE5(runOf(2, { events: window, samples }));
    expect(result).toMatchObject({ checked: 28, matched: 28 });
    expect(result.classMismatches).toEqual([]);
    expect(e5Check(runOf(2, { events: window, samples })).status).toBe("pass");
  });

  it("fails on a sentence of another class after the settle, and says which window", () => {
    const samples = minutes(0, 60, (index) => ({
      jobs: remoteTask,
      status:
        index >= 20 && index < 25
          ? statusOf("offline", "network_unreachable")
          : statusOf("waiting", "provider_rate_limit")
    }));
    const check = e5Check(runOf(2, { events: window, samples }));
    expect(check.status).toBe("fail");
    expect(check.details.join(" ")).toContain("w30 expected waiting.provider_rate_limit");
    expect(check.details.join(" ")).toContain("class mismatches in w30: 5");
  });

  it("takes the highest-precedence class when two windows are active", () => {
    const events = [
      truth("a", "start", 0, 2, ["waiting", "provider_rate_limit"]),
      truth("b", "start", 10 * minute, 2, ["paused", "autonomy_off"], "autonomy_off"),
      truth("b", "end", 30 * minute, 2),
      truth("a", "end", 40 * minute, 2)
    ];
    const samples = minutes(0, 50, (index) => ({
      jobs: remoteTask,
      status:
        index >= 12 && index < 30
          ? statusOf("paused", "autonomy_off")
          : statusOf("waiting", "provider_rate_limit")
    }));
    expect(computeE5(runOf(2, { events, samples })).classMismatches).toEqual([]);
  });

  it("notes a right class with another reason without failing it", () => {
    const samples = minutes(0, 60, () => ({
      jobs: remoteTask,
      status: statusOf("waiting", "provider_unavailable")
    }));
    const result = computeE5(runOf(2, { events: window, samples }));
    expect(result.checked).toBeGreaterThan(0);
    expect(result.matched).toBe(result.checked);
    expect(result.reasonMismatches).toBe(result.checked);
  });

  it("fails when the sentence is still the window's long after it ended", () => {
    const samples = minutes(0, 60, () => ({ status: statusOf("waiting", "provider_rate_limit") }));
    const result = computeE5(runOf(2, { events: window, samples }));
    expect(result.recoveryMismatches.length).toBeGreaterThan(0);
    expect(result.recoveryMismatches[0]).toMatchObject({ window: "w30" });
  });

  it("counts a fallback sample: a task set aside whose sentence names no class", () => {
    const blocked = (cls: string | undefined, reason?: string) => ({
      jobs: [
        { ...job("held", "topic-name"), blockedClass: "cap", blockedReason: "subscription_daily" }
      ],
      status: statusOf(cls, reason)
    });
    const samples = [
      sampleAt(0, blocked("cap", "subscription_daily")),
      sampleAt(minute, blocked(undefined)),
      sampleAt(2 * minute, {
        ...blocked("cap", "subscription_daily"),
        status: { ...statusOf("cap", "x"), fallback: true }
      })
    ];
    const result = computeE5(runOf(1, { events: [], samples }));
    expect(result).toMatchObject({ samplesWithBlocked: 3, fallbackSamples: 2 });
    expect(e5Check(runOf(1, { samples })).status).toBe("fail");
  });

  it("is a review, not a pass, when the run recorded no status", () => {
    const samples = minutes(0, 10, () => ({}));
    expect(e5Check(runOf(1, { events: window, samples })).status).toBe("review");
  });

  it("waits out the settle of an end that is longer than a start's (the sign-in probe)", () => {
    const events = [
      truth("w102", "start", 0, 2, ["no_model", "signin_required"], "unauthorized"),
      truth("w102", "end", 10 * minute, 6)
    ];
    const samples = minutes(0, 30, (index) => ({
      status: index < 16 ? statusOf("no_model", "signin_required") : statusOf(undefined)
    }));
    // At minutes 11-15 the sentence still names the window: inside the six-minute settle, unchecked.
    expect(computeE5(runOf(1, { events, samples })).recoveryMismatches).toEqual([]);
  });

  it("is a review when no call met a provider-wait window: its class could not be shown", () => {
    const unmet = [
      truth("w54", "start", 10 * minute, 2, undefined, "refused"),
      { ...truth("w54", "end", 25 * minute, 2, undefined, "refused"), detail: { met: false } }
    ];
    const samples = minutes(0, 40, () => ({ status: statusOf(undefined) }));
    const check = e5Check(runOf(1, { events: unmet, samples }));
    expect(computeE5(runOf(1, { events: unmet, samples })).notExercised).toEqual([
      { window: "w54", why: "unmet" }
    ]);
    expect(check.status).toBe("review");
    expect(check.details.join(" ")).toContain("w54: no call met its fault");
    // Met, it is checked from that moment like any window.
    const met = [
      truth("w54", "start", 10 * minute, 2, undefined, "refused"),
      truth("w54#met", "start", 14 * minute, 2, ["waiting", "provider_unavailable"], "refused"),
      truth("w54#met", "end", 25 * minute, 2, undefined, "refused"),
      { ...truth("w54", "end", 25 * minute, 2, undefined, "refused"), detail: { met: true } }
    ];
    const following = minutes(0, 40, (index) => ({
      jobs: remoteTask,
      status:
        index >= 14 && index < 27
          ? statusOf("waiting", "provider_unavailable")
          : statusOf(undefined)
    }));
    const result = computeE5(runOf(1, { events: met, samples: following }));
    expect(result).toMatchObject({ notExercised: [], checked: 9, matched: 9 });
    expect(e5Check(runOf(1, { events: met, samples: following })).status).toBe("pass");
  });

  // Gate S 10-25 (soak7-gate-20261024T2343): 33 of its 35 misses were samples where the window's
  // condition affected no work, so the status rightly said idle (spec 3.8: a class with a task
  // it affects); v3 compares only where the condition affects work.
  const idleStatus = { state: "idle", params: {} };
  const busyLane = (waitingP0: number, running = 0) => [
    { ...lane(running), waiting: { P0: waitingP0, P1: 0, P2: 0, P3: 0 } }
  ];

  it("compares a provider window's class only while work uses a remote lane (the usage limit, the sign-in)", () => {
    const events = [
      truth("g30", "start", 0, 2, undefined, "usage_limit"),
      truth("g30#met", "start", 4 * minute, 2, ["waiting", "provider_rate_limit"]),
      truth("g30#met", "end", 15 * minute, 2),
      { ...truth("g30", "end", 15 * minute, 2), detail: { met: true } }
    ];
    const samples = minutes(0, 20, (index) =>
      index === 8
        ? // An Ask waits on the lane: the sentence names the rate limit (00:21:09 in gate S).
          {
            lanes: busyLane(1),
            status: { ...statusOf("waiting", "provider_rate_limit"), state: "idle" }
          }
        : index === 9
          ? // A local Gardener task alone does not use the lane.
            { jobs: [job("rebalance", "topic-rebalance")], status: statusOf("waiting", "queue") }
          : index === 10
            ? // An import waiting for its next attempt is not Gardener work (D27).
              { jobs: [job("import", "ingestion")], status: idleStatus }
            : index === 11
              ? // A remote Gardener task due is affected: idle here is a miss.
                { jobs: [job("match", "relation-match")], status: idleStatus }
              : { status: idleStatus }
    );
    const result = computeE5(runOf(1, { events, samples }));
    expect(result.checked).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.classMismatches).toEqual([
      expect.objectContaining({ window: "g30#met", seen: "none.none (idle)" })
    ]);
    // 6..14 are past the settle and inside the window; 8 and 11 were compared.
    expect(result.unaffected.map((row) => row.at)).toEqual(
      [6, 7, 9, 10, 12, 13, 14].map((index) => at(index * minute))
    );
    // The same samples with the remote task idle as well: nothing to fail, all apart.
    const quiet = samples.map((sample, index) => (index === 11 ? { ...sample, jobs: [] } : sample));
    expect(e5Check(runOf(1, { events, samples: quiet })).status).toBe("pass");
    // A task the breaker set aside is affected too, whatever its kind (d1376f47).
    const outage = [
      truth("g54", "start", 0, 2, ["offline", "network_unreachable"], "enotfound"),
      truth("g54", "end", 10 * minute, 2, undefined, "enotfound")
    ];
    const setAside = minutes(0, 10, () => ({
      jobs: [
        {
          ...job("import", "ingestion"),
          blockedClass: "offline",
          blockedReason: "network_unreachable"
        }
      ],
      status: statusOf("offline", "network_unreachable")
    }));
    expect(computeE5(runOf(1, { events: outage, samples: setAside }))).toMatchObject({
      checked: 8,
      matched: 8
    });
  });

  it("expects a missing decider only from the tasks it set aside, a model check while Gardener work is in progress", () => {
    const ranker = [
      truth("g170", "start", 0, 2, ["no_model", "no_decider"], "ranker_invalid"),
      truth("g170", "end", 10 * minute, 2, undefined, "ranker_invalid")
    ];
    const samples = minutes(0, 10, (index) =>
      index === 4
        ? // A placement due: it takes decision 19's path and waits for its turn, not for a decider.
          { jobs: [job("place", "topic-place")], status: statusOf("waiting", "queue") }
        : index === 5
          ? {
              jobs: [
                {
                  ...job("match", "relation-match"),
                  blockedClass: "no_model",
                  blockedReason: "no_decider"
                }
              ],
              status: { ...statusOf("no_model", "no_decider"), state: "blocked" }
            }
          : { status: idleStatus }
    );
    const result = computeE5(runOf(1, { events: ranker, samples }));
    expect(result).toMatchObject({ checked: 1, matched: 1, classMismatches: [] });
    expect(result.unaffected).toHaveLength(7);

    const embedder = [
      truth("g190", "start", 0, 2, ["download", "model_verifying"], "embedder_verifying"),
      truth("g190", "end", 10 * minute, 2, undefined, "embedder_verifying")
    ];
    const verifying = minutes(0, 10, (index) =>
      index === 6
        ? { jobs: [job("rebalance", "topic-rebalance")], status: idleStatus }
        : index === 7
          ? // Scheduled for tomorrow: not work in progress.
            {
              jobs: [job("retention", "gardener-retention", { runAfter: start + 20 * hour })],
              status: idleStatus
            }
          : { status: idleStatus }
    );
    const checked = computeE5(runOf(1, { events: embedder, samples: verifying }));
    expect(checked).toMatchObject({ checked: 1, matched: 0 });
    expect(checked.classMismatches[0]).toMatchObject({
      window: "g190",
      expected: "download.model_verifying"
    });
  });

  it("keeps a control or a cap standing: idle with no task in the way is still a miss", () => {
    const events = [
      truth("g250", "start", 0, 2, undefined, "money"),
      truth("g250#80", "start", 1 * minute, 2, ["cap", "money_80"], "money"),
      truth("g250#80", "end", 6 * minute, 2, undefined, "money"),
      truth("g250", "end", 9 * minute, 2, undefined, "money")
    ];
    // Gate S 03:55:21 and 03:56:21: the budget paused at 80 %, no task held, the sentence idle.
    const samples = minutes(0, 10, () => ({ status: idleStatus }));
    const result = computeE5(runOf(1, { events, samples }));
    expect(result.classMismatches.map((row) => row.at)).toEqual([
      at(3 * minute),
      at(4 * minute),
      at(5 * minute)
    ]);
    expect(e5Check(runOf(1, { events, samples })).status).toBe("fail");
  });

  it("reads an only-idle block from the sample's power reading, not from the tick that records its end", () => {
    const events = [
      truth("g205", "start", 0, 2, undefined, "only_idle"),
      truth("g205#1", "start", 0, 2, ["paused", "only_idle_user_active"], "only_idle"),
      // The block turned at minute 10; the tick recorded it a little later (gate S: 03:18:07 vs 03:18:19.345).
      truth("g205#1", "end", 10 * minute + 30_000, 2, undefined, "only_idle"),
      truth("g205", "end", 20 * minute, 2, undefined, "only_idle")
    ];
    const power = (active: boolean) => ({
      active,
      onBattery: false,
      overridden: true,
      idleMs: active ? 0 : 300_000 + 11_000
    });
    const samples = minutes(0, 11, (index) =>
      index === 10
        ? { power: power(false), status: idleStatus }
        : { power: power(true), status: statusOf("paused", "only_idle_user_active") }
    );
    const result = computeE5(runOf(1, { events, samples }));
    expect(result).toMatchObject({ checked: 8, matched: 8, classMismatches: [] });
    expect(result.unaffected).toEqual([{ at: at(10 * minute), window: "g205#1" }]);
    // While the reading says the user is active, idle is a miss.
    const missed = samples.map((sample, index) =>
      index === 5 ? { ...sample, status: idleStatus } : sample
    );
    expect(computeE5(runOf(1, { events, samples: missed })).classMismatches).toHaveLength(1);
  });

  it("is a review when a window's class was never compared: no work affected, ended in its settle, never opened", () => {
    const events = [
      truth("g170", "start", 0, 2, ["no_model", "no_decider"], "ranker_invalid"),
      truth("g170", "end", 10 * minute, 2, undefined, "ranker_invalid"),
      truth("g070", "start", 12 * minute, 2, undefined, "refused"),
      truth("g070#met", "start", 20 * minute, 2, ["waiting", "provider_unavailable"], "refused"),
      truth("g070#met", "end", 21 * minute, 2, undefined, "refused"),
      { ...truth("g070", "end", 21 * minute, 2, undefined, "refused"), detail: { met: true } },
      truth("g120", "start", 25 * minute, 2, undefined, "codex_daily_cap"),
      truth("g120", "end", 35 * minute, 2, undefined, "codex_daily_cap")
    ];
    const samples = minutes(0, 40, () => ({
      jobs: [job("match", "relation-match")],
      status: idleStatus
    }));
    const meta = {
      f4: {
        codex: { expected: 1, cap: 2, dropFromHour0: 0 },
        windows: [
          {
            id: "g120",
            kind: "codex_daily_cap",
            startMinute: 25,
            durationMinutes: 10,
            expect: { class: "cap", reason: "subscription_daily" },
            settleMinutes: 2,
            settleEndMinutes: 2
          }
        ],
        predicates: { workerStates: 1 }
      }
    };
    const run = runOf(1, { events, samples, meta });
    expect(computeE5(run).notExercised).toEqual([
      { window: "g070", why: "ended_in_settle" },
      { window: "g120", why: "never_opened" },
      { window: "g170", why: "nothing_affected" }
    ]);
    const check = e5Check(run);
    expect(check.status).toBe("review");
    expect(check.details.join(" ")).toContain("g170: no sample after its settle held work");
  });
});

describe("E5 v4: a fault injected outside any window is a ground truth of its lane", () => {
  const second = 1_000;
  const exchange = (
    seq: number,
    offset: number,
    overrides: Partial<ExchangeRecord> = {}
  ): ExchangeRecord => ({
    type: "exchange",
    provider: "openai-codex",
    seq,
    startedAt: at(offset),
    endedAt: at(offset),
    kind: "unauthorized",
    injected: true,
    status: 401,
    outcome: "completed",
    closedAfterMs: null,
    closedAfterLastWriteMs: null,
    retryAfterSeconds: null,
    plannedMs: null,
    forwardedBytes: 0,
    synthetic: true,
    tag: "soak-injected",
    ...overrides
  });
  const forwarded = (seq: number, offset: number) =>
    exchange(seq, offset, {
      kind: "none",
      injected: false,
      status: 200,
      synthetic: undefined,
      tag: undefined
    });
  /** A call on the Codex lane that succeeded: the lane's success is when its stream ended. */
  const succeeded = (offset: number, finishedAfter: number): TaskRunRecord => ({
    id: `row-${offset}`,
    taskType: "structured-output",
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    runtime: "remote",
    workloadClass: "write-fast",
    lane: codexLane,
    priority: 3,
    deadlineMs: 120_000,
    deadlineOutcome: "met",
    isRepair: false,
    schemaMode: "none",
    retryWaitMs: 0,
    requeueMs: 0,
    queueMs: 1,
    attempt: 0,
    status: "succeeded",
    error: null,
    startedAt: at(offset),
    finishedAt: at(offset + finishedAfter),
    durationMs: finishedAfter,
    inputTokens: 1_000,
    outputTokens: 100,
    budgetClass: "background",
    jobId: null
  });
  const breaker = (offset: number, from: string, to: string): BreakerRecord => ({
    type: "breaker",
    at: at(offset),
    lane: codexLane,
    from,
    to,
    reason: "failures"
  });
  const backfill = (reason: string) => [
    {
      ...job("explain", "relation-explain-backfill"),
      blockedClass: "cap",
      blockedReason: reason
    }
  ];
  const attention = (cls: string, reason: string) => ({
    ...statusOf(cls, reason),
    state: "attention"
  });

  // Gate S soak7-gate-20261025T0815, 12:25:19: a random 401 (rates.unauthorized) on the Codex lane in
  // the second the money window opened. The lane kept the failure until its next success, 12:30:23.
  const fault = 250 * minute;
  const money = [
    truth("g250-money", "start", fault + 13, 2, undefined, "money"),
    truth("g250-money#80", "start", fault + 11 * second, 2, ["cap", "money_80"], "money"),
    truth("g250-money#80", "end", fault + 3 * minute + 11_600, 2, undefined, "money"),
    truth("g250-money#100", "start", fault + 4 * minute + 11_200, 2, ["cap", "money_100"], "money"),
    truth("g250-money#100", "end", fault + 15 * minute, 2, undefined, "money"),
    truth("g250-money", "end", fault + 15 * minute, 2, undefined, "money")
  ];
  const randomFault = exchange(298, fault);
  const nextCall = [forwarded(299, fault + 5 * minute + 900)];
  const nextSuccess = [succeeded(fault + 5 * minute + 900, 2_600)];
  /** Samples a minute from 12:25:30.9; the sentence says sign-in through 12:29:30, then the cap. */
  const gateSamples = (signinUntil = 4) =>
    minutes(fault + 11_500, 12, (index) => ({
      jobs: backfill(index < 4 ? "money_80" : "money_100"),
      status:
        index <= signinUntil
          ? attention("no_model", "signin_required")
          : attention("cap", "money_100")
    }));

  it("replays the lane's failure: a sign-in fault holds until the next success's stream ends", () => {
    const run = runOf(6, { events: [randomFault, ...nextCall], rows: nextSuccess });
    expect(e5LaneFaults(run)).toEqual([
      {
        id: "fault-unauthorized#298",
        lane: codexLane,
        from: start + fault,
        // The answer's headers (5:00.9) do not forget it; the call's end does (5:03.5).
        until: start + fault + 5 * minute + 3_500,
        expect: { class: "no_model", reason: "signin_required" }
      }
    ]);
  });

  it("reads the 12:25 case right: the sign-in outranks the money window's 80 % while the lane holds it", () => {
    const run = runOf(6, {
      events: [randomFault, ...nextCall, ...money],
      rows: nextSuccess,
      samples: gateSamples()
    });
    const result = computeE5(run);
    // 12:27:30 and 12:28:30 against the fault, 12:31:30 to 12:36:30 against the cap at 100 %.
    expect(result).toMatchObject({ checked: 8, matched: 8, laneFaultChecks: 2 });
    expect(result.classMismatches).toEqual([]);
    expect(result.recoveryMismatches).toEqual([]);
    expect(e5Check(run).status).toBe("pass");
    expect(e5Check(run).details.join(" ")).toContain(
      "injected lane faults outside any window, held as the product holds them (E5 v4): 1 (no_model.signin_required 1); 2 sample(s) compared with one"
    );
  });

  it("still fails a sign-in the sentence shows with no injected fault and no window behind it", () => {
    const run = runOf(6, {
      events: [...nextCall, ...money],
      rows: nextSuccess,
      samples: gateSamples()
    });
    const check = e5Check(run);
    expect(check.status).toBe("fail");
    expect(computeE5(run).classMismatches).toEqual([
      expect.objectContaining({
        at: at(fault + 2 * minute + 11_500),
        window: "g250-money#80",
        expected: "cap.money_80",
        seen: "no_model.signin_required (attention)"
      }),
      expect.objectContaining({ at: at(fault + 3 * minute + 11_500), window: "g250-money#80" })
    ]);
    // A real 401 (not injected) is no lane fault either.
    const real = { ...randomFault, injected: false, synthetic: undefined, tag: undefined };
    const unexplained = runOf(6, {
      events: [real, ...nextCall, ...money],
      rows: nextSuccess,
      samples: gateSamples()
    });
    expect(computeE5(unexplained).classMismatches).toHaveLength(2);
  });

  it("fails a sign-in the sentence still shows after the lane's hold ended", () => {
    // The hold ended at 5:03.5; at 12:31:30 (6:11.5) the sentence still says sign-in.
    const run = runOf(6, {
      events: [randomFault, ...nextCall, ...money],
      rows: nextSuccess,
      samples: gateSamples(6)
    });
    expect(computeE5(run).classMismatches).toEqual([
      expect.objectContaining({
        at: at(fault + 6 * minute + 11_500),
        window: "g250-money#100",
        expected: "cap.money_100"
      })
    ]);
    expect(e5Check(run).status).toBe("fail");
    // With no window: the sentence leaves the fault's class after its end like a window's.
    const alone = runOf(6, {
      events: [randomFault, ...nextCall],
      rows: nextSuccess,
      samples: gateSamples(8).map((sample) => ({
        ...sample,
        jobs: [job("match", "relation-match")]
      }))
    });
    expect(computeE5(alone).recoveryMismatches).toEqual([
      {
        at: at(fault + 6 * minute + 11_500),
        window: "fault-unauthorized#298",
        seen: "no_model.signin_required"
      },
      {
        at: at(fault + 7 * minute + 11_500),
        window: "fault-unauthorized#298",
        seen: "no_model.signin_required"
      },
      {
        at: at(fault + 8 * minute + 11_500),
        window: "fault-unauthorized#298",
        seen: "no_model.signin_required"
      }
    ]);
  });

  it("keeps the money window's 80 % binding when no lane fault holds", () => {
    // 10:45:19 in the same run: a 429 11 ms after the 401 is an answer, and the lane forgot it.
    const forgotten = [randomFault, exchange(299, fault + 11, { kind: "rate_limit", status: 429 })];
    const showing = (cls: string, reason: string) =>
      gateSamples().map((sample, index) =>
        index === 2 || index === 3 ? { ...sample, status: attention(cls, reason) } : sample
      );
    const misses = computeE5(
      runOf(6, {
        events: [...forgotten, ...money],
        rows: nextSuccess,
        samples: showing("no_model", "signin_required")
      })
    );
    expect(misses.laneFaultChecks).toBe(0);
    expect(misses.classMismatches.map((row) => row.window)).toEqual([
      "g250-money#80",
      "g250-money#80"
    ]);
    const right = runOf(6, {
      events: [...forgotten, ...money],
      rows: nextSuccess,
      samples: showing("cap", "money_80")
    });
    expect(computeE5(right)).toMatchObject({ classMismatches: [], laneFaultChecks: 0 });
    expect(e5Check(right).status).toBe("pass");
  });

  it("holds a sign-in fault at most the status's failure TTL, and a later failure replaces it", () => {
    const ttl = runOf(6, { events: [randomFault] });
    expect(e5LaneFaults(ttl)[0]?.until).toBe(start + fault + 15 * minute);
    const replaced = runOf(6, {
      events: [randomFault, exchange(299, fault + minute, { kind: "unavailable", status: 503 })],
      rows: nextSuccess
    });
    // The 503 replaces it; with the breaker closed it holds nothing of its own.
    expect(e5LaneFaults(replaced)).toEqual([
      expect.objectContaining({ id: "fault-unauthorized#298", until: start + fault + minute })
    ]);
    // An answer while the breaker is open (a call that started before) forgets nothing.
    const open = runOf(6, {
      events: [
        randomFault,
        breaker(fault + 10 * second, "closed", "open"),
        breaker(fault + 40 * second, "open", "half_open"),
        breaker(fault + 4 * minute, "half_open", "closed")
      ],
      rows: [succeeded(fault + 5 * second, 20 * second), ...nextSuccess]
    });
    expect(e5LaneFaults(open).map((entry) => [entry.id, entry.until - start - fault])).toEqual([
      ["fault-unauthorized#298", 5 * minute + 3_500]
    ]);
  });

  it("reads a rate limit's pause and a breaker the faults opened; a window's own faults are the window's", () => {
    const events = [
      exchange(10, 10 * minute, { kind: "rate_limit", status: 429, retryAfterSeconds: 7 }),
      exchange(11, 20 * minute, { kind: "rate_limit", status: 429, retryAfterSeconds: 3_600 }),
      ...[1, 2, 3, 4, 5].map((index) =>
        exchange(20 + index, 30 * minute + index * 100, { kind: "unavailable", status: 503 })
      ),
      breaker(30 * minute + 600, "closed", "open"),
      breaker(31 * minute, "open", "half_open"),
      breaker(31 * minute + 5 * second, "half_open", "closed"),
      exchange(40, 40 * minute, { kind: "unavailable", status: 503 }),
      exchange(50, 50 * minute, { window: "w102-unauthorized" })
    ];
    expect(
      e5LaneFaults(runOf(2, { events })).map((entry) => [
        entry.id,
        entry.from - start,
        entry.until - entry.from,
        `${entry.expect.class}.${entry.expect.reason}`
      ])
    ).toEqual([
      ["fault-rate_limit#10", 10 * minute, 7_000, "waiting.provider_rate_limit"],
      // The lane pauses at most `maxPauseMs`.
      ["fault-rate_limit#11", 20 * minute, minute, "waiting.provider_rate_limit"],
      ["fault-unavailable#25", 30 * minute + 600, minute + 4_400, "waiting.provider_unavailable"]
    ]);
  });

  it("does not judge a sample in a fault's settle that it would outrank, and leaves lower faults alone", () => {
    const pause = exchange(10, 20 * minute + 50 * second, {
      kind: "rate_limit",
      status: 429,
      retryAfterSeconds: 9
    });
    const events = [
      truth("g30", "start", 0, 2, ["waiting", "provider_unavailable"], "refused"),
      truth("g30", "end", 40 * minute, 2, undefined, "refused"),
      truth("g05", "start", 0, 2, ["offline", "network_unreachable"], "enotfound"),
      truth("g05", "end", 40 * minute, 2, undefined, "enotfound"),
      pause,
      exchange(298, 25 * minute + 30 * second)
    ];
    const samples = minutes(0, 40, (index) => ({
      jobs: [job("match", "relation-match")],
      status:
        index < 26
          ? // The pause is of the window's class: compared with the window as ever.
            statusOf("waiting", "provider_rate_limit")
          : index === 26
            ? statusOf("waiting", "provider_unavailable")
            : statusOf("no_model", "signin_required")
    }));
    const result = computeE5(runOf(1, { events, samples }));
    // Minutes 0-1 are the windows' settle; 26 is the sign-in fault's (25:30-26:30), not judged:
    // either reading may be right. From 27 the fault is expected, above both windows.
    expect(result.classMismatches).toEqual([]);
    expect(result).toMatchObject({ checked: 37, matched: 37, laneFaultChecks: 13 });
    // The same sentence at 26 as at 27 is no miss either.
    const early = samples.map((sample, index) =>
      index === 26 ? { ...sample, status: statusOf("no_model", "signin_required") } : sample
    );
    expect(computeE5(runOf(1, { events, samples: early })).classMismatches).toEqual([]);
  });
});

describe("E4 cap within one call", () => {
  const codexRow = (offset: number, overrides: Partial<TaskRunRecord> = {}): TaskRunRecord => ({
    id: `row-${offset}`,
    taskType: "text-generation",
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    runtime: "remote",
    workloadClass: "write-fast",
    lane: codexLane,
    priority: 3,
    deadlineMs: 120_000,
    deadlineOutcome: "met",
    isRepair: false,
    schemaMode: "none",
    retryWaitMs: 0,
    requeueMs: 0,
    queueMs: 10,
    attempt: 0,
    status: "succeeded",
    error: null,
    startedAt: at(offset),
    finishedAt: at(offset + 2_000),
    durationMs: 2_000,
    inputTokens: 5_000,
    outputTokens: 800,
    budgetClass: "background",
    jobId: null,
    ...overrides
  });

  it("(a) holds the harness cap to the lowered cap plus at most the largest call", () => {
    const events: SoakEvent[] = [
      truth("g285", "start", 100 * minute, 2, undefined, "harness_cap"),
      {
        type: "cap",
        at: at(100 * minute),
        action: "lower",
        capTokens: 60_000,
        spentTokens: 50_000,
        reservedTokens: 0,
        detail: {}
      },
      truth("g285", "end", 120 * minute, 2, undefined, "harness_cap")
    ];
    const samples = minutes(100 * minute, 20, (index) => ({
      cap: {
        capTokens: 60_000,
        spentTokens: 50_000 + (index > 5 ? 8_000 : 0),
        reservedTokens: 0,
        calls: 10,
        refusals: 0,
        largestCallTokens: 5_800
      }
    }));
    const check = e4Check(runOf(3, { events, samples, rows: [codexRow(0)] }));
    expect(check.details.join(" ")).toContain("harness cap lowered to 60000");
    expect(check.details.join(" ")).toContain("2000 under");
    expect(check.status).toBe("pass");
    const over = minutes(100 * minute, 20, () => ({
      cap: {
        capTokens: 60_000,
        spentTokens: 70_000,
        reservedTokens: 0,
        calls: 10,
        refusals: 0,
        largestCallTokens: 5_800
      }
    }));
    expect(e4Check(runOf(3, { events, samples: over, rows: [codexRow(0)] })).status).toBe("fail");
  });

  it("(a) reads a hard cap that was reached as inconclusive, never a pass", () => {
    const events: SoakEvent[] = [
      {
        type: "cap",
        at: at(50 * hour),
        action: "exhausted",
        capTokens: 4_700_000,
        spentTokens: 4_699_000,
        reservedTokens: 0,
        detail: {}
      }
    ];
    expect(e4Check(runOf(100, { events })).status).toBe("fail");
  });

  it("(b) counts the background Codex admissions after the budget's calls read exhausted", () => {
    const events: SoakEvent[] = [
      truth("w84", "start", 10 * minute, 2, ["cap", "subscription_daily"], "codex_daily_cap"),
      truth("w84", "end", 100 * minute, 2, undefined, "codex_daily_cap")
    ];
    const samples = minutes(0, 120, (index) => ({
      budget: {
        moneyState: "open",
        spentUsd: 0,
        reservedUsd: 0,
        capUsd: 5,
        callsState: index >= 30 ? "exhausted" : "open",
        usedCalls: 10 + Math.min(index, 30),
        reservedCalls: 0,
        capCalls: 40
      }
    }));
    const rows = [
      codexRow(20 * minute),
      // One background call is admitted at the crossing (its reservation was taken just before).
      codexRow(30 * minute + 1_000),
      codexRow(50 * minute, { budgetClass: "interactive", priority: 0 })
    ];
    const check = e4Check(runOf(3, { events, samples, rows }));
    expect(check.details.join(" ")).toContain("1 background Codex call(s) admitted after it");
    expect(check.details.join(" ")).toContain("1 P0 or user call(s) went on");
    expect(check.status).toBe("pass");
    const second = [...rows, codexRow(60 * minute)];
    expect(e4Check(runOf(3, { events, samples, rows: second })).status).toBe("fail");
  });

  it("(b) does not count the background calls the budget refused: they were never admitted", () => {
    const events: SoakEvent[] = [
      truth("w84", "start", 10 * minute, 2, undefined, "codex_daily_cap"),
      truth(
        "w84#crossed",
        "start",
        30 * minute,
        2,
        ["cap", "subscription_daily"],
        "codex_daily_cap"
      ),
      truth("w84#crossed", "end", 100 * minute, 2, undefined, "codex_daily_cap"),
      truth("w84", "end", 100 * minute, 2, undefined, "codex_daily_cap")
    ];
    const refused = (offset: number) =>
      codexRow(offset, {
        status: "failed",
        error: "gardener.blocked.cap.subscription_daily",
        inputTokens: null,
        outputTokens: null,
        durationMs: 3
      });
    const rows = [
      codexRow(20 * minute),
      refused(40 * minute),
      refused(50 * minute),
      refused(70 * minute),
      codexRow(80 * minute, { budgetClass: "user", priority: 2 })
    ];
    // No sample recorded the budget: the window's own record of the crossing is the crossing.
    const check = e4Check(runOf(3, { events, rows }));
    expect(check.details.join(" ")).toContain("0 background Codex call(s) admitted after it");
    expect(check.details.join(" ")).toContain("3 refused by the budget");
    expect(check.status).toBe("pass");
    // An admitted background call 40 minutes after the crossing, and a second: the cap leaked.
    const leaked = [...rows, codexRow(70 * minute + 5_000), codexRow(75 * minute)];
    expect(e4Check(runOf(3, { events, rows: leaked })).status).toBe("fail");
  });

  it("(b) reads a cap the count never reached as not exercised: a review, not a fail", () => {
    // Gate S of 10-25: calls so far 65 + 10 over 30 minutes; 3 background calls came (68 of 75).
    const events: SoakEvent[] = [
      {
        ...truth("w84", "start", 10 * minute, 2, undefined, "codex_daily_cap"),
        detail: { callsSoFar: 65, cap: 75 }
      },
      truth("w84", "end", 40 * minute, 2, undefined, "codex_daily_cap")
    ];
    const budget = (usedCalls: number, callsState: "open" | "exhausted" = "open") => ({
      moneyState: "open" as const,
      spentUsd: 0,
      reservedUsd: 0,
      capUsd: 5,
      callsState,
      usedCalls,
      reservedCalls: 0,
      capCalls: 75
    });
    const samples = minutes(10 * minute, 30, (index) => ({
      budget: budget(65 + Math.min(3, index))
    }));
    const check = e4Check(runOf(3, { events, samples, rows: [codexRow(20 * minute)] }));
    expect(check.details.join(" ")).toContain(
      "not exercised: the background Codex calls counted reached 68 of the window's cap 75"
    );
    expect(check.value).toBe("a: n/a, b: review, c: n/a");
    expect(check.status).toBe("review");
    // The count reached the cap and the budget never read exhausted: the cap did not take effect.
    const reached = minutes(10 * minute, 30, () => ({ budget: budget(75) }));
    const failed = e4Check(runOf(3, { events, samples: reached }));
    expect(failed.details.join(" ")).toContain("the cap did not take effect");
    expect(failed.status).toBe("fail");
  });

  it("(c) measures the spend over the cap against one attempt's estimate, not the ledger's remainder", () => {
    // A row's `budgetEstimateUsd` is what the ledger adds for usage the row did not report (0 when
    // it reported its tokens): gate S's report read it as "the largest attempt estimate 0.0000".
    const money: GroundTruthRecord[] = [
      {
        ...truth("w146", "start", 0, 2, undefined, "money"),
        detail: { fakeModel: "dev-fake-priced-1", capUsd: 0.1, attemptEstimateUsd: 0.012216 }
      },
      { ...truth("w146#80", "start", 5 * minute, 2, ["cap", "money_80"], "money") },
      {
        ...truth("w146#80", "end", 10 * minute, 2, undefined, "money"),
        detail: { continued: true }
      },
      { ...truth("w146#100", "start", 12 * minute, 2, ["cap", "money_100"], "money") },
      truth("w146", "end", 30 * minute, 2, undefined, "money")
    ];
    const samples = (spentUsd: number) =>
      minutes(0, 30, () => ({
        budget: {
          moneyState: "exhausted",
          spentUsd,
          reservedUsd: 0,
          capUsd: 0.1,
          callsState: "open",
          usedCalls: 0,
          reservedCalls: 0,
          capCalls: 800
        }
      }));
    const priced = codexRow(minute, {
      provider: "openai-compatible",
      modelId: "dev-fake-priced-1",
      lane: "remote:fake",
      inputTokens: 5_808,
      outputTokens: 2_048,
      budgetEstimateUsd: 0
    });
    const plan = {
      f4: { money: { model: "dev-fake-priced-1", inputUsdPerM: 1, outputUsdPerM: 4 } }
    };
    const run = (spentUsd: number) =>
      runOf(8, { events: money, samples: samples(spentUsd), rows: [priced], meta: { plan } });
    // The largest priced attempt billed 5,808 in + 2,048 out = US$0.0140 at the fake's prices.
    const within = e4Check(run(0.11));
    expect(within.details.join(" ")).toContain("0.0100 over; the largest attempt estimate 0.0140");
    expect(within.status).toBe("pass");
    expect(e4Check(run(0.115)).status).toBe("fail");
  });

  it("(c) wants both money transitions, the continue, and spend within one attempt's estimate of the cap", () => {
    const money: GroundTruthRecord[] = [
      // The driver records the attempt estimate it set the cap from.
      {
        ...truth("w146", "start", 0, 2, undefined, "money"),
        detail: { attemptEstimateUsd: 0.008 }
      },
      {
        ...truth("w146#80", "start", 20 * minute, 2, ["cap", "money_80"], "money"),
        detail: { stage: "money_80" }
      },
      {
        ...truth("w146#80", "end", 31 * minute, 2, undefined, "money"),
        detail: { continued: true }
      },
      {
        ...truth("w146#100", "start", 45 * minute, 2, ["cap", "money_100"], "money"),
        detail: { stage: "money_100" }
      },
      truth("w146", "end", 6 * hour, 2, undefined, "money")
    ];
    const samples = minutes(0, 60, (index) => ({
      budget: {
        moneyState: index > 44 ? "exhausted" : "open",
        spentUsd: Math.min(0.083, index * 0.0015),
        reservedUsd: 0,
        capUsd: 0.08,
        callsState: "open",
        usedCalls: 0,
        reservedCalls: 0,
        capCalls: 800
      }
    }));
    const rows = [
      codexRow(0, { provider: "openai-compatible", lane: "remote:fake", budgetEstimateUsd: 0.008 })
    ];
    const check = e4Check(runOf(8, { events: money, samples, rows }));
    expect(check.details.join(" ")).toContain("cap.money_80 seen");
    expect(check.details.join(" ")).toContain("continued");
    expect(check.details.join(" ")).toContain("cap.money_100 seen");
    expect(check.status).toBe("pass");
    const missing = e4Check(
      runOf(8, { events: money.filter((entry) => !entry.id.endsWith("#100")), samples, rows })
    );
    expect(missing.status).toBe("fail");
  });
});

describe("the injection ledger", () => {
  const exchange = (overrides: Partial<ExchangeRecord> = {}): ExchangeRecord => ({
    type: "exchange",
    provider: "openai-codex",
    seq: 1,
    startedAt: at(0),
    endedAt: at(1_000),
    kind: "rate_limit",
    injected: true,
    status: 429,
    outcome: "completed",
    closedAfterMs: null,
    closedAfterLastWriteMs: null,
    retryAfterSeconds: 3,
    plannedMs: null,
    forwardedBytes: 0,
    synthetic: true,
    tag: "soak-injected",
    ...overrides
  });

  it("passes when every injected exchange is tagged and forwarded nothing but a stall", () => {
    const events = [
      exchange(),
      exchange({ seq: 2, kind: "unavailable", status: 503 }),
      exchange({
        seq: 3,
        kind: "stall",
        status: 200,
        outcome: "client_closed",
        forwardedBytes: 4_200
      }),
      exchange({
        seq: 4,
        kind: "none",
        injected: false,
        status: 200,
        forwardedBytes: 5_000,
        tag: undefined,
        synthetic: undefined
      })
    ];
    const { check, table } = injectionCheck(runOf(1, { events }));
    expect(check.status).toBe("pass");
    expect(check.value).toContain("3 injected of 4 Codex exchange(s)");
    expect(table.find((row) => row.kind === "stall")).toMatchObject({ "bytes forwarded": 4_200 });
  });

  it("fails on a non-stall injected exchange that forwarded bytes, and on a missing tag", () => {
    const forwarded = injectionCheck(runOf(1, { events: [exchange({ forwardedBytes: 120 })] }));
    expect(forwarded.check.status).toBe("fail");
    expect(forwarded.check.details[0]).toContain("forwarded 120 byte(s)");
    const untagged = injectionCheck(runOf(1, { events: [exchange({ tag: undefined })] }));
    expect(untagged.check.status).toBe("fail");
    const stalled = injectionCheck(
      runOf(1, {
        events: [exchange({ kind: "stall", forwardedBytes: 0, outcome: "client_closed" })]
      })
    );
    expect(stalled.check.status).toBe("fail");
  });

  it("says the fault bodies are synthetic shapes", () => {
    expect(injectionCheck(runOf(1, { events: [exchange()] })).check.value).toContain(
      "synthetic shapes built from our parser's patterns"
    );
  });
});

describe("the token budget and the load ledger", () => {
  it("sums the Codex tokens of the real lane against the plan, with the drop steps taken", () => {
    const rows: TaskRunRecord[] = Array.from({ length: 3 }, (_, index) => ({
      id: `r${index}`,
      taskType: "text-generation",
      provider: "openai-codex",
      modelId: "m",
      runtime: "remote",
      workloadClass: "write-fast",
      lane: codexLane,
      priority: 3,
      deadlineMs: 1,
      deadlineOutcome: "met",
      isRepair: false,
      schemaMode: null,
      retryWaitMs: 0,
      requeueMs: 0,
      queueMs: 0,
      attempt: 0,
      status: "succeeded",
      error: null,
      startedAt: at(index * hour),
      finishedAt: at(index * hour + 1_000),
      durationMs: 1_000,
      inputTokens: 1_000,
      outputTokens: 500
    }));
    const events: SoakEvent[] = [
      {
        type: "drop_step",
        at: at(30 * hour),
        step: 1,
        spentTokens: 1_000_000,
        projectedTokens: 4_000_000,
        capTokens: 4_700_000,
        note: "explanation bursts off"
      }
    ];
    const { check, table } = tokensCheck(runOf(168, { rows, events }));
    expect(check.status).toBe("pass");
    expect(check.value).toContain("4500 tokens in 3 Codex call(s)");
    expect(check.value).toContain("1 drop step(s)");
    expect(table[0]).toMatchObject({ day: 1, "Codex tokens": 4_500 });
  });

  it("fails a run that reached the hard cap and reviews a run at the last drop step", () => {
    const exhausted: SoakEvent[] = [
      {
        type: "cap",
        at: at(hour),
        action: "exhausted",
        capTokens: 1,
        spentTokens: 1,
        reservedTokens: 0,
        detail: {}
      }
    ];
    expect(tokensCheck(runOf(10, { events: exhausted })).check.status).toBe("fail");
    const floor: SoakEvent[] = [
      { type: "drop_step", at: at(hour), step: 5, spentTokens: 1, projectedTokens: 1, capTokens: 1 }
    ];
    expect(tokensCheck(runOf(10, { events: floor })).check.status).toBe("review");
  });

  it("tells the busiest outside processes by day, and reviews critical memory pressure", () => {
    const samples = minutes(0, 5, (index) => ({
      load: {
        loadAverage: [2.5, 2, 1] as [number, number, number],
        memoryPressure: index === 3 ? ("critical" as const) : ("normal" as const),
        memoryFreePercent: 40,
        top: [{ command: "node", cpuPercent: 90, rssMb: 1200 }]
      }
    }));
    const { check, table } = loadCheck(runOf(1, { samples }));
    expect(check.status).toBe("review");
    expect(table[0]).toMatchObject({
      day: 1,
      "max load (1 min)": 2.5,
      "pressure critical": 1,
      "busy outside processes (>= 50 % CPU, minutes)": "node 5"
    });
  });
});

describe("the whole F4 report", () => {
  const codexRow = (): TaskRunRecord => ({
    id: "row-local",
    taskType: "structured-output",
    provider: "local-mlx",
    modelId: "writer",
    runtime: "mlx",
    workloadClass: "write-fast",
    lane: "local",
    priority: 2,
    deadlineMs: 140_000,
    deadlineOutcome: "met",
    isRepair: true,
    schemaMode: "none",
    retryWaitMs: 0,
    requeueMs: 0,
    queueMs: 0,
    attempt: 0,
    status: "succeeded",
    error: null,
    startedAt: at(hour),
    finishedAt: at(hour + 1_000),
    durationMs: 1_000
  });

  it("adds E1 to E5, the ledgers, the predicate versions and the relations line to a 7-day run's report", () => {
    const run = runOf(2, { samples: minutes(0, 120, () => ({})) });
    const report = analyzeRun(run, { now: new Date("2026-11-04T00:00:00Z") });
    expect(report.f4).not.toBeNull();
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "e1-blocked",
        "e2-quarantine",
        "e3-within-24h",
        "e4-cap",
        "e5-status",
        "injection-ledger",
        "tokens",
        "load-ledger"
      ])
    );
    expect(report.predicates).toMatchObject({ e1: 1, e3: 2, e5: 4, workerStates: 1 });
    expect(report.relations).toContain("source discovery neighbours 1");
    // The source judge's mode beside the neighbours (F4 D21): what C2 decided, the run states.
    expect(report.relations).toContain("source judge perRoot (at most 12 pairs a call)");
    expect(report.relations).toContain("note decider mode ranker");
    const older = runOf(2, {
      samples: minutes(0, 120, () => ({})),
      meta: { relations: { discoveryNeighbours: 1, judgeMode: null } }
    });
    expect(analyzeRun(older, { now: new Date("2026-11-04T00:00:00Z") }).relations).toContain(
      "source judge not recorded"
    );
    const text = renderReport(report);
    expect(text).toContain("Predicates evaluated:");
    expect(text).toContain("synthetic shapes");
    expect(text).toContain("## E1 contention exposure");
    expect(text).toContain("## Injection ledger (Codex lane)");
    expect(text).toContain("source discovery neighbours 1");
  });

  it("leaves an F3 run's report as it was: no F4 section", () => {
    const run = runOf(2, { samples: minutes(0, 5, () => ({})), meta: { f4: undefined } });
    const report = analyzeRun(run);
    expect(report.f4).toBeNull();
    expect(f4Report(run, { injected: new Map(), injectedJobs: new Map() })).toBeNull();
  });

  it("counts the local writer's rows in the repair rate with --count-local-writer, and wants 0 in mode none", () => {
    const run = runOf(2, { samples: minutes(0, 5, () => ({})), rows: [codexRow()] });
    const set = analyzeRun(run);
    const counted = analyzeRun(run, { countLocalWriter: true });
    const repairs = (report: ReturnType<typeof analyzeRun>) =>
      report.checks.find((check) => check.id === "repairs")!;
    // Decision 31a sets the local writer's rows aside, so nothing counts; C4 counts them.
    expect(repairs(set).status).toBe("review");
    expect(repairs(counted).status).toBe("fail");
    expect(repairs(counted).value).toContain("1 local-writer structured row(s) in mode none");
    expect(counted.countedLocalWriter).toBe(true);
    expect(renderReport(counted)).toContain("every local-writer row");
  });
});

// Gate S of 10-25 left g070, g170 and g190 with nothing their condition affects, so their classes
// were never compared (review). The plan now gives each the work it needs; these read the plan's own
// numbers against the rule that decides what is affected (E5 v3).
describe("the work the gate S plan gives the windows E5 v3 compared nothing in", () => {
  const { profile } = readSoakPlan(resolve(import.meta.dirname, "plan.json"), "soak7-gate");
  const windows = expandWindows(profile.f4!, profile.durationHours * 60);
  const window = (id: string) => windows.find((entry) => entry.id === id)!;
  const backfill = (overrides: Partial<Job> = {}) =>
    job("backfill", "relation-explain-backfill", overrides);

  it("g070: a backfill that met the refusal and was set aside is remote Gardener work the outage affects, and an Ask on the lane alone is not", () => {
    const refused = window("g070-refused");
    expect(refused.params.backfillRelations).toBeGreaterThan(0);
    const setAside = backfill({ blockedClass: "waiting", blockedReason: "provider_unavailable" });
    expect(e5Affected(sampleAt(0, { jobs: [setAside] }), refused.expect!)).toBe(true);
    expect(
      e5Affected(sampleAt(0, { jobs: [backfill({ status: "running" })] }), refused.expect!)
    ).toBe(true);
    // The window ends with nothing queued: the sentence has nothing to name.
    expect(e5Affected(sampleAt(0, { jobs: [] }), refused.expect!)).toBe(false);
  });

  it("g170: an edited note's match, set aside for want of a decider, is the only work the missing decider affects", () => {
    const ranker = window("g170-ranker-invalid");
    expect(ranker.params.noteEdits).toBeGreaterThan(0);
    const match = job("match", "relation-match", {
      blockedClass: "no_model",
      blockedReason: "no_decider"
    });
    expect(e5Affected(sampleAt(0, { jobs: [match] }), ranker.expect!)).toBe(true);
    // A match still waiting out its debounce, or a placement taking decision 19's path, is not set aside.
    expect(
      e5Affected(sampleAt(0, { jobs: [job("match", "relation-match")] }), ranker.expect!)
    ).toBe(false);
    expect(e5Affected(sampleAt(0, { jobs: [job("place", "topic-place")] }), ranker.expect!)).toBe(
      false
    );
  });

  it("g190: backfills due late are Gardener work in progress from the settle to the minute they are due, for several samples", () => {
    const embedder = window("g190-embedder-verifying");
    const delay = embedder.params.backfillDelayMinutes!;
    const due = start + delay * minute;
    const pending = backfill({ runAfter: due });
    const inWindow = (m: number) =>
      sampleAt(m * minute, { jobs: m * minute < delay * minute ? [pending] : [] });
    const compared = Array.from({ length: embedder.durationMinutes }, (_, index) => index)
      .filter((m) => m >= embedder.settleMinutes && m < embedder.durationMinutes)
      .filter((m) => e5Affected(inWindow(m), embedder.expect!));
    // From the settle to the minute they are due, none missing, and at least three samples.
    expect(compared).toEqual(
      Array.from(
        { length: delay - embedder.settleMinutes },
        (_, index) => embedder.settleMinutes + index
      )
    );
    expect(compared.length).toBeGreaterThanOrEqual(3);
    // Due after the window ends they would be nothing to name inside it.
    expect(
      e5Affected(
        sampleAt(embedder.settleMinutes * minute, {
          jobs: [backfill({ runAfter: start + 3 * hour })]
        }),
        embedder.expect!
      )
    ).toBe(false);
  });
});

// The 7-day plan's windows of these kinds bring gate S's work (10-25), unscaled: a refusal and a
// missing decider keep what they set aside for the whole window (g070 for 10 min, g170 for 15), so
// w054's 15 and w114's 30 minutes need no more; w120 lasts g190's 10 minutes.
describe("the work the 7-day plan gives its refused, missing-decider and model-check windows", () => {
  const plan = resolve(import.meta.dirname, "plan.json");
  const read = (name: string) => {
    const { profile } = readSoakPlan(plan, name);
    return { profile, windows: expandWindows(profile.f4!, profile.durationHours * 60) };
  };
  const soak7 = read("soak7");
  const gate = read("soak7-gate");
  const params = (windows: typeof soak7.windows, id: string) =>
    windows.find((entry) => entry.id === id)!.params;

  it("is gate S's, window for window", () => {
    for (const [week, short] of [
      ["w054-refused", "g070-refused"],
      ["w114-ranker-invalid", "g170-ranker-invalid"],
      ["w120-embedder-verifying", "g190-embedder-verifying"]
    ] as const)
      expect(params(soak7.windows, week)).toEqual(params(gate.windows, short));
  });

  it("keeps imports, typing faults and helper faults out of the model-check window", () => {
    const outside = (run: typeof soak7, id: string) => {
      const window = run.windows.find((entry) => entry.id === id)!;
      const from = window.startMinute * minute;
      const to =
        (window.startMinute +
          window.durationMinutes +
          (window.settleEndMinutes ?? window.settleMinutes)) *
        minute;
      return buildTimeline(run.profile)
        .filter((entry) => entry.atMs >= from && entry.atMs < to)
        .map((entry) => entry.kind)
        .filter((kind) =>
          ["article", "source_reimport", "typing_fault", "mlx_kill", "gguf_abort"].includes(kind)
        );
    };
    expect(outside(soak7, "w120-embedder-verifying")).toEqual([]);
    // Gate S's g190 met its typing fault at minute 190, its first minute.
    expect(outside(gate, "g190-embedder-verifying")).toEqual(["typing_fault"]);
  });
});
