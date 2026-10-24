import { describe, expect, it } from "vitest";

import type {
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
  e5Check,
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
    relations: { discoveryNeighbours: 1, judgeMode: "ranker" },
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

  it("counts done, no change, a pending review and a cancellation as completed; a quarantine and a failure as not", () => {
    const events = [
      job24("done", 1),
      job24("nochange", 1, { outcome: "no_change" }),
      job24("review", 1, { outcome: "done", resultStatus: "pending_review" }),
      job24("canceled", 1, { status: "canceled", outcome: null, resultStatus: null }),
      job24("failed", 1, { status: "failed", outcome: null, resultStatus: null }),
      job24("quarantined", 1, {
        status: "failed",
        outcome: null,
        quarantinedAt: at(created + hour)
      })
    ];
    expect(e3Check(runOf(72, { events })).check.value).toContain("4 of 6");
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

  it("passes when the sentence follows the window after the settle of its start and of its end", () => {
    const samples = minutes(0, 60, (index) => ({
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
      status:
        index >= 12 && index < 30
          ? statusOf("paused", "autonomy_off")
          : statusOf("waiting", "provider_rate_limit")
    }));
    expect(computeE5(runOf(2, { events, samples })).classMismatches).toEqual([]);
  });

  it("notes a right class with another reason without failing it", () => {
    const samples = minutes(0, 60, () => ({ status: statusOf("waiting", "provider_unavailable") }));
    const result = computeE5(runOf(2, { events: window, samples }));
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

  it("(c) wants both money transitions, the continue, and spend within one attempt's estimate of the cap", () => {
    const money: GroundTruthRecord[] = [
      truth("w146", "start", 0, 2, undefined, "money"),
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
    expect(report.predicates).toMatchObject({ e1: 1, e5: 1, workerStates: 1 });
    expect(report.relations).toContain("source discovery neighbours 1");
    expect(report.relations).toContain("judge decider mode ranker");
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
