import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ActionRecord,
  ExchangeRecord,
  JobDoneRecord,
  SoakEvent,
  SoakMeta,
  SoakSample,
  TaskRunRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import { e1RunLines, refusalKey } from "./report-e1.ts";
import { computeE1, e1Check, f4Report } from "./report-f4.ts";
import { analyzeRun, runSoakReport, type Check, type LoadedRun } from "./report.ts";

// The dedicated E1 contention run's report (F4 D38b): scoped exposure beside the registered one,
// the plan day from the warm-up's end, the full-day and truncation rules, the reported lines, and
// the stop-line audit of a run that makes no Codex call.
const start = Date.parse("2026-11-14T08:00:00.000Z");
const minute = 60_000;
const hour = 60 * minute;
const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();
const writer = "5a1d2f50-3c1e-4d7a-9b38-0d2f2f6a7c11";
const e1 = { autonomy: "off", power: "idle", floorReads: "scoped", dayOrigin: "warmup_end" };

function metaOf(overrides: Partial<SoakMeta> = {}, plan: object = { f4: { e1 } }): SoakMeta {
  return {
    format: "memora-soak-run",
    version: 1,
    run: "soak7-e1-test",
    profile: "soak7-e1",
    seed: 20261114,
    startedAt: at(0),
    endedAt: at(24.5 * hour),
    endReason: "duration",
    durationMs: 24.5 * hour,
    warmupMs: 30 * minute,
    sampleIntervalMs: minute,
    host: { platform: "darwin", arch: "arm64", totalMemoryMb: 32768 },
    catalogHeader: { refresh: "on", reason: null },
    bounds: { connectMs: 10_000, firstByteMs: 30_000, stallMs: 20_000 },
    providers: [
      { provider: "openai-codex", providerConfigId: writer, baseUrl: "https://chatgpt.com" }
    ],
    plan,
    relations: {
      discoveryNeighbours: 1,
      judgeMode: "ranker",
      sourceJudge: { mode: "perRoot", maxPairsPerCall: 12 }
    },
    dataRoot: "/data/.cache",
    realWriter: { providerConfigId: writer, provider: "openai-codex", modelId: "gpt-5.6-luna" },
    f4: {
      codex: { expected: 0, cap: 50_000, dropFromHour0: 0 },
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
  lane: type === "note-embedding" ? "heavy" : "light",
  status: "queued",
  sourceItemId: null,
  attempts: 0,
  updatedAt: start,
  runAfter: start,
  lockedAt: null,
  scopeKey: null,
  ...overrides
});

/** Every worker busy with other work: due tasks wait their turn, which is no event. */
const busy: NonNullable<SoakSample["workers"]> = [
  { worker: "relations", state: "executing", jobId: "x1", scopeKey: "root:z1" },
  { worker: "relations", state: "executing", jobId: "x2", scopeKey: "root:z2" },
  { worker: "heavy", state: "executing", jobId: "x3", scopeKey: null },
  { worker: "compute", state: "idle" },
  { worker: "model", state: "idle" }
];
const idle: NonNullable<SoakSample["workers"]> = [
  { worker: "relations", state: "idle" },
  { worker: "relations", state: "idle" },
  { worker: "heavy", state: "idle" },
  { worker: "compute", state: "idle" },
  { worker: "model", state: "idle" }
];

function sampleAt(offsetMs: number, extra: Partial<SoakSample> = {}): SoakSample {
  return {
    at: at(offsetMs),
    elapsedMs: offsetMs,
    lanes: [],
    jobs: [],
    jobCounts: {},
    helper: { pid: 10, rssMb: 900, spawnCount: 1 },
    appRssMb: 700,
    pageouts: 1_000,
    pageSizeBytes: 16_384,
    eventLoopLagP99Ms: 4,
    dbPool: { total: 4, idle: 4, waiting: 0 },
    workers: idle,
    controls: {
      autonomy: "off",
      paused: false,
      onlyIdle: false,
      onlyOnAc: false,
      monthlyCapUsd: 0
    },
    power: { active: false, onBattery: false, overridden: true },
    jobsTruncated: 0,
    ...extra
  };
}

/** Two due MATCH jobs of two roots (scoped and registered exposure: 1 lane-minute). */
const twoRoots = (): Partial<SoakSample> => ({
  jobs: [
    job("m1", "relation-match", { scopeKey: "root:a" }),
    job("m2", "relation-match", { scopeKey: "root:b" })
  ],
  workers: busy
});
/** Two due unscoped embeddings (registered only). */
const twoUnscoped = (): Partial<SoakSample> => ({
  jobs: [job("e1", "note-embedding"), job("e2", "note-embedding")],
  workers: busy
});

/** One sample a minute from minute `from` to `to` (exclusive), shifted by `shiftMs`. */
const minutes = (
  from: number,
  to: number,
  make: (minuteIndex: number) => Partial<SoakSample> = () => ({}),
  shiftMs = 0
) =>
  Array.from({ length: to - from }, (_, index) =>
    sampleAt((from + index) * minute + shiftMs, make(from + index))
  );

function runOf(
  samples: SoakSample[],
  parts: {
    meta?: Partial<SoakMeta>;
    plan?: object;
    events?: SoakEvent[];
    rows?: TaskRunRecord[];
  } = {}
): LoadedRun {
  return {
    meta: metaOf(parts.meta, parts.plan),
    events: parts.events ?? [],
    samples,
    rows: parts.rows ?? [],
    invalid: {}
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("scoped exposure beside the registered one (D38b)", () => {
  const one = (extra: Partial<SoakSample>) => computeE1(runOf([sampleAt(40 * minute, extra)]));

  it("counts distinct non-null scopes only, and the same reading without link rows", () => {
    const unscoped = one(twoUnscoped());
    expect(unscoped.exposure[0]).toEqual({ heavy: 1 });
    expect(unscoped.scopedExposure[0]).toEqual({});
    const roots = one(twoRoots());
    expect(roots.exposure[0]).toEqual({ relations: 1 });
    expect(roots.scopedExposure[0]).toEqual({ relations: 1 });
    expect(roots.scopedWithoutLink[0]).toEqual({ relations: 1 });
    const sameRoot = one({
      jobs: [
        job("m1", "relation-match", { scopeKey: "root:a" }),
        job("m2", "relation-match", { scopeKey: "root:a" })
      ],
      workers: busy
    });
    expect(sameRoot.exposure[0]).toEqual({});
    expect(sameRoot.scopedExposure[0]).toEqual({});
    const links = one({
      jobs: [
        job("l1", "relation-link", { scopeKey: "root:a" }),
        job("l2", "relation-link", { scopeKey: "root:b" })
      ],
      workers: busy
    });
    expect(links.scopedExposure[0]).toEqual({ relations: 1 });
    expect(links.scopedWithoutLink[0]).toEqual({});
    expect(links.perSample).toEqual([
      { at: start + 40 * minute, registered: 1, scoped: 1, scopedWithoutLink: 0 }
    ]);
  });

  it("adds no exposure from a truncated sample, whose running rows still feed the event predicate", () => {
    const truncated = computeE1(
      runOf(minutes(40, 60, () => ({ ...twoRoots(), jobsTruncated: 7 })))
    );
    expect(truncated.exposure[0]).toEqual({});
    expect(truncated.scopedExposure[0]).toEqual({});
    expect(truncated.truncatedByDay[0]).toBe(20);
    // A due task beside idle workers for 20 minutes is an event, truncated or not.
    const stalled = computeE1(
      runOf(
        minutes(40, 60, () => ({
          jobs: [job("m1", "relation-match", { scopeKey: "root:a" })],
          workers: idle,
          jobsTruncated: 7
        }))
      )
    );
    expect(stalled.events).toHaveLength(1);
  });

  it("prints the scoped reading beside the registered one on a run without the E1 section, its line unchanged", () => {
    const run = runOf(minutes(0, 130, twoUnscoped), { plan: {} });
    const { check } = e1Check(run);
    expect(check.value).toBe("0 events; exposure 130 lane-minutes a day");
    expect(
      check.details.some(
        (line) => line.startsWith("scoped exposure") && line.includes(": 0 lane-minutes")
      )
    ).toBe(true);
  });
});

describe("E1 in the dedicated run's plan day (D38b)", () => {
  /** A whole run: one sample a minute (shifted), exposure in the minutes `exposed` says. */
  const dayRun = (
    exposed: (minuteIndex: number) => Partial<SoakSample>,
    options: { count?: number; shiftMs?: number; plan?: object; meta?: Partial<SoakMeta> } = {}
  ) =>
    runOf(minutes(0, options.count ?? 1470, exposed, options.shiftMs ?? 0), {
      ...(options.plan ? { plan: options.plan } : {}),
      ...(options.meta ? { meta: options.meta } : {})
    });
  const exposedIn =
    (from: number, to: number, make = twoRoots) =>
    (index: number) =>
      index >= from && index < to ? make() : {};

  it("passes with 0 events and scoped exposure at the floor in a full day from the warm-up's end", () => {
    const { check, table } = e1Check(dayRun(exposedIn(100, 230)));
    expect(check.status).toBe("pass");
    expect(check.value).toContain("scoped exposure 130 lane-minutes");
    expect(check.value).toContain("registered 130");
    expect(check.data).toMatchObject({ scoped: 130, registered: 130, samples: 1440, truncated: 0 });
    expect(table[1]).toMatchObject({ reading: "day from the start (the registered origin)" });
  });

  it("drops the warm-up's exposure from the plan day, and prints the start-origin reading beside", () => {
    const run = dayRun((index) => (index < 30 || (index >= 100 && index < 200) ? twoRoots() : {}));
    const { check } = e1Check(run);
    expect(check.status).toBe("review");
    expect(check.value).toContain("not exercised");
    expect(check.value).toContain("scoped exposure 100 < 120");
    expect(check.details[0]).toContain("start-origin reading (day [start, +24 h)): scoped 130");
    // The same samples read from the start: the warm-up counts.
    const fromStart = e1Check(
      dayRun((index) => (index < 30 || (index >= 100 && index < 200) ? twoRoots() : {}), {
        plan: { f4: { e1: { ...e1, dayOrigin: "start" } } }
      })
    );
    expect(fromStart.check.status).toBe("pass");
  });

  it("reads one full day from 1,440 samples whose last is 1 s before 24.5 h, and 'not exercised' from 1,425", () => {
    const shifted = dayRun(exposedIn(100, 230), {
      shiftMs: 59_000,
      meta: { endedAt: null, endReason: null }
    });
    expect(shifted.samples.at(-1)!.at).toBe(at(24.5 * hour - 1_000));
    expect(e1Check(shifted).check).toMatchObject({ status: "pass" });
    const gaps = dayRun(exposedIn(100, 230));
    gaps.samples = gaps.samples.filter((_, index) => index < 500 || index >= 515);
    const short = e1Check(gaps).check;
    expect(short.status).toBe("review");
    expect(short.value).toContain("the plan day holds 1425 of 1440 samples (needs 1426)");
    // A run that ended before the day's end, or that the token cap ended, is not exercised either.
    const early = dayRun(exposedIn(100, 230), {
      count: 1400,
      meta: { endedAt: at(1400 * minute), endReason: "stop_file" }
    });
    expect(e1Check(early).check.value).toContain("ended 70.0 min before the plan day's end");
    const capped = dayRun(exposedIn(100, 230), { meta: { endReason: "token_cap" } });
    expect(e1Check(capped).check.value).toContain("the harness token cap ended the run");
  });

  it("reads the floor on scoped exposure: registered 200 with scoped 100 is not exercised", () => {
    const mixed = (index: number) =>
      index >= 100 && index < 200 ? twoRoots() : index >= 200 && index < 300 ? twoUnscoped() : {};
    const scoped = e1Check(dayRun(mixed)).check;
    expect(scoped.status).toBe("review");
    expect(scoped.value).toContain("scoped exposure 100 lane-minutes");
    expect(scoped.value).toContain("registered 200");
    const registered = e1Check(
      dayRun(mixed, { plan: { f4: { e1: { ...e1, floorReads: "registered" } } } })
    ).check;
    expect(registered.status).toBe("pass");
  });

  it("reads 'not exercised' above 1 % of truncated samples, and fails on an event however exposed", () => {
    const truncated = e1Check(
      dayRun((index) =>
        index >= 100 && index < 300
          ? twoRoots()
          : index >= 300 && index < 315
            ? { jobsTruncated: 3 }
            : {}
      )
    ).check;
    expect(truncated.value).toContain("15 of 1440 samples truncated (> 1 %)");
    expect(truncated.status).toBe("review");
    const stalled = e1Check(
      dayRun((index) =>
        index >= 100 && index < 300
          ? twoRoots()
          : index >= 400 && index < 420
            ? { jobs: [job("m9", "relation-match", { scopeKey: "root:a" })], workers: idle }
            : {}
      )
    ).check;
    expect(stalled.status).toBe("fail");
  });
});

describe("the dedicated run's reported lines (D38b)", () => {
  const wave = (index: number, minuteAt: number, detail: ActionRecord["detail"]): ActionRecord => ({
    type: "action",
    kind: "edit_wave",
    index,
    scheduledAt: at(minuteAt * minute),
    startedAt: at(minuteAt * minute),
    durationMs: 9_000,
    status: "ok",
    detail
  });
  const matchDone = (id: string, minuteAt: number, resultStatus: string): JobDoneRecord => ({
    type: "job_done",
    id,
    jobType: "relation-match",
    lane: "light",
    status: "succeeded",
    outcome: "done",
    scopeKey: "root:a",
    subjectKey: null,
    attempts: 1,
    createdAt: at(minuteAt * minute),
    finishedAt: at((minuteAt + 2) * minute),
    quarantinedAt: null,
    resultStatus
  });
  const remoteRow = (id: string, overrides: Partial<TaskRunRecord>): TaskRunRecord => ({
    id,
    taskType: "structured-output",
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    runtime: "remote",
    workloadClass: "write-fast",
    lane: `remote:${writer}`,
    priority: 3,
    deadlineMs: null,
    deadlineOutcome: null,
    isRepair: false,
    schemaMode: "json",
    retryWaitMs: 0,
    requeueMs: 0,
    queueMs: 0,
    durationMs: 0,
    attempt: 0,
    status: "failed",
    error: "gardener.blocked.paused.autonomy_off",
    startedAt: at(50 * minute),
    finishedAt: at(50 * minute),
    inputTokens: null,
    outputTokens: null,
    ...overrides
  });
  const lines = (run: LoadedRun) => {
    const result = e1Check(run).result!;
    return e1RunLines(run, result);
  };
  const check = (checks: readonly Check[], id: string) => checks.find((entry) => entry.id === id)!;

  it("keeps a ledger per wave: edits, MATCH outcomes, first due, drain end, link set-asides, counters, exposure", () => {
    const samples = minutes(0, 70, (index) => ({
      ...(index >= 32 && index < 35 ? twoRoots() : {}),
      ...(index === 34
        ? {
            jobs: [
              ...twoRoots().jobs!,
              job("l1", "relation-link", {
                scopeKey: "root:a",
                blockedClass: "paused",
                blockedReason: "autonomy_off",
                blockedAt: start + 33 * minute
              })
            ]
          }
        : {}),
      relationCalls: { day: "2026-11-14", calls: index < 40 ? 10 : 30 },
      changeSets: index < 40 ? 4 : 9
    }));
    const run = runOf(samples, {
      events: [
        wave(0, 31.4, {
          picked: 3,
          edited: 3,
          conflicts: 0,
          gone: 0,
          order: "by_root",
          issueMs: 900
        }),
        wave(1, 45.782, {
          picked: 3,
          edited: 2,
          conflicts: 1,
          gone: 0,
          order: "interleaved",
          issueMs: 800
        }),
        matchDone("j1", 31.5, "completed"),
        matchDone("j2", 31.6, "no_change"),
        matchDone("j3", 31.7, "skipped")
      ]
    });
    const { waves, checks } = lines(run);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toMatchObject({
      wave: 0,
      order: "by_root",
      edited: 3,
      "MATCH decided": 2,
      "MATCH skipped": 1,
      "first due min": 0.6,
      "drain end min": 2.6,
      "link set-aside": 1,
      "D26 start": 10,
      "D26 end": 30,
      "change-sets": 5,
      scoped: 3,
      registered: 3,
      "power pinned": "yes"
    });
    // A wave with more than 5 % conflicts needs a look.
    expect(check(checks, "e1-waves").status).toBe("review");
    expect(check(checks, "e1-waves").details[0]).toContain("wave 1: 1 conflict(s)");
  });

  it("never counts a link row that waits for the next local day (D26 cap) as busy", () => {
    // After the cap a link run re-queues its root for the next local day: queued, unblocked,
    // `runAfter` a day ahead. It sits in every sample between waves and is no drain work.
    const nextDay = job("l9", "relation-link", {
      scopeKey: "root:c",
      runAfter: start + 24 * 60 * minute
    });
    const samples = minutes(0, 70, (index) => {
      const due = (index >= 32 && index < 35) || (index >= 46 && index < 49);
      const jobs = [...(due ? twoRoots().jobs! : []), ...(index >= 35 ? [nextDay] : [])];
      return { jobs, workers: due ? busy : idle };
    });
    const run = runOf(samples, {
      events: [
        wave(0, 31.4, { picked: 3, edited: 3, conflicts: 0, gone: 0, order: "by_root" }),
        wave(1, 45.782, { picked: 3, edited: 3, conflicts: 0, gone: 0, order: "interleaved" })
      ]
    });
    const { waves, checks } = lines(run);
    expect(waves.map((row) => row["drain end min"])).toEqual([2.6, 2.2]);
    expect(check(checks, "e1-waves").status).toBe("pass");
    expect(check(checks, "e1-waves").value).toContain("busy p50 2.2 / max 2.6 min");
  });

  it("reviews a row set aside by another blocker for more than 45 min, never the run's own Off", () => {
    const aside = (blockedClass: string, blockedReason: string) =>
      minutes(0, 60, () => ({
        jobs: [
          job("l1", "relation-match", {
            blockedClass,
            blockedReason,
            blockedAt: start - 2 * minute
          })
        ]
      }));
    const stale = check(lines(runOf(aside("no_model", "no_decider"))).checks, "e1-set-aside");
    expect(stale.status).toBe("review");
    expect(stale.details[0]).toContain("no_model.no_decider");
    const own = check(lines(runOf(aside("paused", "autonomy_off"))).checks, "e1-set-aside");
    expect(own.status).toBe("pass");
  });

  it("counts completed Codex exchanges and rows with tokens, and lists refusals apart", () => {
    const exchange: ExchangeRecord = {
      type: "exchange",
      provider: "openai-codex",
      seq: 1,
      startedAt: at(50 * minute),
      endedAt: at(50 * minute + 3_000),
      kind: "none",
      injected: false,
      status: 200,
      outcome: "completed",
      closedAfterMs: null,
      closedAfterLastWriteMs: null,
      retryAfterSeconds: null,
      plannedMs: null
    };
    const refused = ["r1", "r2", "r3"].map((id) => remoteRow(id, {}));
    const quiet = check(lines(runOf(minutes(0, 60), { rows: refused })).checks, "e1-d12");
    expect(quiet.status).toBe("pass");
    expect(quiet.value).toContain("0 completed Codex exchange(s)");
    expect(quiet.details).toEqual(["refused (not spend): gardener.blocked.paused.autonomy_off x3"]);
    const spent = check(
      lines(
        runOf(minutes(0, 60), {
          events: [exchange],
          rows: [
            ...refused,
            remoteRow("s1", {
              status: "succeeded",
              error: null,
              inputTokens: 900,
              outputTokens: 80
            })
          ]
        })
      ).checks,
      "e1-d12"
    );
    expect(spent.status).toBe("review");
    expect(spent.data).toMatchObject({ completedExchanges: 1, rowsWithTokens: 1, refused: 3 });
    expect(refusalKey("Error: gardener.blocked.cap.subscription_daily (x)")).toBe(
      "gardener.blocked.cap.subscription_daily"
    );
  });

  it("reviews an idle slot beside claimable due work for 3 samples, and the run's conditions", () => {
    const stall = minutes(0, 60, (index) =>
      index >= 40 && index < 43
        ? { jobs: [job("m1", "relation-match", { scopeKey: "root:a" })], workers: idle }
        : {}
    );
    const idleCheck = check(lines(runOf(stall)).checks, "e1-idle-due");
    expect(idleCheck.status).toBe("review");
    expect(idleCheck.value).toContain("relations 3 sample(s), longest 3");
    const unpinned = minutes(0, 60, (index) =>
      index === 10 ? { power: { active: true, onBattery: false, overridden: false } } : {}
    );
    const conditions = check(lines(runOf(unpinned)).checks, "e1-conditions");
    expect(conditions.status).toBe("review");
    expect(conditions.details[0]).toContain("1 sample(s) without the idle power pin");
  });

  it("reviews a collector whose mean spacing would leave a full day short of its samples", () => {
    // The loop sleeps a full interval, then collects: its overhead adds to the spacing. A day
    // needs 1,426 of 1,440 samples, so a mean spacing above 60 x 1440 / 1426 = 60.589 s fails it.
    const spaced = (spacingMs: number) =>
      Array.from({ length: 120 }, (_, index) => sampleAt(index * spacingMs));
    const slow = check(lines(runOf(spaced(60_650))).checks, "e1-conditions");
    expect(slow.status).toBe("review");
    expect(slow.value).toContain("mean spacing 60.650 s");
    expect(slow.details[0]).toContain("projects 1424 samples a day (< 1426)");
    const fine = check(lines(runOf(spaced(60_064))).checks, "e1-conditions");
    expect(fine.status).toBe("pass");
    expect(fine.value).toContain("mean spacing 60.064 s");
  });

  it("adds its lines and the wave ledger to the F4 report of the dedicated run only", () => {
    const context = { injected: new Map(), injectedJobs: new Map() };
    const dedicated = f4Report(runOf(minutes(0, 60)), context)!;
    expect(dedicated.checks.map((entry) => entry.id)).toContain("e1-d12");
    expect(dedicated.tables.waves).toEqual([]);
    const other = f4Report(runOf(minutes(0, 60), { plan: {} }), context)!;
    expect(other.checks.map((entry) => entry.id)).not.toContain("e1-d12");
    expect(other.tables.waves).toBeUndefined();
  });
});

describe("the stop lines of a run that makes no Codex call (D38b, change 9)", () => {
  /** The tracked watchdog's stop regex, read from the script: a change there re-runs this audit. */
  const stopRegex = (() => {
    const script = readFileSync(resolve(import.meta.dirname, "watch-soak.sh"), "utf8");
    const match = /grep -qE "(\^FAIL \([^"]+\))"/u.exec(script);
    if (!match) throw new Error("watch-soak.sh has no stop regex");
    return new RegExp(match[1]!, "u");
  })();

  /** A 24.5 h E1 run under Off: local ranker calls, refused remote rows, two helper kills. */
  function zeroCodexRun(parts: { plan?: object; events?: SoakEvent[] } = {}): LoadedRun {
    const kills: SoakEvent[] = [400, 900].map((minuteAt) => ({
      type: "local",
      kind: "mlx_kill",
      at: at(minuteAt * minute),
      detail: { killed: true, pid: 10, status: "ok" }
    }));
    const samples = minutes(0, 1470, (index) => ({
      helper: {
        pid: 10,
        rssMb: 900,
        spawnCount: 1 + (index > 400 ? 1 : 0) + (index > 900 ? 1 : 0)
      },
      // Each minute's due MATCH jobs are new ones, as a draining wave's are.
      ...(index >= 100 && index < 300
        ? {
            jobs: ["a", "b"].map((root) =>
              job(`m-${root}-${index}`, "relation-match", {
                scopeKey: `root:${root}`,
                updatedAt: start + index * minute - 1_000,
                runAfter: start + index * minute - 1_000
              })
            ),
            workers: busy
          }
        : {})
    }));
    const ranker = Array.from({ length: 30 }, (_, index): TaskRunRecord => ({
      id: `rank-${index}`,
      taskType: "reranking",
      provider: "local-mlx",
      modelId: "ranker",
      runtime: "mlx",
      workloadClass: "decide",
      lane: "local",
      priority: 2,
      deadlineMs: 10_000,
      deadlineOutcome: "met",
      isRepair: false,
      schemaMode: "none",
      retryWaitMs: 0,
      requeueMs: 0,
      queueMs: 20,
      durationMs: 400,
      attempt: 0,
      status: "succeeded",
      error: null,
      startedAt: at((100 + index) * minute),
      finishedAt: at((100 + index) * minute + 400),
      inputTokens: null,
      outputTokens: null
    }));
    const refused = Array.from(
      { length: 5 },
      (_, index) =>
        ({
          ...ranker[0]!,
          id: `refused-${index}`,
          taskType: "structured-output",
          provider: "openai-codex",
          modelId: "gpt-5.6-luna",
          runtime: "remote",
          workloadClass: "write-fast",
          lane: `remote:${writer}`,
          deadlineMs: null,
          deadlineOutcome: null,
          durationMs: 0,
          status: "failed",
          error: "gardener.blocked.paused.autonomy_off",
          budgetClass: "background",
          startedAt: at((200 + index) * minute),
          finishedAt: at((200 + index) * minute)
        }) satisfies TaskRunRecord
    );
    return runOf(samples, {
      ...(parts.plan ? { plan: parts.plan } : {}),
      events: [...kills, ...(parts.events ?? [])],
      rows: [...ranker, ...refused]
    });
  }

  async function statusOf(run: LoadedRun): Promise<string> {
    const directory = mkdtempSync(join(tmpdir(), "soak7-e1-status-"));
    directories.push(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify(run.meta));
    writeFileSync(
      join(directory, "samples.ndjson"),
      run.samples.map((sample) => JSON.stringify(sample)).join("\n")
    );
    writeFileSync(
      join(directory, "events.ndjson"),
      run.events.map((event) => JSON.stringify(event)).join("\n")
    );
    writeFileSync(
      join(directory, "task-runs.ndjson"),
      run.rows.map((row) => JSON.stringify(row)).join("\n")
    );
    return (await runSoakReport([directory, "--status"])).text;
  }

  it("reads remote deadlines n/a and no stop check FAIL on the --status the watchdog reads", async () => {
    const run = zeroCodexRun();
    const report = analyzeRun(run);
    expect(report.checks.find((entry) => entry.id === "remote-deadlines")).toMatchObject({
      status: "n/a",
      value: expect.stringContaining("not exercised: the dedicated E1 run makes no Codex call")
    });
    expect(report.checks.find((entry) => entry.id === "helper-restarts")?.status).toBe("pass");
    expect(report.checks.find((entry) => entry.id === "tokens")?.status).toBe("pass");
    const text = await statusOf(run);
    const stops = text.split("\n").filter((line) => stopRegex.test(line));
    expect(stops).toEqual([]);
    // Every FAIL a check could print would be seen: none of the run's checks fails at all.
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });

  it("keeps soak7's reading without the E1 section (FAIL, a stop line), and reviews a completed exchange under Off", async () => {
    const without = zeroCodexRun({ plan: {} });
    expect(
      analyzeRun(without).checks.find((entry) => entry.id === "remote-deadlines")?.status
    ).toBe("fail");
    expect((await statusOf(without)).split("\n").some((line) => stopRegex.test(line))).toBe(true);
    const leaked = zeroCodexRun({
      events: [
        {
          type: "exchange",
          provider: "openai-codex",
          seq: 1,
          startedAt: at(500 * minute),
          endedAt: at(500 * minute + 3_000),
          kind: "none",
          injected: false,
          status: 200,
          outcome: "completed",
          closedAfterMs: null,
          closedAfterLastWriteMs: null,
          retryAfterSeconds: null,
          plannedMs: null
        }
      ]
    });
    const check = analyzeRun(leaked).checks.find((entry) => entry.id === "remote-deadlines")!;
    expect(check.status).toBe("review");
    expect(check.value).toContain("a D12 finding");
  });
});
