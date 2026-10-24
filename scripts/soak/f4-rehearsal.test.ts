import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runSoak,
  type SoakClock,
  type SoakF4Runtime,
  type SoakPorts
} from "../../apps/desktop/src/main/services/dev/soak-driver.ts";
import { soakProfileSchema } from "../../apps/desktop/src/main/services/dev/soak-plan.ts";
import { expandWindows } from "../../apps/desktop/src/main/services/dev/soak-plan-f4.ts";
import {
  MemoryEventSink,
  type SoakEventSink,
  fileEventSink,
  soakFiles,
  soakMetaSchema,
  type GroundTruthRecord,
  type SoakEvent
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import { HarnessTokenCap } from "../../apps/desktop/src/main/services/dev/soak-token-cap.ts";
import {
  WindowRunner,
  type WindowPorts
} from "../../apps/desktop/src/main/services/dev/soak-windows.ts";
import { computeE5, e5Check } from "./report-f4.ts";
import { analyzeRun, loadRun, renderReport } from "./report.ts";

/**
 * The 7-day driver at the scale of minutes (F4 T89): the real driver, the real window runner and the
 * real harness cap on a virtual clock, fake ports that follow the windows (a status sentence that
 * says what each window makes true, as the product should), and the real report over the folder it
 * writes. It proves the parts agree with each other: every transition of the ground truth is
 * recorded with its settle, the sentence follows the windows (E5), the drop steps are taken by the
 * hourly check and never reverted, the harness-cap window lowers and restores the cap, the
 * windows still open at the end are lifted, and a cap that is reached ends the run inconclusive.
 */

class VirtualClock implements SoakClock {
  private t = Date.parse("2026-10-28T00:00:00.000Z");
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
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 3));
const minute = 60_000;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const tokens = {
  article: 40_800,
  typing_fault: 40_800,
  source_reimport: 40_800,
  ask: 6_600,
  explain: 1_000,
  explain_burst: 3_000,
  topic_open: 3_167,
  note_edit: 3_500,
  burst_edit: 1_750,
  contention_burst: 0,
  backgroundPerHour: 4_792
};

function profileWith(cap: number) {
  return soakProfileSchema.parse({
    seed: 11,
    durationHours: 3,
    warmupMinutes: 2,
    sampleEveryMinutes: 1,
    runFolder: "f4",
    driver: {
      article: { everyMinutes: 40, offsetMinutes: 5 },
      ask: { everyMinutes: 30, offsetMinutes: 7 },
      explain: { everyMinutes: 20, offsetMinutes: 3 },
      explainBurst: { everyMinutes: 90, offsetMinutes: 11, count: 3 },
      noteEdit: { everyMinutes: 45, offsetMinutes: 9 },
      sourceReimport: { everyMinutes: 1440, offsetMinutes: 30, days: "odd" },
      typingFault: { everyMinutes: 1440, offsetMinutes: 30, days: "even" },
      topicOpen: { everyMinutes: 40, offsetMinutes: 13 },
      contentionBurst: {
        everyMinutes: 90,
        offsetMinutes: 50,
        reembeds: 5,
        edits: 3,
        editSpacingMinutes: 1
      },
      postOutageProbeSeconds: 35
    },
    local: { mlxKill: { everyMinutes: 100, jitterMinutes: 0 }, ggufAbort: { everyMinutes: 100 } },
    f4: {
      codex: { expected: cap / 2, cap, tokens, windowTokenFactor: { usage_limit: 0 } },
      windows: [
        {
          id: "w-limit",
          kind: "usage_limit",
          startMinute: 10,
          durationMinutes: 10,
          expect: { class: "waiting", reason: "provider_rate_limit" }
        },
        {
          id: "w-off",
          kind: "autonomy_off",
          startMinute: 30,
          durationMinutes: 10,
          expect: { class: "paused", reason: "autonomy_off" }
        },
        {
          id: "w-cap",
          kind: "harness_cap",
          startMinute: 60,
          durationMinutes: 10,
          params: { calls: 1.5 }
        },
        {
          id: "w-idle",
          kind: "only_idle",
          startMinute: 80,
          durationMinutes: 30,
          expect: { class: "paused", reason: "only_idle_user_active" },
          params: { blockMinutes: 10 }
        }
      ],
      decisions: "off"
    }
  });
}

/** The cap fields a minute sample records (the snapshot's hard cap stays in the cap itself). */
function sampledCap(snapshot: ReturnType<HarnessTokenCap["snapshot"]>) {
  return {
    capTokens: snapshot.capTokens,
    spentTokens: snapshot.spentTokens,
    reservedTokens: snapshot.reservedTokens,
    calls: snapshot.calls,
    refusals: snapshot.refusals,
    largestCallTokens: snapshot.largestCallTokens
  };
}

/** The product as the harness hopes to find it: a sentence that says what each window makes true. */
function world(sink: SoakEventSink, capTokens: number, now: () => number) {
  const state = {
    laneWindow: false,
    /** When the product's first call met the lane window: at once, Codex is never idle here. */
    laneMetAt: null as number | null,
    autonomy: "auto" as "off" | "suggest" | "auto",
    idleOn: false,
    idleStartedAt: 0,
    capLowered: false,
    controlsCalls: [] as string[]
  };
  const cap = new HarnessTokenCap({ capTokens, sink, now: () => Date.now() });
  const windowPorts: WindowPorts = {
    lane: {
      start: () => {
        state.laneWindow = true;
        state.laneMetAt = now();
      },
      end: () => {
        state.laneWindow = false;
      },
      metAt: () => (state.laneWindow ? state.laneMetAt : null)
    },
    controls: {
      update: async (change) => {
        state.controlsCalls.push(JSON.stringify(change));
        if (change.autonomy) state.autonomy = change.autonomy;
        if (change.onlyIdle !== undefined) {
          state.idleOn = change.onlyIdle;
          state.idleStartedAt = now();
        }
      },
      autonomy: () => state.autonomy
    },
    power: { setBlocks: () => undefined },
    codexDailyCap: { today: async () => ({ calls: 0, day: "d" }), set: () => undefined },
    hooks: {
      invalidateRanker: async () => undefined,
      restoreRanker: async () => undefined,
      markEmbedderVerifying: async () => undefined,
      clearEmbedderVerifying: async () => undefined
    },
    harnessCap: {
      lowerToSpentPlus: (calls) => {
        state.capLowered = true;
        return cap.lowerToSpentPlus(calls);
      },
      restore: () => {
        state.capLowered = false;
        cap.restore();
      }
    },
    money: null
  };
  const status = () => {
    if (state.autonomy === "off")
      return { state: "blocked", class: "paused", reason: "autonomy_off", params: {} };
    if (state.laneWindow)
      return { state: "blocked", class: "waiting", reason: "provider_rate_limit", params: {} };
    // The idle window alternates ten minutes of activity and ten of idleness, active first.
    if (state.idleOn && Math.floor((now() - state.idleStartedAt) / (10 * minute)) % 2 === 0)
      return { state: "blocked", class: "paused", reason: "only_idle_user_active", params: {} };
    return { state: "running", params: {} };
  };
  return { state, cap, windowPorts, status };
}

function portsFor(w: ReturnType<typeof world>, extra: Partial<SoakPorts> = {}): SoakPorts {
  const calls: string[] = [];
  return {
    importArticle: async () => ({ title: "t" }),
    ask: async () => ({ outcome: "answered" }),
    explain: async () => ({ opened: 1 }),
    editNote: async () => ({ outcome: "edited" }),
    reimportSource: async () => ({ versioned: "s" }),
    importTypingFaultSource: async () => ({ sourceItemId: "s" }),
    killMlxHelper: async () => ({ killed: true, detail: { pid: 1 } }),
    armGgufAbort: async () => ({ stage: "armed" }),
    openTopic: async (index) => (calls.push(`topic ${index}`), { outcome: "opened" }),
    contentionBurst: async () => ({ auditRequested: true, reembedsQueued: 5 }),
    editBurstNote: async (_index, rootIndex) => ({ outcome: "edited", rootIndex }),
    finishedJobs: async () => [],
    outcomeChanges: async () => [],
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
      jobCounts: {},
      helper: { pid: 1, rssMb: 1, spawnCount: 1 },
      appRssMb: 100,
      pageouts: 0,
      pageSizeBytes: 16_384,
      eventLoopLagP99Ms: 1,
      dbPool: { total: 1, idle: 1, waiting: 0 },
      status: w.status(),
      cap: sampledCap(w.cap.snapshot())
    }),
    taskRuns: async () => [],
    failedJobs: async () => [],
    stopRequested: async () => false,
    ...extra
  };
}

async function play(options: {
  cap: number;
  minutes: number;
  mutate?: (w: ReturnType<typeof world>, now: () => number) => void;
  ports?: (w: ReturnType<typeof world>) => Partial<SoakPorts>;
}) {
  const profile = profileWith(options.cap);
  const directory = mkdtempSync(join(tmpdir(), "soak-f4-"));
  directories.push(directory);
  const clock = new VirtualClock();
  // The events go to the run folder, as in a real run, and are kept in memory for the assertions.
  const memory = new MemoryEventSink();
  const file = fileEventSink(join(directory, soakFiles.events));
  const sink = {
    events: memory.events,
    append: (event: SoakEvent) => {
      memory.append(event);
      file.append(event);
    },
    flush: () => file.flush()
  };
  const w = world(sink, options.cap, () => clock.now());
  // The allowances drop step 3 gives the explanation backfill.
  const backfillCaps: number[] = [];
  const f4: SoakF4Runtime = {
    windows: new WindowRunner({
      ports: w.windowPorts,
      sink,
      clock,
      logger: { info: () => undefined, error: (...a: unknown[]) => console.error(...a) }
    }),
    cap: w.cap,
    setBackfillCap: (calls) => void backfillCaps.push(calls),
    isExhausted: () => w.cap.isExhausted
  };
  const overrides = options.ports?.(w) ?? {};
  const ports = portsFor(w, {
    ...overrides,
    sample: async () => {
      options.mutate?.(w, () => clock.now());
      return (overrides.sample ?? portsFor(w).sample)();
    }
  });
  const windowSpecs = expandWindows(profile.f4!, profile.durationHours * 60);
  const done = runSoak({
    profile,
    profileName: "soak7-rehearsal",
    directory,
    run: "rehearsal",
    ports,
    sink,
    clock,
    f4,
    settleMs: 1,
    logger: { info: () => undefined, error: (...a: unknown[]) => console.error(...a) },
    meta: {
      host: { platform: "darwin", arch: "arm64", totalMemoryMb: 32_768 },
      catalogHeader: { refresh: "on", reason: null },
      bounds: { connectMs: 10_000, firstByteMs: 30_000, stallMs: 20_000 },
      providers: [
        { provider: "openai-codex", providerConfigId: "writer-1", baseUrl: "https://chatgpt.com" }
      ],
      relations: { discoveryNeighbours: 1, judgeMode: "ranker" },
      realWriter: { providerConfigId: "writer-1", provider: "openai-codex", modelId: "luna" },
      f4: {
        codex: { expected: options.cap / 2, cap: options.cap, dropFromHour0: 0 },
        windows: windowSpecs.map((window) => ({
          id: window.id,
          kind: window.kind,
          startMinute: window.startMinute,
          durationMinutes: window.durationMinutes,
          ...(window.expect ? { expect: window.expect } : {}),
          settleMinutes: window.settleMinutes,
          settleEndMinutes: window.settleEndMinutes ?? window.settleMinutes
        })),
        predicates: { workerStates: 1 }
      }
    }
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  // The run ends with its duration unless something ends it sooner.
  await clock.advance(Math.max(options.minutes, 181) * minute);
  const outcome = await done;
  return { directory, sink, w, outcome, clock, backfillCaps };
}

const truths = (sink: MemoryEventSink) =>
  sink.events.filter((event): event is GroundTruthRecord => event.type === "ground_truth");

describe("the 7-day driver on a virtual clock", () => {
  it("records every transition of the ground truth with its settle, and the sentence follows the windows (E5)", async () => {
    const { sink, outcome, directory, w } = await play({ cap: 50_000_000, minutes: 181 });
    expect(outcome.reason).toBe("duration");
    const records = truths(sink);
    // Four windows, a start and an end each; the idle window's active blocks come on top.
    expect(records.filter((entry) => entry.id === "w-limit").map((e) => e.phase)).toEqual([
      "start",
      "end"
    ]);
    // The provider window expects its class from the first call that met it, seen at a tick.
    expect(records.filter((entry) => entry.id === "w-limit#met").map((e) => e.phase)).toEqual([
      "start",
      "end"
    ]);
    expect(records.filter((entry) => entry.id.startsWith("w-idle#")).length).toBeGreaterThanOrEqual(
      4
    );
    for (const record of records) {
      const settle = Date.parse(record.settleUntil) - Date.parse(record.at);
      expect(settle, `${record.id} ${record.phase}`).toBe(2 * minute);
    }
    // Windows start at their minute (the next sample tick is at most a minute away for blocks).
    const start = Date.parse(sink.events.find((event) => event.type === "action")!.startedAt);
    void start;
    const limit = records.find((entry) => entry.id === "w-limit" && entry.phase === "start")!;
    expect(Date.parse(limit.at) - Date.parse("2026-10-28T00:00:00.000Z")).toBe(10 * minute);
    expect(w.state.laneWindow).toBe(false);
    expect(w.state.autonomy).toBe("auto");
    expect(w.state.idleOn).toBe(false);

    const run = await loadRun(directory);
    const e5 = computeE5(run);
    expect(e5.checked).toBeGreaterThan(10);
    expect(e5.matched).toBe(e5.checked);
    expect(e5.recoveryMismatches).toEqual([]);
    expect(e5Check(run).status).toBe("pass");
    const meta = soakMetaSchema.parse(
      JSON.parse(readFileSync(join(directory, soakFiles.meta), "utf8"))
    );
    expect(meta.f4?.windows).toHaveLength(4);
  }, 120_000);

  it("fails E5 when the sentence does not follow a window", async () => {
    const { directory } = await play({
      cap: 50_000_000,
      minutes: 60,
      ports: (w) => ({
        // A sentence that never leaves "running", whatever the windows make true.
        sample: async () => ({
          ...(await portsFor(w).sample()),
          status: { state: "running", params: {} }
        })
      })
    });
    const run = await loadRun(directory);
    const check = e5Check(run);
    expect(check.status).toBe("fail");
    expect(check.details.join(" ")).toContain("w-limit#met expected waiting.provider_rate_limit");
  }, 120_000);

  it("plays the topic opens, the bursts and their edits through the F4 ports", async () => {
    const played: string[] = [];
    const { sink } = await play({
      cap: 50_000_000,
      minutes: 120,
      ports: () => ({
        openTopic: async (index) => (played.push(`topic ${index}`), { outcome: "opened" }),
        contentionBurst: async (index, reembeds) => (
          played.push(`burst ${index} ${reembeds}`),
          { auditRequested: true }
        ),
        editBurstNote: async (index, rootIndex) => (
          played.push(`edit ${index} root ${rootIndex}`),
          { outcome: "edited" }
        )
      })
    });
    // Every 40 minutes from minute 13 over three hours: five page opens.
    expect(played.filter((entry) => entry.startsWith("topic"))).toEqual([
      "topic 0",
      "topic 1",
      "topic 2",
      "topic 3",
      "topic 4"
    ]);
    expect(played).toContain("burst 0 5");
    // Three edits a minute apart after each burst, each in a root of its own.
    expect(played.filter((entry) => entry.startsWith("edit")).slice(0, 3)).toEqual([
      "edit 0 root 0",
      "edit 1 root 1",
      "edit 2 root 2"
    ]);
    const kinds = new Set(
      sink.events.flatMap((event: SoakEvent) => (event.type === "action" ? [event.kind] : []))
    );
    expect([...kinds]).toEqual(
      expect.arrayContaining(["topic_open", "contention_burst", "burst_edit"])
    );
  }, 120_000);

  it("lowers the harness cap in its window and restores it at the end", async () => {
    const { sink, w } = await play({
      cap: 50_000_000,
      minutes: 90,
      mutate: (world, now) => {
        // Some calls before the window, so a typical call has a weight.
        if (now() < Date.parse("2026-10-28T00:00:00.000Z") + 40 * minute) {
          const reservation = world.cap.reserve(20_000);
          world.cap.settle(reservation, 18_000);
        }
      }
    });
    const caps = sink.events.filter((event) => event.type === "cap");
    expect(caps.map((event) => event.type === "cap" && event.action)).toEqual(
      expect.arrayContaining(["lower", "set"])
    );
    expect(w.state.capLowered).toBe(false);
    expect(w.cap.snapshot().capTokens).toBe(50_000_000);
  }, 120_000);

  it("takes the drop steps at the hourly checks, one at a time, and never reverts them", async () => {
    const { sink, backfillCaps } = await play({
      cap: 400_000,
      minutes: 181,
      mutate: (world, now) => {
        // A spend far above what the plan projects: 380k tokens in the first minutes.
        if (now() - Date.parse("2026-10-28T00:00:00.000Z") === 3 * minute) {
          const reservation = world.cap.reserve(10_000);
          world.cap.settle(reservation, 380_000);
        }
      }
    });
    const drops = sink.events.filter((event) => event.type === "drop_step");
    expect(drops.length).toBeGreaterThanOrEqual(2);
    expect(drops.map((event) => event.type === "drop_step" && event.step)).toEqual(
      [1, 2, 3, 4, 5].slice(0, drops.length)
    );
    // Step 3 lowers the explanation backfill's daily allowance from 20 to 10, once.
    expect(backfillCaps).toEqual(drops.length >= 3 ? [10] : []);
    const skipped = sink.events.filter(
      (event) => event.type === "action" && event.status === "skipped"
    );
    expect(
      skipped.some(
        (event) => event.type === "action" && /drop step 1/u.test(String(event.detail.reason))
      )
    ).toBe(true);
  }, 120_000);

  it("ends the run inconclusive when the hard cap is reached, and lifts the windows still open", async () => {
    const { outcome, directory, w } = await play({
      cap: 5_000_000,
      minutes: 60,
      mutate: (world, now) => {
        // Inside the usage-limit window the cap is reached.
        if (now() - Date.parse("2026-10-28T00:00:00.000Z") === 15 * minute)
          try {
            world.cap.reserve(9_000_000);
          } catch {
            // Refused: the cap is exhausted.
          }
      }
    });
    expect(outcome.reason).toBe("token_cap");
    const run = await loadRun(directory);
    expect(run.meta.endReason).toBe("token_cap");
    const report = analyzeRun(run);
    expect(report.checks.find((check) => check.id === "tokens")?.status).toBe("fail");
    expect(renderReport(report)).toContain("Tokens and cap");
    expect(w.state.autonomy).toBe("auto");
  }, 120_000);
});
