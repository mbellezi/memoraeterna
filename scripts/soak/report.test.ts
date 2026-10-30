import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  soakFiles,
  type ExchangeRecord,
  type JobFailureEvent,
  type SoakEvent,
  type SoakMeta,
  type SoakSample,
  type TaskRunRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import {
  analyzeRun,
  classifyError,
  injectedJobFailures,
  injectedRows,
  isStructuredGenerative,
  isUnconstrainedLocalWriterCall,
  loadRun,
  p0Waits,
  pageoutWindows,
  presoakAssertions,
  renderReport,
  runSoakReport,
  statusDigest,
  unexplainedActionFailures,
  windowRefusals,
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
    runtime: "mlx",
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
      schemaMode: "none",
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
  /** A call of a remote answer provider: schema output on, so it counts against the bar. */
  const answer = (offsetMs: number, overrides: Partial<TaskRunRecord> = {}) =>
    row(offsetMs, {
      taskType: "structured-output",
      workloadClass: "answer",
      provider: "openai-compatible",
      runtime: "remote",
      lane: "remote:aaa",
      schemaMode: "json",
      ...overrides
    });
  /** A call of the local MLX writer: no schema enforcement (schema mode none). */
  const writer = (offsetMs: number, overrides: Partial<TaskRunRecord> = {}) =>
    row(offsetMs, {
      taskType: "knowledge-graph-generation",
      workloadClass: "write-quality",
      schemaMode: "none",
      ...overrides
    });

  it("excludes injected calls: a repair after an injected malformed answer is not counted", () => {
    const structured = Array.from({ length: 100 }, (_, index) =>
      answer(80 * minute + index * 1_000)
    );
    expect(statusOf(analyzeRun(goodRun({ rows: structured })).checks, "repairs")).toBe("pass");
    // Four repairs in 108 calls is above 2 %: a failure, unless they follow an injected malformed
    // answer to the call they repair.
    const firsts = [0, 1, 2, 3].map((index) => answer(90 * minute + index * 10_000));
    const repairs = [0, 1, 2, 3].map((index) =>
      answer(90 * minute + index * 10_000 + 2_000, { isRepair: true, attempt: 1 })
    );
    expect(
      statusOf(
        analyzeRun(goodRun({ rows: [...structured, ...firsts, ...repairs] })).checks,
        "repairs"
      )
    ).toBe("fail");
    const malformed = [0, 1, 2, 3].map((index) =>
      exchange(90 * minute + index * 10_000, {
        provider: "openai-compatible",
        kind: "malformed",
        injected: true,
        endedAt: at(90 * minute + index * 10_000 + 500)
      })
    );
    const excused = analyzeRun(
      goodRun({ rows: [...structured, ...firsts, ...repairs], events: malformed })
    );
    expect(statusOf(excused.checks, "repairs")).toBe("pass");
    const reasons = injectedRows(goodRun({ rows: [...firsts, ...repairs], events: malformed }));
    expect(reasons.size).toBe(8);
    expect(repairs.every((entry) => reasons.get(entry.id) === "malformed")).toBe(true);
  });

  it("lets an injected exchange explain only the call it belongs to, not the calls beside it on the lane", () => {
    // Gate S (10-25): a 30 s late first byte of a graph call overlapped five other Codex calls with
    // answers of their own (a naming repair among them); an overlap set all six aside.
    const codex = (offsetMs: number, overrides: Partial<TaskRunRecord>) =>
      row(offsetMs, {
        provider: "openai-codex",
        runtime: "remote",
        lane: "remote:ccc",
        schemaMode: "none",
        ...overrides
      });
    const late = exchange(90 * minute, {
      provider: "codex-wire",
      kind: "late_first_byte",
      injected: true,
      outcome: "client_closed",
      endedAt: at(90 * minute + 30_000)
    });
    const graph = codex(90 * minute, {
      taskType: "knowledge-graph-generation",
      workloadClass: "write-quality",
      durationMs: 39_000
    });
    const beside = codex(90 * minute + 24_000, {
      taskType: "structured-output",
      workloadClass: "write-fast",
      durationMs: 2_500,
      isRepair: true,
      attempt: 1
    });
    // A retry inside a call that started earlier is that call's, though it did not start with it.
    const retry = exchange(120 * minute + 3_000, {
      provider: "codex-wire",
      kind: "rate_limit",
      injected: true,
      status: 429,
      retryAfterSeconds: 2,
      endedAt: at(120 * minute + 3_000)
    });
    const retried = codex(120 * minute, { taskType: "structured-output", durationMs: 6_000 });
    const reasons = injectedRows(
      goodRun({ rows: [graph, beside, retried], events: [late, retry] })
    );
    expect(reasons.get(graph.id)).toBe("late_first_byte");
    expect(reasons.has(beside.id)).toBe(false);
    expect(reasons.get(retried.id)).toBe("rate_limit");
  });

  it("sets aside only the repair of the call a malformed answer reached, not another caller's that follows", () => {
    // Gate S (10-25): the malformed answer reached a summary call of one job; 66 s later a topic
    // naming job repaired one of its own names. The naming repair is the model's, and counts.
    const codex = (offsetMs: number, overrides: Partial<TaskRunRecord>) =>
      row(offsetMs, {
        provider: "openai-codex",
        runtime: "remote",
        lane: "remote:ccc",
        schemaMode: "none",
        ...overrides
      });
    const malformed = exchange(90 * minute, {
      provider: "codex-wire",
      kind: "malformed",
      injected: true,
      endedAt: at(90 * minute)
    });
    const summary = codex(90 * minute, { taskType: "summarization", jobId: "summary-job" });
    const naming = (offsetMs: number, overrides: Partial<TaskRunRecord> = {}) =>
      codex(offsetMs, {
        taskType: "structured-output",
        workloadClass: "write-fast",
        jobId: "naming-job",
        ...overrides
      });
    const first = naming(90 * minute + 60_000);
    const repair = naming(90 * minute + 66_000, { isRepair: true, attempt: 1 });
    const run = goodRun({ rows: [summary, first, repair], events: [malformed] });
    expect(injectedRows(run).get(summary.id)).toBe("malformed");
    expect(injectedRows(run).has(repair.id)).toBe(false);
    const check = analyzeRun(run).checks.find((entry) => entry.id === "repairs")!;
    // The run's own answer, the naming call and its repair count: 1 of 3.
    expect(check.value).toContain("1 of 3 = 33.33 % counted");
    // The same caller asking again after the malformed answer is the fault's repair.
    const reached = naming(90 * minute, {});
    const own = naming(90 * minute + 6_000, { isRepair: true, attempt: 1 });
    const excused = goodRun({ rows: [reached, own], events: [malformed] });
    expect(injectedRows(excused).get(own.id)).toBe("malformed");
    // A jobless caller (an Ask) is matched by task type and class, never by a job.
    const ask = (offsetMs: number, overrides: Partial<TaskRunRecord> = {}) =>
      codex(offsetMs, { taskType: "structured-output", workloadClass: "answer", ...overrides });
    const askRepair = ask(90 * minute + 6_000, { isRepair: true });
    expect(
      injectedRows(goodRun({ rows: [ask(90 * minute), askRepair], events: [malformed] })).get(
        askRepair.id
      )
    ).toBe("malformed");
    expect(
      injectedRows(goodRun({ rows: [summary, askRepair], events: [malformed] })).has(askRepair.id)
    ).toBe(false);
  });

  it("sets aside every structured call of the local MLX writer (decision 31a), not only its graph", () => {
    const remote = Array.from({ length: 100 }, (_, index) => answer(80 * minute + index * 1_000));
    // Repairs in the writer's graph, atomic notes and structured output: 8-19 % of the writer's calls.
    const local = [
      ...Array.from({ length: 10 }, (_, index) =>
        writer(100 * minute + index * 1_000, { isRepair: index < 3 })
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        writer(101 * minute + index * 1_000, {
          taskType: "atomic-note-generation",
          isRepair: index < 2
        })
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        writer(102 * minute + index * 1_000, {
          taskType: "structured-output",
          workloadClass: "write-fast",
          isRepair: index < 2
        })
      )
    ];
    const report = analyzeRun(goodRun({ rows: [...remote, ...local] }));
    const check = report.checks.find((entry) => entry.id === "repairs")!;
    expect(check.status).toBe("pass");
    // The run's own remote answer is the 101st counted call and its local graph call the 31st set aside.
    expect(check.value).toContain("0 of 101 = 0.00 % counted");
    expect(check.value).toContain("31 local writer call(s), 7 repair(s) = 22.58 %");
    expect(check.bar).toContain("decision 31a");
    // The set-aside calls stay visible in the per-class lines, with their own rate.
    expect(check.details.join(" ")).toContain(
      "write-quality: counted 0 of 0 = 0.00 %; set aside 5 of 20"
    );
    expect(check.details.join(" ")).toContain(
      "all structured calls, set-aside ones included: 7 of 132"
    );
  });

  it("keeps remote, GGUF and schema-constrained local calls counted", () => {
    const base = (index: number) => 100 * minute + index * 1_000;
    const counted = [
      // A remote provider's repair.
      answer(base(0), { isRepair: true, attempt: 1 }),
      // The GGUF runtime constrains the answer with a grammar: its repairs count.
      writer(base(1), {
        runtime: "gguf",
        provider: "local-gguf",
        schemaMode: "grammar",
        isRepair: true
      }),
      // A local MLX call that states an enforced schema mode (a constrained helper, F4) counts too.
      writer(base(2), { schemaMode: "json", isRepair: true }),
      // A GGUF call that stated no schema mode counts: only the MLX writer is set aside.
      writer(base(3), { runtime: "gguf", provider: "local-gguf", isRepair: true })
    ];
    const none = writer(base(4), { isRepair: true });
    const unstated = writer(base(5), { schemaMode: null, isRepair: true });
    for (const entry of counted) expect(isUnconstrainedLocalWriterCall(entry)).toBe(false);
    expect(isUnconstrainedLocalWriterCall(none)).toBe(true);
    expect(isUnconstrainedLocalWriterCall(unstated)).toBe(true);
    // A row without a lane predates the scheduler's columns: it is a local one.
    expect(isUnconstrainedLocalWriterCall(writer(base(6), { lane: null }))).toBe(true);
    // A remote lane never is, whatever its runtime or schema mode says.
    expect(
      isUnconstrainedLocalWriterCall(answer(base(7), { schemaMode: "none", runtime: "mlx" }))
    ).toBe(false);
    const report = analyzeRun(goodRun({ rows: [...counted, none, unstated] }));
    const check = report.checks.find((entry) => entry.id === "repairs")!;
    // Four repairs in five counted calls (the run's own remote answer is the fifth): the bar fails;
    // the two set-aside repairs and the run's own local graph call are information.
    expect(check.status).toBe("fail");
    expect(check.value).toContain("4 of 5 = 80.00 % counted");
    expect(check.value).toContain("3 local writer call(s), 2 repair(s)");
  });

  it("asks for a person when only the writer's calls ran", () => {
    const only = Array.from({ length: 20 }, (_, index) => writer(100 * minute + index * 1_000));
    const report = analyzeRun({ ...goodRun(), rows: only });
    const check = report.checks.find((entry) => entry.id === "repairs")!;
    expect(check.status).toBe("review");
    expect(check.details.join(" ")).toContain("nothing counts against the bar");
  });

  it("counts only structured generative calls", () => {
    expect(isStructuredGenerative(row(0, { taskType: "embedding" }))).toBe(false);
    // A dedicated cross-encoder ranker records no schema mode: it generates nothing.
    expect(isStructuredGenerative(row(0, { taskType: "reranking", schemaMode: null }))).toBe(false);
    expect(isStructuredGenerative(row(0, { taskType: "summarization", schemaMode: "none" }))).toBe(
      false
    );
    expect(
      isStructuredGenerative(row(0, { taskType: "summarization", schemaMode: "grammar" }))
    ).toBe(true);
    expect(isStructuredGenerative(row(0, { taskType: "knowledge-graph-generation" }))).toBe(true);
  });
  it("counts the writer judging a source pair, and its repair, with the structured calls", () => {
    // The source judge runs the reranking task on the writer, which records a schema mode.
    const judge = (offsetMs: number, overrides: Partial<TaskRunRecord> = {}) =>
      row(offsetMs, { taskType: "reranking", workloadClass: "decide", ...overrides });
    expect(isStructuredGenerative(judge(0))).toBe(true);
    expect(isStructuredGenerative(judge(0, { schemaMode: "json" }))).toBe(true);
    const ranker = judge(70 * minute, { modelId: "ranker", schemaMode: null });
    const run = goodRun({
      rows: [
        ranker,
        judge(80 * minute, { attempt: 0 }),
        judge(81 * minute, { attempt: 1, isRepair: true })
      ]
    });
    const check = analyzeRun(run).checks.find((entry) => entry.id === "repairs")!;
    // The writer on the local MLX lane: set aside by decision 31a, reported with its repair.
    expect(check.details).toContain("decide: counted 0 of 0 = 0.00 %; set aside 1 of 2 = 50.00 %");
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

  describe("pageouts in any 24 h (swap v2, the bar F4 registered)", () => {
    // A run of `hours` with a sample every 10 minutes, the meta's warm-up of 20 minutes.
    const long = (hours: number, pageouts: (minute: number) => number | null): LoadedRun => {
      const base = goodRun();
      const count = (hours * 60) / 10 + 1;
      return {
        ...base,
        meta: { ...meta, endedAt: at(hours * 60 * minute), durationMs: hours * 60 * minute },
        samples: Array.from({ length: count }, (_, index) => ({
          ...base.samples[0]!,
          at: at(index * 10 * minute),
          elapsedMs: index * 10 * minute,
          pageouts: pageouts(index * 10)
        }))
      };
    };
    // 64 pages of 16 KiB are 1 MB.
    const mb = (megabytes: number) => megabytes * 64;
    const swapOf = (run: LoadedRun) => analyzeRun(run).checks.find((check) => check.id === "swap")!;

    it("passes 40 MB in each of two days: the 80 MB total is information", () => {
      const check = swapOf(
        long(
          48,
          (minute) =>
            1_000 +
            (minute < 24 * 60
              ? mb(40 * (minute / (24 * 60)))
              : mb(40 + 40 * ((minute - 24 * 60) / (24 * 60))))
        )
      );
      expect(check.status).toBe("pass");
      expect(check.value).toMatch(/^worst 24 h 40\.\d MB \(from /u);
      expect(check.value).toContain("79.");
      expect(check.value).toContain("MB over the run after warm-up (information)");
      expect(check.bar).toContain("in any 24 h after warm-up");
    });

    it("fails 60 MB inside a 24 h span that straddles the day boundary", () => {
      // 30 MB in the last 6 h of day 1 and 30 MB in the first 6 h of day 2: each day holds 30 MB.
      const check = swapOf(
        long(48, (minute) =>
          minute < 18 * 60
            ? 1_000
            : minute < 30 * 60
              ? 1_000 + mb(60 * ((minute - 18 * 60) / (12 * 60)))
              : 1_000 + mb(60)
        )
      );
      expect(check.status).toBe("fail");
      expect(check.value).toMatch(/^worst 24 h 60\.0 MB/u);
    });

    it("reads a lower counter as a reset, not a negative window", () => {
      // 9 MB after warm-up, then the counter restarts at 0 and climbs 20 MB: 29 MB, never a negative step.
      const pages = pageoutWindows(
        long(10, (minute) =>
          minute < 300 ? 1_000 + mb(10 * (minute / 300)) : mb(20 * ((minute - 300) / 300))
        ).samples,
        start + 20 * minute
      );
      expect(pages.worstMb).toBeCloseTo(29, 6);
      expect(pages.totalMb).toBe(pages.worstMb);
      expect(pageoutWindows(long(10, () => null).samples, start + 20 * minute).worstMb).toBeNull();
      expect(swapOf(long(10, () => null)).status).toBe("review");
    });

    it("prints the worst 24 h in the status digest", () => {
      const run = long(48, (minute) => 1_000 + mb(minute / 60));
      const lines = statusDigest(run, analyzeRun(run)).join("\n");
      expect(lines).toMatch(/pageouts worst 24 h 24\.0 MB \(since warm-up 47\.\d MB\)/u);
    });
  });

  it("fails a P0 call that waited behind background work for longer than one bounded call", () => {
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
    const group = report.tables.p0.find((entry) => entry.class === "embed");
    expect(group?.["p100 wait (ms)"]).toBe(80_000);
    expect(group?.["raw queue p100 (ms)"]).toBe(80_000);
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

  it("does not count the helper's first spawn as a restart", () => {
    const beforeFirstSpawn = samples({ spawn: (index) => (index === 0 ? 0 : 1) });
    expect(
      statusOf(
        analyzeRun(goodRun({ samples: beforeFirstSpawn, events: [] })).checks,
        "helper-restarts"
      )
    ).toBe("pass");
  });
});

describe("P0 wait as the spec defines it (3.1)", () => {
  /** A Codex-lane P0 call that took 3 s, admitted `queueMs` before it started. */
  const p0 = (offsetMs: number, queueMs: number, overrides: Partial<TaskRunRecord> = {}) =>
    row(offsetMs, {
      taskType: "text-generation",
      provider: "openai-codex",
      runtime: "remote",
      lane: "remote:ccc",
      workloadClass: "write-fast",
      priority: 0,
      deadlineMs: 120_000,
      durationMs: 3_000,
      queueMs,
      ...overrides
    });
  const groupOf = (report: ReturnType<typeof analyzeRun>) =>
    report.tables.p0.find((entry) => entry.lane === "remote:ccc")!;
  const admitted = 100 * minute;

  it("counts a burst of ten P0 calls from the head of the queue, not from the burst", () => {
    // Ten calls of 3 s admitted together and served one after the other: the tenth waits 27 s.
    const burst = Array.from({ length: 10 }, (_, index) =>
      p0(admitted + index * 3_000, index * 3_000)
    );
    const report = analyzeRun(goodRun({ rows: burst }));
    expect(statusOf(report.checks, "p0-wait")).toBe("pass");
    expect(groupOf(report)["raw queue p100 (ms)"]).toBe(27_000);
    expect(groupOf(report)["p100 wait (ms)"]).toBe(3_000);
    // A tenth call that stayed at the head for 20 s after the ninth started is a late one.
    const late = [...burst.slice(0, 9), p0(admitted + 9 * 3_000 + 20_000, 9 * 3_000 + 20_000)];
    expect(statusOf(analyzeRun(goodRun({ rows: late })).checks, "p0-wait")).toBe("fail");
  });

  describe("a lane's Retry-After pause", () => {
    // The second call is answered 429 at once and the lane pauses 7 s: the third starts at its end.
    const limited = p0(admitted + 3_000, 3_000, {
      durationMs: 2,
      status: "failed",
      error: "AI provider returned 429",
      deadlineOutcome: "met"
    });
    const rows = [p0(admitted, 0), limited, p0(admitted + 10_002, 10_002)];
    const rateLimit = (retryAfterSeconds: number) =>
      exchange(admitted + 3_000, {
        kind: "rate_limit",
        injected: true,
        status: 429,
        retryAfterSeconds,
        endedAt: at(admitted + 3_002),
        plannedMs: 0
      });

    it("is not a wait of the scheduler", () => {
      const without = analyzeRun(goodRun({ rows }));
      expect(statusOf(without.checks, "p0-wait")).toBe("fail");
      expect(groupOf(without)["p100 wait (ms)"]).toBe(7_002);
      const excluded = analyzeRun(goodRun({ rows, events: [rateLimit(7)] }));
      expect(statusOf(excluded.checks, "p0-wait")).toBe("pass");
      expect(groupOf(excluded)["p100 wait (ms)"]).toBe(3_000);
      expect(groupOf(excluded)["raw queue p100 (ms)"]).toBe(10_002);
    });

    it("excludes only the part inside the wait, and at most the 60 s the scheduler pauses for", () => {
      const partial = p0Waits(goodRun({ rows, events: [rateLimit(3)] }));
      expect(partial.find((entry) => entry.row.queueMs === 10_002)?.waitMs).toBe(4_002);
      const long = [p0(admitted, 0), p0(admitted + 90_000, 90_000, { durationMs: 2 })];
      const capped = p0Waits(
        goodRun({ rows: long, events: [{ ...rateLimit(120), endedAt: at(admitted) }] })
      );
      expect(capped.find((entry) => entry.row.queueMs === 90_000)?.waitMs).toBe(30_000);
    });

    it("pauses the lane of the provider that answered, and no other", () => {
      const other = { ...rateLimit(7), provider: "openai-compatible" };
      expect(statusOf(analyzeRun(goodRun({ rows, events: [other] })).checks, "p0-wait")).toBe(
        "fail"
      );
    });
  });

  it("bounds a wait by the longest time a call held its lane, retry sleeps and re-waits left out", () => {
    // One call lasted 70 s, of which 55 s was backoff sleeping off the lane and 6 s a re-wait.
    const sleeper = p0(90 * minute, 0, {
      priority: 2,
      lane: "remote:aaa",
      provider: "openai-compatible",
      durationMs: 70_000,
      retryWaitMs: 55_000,
      requeueMs: 6_000
    });
    // A P0 call that waited 30 s from its admission: far above the 9 s the calls on the lane held it.
    const waiting = p0(admitted, 30_000, { lane: "remote:aaa", provider: "openai-compatible" });
    const report = analyzeRun(goodRun({ rows: [sleeper, waiting] }));
    expect(statusOf(report.checks, "p0-wait")).toBe("fail");
    expect(report.tables.p0.find((entry) => entry.lane === "remote:aaa")?.["bound (ms)"]).toBe(
      11_000
    );
  });
});

describe("the run window", () => {
  it("leaves out the audit rows that started before the run began", () => {
    // Read from the two minutes before the run: a P0 call that waited 80 s and a failed call.
    const waited = row(-30_000, { priority: 0, queueMs: 80_000, durationMs: 400 });
    const failed = row(-20_000, { status: "failed", error: "something odd" });
    const atStart = row(0, { priority: 0, queueMs: 50, durationMs: 400 });
    const report = analyzeRun(goodRun({ rows: [waited, failed, atStart] }));
    expect(report.counts.beforeStart).toBe(2);
    expect(report.counts.taskRuns).toBe(goodRun().rows.length + 1);
    expect(statusOf(report.checks, "p0-wait")).toBe("pass");
    expect(statusOf(report.checks, "failure-handling")).toBe("pass");
    expect(renderReport(report)).toContain("2 audit row(s) that started before the run");
    // The same rows inside the run are counted.
    const inside = analyzeRun(
      goodRun({
        rows: [
          { ...waited, startedAt: at(60 * minute) },
          { ...failed, startedAt: at(61 * minute) }
        ]
      })
    );
    expect(inside.counts.beforeStart).toBe(0);
    expect(statusOf(inside.checks, "p0-wait")).toBe("fail");
    expect(statusOf(inside.checks, "failure-handling")).toBe("review");
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

  it("passes a late first byte whose call was retried after the abort, as spec 5.4 says (gate S, 10-25)", () => {
    // The real lane interleaves calls: a burst of three late first bytes lands on two calls, and
    // each call's next attempt answers. The call ends met after the aborted attempt ended.
    const run = injectedRun();
    const lateExchange = run.events.find(
      (event): event is ExchangeRecord =>
        event.type === "exchange" &&
        event.kind === "late_first_byte" &&
        event.provider === "codex-wire"
    )!;
    const retried = (fields: Partial<TaskRunRecord>) => ({
      ...run,
      rows: run.rows.map((entry) => {
        if (!/sent no data/u.test(entry.error ?? "") || entry.lane !== "remote:ccc") return entry;
        const durationMs = Date.parse(lateExchange.endedAt) - Date.parse(entry.startedAt) + 2_000;
        return {
          ...entry,
          status: "succeeded" as const,
          error: null,
          deadlineOutcome: "met",
          retryWaitMs: 300,
          durationMs,
          finishedAt: new Date(Date.parse(entry.startedAt) + durationMs).toISOString(),
          ...fields
        };
      })
    });
    const lateLine = (target: LoadedRun) =>
      presoakAssertions(target).find(
        (entry) => entry.kind === "late_first_byte" && entry.provider === "codex-wire"
      )!;
    expect(lateLine(run)).toMatchObject({ status: "pass" });
    expect(lateLine(retried({}))).toMatchObject({ status: "pass" });
    expect(lateLine(retried({})).call).toContain(
      "1 of 1 retried after the abort (1 call(s) ended met)"
    );
    // A call that never backed off did not retry; one that ended with the attempt was not retried.
    expect(lateLine(retried({ retryWaitMs: 0 })).status).toBe("fail");
    expect(
      lateLine(
        retried({
          durationMs: 1_000,
          finishedAt: new Date(Date.parse(lateExchange.endedAt) - 1_000).toISOString()
        })
      ).status
    ).toBe("fail");
  });

  it("fails a malformed answer whose second call the audit does not mark as a repair", () => {
    // The Ask path asked again at once (the soak's presoak4 run), but the second call carried
    // neither is_repair nor a retry index: the audit cannot tell it from a new question.
    const run = injectedRun();
    const unmarked = {
      ...run,
      rows: run.rows.map((entry) =>
        entry.isRepair && entry.lane === "remote:aaa"
          ? { ...entry, isRepair: false, attempt: null }
          : entry
      )
    };
    const malformed = presoakAssertions(unmarked).filter((entry) => entry.kind === "malformed");
    expect(malformed.find((entry) => entry.provider === "openai-compatible")).toMatchObject({
      status: "fail"
    });
    // The Codex wire's repair stays marked, so only the Ask path's kind fails.
    expect(malformed.find((entry) => entry.provider === "codex-wire")?.status).toBe("pass");
  });

  it("fails a malformed answer followed only by another caller's repair", () => {
    // Gate S (10-25): the answer reached a summary call (plain text is a summary's answer, so it
    // never repairs) and the line passed on a topic-naming job's repair 66 s later.
    const run = injectedRun();
    const otherCaller = {
      ...run,
      rows: run.rows.map((entry) =>
        entry.isRepair && entry.lane === "remote:ccc" ? { ...entry, jobId: "naming-job" } : entry
      )
    };
    const codex = presoakAssertions(otherCaller).find(
      (entry) => entry.kind === "malformed" && entry.provider === "codex-wire"
    );
    expect(codex).toMatchObject({ status: "fail" });
    expect(codex?.call).toContain("0 followed by a repair of the call it reached");
    expect(codex?.call).toContain("reached: summarization");
  });
});

describe("failed jobs", () => {
  const failedJob = (
    offsetMs: number,
    overrides: Partial<JobFailureEvent> = {}
  ): JobFailureEvent => ({
    type: "job_failure",
    id: `job-${++counter}`,
    jobType: "knowledge-graph-generation",
    lane: "heavy",
    at: at(offsetMs),
    attempts: 1,
    sourceItemId: null,
    error: "errors.entityIdentity.invalidOutput",
    ...overrides
  });
  const failureCheck = (report: ReturnType<typeof analyzeRun>) =>
    report.checks.find((check) => check.id === "failure-handling")!;

  it("audits a failed job although no AI call failed", () => {
    expect(statusOf(analyzeRun(goodRun()).checks, "failure-handling")).toBe("pass");
    const report = analyzeRun(goodRun({ events: [failedJob(100 * minute)] }));
    expect(failureCheck(report).status).toBe("review");
    expect(failureCheck(report).value).toContain("1 non-injected failed job(s)");
    expect(failureCheck(report).details.join(" ")).toContain("errors.entityIdentity.invalidOutput");
    expect(report.counts.failedJobs).toBe(1);
    expect(report.failureAudit).toEqual([
      expect.objectContaining({
        class: "job",
        task: "knowledge-graph-generation",
        lane: "heavy",
        status: "failed",
        "classified as": "permanent: output",
        error: "errors.entityIdentity.invalidOutput"
      })
    ]);
  });

  it("leaves out a job an injected fault explains, and one that failed before the run", () => {
    const marked = failedJob(100 * minute, {
      error: "soak-injected: typing fails for this source."
    });
    // A remote answer that was malformed on purpose, and a job that failed right after it.
    const malformed = exchange(110 * minute, {
      provider: "openai-compatible",
      kind: "malformed",
      injected: true
    });
    const call = row(110 * minute, {
      lane: "remote:aaa",
      runtime: "remote",
      provider: "openai-compatible",
      durationMs: 3_000,
      status: "failed",
      error: "organization.errors.invalidOutput"
    });
    const after = failedJob(110 * minute + 10_000);
    const later = failedJob(110 * minute + 10 * minute);
    const before = failedJob(-60_000);
    const run = goodRun({ rows: [call], events: [marked, malformed, after, later, before] });
    expect([...injectedJobFailures(run, injectedRows(run)).keys()].sort()).toEqual(
      [marked.id, after.id].sort()
    );
    const report = analyzeRun(run);
    // Only the job that failed ten minutes after the injected call is a real failure.
    expect(report.counts.failedJobs).toBe(3);
    expect(report.failureAudit).toHaveLength(1);
    expect(report.failureAudit[0]).toMatchObject({ class: "job" });
    expect(failureCheck(report).value).toContain("0 non-injected failed call(s), 1 non-injected");
    expect(failureCheck(report).details.join(" ")).toContain("2 failed job(s) left out");
  });

  it("lets only a local injected call, or a remote one that failed, explain a failed job", () => {
    // A rate limit injected on an explanation that the retry then answered, on another lane.
    const limited = exchange(100 * minute, {
      provider: "codex-wire",
      kind: "rate_limit",
      injected: true,
      status: 429
    });
    const recovered = row(100 * minute, {
      taskType: "text-generation",
      lane: "remote:ccc",
      runtime: "remote",
      provider: "openai-codex",
      durationMs: 9_000
    });
    const graph = failedJob(100 * minute + 5_000);
    // A local call the helper kill ended, and the job that failed with it.
    const killed = row(140 * minute, {
      status: "failed",
      error: "errors.localModels.runtimeFailed",
      durationMs: 5_000
    });
    const kill: SoakEvent = {
      type: "local",
      kind: "mlx_kill",
      at: at(140 * minute + 1_000),
      detail: { killed: true, pid: 10, status: "ok" }
    };
    const crashed = failedJob(140 * minute + 6_000, { error: "errors.localModels.runtimeFailed" });
    const run = goodRun({ rows: [recovered, killed], events: [limited, graph, kill, crashed] });
    const injected = injectedRows(run);
    expect(injected.get(recovered.id)).toBe("rate_limit");
    expect([...injectedJobFailures(run, injected).entries()]).toEqual([[crashed.id, "mlx_kill"]]);
    expect(analyzeRun(run).failureAudit).toEqual([
      expect.objectContaining({ class: "job", error: "errors.entityIdentity.invalidOutput" })
    ]);
  });

  it("asks for the jobs the samples counted as failed that the run did not record", () => {
    const counted = samples();
    for (const point of counted.slice(100)) point.jobCounts = { failed: 2, succeeded: 40 };
    // One of them was recorded (and is a real failure), one was not: the counts say two.
    const report = analyzeRun(goodRun({ samples: counted, events: [failedJob(100 * minute)] }));
    expect(failureCheck(report).status).toBe("review");
    expect(failureCheck(report).value).toContain("1 more failed job(s) in the job counts");
    // Jobs that were already failed when the run began are not the run's.
    const baseline = samples();
    for (const point of baseline) point.jobCounts = { failed: 3 };
    expect(statusOf(analyzeRun(goodRun({ samples: baseline })).checks, "failure-handling")).toBe(
      "pass"
    );
    // A run that recorded every failed job it counted asks for nothing more.
    const recorded = analyzeRun(
      goodRun({
        samples: counted,
        events: [failedJob(100 * minute), failedJob(101 * minute)]
      })
    );
    expect(failureCheck(recorded).value).not.toContain("job counts");
  });
});

describe("calls a window refused by design (F4)", () => {
  const f4Meta: SoakMeta = {
    ...meta,
    providers: [{ provider: "openai-codex", providerConfigId: "ccc", baseUrl: "https://x/codex" }],
    realWriter: { providerConfigId: "ccc", provider: "openai-codex", modelId: "gpt-5.6-luna" }
  };
  const truth = (id: string, kind: string, phase: "start" | "end", offset: number): SoakEvent => ({
    type: "ground_truth",
    id,
    kind,
    phase,
    at: at(offset),
    settleUntil: at(offset + 2 * minute),
    detail: {}
  });
  const failed = (offset: number, lane: string, error: string) =>
    row(offset, { lane, runtime: "remote", provider: "openai-codex", status: "failed", error });

  it("sets apart a provider window's breaker refusals until the breaker closed, and a budget window's blockers", () => {
    const inside = failed(32 * minute, "remote:ccc", "errors.ai.providerUnavailable");
    const halfOpen = failed(45 * minute + 1_000, "remote:ccc", "errors.ai.providerUnavailable");
    const afterClose = failed(47 * minute, "remote:ccc", "errors.ai.providerUnavailable");
    const otherFailure = failed(33 * minute, "remote:ccc", "organization.errors.invalidOutput");
    const money = failed(91 * minute, "remote:fff", "gardener.blocked.cap.money_80");
    const moneyOutside = failed(130 * minute, "remote:fff", "gardener.blocked.cap.money_80");
    // The job that failed 28 s after its call was refused: the window explains no job failure.
    const job: JobFailureEvent = {
      type: "job_failure",
      id: "job-backfill",
      jobType: "relation-explain-backfill",
      lane: "light",
      at: at(91 * minute + 28_000),
      attempts: 1,
      sourceItemId: null,
      error: '[\n  {\n    "code": "invalid_union",\n    "errors": []\n  }\n]'
    };
    const run: LoadedRun = {
      ...goodRun({
        rows: [inside, halfOpen, afterClose, otherFailure, money, moneyOutside],
        events: [
          truth("g030-usage-limit", "usage_limit", "start", 30 * minute),
          truth("g030-usage-limit#met", "usage_limit", "start", 31 * minute),
          truth("g030-usage-limit#met", "usage_limit", "end", 45 * minute),
          truth("g030-usage-limit", "usage_limit", "end", 45 * minute),
          {
            type: "breaker",
            at: at(45 * minute + 7_000),
            lane: "remote:ccc",
            from: "half_open",
            to: "closed",
            reason: "probe_answered"
          },
          truth("g090-money", "money", "start", 90 * minute),
          truth("g090-money", "money", "end", 120 * minute),
          job
        ]
      }),
      meta: f4Meta
    };
    expect([...windowRefusals(run)].sort()).toEqual(
      [
        [inside.id, "g030-usage-limit"],
        [halfOpen.id, "g030-usage-limit"],
        [money.id, "g090-money"]
      ].sort()
    );
    const report = analyzeRun(run);
    const check = report.checks.find((entry) => entry.id === "failure-handling")!;
    expect(check.value).toContain("3 non-injected failed call(s), 1 non-injected failed job(s)");
    expect(check.value).toContain("3 call(s) a window refused by design set apart");
    expect(check.details.join(" ")).toContain("g030-usage-limit 2, g090-money 1");
    expect(report.failureAudit.map((entry) => entry["classified as"]).sort()).toEqual(
      [
        "blocked: budget cap",
        "permanent: job payload",
        "permanent: output",
        "transient: server"
      ].sort()
    );
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
    // Output the writer could not shape, or none of whose items held.
    expect(text("atomic_note_output_shape")).toBe("permanent: output");
    expect(text("summary_nothing_valid")).toBe("permanent: output");
    expect(text("knowledge_graph_output_invalid:nothing_valid")).toBe("permanent: output");
    // A local helper that died or a busy local model: transient, as a job retry treats them.
    expect(text("errors.localModels.runtimeFailed")).toBe("transient: local runtime");
    expect(text("errors.localModels.modelBusy")).toBe("transient: local runtime");
    // The caller's own cap (an Ask's budget) canceled the call; a provider deadline stays a timeout.
    expect(classifyError(row(0, { status: "canceled", error: "The operation timed out." }))).toBe(
      "cancelled by caller deadline"
    );
    expect(text("The operation timed out.")).toBe("transient: timeout");
    // A RemoteBudget refusal is a blocker, a routing change a transient retry, a Zod issue list the
    // job's own payload refused (gate S, 10-25).
    expect(text("gardener.blocked.cap.money_80")).toBe("blocked: budget cap");
    expect(text("organization.errors.modelChanged")).toBe("transient: model changed");
    expect(text('[\n  {\n    "code": "invalid_union",\n    "errors": [')).toBe(
      "permanent: job payload"
    );
  });

  it("lists a failed driver action that no injected fault explains, and asks a person", () => {
    const action = (
      offsetMs: number,
      overrides: Partial<Extract<SoakEvent, { type: "action" }>> = {}
    ): SoakEvent => ({
      type: "action",
      kind: "ask",
      index: ++counter,
      scheduledAt: at(offsetMs),
      startedAt: at(offsetMs),
      durationMs: 20_000,
      status: "failed",
      detail: {},
      ...overrides
    });
    const limited = exchange(100 * minute + 5_000, {
      provider: "openai-compatible",
      kind: "rate_limit",
      injected: true,
      status: 429
    });
    const explained = action(100 * minute, { error: "AI provider request failed (429)." });
    const answered = action(110 * minute, { status: "ok" });
    expect(
      statusOf(
        analyzeRun(goodRun({ events: [limited, explained, answered] })).checks,
        "failure-handling"
      )
    ).toBe("pass");
    const late = action(120 * minute, {
      index: 98,
      durationMs: 150_000,
      error: "consultation.errors.deadline",
      detail: { wallMs: 150_000, remoteCallStarted: false }
    });
    const report = analyzeRun(goodRun({ events: [limited, explained, late] }));
    const check = report.checks.find((entry) => entry.id === "failure-handling")!;
    expect(check.status).toBe("review");
    expect(check.value).toContain("1 failed driver action(s) with no injected fault");
    expect(check.details).toContain(
      `failed action ask #98 at ${at(120 * minute)} after 150000 ms (wallMs 150000, remoteCallStarted false): consultation.errors.deadline`
    );
  });

  it("lets an injected exchange explain a failed action only on the action's own fake, and only after its call started", () => {
    const ask = (
      offsetMs: number,
      detail: Extract<SoakEvent, { type: "action" }>["detail"],
      overrides: Partial<Extract<SoakEvent, { type: "action" }>> = {}
    ): SoakEvent => ({
      type: "action",
      kind: "ask",
      index: ++counter,
      scheduledAt: at(offsetMs),
      startedAt: at(offsetMs),
      durationMs: 20_000,
      status: "failed",
      detail,
      error: "consultation.errors.deadline",
      ...overrides
    });
    const injectedOn = (provider: string, offsetMs: number) =>
      exchange(offsetMs, { provider, kind: "rate_limit", injected: true, status: 429 });
    const verdict = (events: SoakEvent[]) =>
      analyzeRun(goodRun({ events })).checks.find((entry) => entry.id === "failure-handling")!;
    const listed = (events: SoakEvent[]) =>
      unexplainedActionFailures(goodRun({ events })).map((entry) => entry.index);

    // An Ask that never started its call is not explained by a fault on the other fake...
    const other = ask(100 * minute, { wallMs: 150_000, remoteCallStarted: false }, { index: 71 });
    const codexFault = injectedOn("codex-wire", 100 * minute + 5_000);
    expect(listed([codexFault, other])).toEqual([71]);
    const check = verdict([codexFault, other]);
    expect(check.status).toBe("review");
    expect(check.value).toContain("1 failed driver action(s) with no injected fault");
    expect(check.details).toContain(
      `failed action ask #71 at ${at(100 * minute)} after 20000 ms (wallMs 150000, remoteCallStarted false): consultation.errors.deadline`
    );
    // ...nor by one on its own fake: it sent nothing that fault could have met.
    const own = injectedOn("openai-compatible", 100 * minute + 5_000);
    expect(listed([own, other])).toEqual([71]);
    expect(verdict([own, other]).status).toBe("review");

    // An Ask that started its call and overlaps an injected exchange on its own fake is explained.
    const started = ask(110 * minute, { wallMs: 20_000, remoteCallStarted: true }, { index: 72 });
    const ownFault = injectedOn("openai-compatible", 110 * minute + 5_000);
    expect(listed([ownFault, started])).toEqual([]);
    expect(verdict([ownFault, started]).status).toBe("pass");
    // The same Ask beside a fault on the Codex-wire fake only is not explained.
    const codexOnly = injectedOn("codex-wire", 110 * minute + 5_000);
    expect(listed([codexOnly, started])).toEqual([72]);
    expect(verdict([codexOnly, started]).status).toBe("review");
    // One whose port could not tell (null) leans on the provider alone.
    const unknown = ask(120 * minute, { wallMs: 20_000, remoteCallStarted: null }, { index: 73 });
    expect(listed([injectedOn("openai-compatible", 120 * minute + 5_000), unknown])).toEqual([]);
    expect(listed([injectedOn("codex-wire", 120 * minute + 5_000), unknown])).toEqual([73]);

    // An explanation belongs to the Codex-wire fake.
    const explain = ask(130 * minute, { opened: 3, failed: 3 }, { index: 74, kind: "explain" });
    expect(listed([injectedOn("codex-wire", 130 * minute + 5_000), explain])).toEqual([]);
    expect(listed([injectedOn("openai-compatible", 130 * minute + 5_000), explain])).toEqual([74]);
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

describe("jobs a blocker set aside (F4 D5)", () => {
  const waitingSamples = (blockedClass: string | null) =>
    samples().map((sample) => ({
      ...sample,
      jobs: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000001",
          type: "topic-name",
          lane: "light",
          status: "queued",
          sourceItemId: null,
          attempts: 0,
          updatedAt: start,
          runAfter: start,
          lockedAt: null,
          scopeKey: "tree:t:names",
          blockedClass,
          blockedReason: blockedClass ? "user_pause" : null
        }
      ]
    }));

  it("are neither stuck nor held up by an unrelated job: they wait for their blocker", () => {
    const report = analyzeRun(goodRun({ samples: waitingSamples("paused") }));
    expect(report.checks.find((check) => check.id === "jobs-stuck")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "jobs-blocked")?.value).toMatch(/^0 /u);
  });

  it("still flags the same job waiting due and unblocked", () => {
    const report = analyzeRun(goodRun({ samples: waitingSamples(null) }));
    expect(report.checks.find((check) => check.id === "jobs-stuck")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "jobs-blocked")?.value).toMatch(/^1 /u);
  });

  it("counts a job enqueued ahead of its time as stuck from when it came due", () => {
    // A window's backfill written at the start and due 100 minutes later, then claimed 30 minutes after.
    const dueAt = start + 100 * minute;
    const aheadSamples = (claimedAfterMinutes: number) =>
      waitingSamples(null).map((sample) => {
        const at = Date.parse(sample.at);
        const queued = at >= dueAt && at < dueAt + claimedAfterMinutes * minute;
        return {
          ...sample,
          jobs: queued ? sample.jobs.map((job) => ({ ...job, runAfter: dueAt })) : []
        };
      });
    const stuck = (claimedAfterMinutes: number) =>
      analyzeRun(goodRun({ samples: aheadSamples(claimedAfterMinutes) })).checks.find(
        (check) => check.id === "jobs-stuck"
      )?.status;
    expect(stuck(30)).toBe("pass");
    expect(stuck(70)).toBe("fail");
  });
});
