import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  soakFiles,
  type ActionRecord,
  type GroundTruthRecord,
  type JobDoneRecord,
  type SoakEvent,
  type SoakMeta,
  type SoakSample,
  type TaskRunRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import type { E5Result } from "./report-f4.ts";
import {
  e4Joined,
  joinPlan,
  joinRuns,
  JoinRefusal,
  mergeE5,
  renderJoinedReport,
  type JoinedSegment
} from "./report-joined.ts";
import { runSoakReport, type LoadedRun, type SoakReport } from "./report.ts";

// A stopped soak7 run (r1: STOP at 95 h, its last action at plan minute 5705) and its tail on the
// soak7-tail plan (tail minute = plan minute - 5675), samples every hour.
const minute = 60_000;
const hour = 60 * minute;
const r1Start = Date.parse("2026-10-26T02:54:11.790Z");
const tailStart = r1Start + 120 * hour;
const iso = (ms: number) => new Date(ms).toISOString();
const writer = "a96a1aba-26ff-499a-af6b-1fa0d9800fd2";
const lane = `remote:${writer}`;
const shift = 5675;

type MetaWindow = NonNullable<SoakMeta["f4"]>["windows"][number];
const window = (id: string, startMinute: number, durationMinutes: number): MetaWindow => ({
  id,
  kind: id.startsWith("pause") ? "pause" : "unauthorized",
  startMinute,
  durationMinutes,
  settleMinutes: 2,
  settleEndMinutes: 2
});
const soak7Windows = [
  window("w030-usage-limit", 1800, 120),
  window("pause-4", 4920, 30),
  window("w084-codex-daily-cap", 5040, 720),
  window("w102-unauthorized", 6120, 10),
  window("pause-5", 6360, 30)
];
const tailWindows = soak7Windows
  .filter((entry) => entry.startMinute > 5705)
  .map((entry) => ({ ...entry, startMinute: entry.startMinute - shift }));

function metaOf(
  part: "r1" | "tail",
  overrides: Partial<SoakMeta> = {},
  windows: MetaWindow[] = part === "r1" ? soak7Windows : tailWindows
): SoakMeta {
  const r1 = part === "r1";
  const startMs = r1 ? r1Start : tailStart;
  return {
    format: "memora-soak-run",
    version: 1,
    run: r1 ? "soak7-r1-20261026T0254" : "soak7-tail-20261031T0900",
    profile: r1 ? "soak7" : "soak7-tail",
    seed: r1 ? 20261028 : 20261030,
    startedAt: iso(startMs),
    endedAt: iso(startMs + (r1 ? 5705.07 * minute : 73.5 * hour)),
    endReason: r1 ? "stop_file" : "duration",
    durationMs: (r1 ? 168 : 73.5) * hour,
    warmupMs: 30 * minute,
    sampleIntervalMs: hour,
    host: { platform: "darwin", arch: "arm64", totalMemoryMb: 65536 },
    catalogHeader: { refresh: "on", reason: null },
    bounds: { connectMs: 10_000, firstByteMs: 30_000, stallMs: 20_000 },
    providers: [{ provider: "openai-codex", providerConfigId: writer, baseUrl: "https://x" }],
    plan: r1
      ? { description: "soak7" }
      : { description: "soak7-tail", f4: { windows: windows.map(({ id }) => ({ id })) } },
    realWriter: { providerConfigId: writer, provider: "openai-codex", modelId: "gpt-5.6-luna" },
    f4: {
      codex: r1
        ? { expected: 5_394_281, cap: 7_973_422, dropFromHour0: 0 }
        : { expected: 2_410_342, cap: 3_562_787, dropFromHour0: 0 },
      windows,
      predicates: { workerStates: 1 }
    },
    ...overrides
  };
}

const action = (startMs: number, planMinute: number, offset = 0): ActionRecord => ({
  type: "action",
  kind: "explain",
  index: 0,
  scheduledAt: iso(startMs + (planMinute - offset) * minute),
  startedAt: iso(startMs + (planMinute - offset) * minute + 4),
  durationMs: 1_000,
  status: "ok",
  detail: {}
});
const truth = (id: string, phase: "start" | "end", atMs: number): GroundTruthRecord => ({
  type: "ground_truth",
  id,
  kind: "unauthorized",
  phase,
  at: iso(atMs),
  settleUntil: iso(atMs + 2 * minute),
  detail: {}
});
const jobDone = (id: string, createdMs: number, finishedAfterMs: number): JobDoneRecord => ({
  type: "job_done",
  id,
  jobType: "topic-name",
  lane: "light",
  status: "succeeded",
  outcome: "done",
  scopeKey: null,
  subjectKey: `tree:${id}`,
  attempts: 1,
  createdAt: iso(createdMs),
  finishedAt: iso(createdMs + finishedAfterMs),
  quarantinedAt: null,
  resultStatus: "named",
  inputFingerprint: "f"
});
const codexRow = (startMs: number, tokens: number): TaskRunRecord => ({
  id: `row-${startMs}`,
  taskType: "text-generation",
  provider: "openai-codex",
  modelId: "gpt-5.6-luna",
  runtime: "remote",
  workloadClass: "write-fast",
  lane,
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
  startedAt: iso(startMs),
  finishedAt: iso(startMs + 2_000),
  durationMs: 2_000,
  inputTokens: tokens,
  outputTokens: 0,
  budgetClass: "background",
  jobId: null
});

/** Hourly samples; `make` adds what a test needs at hour `index`. */
function hourly(
  startMs: number,
  hours: number,
  spentTokens: number,
  make: (index: number) => Partial<SoakSample> = () => ({})
): SoakSample[] {
  return Array.from({ length: Math.floor(hours) + 1 }, (_, index) => ({
    at: iso(startMs + index * hour),
    elapsedMs: index * hour,
    lanes: [],
    jobs: [],
    jobCounts: {},
    helper: null,
    appRssMb: 800,
    pageouts: 1_000,
    pageSizeBytes: 16_384,
    eventLoopLagP99Ms: 3,
    dbPool: { total: 4, idle: 4, waiting: 0 },
    cap: {
      capTokens: 1,
      spentTokens: Math.round((spentTokens * index) / Math.floor(hours)),
      reservedTokens: 0,
      calls: 0,
      refusals: 0,
      largestCallTokens: 0
    },
    ...make(index)
  }));
}

function runs(
  parts: {
    r1?: Omit<Partial<LoadedRun>, "meta"> & { meta?: Partial<SoakMeta> };
    tail?: Omit<Partial<LoadedRun>, "meta"> & { meta?: Partial<SoakMeta> };
    tailWindows?: MetaWindow[];
    r1Spent?: number;
    tailSpent?: number;
  } = {}
): [LoadedRun, LoadedRun] {
  const first: LoadedRun = {
    meta: metaOf("r1", parts.r1?.meta),
    events: [
      action(r1Start, 60),
      action(r1Start, 5705),
      truth("w030-usage-limit", "start", r1Start + 1800 * minute),
      truth("w030-usage-limit", "end", r1Start + 1920 * minute),
      truth("w084-codex-daily-cap", "start", r1Start + 5040 * minute),
      truth("w084-codex-daily-cap", "end", r1Start + 5705.02 * minute),
      ...(parts.r1?.events ?? [])
    ],
    samples: parts.r1?.samples ?? hourly(r1Start, 95, parts.r1Spent ?? 1_947_546),
    rows: parts.r1?.rows ?? [codexRow(r1Start + hour, 10_000)],
    invalid: {}
  };
  const tail: LoadedRun = {
    meta: metaOf("tail", parts.tail?.meta, parts.tailWindows),
    events: [
      action(tailStart, 5765, shift),
      truth("w102-unauthorized", "start", tailStart + 445 * minute),
      truth("w102-unauthorized", "end", tailStart + 455 * minute),
      ...(parts.tail?.events ?? [])
    ],
    samples: parts.tail?.samples ?? hourly(tailStart, 73.5, parts.tailSpent ?? 1_500_000),
    rows: parts.tail?.rows ?? [codexRow(tailStart + 2 * hour, 20_000)],
    invalid: {}
  };
  return [first, tail];
}

const now = new Date("2026-11-03T12:00:00.000Z");
const checkOf = (first: LoadedRun, tail: LoadedRun, id: string) =>
  joinRuns(first, tail, { now }).checks.find((check) => check.id === id)!;

describe("joining a stopped 7-day run and its tail (D38a)", () => {
  it("derives the shift from the windows and T0 from the stopped run's last action", () => {
    const [first, tail] = runs();
    expect(joinPlan(first, tail)).toEqual({ shiftMinutes: 5675, t0Minute: 5705, problems: [] });
    const report = joinRuns(first, tail, { now });
    expect(report.plan).toMatchObject({ t0Minute: 5705, shiftMinutes: 5675, plannedHours: 168 });
    expect(report.plan.coveredHours).toBe(168.08);
    expect(report.plan.gapHours).toBe(24.92);
    expect(report.segments.map((segment) => segment.label)).toEqual(["soak7-r1", "tail"]);
    expect(report.segments.map((segment) => segment.windows)).toEqual([
      ["w030-usage-limit", "w084-codex-daily-cap"],
      ["w102-unauthorized"]
    ]);
    const notes = report.notes.join("\n");
    expect(notes).toContain("w084-codex-daily-cap was lifted at plan minute 5705 instead of 5760");
    expect(notes).toContain("swap v2, e4 v3, jobs v2");
    expect(notes).toContain("soak7-r1 20261028, tail 20261030");
  });

  it("refuses runs that are not one plan: another writer, unequal shifts, a window at or before T0, the plan not covered", () => {
    const refused = (first: LoadedRun, tail: LoadedRun) => {
      try {
        joinRuns(first, tail, { now });
      } catch (error) {
        expect(error).toBeInstanceOf(JoinRefusal);
        return (error as JoinRefusal).problems.join("\n");
      }
      throw new Error("joined");
    };
    const [first, tail] = runs();
    expect(
      refused(first, {
        ...tail,
        meta: {
          ...tail.meta,
          realWriter: { providerConfigId: "other", provider: "openai-codex", modelId: null }
        }
      })
    ).toContain("the real writers differ");
    const unequal = runs({
      tailWindows: [
        { ...tailWindows[0]!, startMinute: 445 },
        { ...tailWindows[1]!, startMinute: 700 }
      ]
    });
    expect(refused(...unequal)).toContain("shifted unequally");
    // The tail shifted by 5615: its windows still come after T0, its first action (tail minute 90) does not.
    const early = runs({
      tailWindows: tailWindows.map((entry) => ({ ...entry, startMinute: entry.startMinute + 60 }))
    });
    expect(refused(...early)).toContain("ran at or before T0 5705");
    // A window r1 already ran (pause-4 at plan minute 4920), in the tail again.
    const again = runs({
      tailWindows: [{ ...soak7Windows[1]!, startMinute: 4920 - shift }, ...tailWindows]
    });
    expect(refused(...again)).toContain(
      "the tail's window pause-4 starts at plan minute 4920, not after T0 5705"
    );
    const short = runs({ tail: { meta: { durationMs: 60 * hour } } });
    expect(refused(...short)).toContain("the plan is not covered");
    const running = runs({ tail: { meta: { endReason: null, endedAt: null } } });
    expect(refused(...running)).toContain("has not ended");
    const twice = runs({
      tail: { events: [truth("w030-usage-limit", "start", tailStart + 2 * hour)] }
    });
    expect(refused(...twice)).toContain("ids in both segments: w030-usage-limit");
  });

  it("counts E1 exposure by plan day, the tail's warm-up never again", () => {
    // Two due tasks of different scopes on the model worker, which executes a third: exposure.
    const contention = (): Partial<SoakSample> => ({
      jobs: ["a", "b"].map((scope) => ({
        id: `due-${scope}`,
        type: "topic-name",
        lane: "light",
        status: "queued",
        sourceItemId: null,
        attempts: 0,
        updatedAt: r1Start,
        runAfter: r1Start,
        lockedAt: null,
        scopeKey: `tree:${scope}:names`
      })),
      workers: [{ worker: "model", state: "executing", jobId: "x", scopeKey: "tree:busy:names" }]
    });
    const [first, tail] = runs({
      r1: { samples: hourly(r1Start, 95, 1_000, (index) => (index === 95 ? contention() : {})) },
      // Tail minute 0 is plan minute 5675 (r1 ran it); minute 60 is plan minute 5735.
      tail: {
        samples: hourly(tailStart, 73.5, 1_000, (index) => (index <= 1 ? contention() : {}))
      }
    });
    const report = joinRuns(first, tail, { now });
    expect(report.tables.exposure).toHaveLength(7);
    expect(report.tables.exposure[3]).toMatchObject({ day: 4, model: 120, "lane-minutes": 120 });
    expect(report.tables.exposure[0]).toMatchObject({ day: 1, "lane-minutes": 0 });
    expect(report.checks.find((check) => check.id === "e1-blocked")!.value).toContain(
      "not exercised: 6 of 7 day(s) below 120 lane-minutes (0, 0, 0, 120, 0, 0, 0)"
    );
  });

  it("sums E3 over each segment's window and lists the tasks created at the seam apart", () => {
    const [first, tail] = runs({
      r1: {
        events: [
          jobDone("r1-in", r1Start + 2 * hour, hour),
          // r1's last 24 h and the tail's warm-up: in neither window.
          jobDone("r1-last-day", r1Start + 80 * hour, hour)
        ]
      },
      tail: {
        events: [
          jobDone("tail-warm", tailStart + 10 * minute, hour),
          jobDone("tail-in", tailStart + 5 * hour, hour),
          jobDone("tail-slow", tailStart + 6 * hour, 30 * hour)
        ]
      }
    });
    const e3 = checkOf(first, tail, "e3-within-24h");
    expect(e3.value).toContain("2 of 3 = 66.67 %");
    expect(e3.status).toBe("fail");
    expect(e3.details.join("\n")).toContain(
      "Not measurable at the seam (created outside both windows"
    );
    expect(e3.details.join("\n")).toContain("topic-name 2");
    expect(e3.details.join("\n")).toContain(
      "soak7-r1 tasks created 0.50 h to 71.08 h, tail tasks created 0.50 h to 49.50 h"
    );
  });

  it("takes each E4 part from the segment that exercised it; a failed part in either fails", () => {
    const segment = (label: string, a: string, b: string, c: string) =>
      ({
        label,
        report: {
          checks: [
            {
              id: "e4-cap",
              title: "E4 cap within one call",
              bar: "",
              status: "pass",
              value: `a: ${a}, b: ${b}, c: ${c}`,
              details: [`(b) ${label}`],
              data: { a, b, c }
            }
          ]
        } as unknown as SoakReport
      }) as JoinedSegment;
    const joined = e4Joined([
      segment("r1", "n/a", "pass", "n/a"),
      segment("tail", "n/a", "n/a", "pass")
    ]);
    expect(joined.value).toBe("a: n/a, b: pass, c: pass");
    expect(joined.status).toBe("pass");
    expect(joined.details).toEqual(["r1: (b) r1", "tail: (b) tail"]);
    expect(
      e4Joined([segment("r1", "n/a", "pass", "n/a"), segment("tail", "n/a", "n/a", "fail")]).status
    ).toBe("fail");
    expect(
      e4Joined([segment("r1", "fail", "pass", "n/a"), segment("tail", "n/a", "n/a", "pass")]).value
    ).toBe("a: fail, b: pass, c: pass");
    // The tail's money window never ran: (c) is a review, not a pass.
    expect(
      e4Joined([segment("r1", "n/a", "pass", "n/a"), segment("tail", "n/a", "n/a", "review")])
        .status
    ).toBe("review");
  });

  it("sums E5's comparisons over the segments and lists what either left unexercised", () => {
    const result = (checked: number, matched: number, notExercised: string[]): E5Result => ({
      laneFaults: [],
      laneFaultChecks: 0,
      notExercised: notExercised.map((id) => ({ window: id, why: "never_opened" as const })),
      checked,
      matched,
      unaffected: [],
      classMismatches: [],
      reasonMismatches: 1,
      recoveryMismatches: [],
      fallbackSamples: 0,
      samplesWithBlocked: 3,
      samplesWithStatus: 10
    });
    const merged = mergeE5([result(663, 663, []), result(400, 399, ["w140-only-ac"])]);
    expect(merged).toMatchObject({
      checked: 1063,
      matched: 1062,
      reasonMismatches: 2,
      samplesWithBlocked: 6,
      notExercised: [{ window: "w140-only-ac", why: "never_opened" }]
    });
  });

  it("reads swap per segment, the worst 24 h of either, never across the seam", () => {
    const climbing = (startMs: number, hours: number, megabytes: number) =>
      hourly(startMs, hours, 1_000, (index) => ({
        pageouts: 1_000 + Math.round((megabytes * 64 * index) / Math.floor(hours))
      }));
    // r1: 57 MB over 95 h (about 14 MB a day); the tail: 30 MB over 73 h, its own warm-up first.
    const [first, tail] = runs({
      r1: { samples: climbing(r1Start, 95, 57) },
      tail: { samples: climbing(tailStart, 73.5, 30) }
    });
    const swap = checkOf(first, tail, "swap");
    expect(swap.status).toBe("pass");
    expect(swap.value).toMatch(/^worst 24 h 14\.\d MB \(soak7-r1, from /u);
    expect(swap.value).toContain("no 24 h window crosses the seam");
    const [, heavy] = runs({ tail: { samples: climbing(tailStart, 73.5, 200) } });
    const failed = checkOf(first, heavy, "swap");
    expect(failed.status).toBe("fail");
    expect(failed.value).toMatch(/\(tail, from /u);
  });

  it("sums the harness spend of both segments against the registered cap", () => {
    const [first, tail] = runs({ r1Spent: 1_947_546, tailSpent: 3_000_000 });
    const tokens = checkOf(first, tail, "tokens");
    expect(tokens.status).toBe("pass");
    expect(tokens.value).toContain("harness cap spent 1947546 + 3000000 = 4947546");
    expect(tokens.value).toContain("against 5394281 expected for the plan and a cap of 7973422");
    const [, over] = runs({ tailSpent: 6_100_000 });
    expect(checkOf(first, over, "tokens").status).toBe("fail");
    // Tokens by plan day: r1's call in day 1, the tail's at tail hour 2 = plan hour 96.6, day 5.
    expect(joinRuns(first, tail, { now }).tables.tokens).toEqual([
      { "plan day": 1, "Codex tokens": 10_000, "planned a day": 770_612 },
      { "plan day": 5, "Codex tokens": 20_000, "planned a day": 770_612 }
    ]);
  });

  it("renders both segments and the per-check lines", () => {
    const [first, tail] = runs();
    const markdown = renderJoinedReport(joinRuns(first, tail, { now }));
    expect(markdown).toContain("# Joined soak report: soak7-r1-20261026T0254 + soak7-tail-");
    expect(markdown).toContain("| soak7-r1 | soak7-r1-20261026T0254 | soak7 | 0 |");
    expect(markdown).toContain("| tail | soak7-tail-20261031T0900 | soak7-tail | 5675 |");
    expect(markdown).toContain("## E1 contention exposure (lane-minutes a plan day)");
  });
});

describe("the --join command", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
  });
  const write = async (directory: string, run: LoadedRun) => {
    await mkdir(directory, { recursive: true });
    const lines = (records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
    await writeFile(join(directory, soakFiles.meta), JSON.stringify(run.meta));
    await writeFile(join(directory, soakFiles.events), lines(run.events as SoakEvent[]));
    await writeFile(join(directory, soakFiles.samples), lines(run.samples));
    await writeFile(join(directory, soakFiles.taskRuns), lines(run.rows));
  };

  it("writes report-joined.md and .json into the tail's folder, never the stopped run's", async () => {
    const root = await mkdtemp(join(tmpdir(), "soak-joined-"));
    directories.push(root);
    const [first, tail] = runs();
    const r1Dir = join(root, "soak7-r1");
    const tailDir = join(root, "soak7-tail");
    await write(r1Dir, first);
    await write(tailDir, tail);
    const { text, code } = await runSoakReport([r1Dir, "--join", tailDir]);
    expect(text).toContain("Joined soak soak7-r1-20261026T0254 + soak7-tail-20261031T0900");
    expect(code).not.toBe(0);
    const json = JSON.parse(await readFile(join(tailDir, "report-joined.json"), "utf8"));
    expect(json.plan.shiftMinutes).toBe(5675);
    expect(json.segments[0].report.run).toBe("soak7-r1-20261026T0254");
    expect(await readFile(join(tailDir, "report-joined.md"), "utf8")).toContain("**Verdict:");
    await expect(readFile(join(r1Dir, "report.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(r1Dir, "report-joined.md"), "utf8")).rejects.toThrow();
    // Never into the stopped run's folder, never with --status; a run that is not a tail is refused.
    const into = await runSoakReport([r1Dir, "--join", tailDir, "--out", join(r1Dir, "x.md")]);
    expect(into).toEqual({ text: expect.stringContaining("never writes into"), code: 1 });
    expect((await runSoakReport([r1Dir, "--join", tailDir, "--status"])).code).toBe(1);
    const self = await runSoakReport([r1Dir, "--join", r1Dir]);
    expect(self.code).toBe(1);
  });
});
