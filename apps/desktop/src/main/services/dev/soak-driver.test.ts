import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildTimeline,
  parseBreakerLog,
  runSoak,
  SoakActionFailure,
  type SoakClock,
  type SoakPorts
} from "./soak-driver.js";
import { soakProfileSchema, type SoakProfile } from "./soak-plan.js";
import {
  MemoryEventSink,
  parseNdjson,
  soakEventSchema,
  soakFiles,
  soakMetaSchema,
  soakSampleSchema,
  taskRunRecordSchema,
  type ActionRecord,
  type JobFailureRecord,
  type LocalFaultRecord,
  type SoakEvent,
  type TaskRunRecord
} from "./soak-records.js";

/** A clock the test moves: sleeping waits for `advance` to reach the time it asked for. */
class VirtualClock implements SoakClock {
  private t = Date.parse("2026-10-20T08:00:00.000Z");
  private waiters: Array<{ at: number; resolve: () => void }> = [];

  public now() {
    return this.t;
  }

  public sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || milliseconds <= 0) return resolve();
      const waiter = { at: this.t + milliseconds, resolve };
      this.waiters.push(waiter);
      signal.addEventListener(
        "abort",
        () => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          resolve();
        },
        { once: true }
      );
    });
  }

  /** Moves time forward, waking what is due in order and letting the run (and its files) catch up. */
  public async advance(milliseconds: number): Promise<void> {
    const target = this.t + milliseconds;
    for (;;) {
      const due = this.waiters.filter((waiter) => waiter.at <= target);
      if (due.length === 0) break;
      const next = Math.min(...due.map((waiter) => waiter.at));
      this.t = next;
      const wake = this.waiters.filter((waiter) => waiter.at <= next);
      this.waiters = this.waiters.filter((waiter) => waiter.at > next);
      for (const waiter of wake) waiter.resolve();
      await settle();
    }
    this.t = target;
    await settle();
  }
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

const minute = 60_000;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const faults = {
  rates: { rateLimit: 0, unavailable: 0, stall: 0, lateFirstByte: 0, malformed: 0 },
  retryAfterSeconds: [1, 10] as [number, number],
  stallMs: 25_000,
  lateFirstByteMs: 35_000,
  windows: [],
  forced: []
};
const latency = {
  fit: null,
  task: null,
  fixedMs: 100,
  minMs: 0,
  maxMs: 1_000,
  firstByteFraction: 0.3
};

/** A 12 minute day: every kind of action happens a few times, one outage gets its probe. */
const profile: SoakProfile = soakProfileSchema.parse({
  seed: 7,
  durationHours: 0.2,
  warmupMinutes: 2,
  sampleEveryMinutes: 1,
  driver: {
    article: { everyMinutes: 4, offsetMinutes: 1 },
    ask: { everyMinutes: 5, offsetMinutes: 2 },
    explain: { everyMinutes: 3, offsetMinutes: 1 },
    explainBurst: { everyMinutes: 6, offsetMinutes: 4, count: 3 },
    noteEdit: { everyMinutes: 10, offsetMinutes: 5 },
    sourceReimport: { everyMinutes: 10, offsetMinutes: 6 },
    typingFault: { everyMinutes: 12, offsetMinutes: 7 },
    postOutageProbeSeconds: 35
  },
  remote: {
    openAiCompatible: { latency, faults },
    codexWire: {
      latency,
      faults: {
        ...faults,
        windows: [{ kind: "outage", startMinute: 3, durationMinutes: 2, factor: 10 }]
      },
      notRelatedRate: 0.02
    }
  },
  local: { mlxKill: { everyMinutes: 5, jitterMinutes: 0 }, ggufAbort: { everyMinutes: 5 } }
});

function ports(overrides: Partial<SoakPorts> = {}) {
  const calls: string[] = [];
  const record = (name: string) => calls.push(name);
  let rows: TaskRunRecord[] = [];
  let failedJobs: JobFailureRecord[] = [];
  const base: SoakPorts = {
    importArticle: async (index) => (record(`article ${index}`), { title: `Article ${index}` }),
    ask: async (index) => (record(`ask ${index}`), { outcome: "answered" }),
    explain: async (count, index) => (record(`explain ${count} ${index}`), { opened: count }),
    editNote: async (index) => (record(`edit ${index}`), { outcome: "edited" }),
    reimportSource: async (index) => (record(`reimport ${index}`), { versioned: "s" }),
    importTypingFaultSource: async (index) => (record(`typing ${index}`), { sourceItemId: "s" }),
    killMlxHelper: async () => (record("kill"), { killed: true, detail: { pid: 4242 } }),
    armGgufAbort: async () => (record("abort"), { stage: "armed" }),
    sample: async () => ({
      lanes: [
        {
          lane: "local",
          limit: 1,
          running: 0,
          held: 0,
          waiting: { P0: 0, P1: 0, P2: 0, P3: 0 },
          rateLimits: 0,
          breaker: null
        }
      ],
      jobs: [],
      jobCounts: { queued: 0 },
      helper: { pid: 4242, rssMb: 100, spawnCount: 1 },
      appRssMb: 300,
      pageouts: 10,
      pageSizeBytes: 16384,
      eventLoopLagP99Ms: 4,
      dbPool: { total: 2, idle: 2, waiting: 0 }
    }),
    taskRuns: async () => rows,
    failedJobs: async () => failedJobs,
    stopRequested: async () => false,
    ...overrides
  };
  return {
    ports: base,
    calls,
    setRows: (next: TaskRunRecord[]) => (rows = next),
    setFailedJobs: (next: JobFailureRecord[]) => (failedJobs = next)
  };
}

const row = (id: string, finishedAt: string): TaskRunRecord => ({
  id,
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
  queueMs: 12,
  durationMs: 900,
  attempt: 0,
  status: "succeeded",
  error: null,
  startedAt: finishedAt,
  finishedAt
});

async function start(driverPorts: SoakPorts, extra: Partial<Parameters<typeof runSoak>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "soak-run-"));
  directories.push(directory);
  const clock = new VirtualClock();
  const sink = new MemoryEventSink();
  const done = runSoak({
    profile,
    profileName: "test",
    directory,
    run: "test-run",
    ports: driverPorts,
    sink,
    clock,
    logger: { info: () => undefined, error: (...a: unknown[]) => console.error(...a) },
    meta: {
      host: { platform: "darwin", arch: "arm64", totalMemoryMb: 16384 },
      catalogHeader: { refresh: "on", reason: null },
      bounds: { connectMs: 10_000, firstByteMs: 30_000, stallMs: 20_000 },
      providers: [{ provider: "codex-wire", providerConfigId: "c1", baseUrl: "http://127.0.0.1:1" }]
    },
    ...extra
  });
  // The run writes its metadata before it sleeps for the first time: let it get there.
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  return { directory, clock, sink, done };
}

const actions = (sink: MemoryEventSink): ActionRecord[] =>
  sink.events.filter((event): event is ActionRecord => event.type === "action");

describe("the soak driver", () => {
  it("plays the timeline on the ports, one record per action, and ends with its duration", async () => {
    const { ports: driverPorts, calls } = ports();
    const { directory, clock, sink, done } = await start(driverPorts);
    await clock.advance(13 * minute);
    const outcome = await done;
    expect(outcome.reason).toBe("duration");
    expect(calls.filter((call) => call.startsWith("article"))).toEqual([
      "article 0",
      "article 1",
      "article 2"
    ]);
    expect(calls.filter((call) => call.startsWith("ask"))).toEqual(["ask 0", "ask 1"]);
    // The burst opens its three at once; the probe after the outage opens one.
    expect(calls).toContain("explain 3 0");
    expect(calls.filter((call) => call === "explain 1 0").length).toBeGreaterThanOrEqual(1);
    expect(calls).toContain("kill");
    expect(calls).toContain("typing 0");
    expect(actions(sink).every((action) => action.status === "ok")).toBe(true);
    expect(actions(sink).some((action) => action.kind === "post_outage_probe")).toBe(true);
    const kills = sink.events.filter(
      (event): event is LocalFaultRecord => event.type === "local" && event.kind === "mlx_kill"
    );
    expect(kills).toHaveLength(2);
    expect(kills[0]!.detail).toMatchObject({ killed: true, pid: 4242, status: "ok" });
    // Everything the run wrote reads back through the schemas the report uses.
    const meta = soakMetaSchema.parse(
      JSON.parse(readFileSync(join(directory, soakFiles.meta), "utf8"))
    );
    expect(meta).toMatchObject({ run: "test-run", endReason: "duration", seed: 7 });
    expect(meta.endedAt).not.toBeNull();
    const samples = parseNdjson(
      readFileSync(join(directory, soakFiles.samples), "utf8"),
      soakSampleSchema
    );
    expect(samples.invalid).toBe(0);
    expect(samples.records.length).toBeGreaterThanOrEqual(12);
    expect(samples.records[1]!.elapsedMs).toBe(minute);
  });

  it("skips an action while the previous one of its kind still runs, instead of piling them up", async () => {
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const { ports: driverPorts } = ports({
      ask: async () => {
        await stuck;
        return { outcome: "answered" };
      }
    });
    const { clock, sink, done } = await start(driverPorts);
    await clock.advance(13 * minute);
    release();
    await done;
    const asks = actions(sink).filter((action) => action.kind === "ask");
    expect(
      asks.map((action) => action.status).filter((status) => status === "skipped")
    ).toHaveLength(1);
    expect(asks.filter((action) => action.status === "ok")).toHaveLength(1);
  });

  it("records a failing action and goes on", async () => {
    const { ports: driverPorts } = ports({
      editNote: async () => {
        throw new Error("sourceWorkspace.conflict");
      }
    });
    const { clock, sink, done } = await start(driverPorts);
    await clock.advance(13 * minute);
    const outcome = await done;
    expect(outcome.failed).toBe(1);
    expect(actions(sink).find((action) => action.kind === "note_edit")).toMatchObject({
      status: "failed",
      error: "sourceWorkspace.conflict"
    });
    expect(actions(sink).filter((action) => action.status === "ok").length).toBeGreaterThan(10);
  });

  it("keeps the facts a failing port reports about its action", async () => {
    const { ports: driverPorts } = ports({
      ask: async () => {
        throw new SoakActionFailure("consultation.errors.deadline", {
          wallMs: 121_500,
          remoteCallStarted: false
        });
      }
    });
    const { clock, sink, done } = await start(driverPorts);
    await clock.advance(13 * minute);
    await done;
    expect(actions(sink).find((action) => action.kind === "ask")).toMatchObject({
      status: "failed",
      error: "consultation.errors.deadline",
      detail: { wallMs: 121_500, remoteCallStarted: false }
    });
  });

  it("writes each audited call once, however often it is read", async () => {
    const harness = ports();
    harness.setRows([row("a", "2026-10-20T08:01:00.000Z"), row("b", "2026-10-20T08:02:00.000Z")]);
    const { directory, clock, done } = await start(harness.ports);
    await clock.advance(13 * minute);
    await done;
    const runs = parseNdjson(
      readFileSync(join(directory, soakFiles.taskRuns), "utf8"),
      taskRunRecordSchema
    );
    expect(runs.records.map((record) => record.id)).toEqual(["a", "b"]);
  });

  it("holds a call whose monitoring entry is not linked yet for its operation, then writes it once with the operation", async () => {
    const harness = ports();
    const unlinked = { ...row("a", "2026-10-20T08:00:50.000Z"), operation: null };
    const never = { ...row("b", "2026-10-20T08:00:50.000Z"), operation: null };
    const old = row("c", "2026-10-20T08:00:50.000Z");
    harness.setRows([unlinked, never, old]);
    const { directory, clock, done } = await start(harness.ports);
    // The first minute's read finds "a" and "b" 10 s after they ended, without an operation: they
    // wait. The link then appears for "a" only; "c" has no operation field at all and is written.
    await clock.advance(minute);
    harness.setRows([{ ...unlinked, operation: "source_relation_matching" }, never, old]);
    await clock.advance(12 * minute);
    await done;
    const runs = parseNdjson(
      readFileSync(join(directory, soakFiles.taskRuns), "utf8"),
      taskRunRecordSchema
    );
    const byId = new Map(runs.records.map((record) => [record.id, record]));
    expect(runs.records).toHaveLength(3);
    expect(byId.get("a")?.operation).toBe("source_relation_matching");
    // A call that never gets a link is written once the wait is over, with a null operation.
    expect(byId.get("b")?.operation).toBeNull();
    expect(byId.get("c")?.operation).toBeUndefined();
  });

  it("writes each failed job once, and none that failed before the run began", async () => {
    const harness = ports();
    const failed = (id: string, at: string): JobFailureRecord => ({
      id,
      jobType: "knowledge-graph-generation",
      lane: "heavy",
      at,
      attempts: 1,
      sourceItemId: null,
      error: "errors.entityIdentity.invalidOutput"
    });
    harness.setFailedJobs([
      failed("before", "2026-10-20T07:59:00.000Z"),
      failed("during", "2026-10-20T08:03:00.000Z")
    ]);
    const { sink, clock, done } = await start(harness.ports);
    await clock.advance(13 * minute);
    const outcome = await done;
    const failures = sink.events.filter((event) => event.type === "job_failure");
    expect(failures).toEqual([
      expect.objectContaining({ id: "during", error: "errors.entityIdentity.invalidOutput" })
    ]);
    expect(outcome.failedJobs).toBe(1);
  });

  it("stops early when the orchestrator leaves a STOP file", async () => {
    let stop = false;
    const { ports: driverPorts } = ports({ stopRequested: async () => stop });
    const { directory, clock, done } = await start(driverPorts);
    await clock.advance(4 * minute);
    stop = true;
    writeFileSync(join(directory, soakFiles.stop), "");
    await clock.advance(2 * minute);
    const outcome = await done;
    expect(outcome.reason).toBe("stop_file");
    const meta = soakMetaSchema.parse(
      JSON.parse(readFileSync(join(directory, soakFiles.meta), "utf8"))
    );
    expect(meta.endReason).toBe("stop_file");
    expect(Date.parse(meta.endedAt!) - Date.parse(meta.startedAt)).toBeLessThan(8 * minute);
  });

  it("waits at most the settle time for an action that never ends, then ends and lets the app quit", async () => {
    let stop = false;
    // The Ask at minute 2 never returns, as a call held up behind work that does not end.
    const { ports: driverPorts } = ports({
      stopRequested: async () => stop,
      ask: () => new Promise<never>(() => undefined)
    });
    const { clock, done } = await start(driverPorts, { settleMs: 10 * minute });
    let ended = false;
    void done.then(() => (ended = true));
    await clock.advance(3 * minute);
    stop = true;
    // The STOP file is seen at the next sample; the stuck action holds the end, but only for the settle time.
    await clock.advance(minute + 9 * minute);
    expect(ended).toBe(false);
    await clock.advance(minute + 1_000);
    expect((await done).reason).toBe("stop_file");
  });

  it("ends as a signal when the app is quitting", async () => {
    const controller = new AbortController();
    const { ports: driverPorts } = ports();
    const { clock, done } = await start(driverPorts, { signal: controller.signal });
    await clock.advance(3 * minute);
    controller.abort();
    await settle();
    await clock.advance(minute);
    expect((await done).reason).toBe("signal");
  });
});

describe("the records", () => {
  it("read a breaker move from the AI service's log line", () => {
    expect(
      parseBreakerLog(
        "AI lane remote:7c2f: circuit breaker closed -> open (5 consecutive transient failures)",
        Date.parse("2026-10-20T14:00:00Z")
      )
    ).toEqual({
      type: "breaker",
      at: "2026-10-20T14:00:00.000Z",
      lane: "remote:7c2f",
      from: "closed",
      to: "open",
      reason: "5 consecutive transient failures"
    });
    expect(parseBreakerLog("something else", 0)).toBeNull();
  });

  it("validate every event kind and refuse a record that is not one", () => {
    const events: SoakEvent[] = [
      {
        type: "exchange",
        provider: "codex-wire",
        seq: 1,
        startedAt: "2026-10-20T08:00:00.000Z",
        endedAt: "2026-10-20T08:00:03.000Z",
        kind: "none",
        injected: false,
        status: 200,
        outcome: "completed",
        closedAfterMs: null,
        closedAfterLastWriteMs: null,
        retryAfterSeconds: null,
        plannedMs: 3000
      },
      {
        type: "window",
        provider: "codex-wire",
        kind: "outage",
        startedAt: "2026-10-20T08:00:00.000Z",
        endedAt: "2026-10-20T08:15:00.000Z",
        factor: null
      }
    ];
    for (const event of events) expect(soakEventSchema.parse(event)).toEqual(event);
    expect(() => soakEventSchema.parse({ type: "exchange", provider: "x" })).toThrow();
  });
});

describe("the edit waves and the listed helper kills (F4 D38b)", () => {
  /** A 40 minute run: a wave every 7.5 min from 2.5, none after 30; kills at listed minutes. */
  const waveProfile: SoakProfile = soakProfileSchema.parse({
    ...profile,
    remote: undefined,
    driver: {
      ...profile.driver,
      article: { everyMinutes: 1440, offsetMinutes: 100_000 },
      ask: { everyMinutes: 1440, offsetMinutes: 100_000 },
      explain: { everyMinutes: 1440, offsetMinutes: 100_000 },
      explainBurst: { everyMinutes: 1440, offsetMinutes: 100_000, count: 1 },
      noteEdit: { everyMinutes: 1440, offsetMinutes: 100_000 },
      sourceReimport: { everyMinutes: 1440, offsetMinutes: 100_000 },
      typingFault: { everyMinutes: 1440, offsetMinutes: 100_000 },
      editWave: { everyMinutes: 7.5, offsetMinutes: 2.5, untilMinutes: 30 }
    },
    durationHours: 40 / 60,
    local: { mlxKill: { atMinutes: [4.5, 19.5] }, ggufAbort: { everyMinutes: 600 } }
  });

  it("places a wave at offset + k x every (fractional), none after its bound, and kills at the listed minutes", () => {
    const timeline = buildTimeline(waveProfile);
    expect(
      timeline.filter((entry) => entry.kind === "edit_wave").map((entry) => entry.atMs / minute)
    ).toEqual([2.5, 10, 17.5, 25]);
    expect(
      timeline
        .filter((entry) => entry.kind === "mlx_kill")
        .map((entry) => [entry.atMs / minute, entry.index])
    ).toEqual([
      [4.5, 1],
      [19.5, 2]
    ]);
    // Defaults: 1,000 notes, alternating order; without a bound, the run's end bounds the waves.
    expect(waveProfile.driver.editWave).toMatchObject({ notes: 1000, order: "alternate" });
    const unbounded = soakProfileSchema.parse({
      ...waveProfile,
      driver: { ...waveProfile.driver, editWave: { everyMinutes: 14.382, offsetMinutes: 1.4 } }
    });
    expect(
      buildTimeline(unbounded)
        .filter((entry) => entry.kind === "edit_wave")
        .map((entry) => entry.atMs)
    ).toEqual([1.4, 15.782, 30.164].map((at) => Math.round(at * minute)));
    // A wave and a burst edit at the same moment: the burst edit first, then the wave, then a kill.
    const tied = soakProfileSchema.parse({
      ...waveProfile,
      driver: {
        ...waveProfile.driver,
        editWave: { everyMinutes: 10, offsetMinutes: 5 },
        contentionBurst: { everyMinutes: 1440, offsetMinutes: 5, edits: 1 }
      },
      local: { mlxKill: { atMinutes: [5] }, ggufAbort: { everyMinutes: 600 } }
    });
    expect(
      buildTimeline(tied)
        .filter((entry) => entry.atMs === 5 * minute)
        .map((entry) => entry.kind)
    ).toEqual(["contention_burst", "burst_edit", "edit_wave", "mlx_kill"]);
  });

  it("refuses kills given both ways or neither, out of order or past the run's end, and waves out of bounds", () => {
    const local = (mlxKill: object) =>
      soakProfileSchema.safeParse({
        ...waveProfile,
        local: { mlxKill, ggufAbort: { everyMinutes: 600 } }
      }).success;
    expect(local({ atMinutes: [4.5, 19.5] })).toBe(true);
    expect(local({ everyMinutes: 10 })).toBe(true);
    expect(local({ everyMinutes: 10, atMinutes: [4.5] })).toBe(false);
    expect(local({})).toBe(false);
    expect(local({ atMinutes: [19.5, 4.5] })).toBe(false);
    expect(local({ atMinutes: [4.5, 40] })).toBe(false);
    const wave = (editWave: object) =>
      soakProfileSchema.safeParse({ ...waveProfile, driver: { ...waveProfile.driver, editWave } })
        .success;
    expect(wave({ everyMinutes: 14.382, notes: 2000, order: "by_root" })).toBe(true);
    expect(wave({ everyMinutes: 0 })).toBe(false);
    expect(wave({ everyMinutes: 10, notes: 0 })).toBe(false);
    expect(wave({ everyMinutes: 10, notes: 2001 })).toBe(false);
    expect(wave({ everyMinutes: 10, order: "random" })).toBe(false);
  });

  it("dispatches each wave with its index, the note cap and the order (even by root, odd interleaved)", async () => {
    const waves: Array<[number, number, string]> = [];
    const { ports: driverPorts, calls } = ports({
      editWave: async (index, spec) => {
        waves.push([index, spec.notes, spec.order]);
        return { picked: 3, edited: 3 };
      }
    });
    const { clock, sink, done } = await start(driverPorts, { profile: waveProfile });
    await clock.advance(41 * minute);
    await done;
    expect(waves).toEqual([
      [0, 1000, "by_root"],
      [1, 1000, "interleaved"],
      [2, 1000, "by_root"],
      [3, 1000, "interleaved"]
    ]);
    expect(calls.filter((call) => call === "kill")).toHaveLength(2);
    const recorded = actions(sink).filter((action) => action.kind === "edit_wave");
    expect(recorded.map((action) => [action.index, action.status])).toEqual([
      [0, "ok"],
      [1, "ok"],
      [2, "ok"],
      [3, "ok"]
    ]);
    expect(recorded[0]!.detail).toMatchObject({ picked: 3, edited: 3 });
  });

  it("fails a wave when the run has no port, and skips (and records) a wave whose predecessor still runs", async () => {
    const { ports: none } = ports();
    const first = await start(none, {
      profile: waveProfile,
      logger: { info: () => undefined, error: () => undefined }
    });
    await first.clock.advance(41 * minute);
    await first.done;
    const failed = actions(first.sink).filter((action) => action.kind === "edit_wave");
    expect(failed).toHaveLength(4);
    expect(failed.every((action) => action.status === "failed")).toBe(true);
    expect(failed[0]!.error).toContain("no edit-wave port");

    let release: () => void = () => undefined;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const { ports: slow } = ports({
      editWave: async () => {
        await stuck;
        return { edited: 1 };
      }
    });
    const second = await start(slow, { profile: waveProfile });
    await second.clock.advance(41 * minute);
    release();
    await second.done;
    const statuses = actions(second.sink)
      .filter((action) => action.kind === "edit_wave")
      .map((action) => [action.index, action.status, action.detail.reason ?? null]);
    expect(statuses).toEqual([
      [1, "skipped", "previous action of the kind still running"],
      [2, "skipped", "previous action of the kind still running"],
      [3, "skipped", "previous action of the kind still running"],
      [0, "ok", null]
    ]);
  });
});
