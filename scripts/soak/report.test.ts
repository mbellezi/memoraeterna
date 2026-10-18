import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  soakFiles,
  type ExchangeRecord,
  type SoakEvent,
  type SoakMeta,
  type SoakSample,
  type TaskRunRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import {
  analyzeRun,
  classifyError,
  injectedRows,
  isStructuredGenerative,
  loadRun,
  presoakAssertions,
  renderReport,
  runSoakReport,
  type Check,
  type LoadedRun
} from "./report.ts";

const start = Date.parse("2026-10-20T08:00:00.000Z");
const minute = 60_000;
const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();

const meta: SoakMeta = {
  format: "memora-soak-run",
  version: 1,
  run: "presoak4-test",
  profile: "presoak4",
  seed: 20261021,
  startedAt: at(0),
  endedAt: at(240 * minute),
  endReason: "duration",
  durationMs: 240 * minute,
  warmupMs: 20 * minute,
  sampleIntervalMs: minute,
  host: { platform: "darwin", arch: "arm64", totalMemoryMb: 32768 },
  catalogHeader: { refresh: "on", reason: null },
  bounds: { connectMs: 10_000, firstByteMs: 30_000, stallMs: 20_000 },
  providers: [
    { provider: "openai-compatible", providerConfigId: "aaa", baseUrl: "http://127.0.0.1:1/v1" },
    {
      provider: "codex-wire",
      providerConfigId: "ccc",
      baseUrl: "http://127.0.0.1:2/backend-api/codex"
    }
  ],
  plan: {}
};

let counter = 0;
function row(offsetMs: number, overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
  const durationMs = overrides.durationMs ?? 1_000;
  counter += 1;
  return {
    id: `row-${counter}`,
    taskType: "summarization",
    provider: "local-mlx",
    modelId: "writer",
    runtime: "local",
    workloadClass: "write-fast",
    lane: "local",
    priority: 2,
    deadlineMs: 140_000,
    deadlineOutcome: "met",
    isRepair: false,
    schemaMode: "none",
    retryWaitMs: 0,
    requeueMs: 0,
    queueMs: 20,
    attempt: 0,
    status: "succeeded",
    error: null,
    startedAt: at(offsetMs),
    finishedAt: at(offsetMs + durationMs),
    durationMs,
    ...overrides
  };
}

function exchange(offsetMs: number, overrides: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    type: "exchange",
    provider: "codex-wire",
    seq: ++counter,
    startedAt: at(offsetMs),
    endedAt: at(offsetMs + 3_000),
    kind: "none",
    injected: false,
    status: 200,
    outcome: "completed",
    closedAfterMs: null,
    closedAfterLastWriteMs: null,
    retryAfterSeconds: null,
    plannedMs: 3_000,
    ...overrides
  };
}

function samples(
  options: {
    pageouts?: (minute: number) => number;
    spawn?: (minute: number) => number;
    running?: (lane: string, minute: number) => number;
  } = {}
): SoakSample[] {
  return Array.from({ length: 241 }, (_, index) => ({
    at: at(index * minute),
    elapsedMs: index * minute,
    lanes: ["local", "remote:ccc", "remote:aaa"].map((lane) => ({
      lane,
      limit: lane === "local" ? 1 : 2,
      running: options.running?.(lane, index) ?? 0,
      held: 0,
      waiting: { P0: 0, P1: 0, P2: 0, P3: 0 },
      rateLimits: 0,
      breaker: lane === "local" ? null : "closed"
    })),
    jobs: [],
    jobCounts: {},
    helper: { pid: 10, rssMb: 5_000, spawnCount: options.spawn?.(index) ?? 1 },
    appRssMb: 700,
    pageouts: options.pageouts?.(index) ?? 1_000,
    pageSizeBytes: 16_384,
    eventLoopLagP99Ms: 8,
    dbPool: { total: 4, idle: 3, waiting: 0 }
  }));
}

/** A day with nothing wrong: local and remote calls, a few P0 ones, no failure. */
function goodRun(
  extra: { rows?: TaskRunRecord[]; events?: SoakEvent[]; samples?: SoakSample[] } = {}
): LoadedRun {
  const rows = [
    row(30 * minute, {
      taskType: "knowledge-graph-generation",
      schemaMode: "strict",
      durationMs: 40_000
    }),
    row(40 * minute, {
      taskType: "embedding",
      workloadClass: "embed",
      priority: 0,
      deadlineMs: 30_000,
      durationMs: 300,
      queueMs: 800
    }),
    row(50 * minute, {
      taskType: "text-generation",
      provider: "openai-codex",
      runtime: "remote",
      lane: "remote:ccc",
      workloadClass: "write-fast",
      priority: 0,
      deadlineMs: 120_000,
      durationMs: 4_000,
      queueMs: 40
    }),
    row(60 * minute, {
      taskType: "structured-output",
      provider: "openai-compatible",
      runtime: "remote",
      lane: "remote:aaa",
      workloadClass: "answer",
      priority: 0,
      deadlineMs: 180_000,
      durationMs: 9_000,
      queueMs: 30,
      schemaMode: "json"
    }),
    ...(extra.rows ?? [])
  ];
  return {
    meta,
    events: [exchange(50 * minute, { provider: "codex-wire" }), ...(extra.events ?? [])],
    samples: extra.samples ?? samples(),
    rows,
    invalid: {}
  };
}

const statusOf = (checks: readonly Check[], id: string) =>
  checks.find((check) => check.id === id)?.status;

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("calls past deadline", () => {
  it("counts duration minus the lane re-waits against the deadline plus two seconds", () => {
    const quiet = analyzeRun(goodRun());
    expect(statusOf(quiet.checks, "past-deadline")).toBe("pass");
    // 130 s against 120 s is past; with 20 s of re-waiting excluded it is not; 2 s over is allowed.
    const past = analyzeRun(
      goodRun({
        rows: [
          row(70 * minute, {
            lane: "remote:ccc",
            runtime: "remote",
            deadlineMs: 120_000,
            durationMs: 130_000,
            deadlineOutcome: "aborted",
            status: "failed",
            error: "stalled"
          })
        ]
      })
    );
    expect(statusOf(past.checks, "past-deadline")).toBe("fail");
    const excluded = analyzeRun(
      goodRun({
        rows: [
          row(70 * minute, {
            lane: "remote:ccc",
            runtime: "remote",
            deadlineMs: 120_000,
            durationMs: 130_000,
            requeueMs: 20_000
          })
        ]
      })
    );
    expect(statusOf(excluded.checks, "past-deadline")).toBe("pass");
    const slack = analyzeRun(
      goodRun({ rows: [row(70 * minute, { deadlineMs: 120_000, durationMs: 121_900 })] })
    );
    expect(statusOf(slack.checks, "past-deadline")).toBe("pass");
  });

  it("sees a call that never ended through its lane: busy for longer than any deadline with nothing ending", () => {
    const stuck = samples({
      running: (lane, index) => (lane === "local" && index > 100 && index < 130 ? 1 : 0)
    });
    const report = analyzeRun(goodRun({ samples: stuck }));
    const check = report.checks.find((entry) => entry.id === "past-deadline")!;
    expect(check.status).toBe("fail");
    expect(check.details.join(" ")).toContain("local: busy from");
    // The same occupation with calls ending every minute is a busy lane, not a wedged one.
    const busy = Array.from({ length: 30 }, (_, index) =>
      row((101 + index) * minute, { durationMs: 50_000 })
    );
    expect(
      statusOf(analyzeRun(goodRun({ samples: stuck, rows: busy })).checks, "past-deadline")
    ).toBe("pass");
  });

  it("lists a slot held after its call settled as a wedged event to explain", () => {
    const held = samples();
    for (const point of held.slice(50, 55)) point.lanes[0] = { ...point.lanes[0]!, held: 1 };
    const report = analyzeRun(goodRun({ samples: held }));
    expect(report.wedged).toHaveLength(1);
    expect(statusOf(report.checks, "failure-handling")).toBe("review");
  });
});

describe("repairs", () => {
  it("excludes injected calls and reports the local writer's graph apart", () => {
    const structured = Array.from({ length: 100 }, (_, index) =>
      row(80 * minute + index * 1_000, {
        taskType: "structured-output",
        workloadClass: "write-quality",
        schemaMode: "strict"
      })
    );
    expect(statusOf(analyzeRun(goodRun({ rows: structured })).checks, "repairs")).toBe("pass");
    // Four repairs in 104 calls is above 2 %: a failure, unless they follow an injected malformed answer.
    const repairs = [0, 1, 2, 3].map((index) =>
      row(90 * minute + index * 10_000, {
        taskType: "structured-output",
        workloadClass: "answer",
        provider: "openai-compatible",
        runtime: "remote",
        lane: "remote:aaa",
        schemaMode: "json",
        isRepair: true,
        attempt: 1
      })
    );
    expect(
      statusOf(analyzeRun(goodRun({ rows: [...structured, ...repairs] })).checks, "repairs")
    ).toBe("fail");
    const malformed = [0, 1, 2, 3].map((index) =>
      exchange(90 * minute + index * 10_000 - 2_000, {
        provider: "openai-compatible",
        kind: "malformed",
        injected: true
      })
    );
    const excused = analyzeRun(goodRun({ rows: [...structured, ...repairs], events: malformed }));
    expect(statusOf(excused.checks, "repairs")).toBe("pass");
    expect(injectedRows(goodRun({ rows: repairs, events: malformed })).size).toBe(4);
    // Repairs only in the local writer's graph: the split is reported and the owner asked.
    const graph = Array.from({ length: 10 }, (_, index) =>
      row(100 * minute + index * 1_000, {
        taskType: "knowledge-graph-generation",
        schemaMode: "strict",
        isRepair: index < 3
      })
    );
    const split = analyzeRun(goodRun({ rows: [...structured, ...graph] }));
    expect(statusOf(split.checks, "repairs")).toBe("review");
    expect(split.checks.find((check) => check.id === "repairs")!.details.join(" ")).toContain(
      "ask the owner"
    );
  });

  it("counts only structured generative calls", () => {
    expect(isStructuredGenerative(row(0, { taskType: "embedding" }))).toBe(false);
    expect(isStructuredGenerative(row(0, { taskType: "reranking", schemaMode: "json" }))).toBe(
      false
    );
    expect(isStructuredGenerative(row(0, { taskType: "summarization", schemaMode: "none" }))).toBe(
      false
    );
    expect(
      isStructuredGenerative(row(0, { taskType: "summarization", schemaMode: "grammar" }))
    ).toBe(true);
    expect(isStructuredGenerative(row(0, { taskType: "knowledge-graph-generation" }))).toBe(true);
  });
});

describe("swap, P0 wait and helper restarts", () => {
  it("counts pageouts after warm-up only", () => {
    const early = samples({
      pageouts: (index) => (index < 15 ? 1_000 + index * 100_000 : 1_000_000)
    });
    expect(statusOf(analyzeRun(goodRun({ samples: early })).checks, "swap")).toBe("pass");
    // 4,000 pages of 16 KiB = 62.5 MB after warm-up.
    const late = samples({ pageouts: (index) => (index > 100 ? 5_000 : 1_000) });
    expect(statusOf(analyzeRun(goodRun({ samples: late })).checks, "swap")).toBe("fail");
  });

  it("compares the longest P0 wait with the longest call on its lane", () => {
    expect(statusOf(analyzeRun(goodRun()).checks, "p0-wait")).toBe("pass");
    const slow = row(120 * minute, {
      taskType: "embedding",
      workloadClass: "embed",
      priority: 0,
      deadlineMs: 30_000,
      durationMs: 200,
      queueMs: 80_000
    });
    const report = analyzeRun(goodRun({ rows: [slow] }));
    expect(statusOf(report.checks, "p0-wait")).toBe("fail");
    expect(report.tables.p0.find((entry) => entry.class === "embed")?.["p100 wait (ms)"]).toBe(
      80_000
    );
  });

  it("wants as many helper restarts as injected kills", () => {
    const kill = (offset: number): SoakEvent => ({
      type: "local",
      kind: "mlx_kill",
      at: at(offset),
      detail: { killed: true, pid: 10, status: "ok" }
    });
    const kills = [kill(75 * minute), kill(150 * minute)];
    const respawned = samples({
      spawn: (index) => 1 + (index > 75 ? 1 : 0) + (index > 150 ? 1 : 0)
    });
    expect(
      statusOf(analyzeRun(goodRun({ samples: respawned, events: kills })).checks, "helper-restarts")
    ).toBe("pass");
    expect(
      statusOf(analyzeRun(goodRun({ samples: samples(), events: kills })).checks, "helper-restarts")
    ).toBe("fail");
    const extra = samples({
      spawn: (index) => 1 + (index > 75 ? 1 : 0) + (index > 150 ? 1 : 0) + (index > 200 ? 1 : 0)
    });
    expect(
      statusOf(analyzeRun(goodRun({ samples: extra, events: kills })).checks, "helper-restarts")
    ).toBe("fail");
  });
});

describe("the breaker", () => {
  const outage = (): SoakEvent => ({
    type: "window",
    provider: "codex-wire",
    kind: "outage",
    startedAt: at(95 * minute),
    endedAt: at(110 * minute),
    factor: null
  });
  const move = (offset: number, from: string, to: string): SoakEvent => ({
    type: "breaker",
    at: at(offset),
    lane: "remote:ccc",
    from,
    to,
    reason: "test"
  });

  it("opens during the outage and closes within a minute after it", () => {
    const events = [
      outage(),
      move(97 * minute, "closed", "open"),
      move(110 * minute + 40_000, "half_open", "closed")
    ];
    expect(statusOf(analyzeRun(goodRun({ events })).checks, "breaker")).toBe("pass");
    expect(
      statusOf(
        analyzeRun(goodRun({ events: [outage(), move(97 * minute, "closed", "open")] })).checks,
        "breaker"
      )
    ).toBe("fail");
    expect(
      statusOf(
        analyzeRun(
          goodRun({
            events: [
              outage(),
              move(97 * minute, "closed", "open"),
              move(112 * minute, "half_open", "closed")
            ]
          })
        ).checks,
        "breaker"
      )
    ).toBe("fail");
    expect(statusOf(analyzeRun(goodRun({ events: [outage()] })).checks, "breaker")).toBe("fail");
    expect(statusOf(analyzeRun(goodRun()).checks, "breaker")).toBe("n/a");
  });
});

describe("remote deadlines (R6)", () => {
  const late = (closedAfterMs: number) =>
    exchange(70 * minute, {
      kind: "late_first_byte",
      injected: true,
      outcome: "client_closed",
      closedAfterMs,
      closedAfterLastWriteMs: closedAfterMs
    });
  const stall = (closedAfterLastWriteMs: number) =>
    exchange(72 * minute, {
      kind: "stall",
      injected: true,
      outcome: "client_closed",
      closedAfterMs: closedAfterLastWriteMs + 4_000,
      closedAfterLastWriteMs
    });

  it("passes when the late first byte ends at 30 s, the stall at 20 s and Codex ran through its adapter", () => {
    const good = goodRun({ events: [late(30_020), stall(20_030)] });
    expect(statusOf(analyzeRun(good).checks, "remote-deadlines")).toBe("pass");
  });

  it("fails when a bound did not hold, or the totals are not the remote ones", () => {
    expect(
      statusOf(
        analyzeRun(goodRun({ events: [late(8_000), stall(20_030)] })).checks,
        "remote-deadlines"
      )
    ).toBe("fail");
    expect(
      statusOf(
        analyzeRun(goodRun({ events: [late(30_020), stall(9_000)] })).checks,
        "remote-deadlines"
      )
    ).toBe("fail");
    const tripled = row(80 * minute, {
      provider: "openai-codex",
      runtime: "remote",
      lane: "remote:ccc",
      workloadClass: "write-fast",
      deadlineMs: 360_000
    });
    expect(
      statusOf(
        analyzeRun(goodRun({ events: [late(30_020), stall(20_030)], rows: [tripled] })).checks,
        "remote-deadlines"
      )
    ).toBe("fail");
    const noCodex = { ...goodRun({ events: [late(30_020), stall(20_030)] }), rows: [row(1, {})] };
    expect(
      statusOf(
        analyzeRun({
          ...noCodex,
          events: noCodex.events.filter(
            (event) => event.type !== "exchange" || event.kind !== "none"
          )
        }).checks,
        "remote-deadlines"
      )
    ).toBe("fail");
  });

  it("asks a person when a fault kind was never injected", () => {
    expect(statusOf(analyzeRun(goodRun()).checks, "remote-deadlines")).toBe("review");
  });
});

describe("the pre-soak assertion", () => {
  /** One injected occurrence of every kind, each followed by the call outcome the deadlines say. */
  function injectedRun(skip: string[] = []): LoadedRun {
    const events: SoakEvent[] = [];
    const rows: TaskRunRecord[] = [];
    const lane = (provider: string) => (provider === "codex-wire" ? "remote:ccc" : "remote:aaa");
    let cursor = 30 * minute;
    for (const provider of ["codex-wire", "openai-compatible"]) {
      const remoteRow = (overrides: Partial<TaskRunRecord>, duration: number) => {
        rows.push(
          row(cursor, {
            provider: provider === "codex-wire" ? "openai-codex" : "openai-compatible",
            runtime: "remote",
            lane: lane(provider),
            durationMs: duration,
            deadlineMs: 120_000,
            ...overrides
          })
        );
      };
      const kind = (
        name: ExchangeRecord["kind"],
        exchangeFields: Partial<ExchangeRecord>,
        rowFields: Partial<TaskRunRecord>,
        duration = 5_000
      ) => {
        if (skip.includes(`${provider}:${name}`)) return;
        events.push(
          exchange(cursor, {
            provider,
            kind: name,
            injected: true,
            ...exchangeFields,
            endedAt: at(cursor + duration)
          })
        );
        remoteRow(rowFields, duration);
        cursor += 10 * minute;
      };
      kind("rate_limit", { status: 429, retryAfterSeconds: 3 }, { status: "succeeded" });
      kind(
        "unavailable",
        { status: 503 },
        { status: "failed", error: "AI provider returned 503", deadlineOutcome: "met" }
      );
      kind(
        "stall",
        { outcome: "client_closed", closedAfterLastWriteMs: 20_040, closedAfterMs: 24_000 },
        {
          status: "failed",
          deadlineOutcome: "aborted",
          error: "AI provider stream stalled for 20000 ms."
        },
        70_000
      );
      kind(
        "late_first_byte",
        { outcome: "client_closed", closedAfterMs: 30_030, closedAfterLastWriteMs: 30_030 },
        {
          status: "failed",
          deadlineOutcome: "aborted",
          error: "AI provider sent no data within 30000 ms."
        },
        95_000
      );
      kind("malformed", {}, { status: "succeeded" });
      // The repair that follows the malformed answer.
      if (!skip.includes(`${provider}:malformed`))
        rows.push(
          row(cursor - 10 * minute + 6_000, {
            provider: "x",
            runtime: "remote",
            lane: lane(provider),
            isRepair: true,
            attempt: 1,
            durationMs: 3_000,
            deadlineMs: 120_000
          })
        );
    }
    events.push(
      {
        type: "window",
        provider: "codex-wire",
        kind: "outage",
        startedAt: at(150 * minute),
        endedAt: at(165 * minute),
        factor: null
      },
      {
        type: "breaker",
        at: at(153 * minute),
        lane: "remote:ccc",
        from: "closed",
        to: "open",
        reason: "5 consecutive transient failures"
      },
      {
        type: "breaker",
        at: at(165 * minute + 38_000),
        lane: "remote:ccc",
        from: "half_open",
        to: "closed",
        reason: "probe succeeded"
      },
      {
        type: "window",
        provider: "openai-compatible",
        kind: "slow",
        startedAt: at(200 * minute),
        endedAt: at(205 * minute),
        factor: 10
      },
      exchange(201 * minute, { provider: "openai-compatible", kind: "slow", injected: true })
    );
    rows.push(
      row(151 * minute, {
        provider: "openai-codex",
        runtime: "remote",
        lane: "remote:ccc",
        status: "failed",
        error: "fetch failed: ECONNREFUSED",
        deadlineOutcome: "met",
        durationMs: 2_000,
        deadlineMs: 120_000
      }),
      row(201 * minute, {
        provider: "openai-compatible",
        runtime: "remote",
        lane: "remote:aaa",
        durationMs: 40_000,
        deadlineMs: 180_000
      })
    );
    return goodRun({ events, rows });
  }

  it("passes when every injected kind ended with its expected outcome, both fakes", () => {
    const assertions = presoakAssertions(injectedRun());
    expect(assertions.filter((entry) => entry.status !== "pass")).toEqual([]);
    expect(new Set(assertions.map((entry) => entry.kind))).toEqual(
      new Set([
        "rate_limit",
        "unavailable",
        "stall",
        "late_first_byte",
        "malformed",
        "outage",
        "slow"
      ])
    );
    expect(assertions.find((entry) => entry.kind === "stall")?.expectedOutcome).toBe("aborted");
    const report = analyzeRun(injectedRun(), { presoak: true });
    expect(report.presoak).toHaveLength(assertions.length);
    expect(renderReport(report)).toContain("Pre-soak assertion");
  });

  it("fails when a kind was never injected on a fake", () => {
    const missing = presoakAssertions(injectedRun(["codex-wire:stall"]));
    expect(
      missing.find((entry) => entry.provider === "codex-wire" && entry.kind === "stall")
    ).toMatchObject({
      occurrences: 0,
      status: "fail"
    });
    expect(analyzeRun(injectedRun(["codex-wire:stall"]), { presoak: true }).verdict).toBe("fail");
  });

  it("fails when a call did not end the way the deadlines say", () => {
    const run = injectedRun();
    const notAborted = {
      ...run,
      rows: run.rows.map((entry) =>
        /stalled/u.test(entry.error ?? "") ? { ...entry, deadlineOutcome: "met" } : entry
      )
    };
    const assertions = presoakAssertions(notAborted);
    expect(
      assertions.filter((entry) => entry.kind === "stall").every((entry) => entry.status === "fail")
    ).toBe(true);
  });
});

describe("failures and files", () => {
  it("classifies an error by its text", () => {
    const text = (error: string) => classifyError(row(0, { error, status: "failed" }));
    expect(text("AI provider returned 429 rate limit")).toBe("transient: rate limit");
    expect(text("AI provider sent no data within 30000 ms.")).toBe("transient: timeout");
    expect(text("fetch failed ECONNREFUSED")).toBe("transient: network");
    expect(text("organization.errors.invalidOutput")).toBe("permanent: output");
    expect(text("something odd")).toBeNull();
  });

  it("attributes a failed local call to the fault that took effect during it, and to no other", () => {
    const aborted = row(100 * minute, {
      taskType: "embedding",
      workloadClass: "embed",
      status: "failed",
      error: "This operation was aborted",
      durationMs: 800
    });
    const unrelated = row(110 * minute, {
      taskType: "embedding",
      workloadClass: "embed",
      status: "failed",
      error: "This operation was aborted",
      durationMs: 800
    });
    const killed = row(120 * minute, {
      status: "failed",
      error: "errors.localModels.runtimeFailed",
      durationMs: 5_000
    });
    const events: SoakEvent[] = [
      {
        type: "local",
        kind: "gguf_abort",
        at: at(100 * minute + 30),
        detail: { stage: "fired", texts: 8 }
      },
      {
        type: "local",
        kind: "gguf_abort",
        at: at(110 * minute + 30),
        detail: { stage: "finished_first", texts: 8 }
      },
      {
        type: "local",
        kind: "mlx_kill",
        at: at(120 * minute + 1_000),
        detail: { killed: true, pid: 10, status: "ok" }
      },
      {
        type: "local",
        kind: "mlx_kill",
        at: at(130 * minute),
        detail: { killed: false, status: "skipped" }
      }
    ];
    const run = goodRun({ rows: [aborted, unrelated, killed], events });
    expect([...injectedRows(run).entries()]).toEqual([
      [aborted.id, "gguf_abort"],
      [killed.id, "mlx_kill"]
    ]);
    const report = analyzeRun(run);
    expect(report.failureAudit).toHaveLength(1);
    expect(report.failureAudit[0]).toMatchObject({
      task: "embedding",
      error: "This operation was aborted"
    });
  });

  it("audits non-injected failures, at most 50, the same ones each time", () => {
    const failures = Array.from({ length: 80 }, (_, index) =>
      row(100 * minute + index * 1_000, {
        status: "failed",
        error: index % 2 ? "stalled" : "something odd",
        deadlineOutcome: "met"
      })
    );
    const first = analyzeRun(goodRun({ rows: failures }));
    expect(first.failureAudit).toHaveLength(50);
    expect(analyzeRun(goodRun({ rows: failures })).failureAudit).toEqual(first.failureAudit);
    expect(statusOf(first.checks, "failure-handling")).toBe("review");
  });

  it("reads a run directory, writes the report and exits by the verdict", async () => {
    const directory = await mkdtemp(join(tmpdir(), "soak-report-"));
    directories.push(directory);
    const run = goodRun({
      events: [
        exchange(70 * minute, {
          kind: "late_first_byte",
          injected: true,
          outcome: "client_closed",
          closedAfterMs: 30_020
        }),
        exchange(72 * minute, {
          kind: "stall",
          injected: true,
          outcome: "client_closed",
          closedAfterLastWriteMs: 20_020
        })
      ]
    });
    await writeFile(join(directory, soakFiles.meta), JSON.stringify(run.meta));
    const lines = (records: unknown[]) =>
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n\nnot json\n`;
    await writeFile(join(directory, soakFiles.events), lines(run.events));
    await writeFile(join(directory, soakFiles.samples), lines(run.samples));
    await writeFile(join(directory, soakFiles.taskRuns), lines(run.rows));
    const loaded = await loadRun(directory);
    expect(loaded.rows).toHaveLength(run.rows.length);
    expect(loaded.invalid).toEqual({ events: 1, samples: 1, taskRuns: 1 });
    const { text, code } = await runSoakReport([directory]);
    expect(code).toBe(0);
    expect(text).toContain("Soak presoak4-test");
    const markdown = await readFile(join(directory, "report.md"), "utf8");
    expect(markdown).toContain("## X6");
    expect(JSON.parse(await readFile(join(directory, "report.json"), "utf8")).verdict).toBe("pass");
    // A run in progress: the status prints the latest sample and writes nothing new.
    await rm(join(directory, "report.md"));
    const status = await runSoakReport([directory, "--status"]);
    expect(status.text).toContain("Latest sample");
    expect(status.text).toContain("Lanes: local running 0/1");
    await expect(readFile(join(directory, "report.md"), "utf8")).rejects.toThrow();
    await expect(runSoakReport([join(directory, "missing")])).rejects.toThrow(/not a soak run/u);
    expect((await runSoakReport(["--help"])).code).toBe(0);
  });
});
