import { describe, expect, it } from "vitest";

import { soakWindowSchema, type SoakWindowSpec } from "./soak-plan-f4.js";
import { MemoryEventSink, type GroundTruthRecord } from "./soak-records.js";
import {
  WindowRunner,
  defaultSettleMs,
  settleMs,
  windowTransitions,
  type MoneyPort,
  type WindowPorts
} from "./soak-windows.js";

const minute = 60_000;
const t0 = Date.parse("2026-10-29T06:00:00Z");

function spec(overrides: Record<string, unknown>): SoakWindowSpec {
  return soakWindowSchema.parse({
    id: "w1",
    kind: "usage_limit",
    startMinute: 10,
    durationMinutes: 30,
    ...overrides
  });
}

function harness(money: Partial<MoneyPort> | null = null, withWork = true) {
  const calls: string[] = [];
  let now = t0;
  /** When a request first met each provider-wait window (the fetch layer's own record). */
  const met = new Map<string, number>();
  let autonomy: "off" | "suggest" | "auto" = "auto";
  let budgetState: "open" | "paused" | "exhausted" = "open";
  let day = "2026-10-29";
  let usedCalls = 12;
  const moneyPort: MoneyPort | null = money
    ? {
        routeToFake: async () => {
          calls.push("money:route");
          return { baseUrl: "http://127.0.0.1:1/v1", model: "dev-fake-priced-1" };
        },
        restoreRoute: async () => void calls.push("money:restore"),
        spentUsd: async () => 0.5,
        monthlyCapUsd: () => 5,
        attemptEstimateUsd: (inputBytes) => (inputBytes + 1_024 + 16_384 * 4) / 1_000_000,
        state: async () => budgetState,
        continuePastPause: async () => {
          calls.push("money:continue");
          budgetState = "exhausted";
        },
        enqueueBackfill: async (count) => {
          calls.push(`money:backfill ${count}`);
          return count;
        },
        ...money
      }
    : null;
  const ports: WindowPorts = {
    lane: {
      start: (id, kind, durationMs) => void calls.push(`lane:start ${id} ${kind} ${durationMs}`),
      end: (id) => void calls.push(`lane:end ${id}`),
      metAt: (id) => met.get(id) ?? null
    },
    controls: {
      update: async (change) => {
        calls.push(`controls:${JSON.stringify(change)}`);
        if (change.autonomy) autonomy = change.autonomy;
      },
      autonomy: () => autonomy
    },
    power: { setBlocks: (blocks) => void calls.push(`power:${blocks ? blocks.join("+") : "off"}`) },
    codexDailyCap: {
      today: async () => ({ calls: usedCalls, day }),
      set: (value) => void calls.push(`dailyCap:${value}`),
      enqueueBackfill: async (count) => {
        calls.push(`dailyCap:backfill ${count}`);
        return count;
      }
    },
    hooks: {
      invalidateRanker: async () => void calls.push("hook:ranker-invalid"),
      restoreRanker: async () => void calls.push("hook:ranker-restore"),
      markEmbedderVerifying: async () => void calls.push("hook:embedder-verifying"),
      clearEmbedderVerifying: async () => void calls.push("hook:embedder-clear")
    },
    harnessCap: {
      lowerToSpentPlus: (callsCount) => {
        calls.push(`harnessCap:lower ${callsCount}`);
        return 123_456;
      },
      restore: () => void calls.push("harnessCap:restore")
    },
    money: moneyPort,
    ...(withWork
      ? {
          work: {
            enqueueBackfill: async (count: number, delayMs: number) => {
              calls.push(`work:backfill ${count} due ${delayMs}`);
              return count;
            },
            editNotes: async (count: number) => {
              calls.push(`work:edit ${count}`);
              return count;
            }
          }
        }
      : {})
  };
  const sink = new MemoryEventSink();
  const runner = new WindowRunner({ ports, sink, clock: { now: () => now } });
  const records = () =>
    sink.events.filter((event): event is GroundTruthRecord => event.type === "ground_truth");
  return {
    runner,
    calls,
    records,
    advance: (milliseconds: number) => void (now += milliseconds),
    setBudget: (state: "open" | "paused" | "exhausted") => void (budgetState = state),
    rollDay: (next: string, used: number) => {
      day = next;
      usedCalls = used;
    },
    setCalls: (used: number) => void (usedCalls = used),
    /** A request of the lane meets window `id` now. */
    meet: (id: string) => void met.set(id, now)
  };
}

describe("the transitions of the windows", () => {
  it("are the starts and ends in time order, an end before a start that falls at the same moment", () => {
    const a = spec({ id: "a", startMinute: 0, durationMinutes: 10 });
    const b = spec({ id: "b", kind: "autonomy_off", startMinute: 10, durationMinutes: 5 });
    expect(
      windowTransitions([b, a]).map(
        (entry) => `${entry.window.id}:${entry.phase}@${entry.atMs / minute}`
      )
    ).toEqual(["a:start@0", "a:end@10", "b:start@10", "b:end@15"]);
  });

  it("settle two minutes unless a window says otherwise (the sign-in window recovers by a probe every five)", () => {
    expect(settleMs(spec({}), "start")).toBe(defaultSettleMs);
    const signin = spec({ kind: "unauthorized", settleEndMinutes: 6 });
    expect(settleMs(signin, "start")).toBe(2 * minute);
    expect(settleMs(signin, "end")).toBe(6 * minute);
  });
});

describe("a window's effect and its ground truth", () => {
  it.each([
    ["autonomy_off", 'controls:{"autonomy":"off"}', 'controls:{"autonomy":"auto"}'],
    ["autonomy_suggest", 'controls:{"autonomy":"suggest"}', 'controls:{"autonomy":"auto"}'],
    ["pause", 'controls:{"paused":true}', 'controls:{"paused":false}'],
    ["ranker_invalid", "hook:ranker-invalid", "hook:ranker-restore"],
    ["embedder_verifying", "hook:embedder-verifying", "hook:embedder-clear"],
    ["only_ac", "power:battery", "power:off"],
    ["harness_cap", "harnessCap:lower 1.5", "harnessCap:restore"]
  ] as const)("%s starts with its effect and ends by lifting it", async (kind, started, ended) => {
    const { runner, calls, records, advance } = harness();
    const window = spec({
      kind,
      expect: { class: "waiting", reason: "provider_rate_limit" }
    });
    await runner.start(window);
    expect(calls.some((call) => call === started)).toBe(true);
    expect(runner.open).toEqual(["w1"]);
    advance(30 * minute);
    await runner.end(window);
    expect(calls.at(-1)).toBe(ended);
    expect(runner.open).toEqual([]);
    const [start, end] = records();
    expect(start).toMatchObject({
      id: "w1",
      kind,
      phase: "start",
      expect: { class: "waiting", reason: "provider_rate_limit" }
    });
    // The sentence gets two minutes after the start, and the end carries no expectation of its own.
    expect(Date.parse(start!.settleUntil) - Date.parse(start!.at)).toBe(defaultSettleMs);
    expect(end).toMatchObject({ id: "w1", phase: "end" });
    expect(end!.expect).toBeUndefined();
    expect(Date.parse(end!.settleUntil) - Date.parse(end!.at)).toBe(defaultSettleMs);
  });

  it.each(["usage_limit", "refused", "enotfound", "unauthorized"] as const)(
    "%s expects its class only once a request met the fault, and closes that at the end",
    async (kind) => {
      const { runner, calls, records, advance, meet } = harness();
      const window = spec({ kind, expect: { class: "waiting", reason: "provider_rate_limit" } });
      await runner.start(window);
      expect(calls).toEqual([`lane:start w1 ${kind} 1800000`]);
      // No call met the fault yet: the status cannot name it, so nothing is expected.
      advance(5 * minute);
      await runner.tick();
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ id: "w1", phase: "start" });
      expect(records()[0]!.expect).toBeUndefined();
      meet("w1");
      advance(minute);
      await runner.tick();
      await runner.tick();
      const opened = records()[1]!;
      expect(opened).toMatchObject({
        id: "w1#met",
        phase: "start",
        expect: { class: "waiting", reason: "provider_rate_limit" }
      });
      // The settle runs from the moment the harness saw the fault met.
      expect(Date.parse(opened.settleUntil) - Date.parse(opened.at)).toBe(defaultSettleMs);
      expect(records()).toHaveLength(2);
      advance(24 * minute);
      await runner.end(window);
      expect(calls.at(-1)).toBe("lane:end w1");
      expect(records().slice(2)).toMatchObject([
        { id: "w1#met", phase: "end" },
        { id: "w1", phase: "end", detail: { met: true } }
      ]);
    }
  );

  it("says so when no request met a provider-wait window: it expected nothing", async () => {
    const { runner, records, advance } = harness();
    const window = spec({
      kind: "refused",
      expect: { class: "waiting", reason: "provider_unavailable" }
    });
    await runner.start(window);
    advance(15 * minute);
    await runner.tick();
    await runner.end(window);
    expect(records().map((record) => [record.id, record.phase, record.expect])).toEqual([
      ["w1", "start", undefined],
      ["w1", "end", undefined]
    ]);
    expect(records()[1]).toMatchObject({ detail: { met: false } });
  });

  it("restores the autonomy the window found, not a fixed one", async () => {
    const { runner, calls } = harness();
    await runner.start(spec({ id: "x", kind: "autonomy_off" }));
    await runner.end(spec({ id: "x", kind: "autonomy_off" }));
    expect(calls).toEqual(['controls:{"autonomy":"off"}', 'controls:{"autonomy":"auto"}']);
    const second = harness();
    await second.runner.start(spec({ id: "s", kind: "autonomy_suggest" }));
    await second.runner.end(spec({ id: "s", kind: "autonomy_suggest" }));
    expect(second.calls).toEqual([
      'controls:{"autonomy":"suggest"}',
      'controls:{"autonomy":"auto"}'
    ]);
  });

  it("does nothing twice: a window already open is not started again, one never opened is not ended", async () => {
    const { runner, calls, records } = harness();
    const window = spec({ kind: "pause" });
    await runner.end(window);
    await runner.start(window);
    await runner.start(window);
    expect(calls).toEqual(['controls:{"paused":true}']);
    expect(records()).toHaveLength(1);
  });

  it("records a failed start with its error and goes on, so the report sees a window that did not take effect", async () => {
    const { runner, records } = harness();
    const ports = (runner as unknown as { options: { ports: WindowPorts } }).options.ports;
    ports.hooks.invalidateRanker = async () => {
      throw new Error("the ranker row is gone");
    };
    await runner.start(spec({ kind: "ranker_invalid" }));
    expect(records()[0]).toMatchObject({
      phase: "start",
      detail: { error: "the ranker row is gone" }
    });
    expect(runner.open).toEqual(["w1"]);
  });

  it("lets the sign-in window's end settle for six minutes", async () => {
    const { runner, records, advance, meet } = harness();
    const window = spec({ kind: "unauthorized", settleEndMinutes: 6 });
    await runner.start(window);
    meet("w1");
    await runner.tick();
    advance(10 * minute);
    await runner.end(window);
    for (const end of records().filter((record) => record.phase === "end"))
      expect(Date.parse(end.settleUntil) - Date.parse(end.at)).toBe(6 * minute);
  });
});

describe("the idle window", () => {
  it("expects the sentence in each active block only, with a settle after every block's start and end", async () => {
    const { runner, calls, records, advance } = harness();
    const window = spec({
      kind: "only_idle",
      durationMinutes: 40,
      params: { blockMinutes: 10 },
      expect: { class: "paused", reason: "only_idle_user_active" }
    });
    await runner.start(window);
    expect(calls).toEqual(['controls:{"onlyIdle":true}', "power:active+idle"]);
    expect(records()[0]!.expect).toBeUndefined();
    await runner.tick();
    for (let step = 0; step < 4; step += 1) {
      advance(10 * minute);
      await runner.tick();
    }
    await runner.end(window);
    const seen = records().map(
      (entry) => `${entry.id}:${entry.phase}${entry.expect ? ":expect" : ""}`
    );
    expect(seen).toEqual([
      "w1:start",
      "w1#1:start:expect",
      "w1#1:end",
      "w1#2:start:expect",
      "w1#2:end",
      "w1#3:start:expect",
      "w1#3:end",
      "w1:end"
    ]);
    expect(calls.slice(-2)).toEqual(['controls:{"onlyIdle":false}', "power:off"]);
  });

  it("closes the block that is open when the window ends", async () => {
    const { runner, records } = harness();
    const window = spec({ kind: "only_idle", params: { blockMinutes: 10 } });
    await runner.start(window);
    await runner.tick();
    await runner.end(window);
    expect(records().map((entry) => `${entry.id}:${entry.phase}`)).toEqual([
      "w1:start",
      "w1#1:start",
      "w1#1:end",
      "w1:end"
    ]);
  });
});

describe("the mid-run Codex cap", () => {
  const capWindow = () =>
    spec({
      kind: "codex_daily_cap",
      params: { extraCalls: 10 },
      expect: { class: "cap", reason: "subscription_daily" }
    });

  it("sets the cap to the calls so far plus ten and lifts it at the end", async () => {
    const { runner, calls, records, advance } = harness();
    const window = capWindow();
    await runner.start(window);
    expect(calls).toEqual(["dailyCap:22"]);
    advance(30 * minute);
    await runner.end(window);
    expect(calls.at(-1)).toBe("dailyCap:null");
    expect(records()[0]).toMatchObject({ phase: "start", detail: { callsSoFar: 12, cap: 22 } });
  });

  it("expects cap.subscription_daily only from the crossing: the budget holds nothing before the count reaches the cap", async () => {
    const { runner, records, advance, setCalls } = harness();
    const window = capWindow();
    await runner.start(window);
    // The window's own start expects nothing: background work still runs below the cap.
    expect(records()[0]!.expect).toBeUndefined();
    setCalls(21);
    advance(minute);
    await runner.tick();
    expect(records()).toHaveLength(1);
    setCalls(22);
    advance(minute);
    await runner.tick();
    expect(records()[1]).toMatchObject({
      id: "w1#crossed",
      phase: "start",
      expect: { class: "cap", reason: "subscription_daily" },
      detail: { calls: 22, cap: 22 }
    });
    expect(Date.parse(records()[1]!.settleUntil) - Date.parse(records()[1]!.at)).toBe(
      defaultSettleMs
    );
    await runner.tick();
    expect(records()).toHaveLength(2);
    advance(30 * minute);
    await runner.end(window);
    expect(records().map((entry) => `${entry.id}:${entry.phase}`)).toEqual([
      "w1:start",
      "w1#crossed:start",
      "w1#crossed:end",
      "w1:end"
    ]);
  });

  it("queues its own background load after the cap is set, so a short window crosses it", async () => {
    // Gate S of 10-25: 30 minutes at calls so far + 10 met 3 background calls and never crossed.
    const { runner, calls, records } = harness();
    const window = spec({
      kind: "codex_daily_cap",
      params: { extraCalls: 2, backfillRelations: 6 },
      expect: { class: "cap", reason: "subscription_daily" }
    });
    await runner.start(window);
    expect(calls).toEqual(["dailyCap:14", "dailyCap:backfill 6"]);
    expect(records()[0]).toMatchObject({
      detail: { callsSoFar: 12, cap: 14, relationsQueued: 6 }
    });
  });

  it("records a load it has no way to queue as the window's start failure", async () => {
    const { runner, records } = harness();
    const ports = (runner as unknown as { options: { ports: WindowPorts } }).options.ports;
    delete ports.codexDailyCap.enqueueBackfill;
    await runner.start(
      spec({ kind: "codex_daily_cap", params: { extraCalls: 2, backfillRelations: 6 } })
    );
    expect(String(records()[0]!.detail.error)).toMatch(/backfill/u);
  });

  it("is set again from the new count when the budget's day rolls over mid-window, and the crossing is closed", async () => {
    const { runner, calls, records, rollDay, setCalls } = harness();
    const window = capWindow();
    await runner.start(window);
    setCalls(22);
    await runner.tick();
    expect(calls).toEqual(["dailyCap:22"]);
    rollDay("2026-10-30", 0);
    await runner.tick();
    expect(calls).toEqual(["dailyCap:22", "dailyCap:10"]);
    await runner.tick();
    expect(calls).toHaveLength(2);
    expect(records().map((entry) => `${entry.id}:${entry.phase}`)).toEqual([
      "w1:start",
      "w1#crossed:start",
      "w1#crossed:end"
    ]);
    // The new day's count reaches the new cap: crossed again.
    setCalls(10);
    await runner.tick();
    expect(records().at(-1)).toMatchObject({ id: "w1#crossed", phase: "start" });
  });
});

describe("the money window", () => {
  const moneyWindow = () =>
    spec({
      id: "w146",
      kind: "money",
      durationMinutes: 360,
      params: {
        attempts: 8,
        backfillRelations: 10,
        continueAfterMinutes: 10,
        attemptEstimateUsd: 0.01
      }
    });

  it("routes the backfill to the priced fake, caps the month at spend plus eight attempts, and queues the pass", async () => {
    const { runner, calls, records } = harness({});
    await runner.start(moneyWindow());
    expect(calls).toEqual(["money:route", 'controls:{"monthlyCapUsd":0.58}', "money:backfill 10"]);
    expect(records()[0]).toMatchObject({
      phase: "start",
      detail: { fakeModel: "dev-fake-priced-1", capUsd: 0.58, relationsQueued: 10 }
    });
    // The window as a whole expects nothing: its two stages do.
    expect(records()[0]!.expect).toBeUndefined();
  });

  it("expects the 80% item once the budget pauses, presses continue ten minutes later, expects the cap after it", async () => {
    const { runner, calls, records, advance, setBudget } = harness({});
    const window = moneyWindow();
    await runner.start(window);
    await runner.tick();
    expect(records()).toHaveLength(1);
    advance(20 * minute);
    setBudget("paused");
    await runner.tick();
    expect(records()[1]).toMatchObject({
      id: "w146#80",
      phase: "start",
      expect: { class: "cap", reason: "money_80" }
    });
    advance(9 * minute);
    await runner.tick();
    expect(calls).not.toContain("money:continue");
    advance(2 * minute);
    await runner.tick();
    expect(calls).toContain("money:continue");
    // The fake's budget then reaches its cap: the second stage.
    await runner.tick();
    expect(records().map((entry) => `${entry.id}:${entry.phase}`)).toEqual([
      "w146:start",
      "w146#80:start",
      "w146#80:end",
      "w146#100:start"
    ]);
    expect(records()[3]!.expect).toEqual({ class: "cap", reason: "money_100" });
    advance(6 * 60 * minute);
    await runner.end(window);
    expect(calls.slice(-2)).toEqual(["money:restore", 'controls:{"monthlyCapUsd":5}']);
    expect(records().at(-2)).toMatchObject({ id: "w146#100", phase: "end" });
    expect(records().at(-1)).toMatchObject({
      id: "w146",
      phase: "end",
      detail: { reached80: true, stage: "exhausted" }
    });
  });

  it("caps the month at eight of the product's own attempt estimates when the plan states none", async () => {
    const { runner, calls, records } = harness({});
    await runner.start(
      spec({
        id: "w146",
        kind: "money",
        durationMinutes: 360,
        params: { attempts: 8, backfillRelations: 10, attemptInputBytes: 3_000 }
      })
    );
    // 0.5 spent + 8 x (4,024 input tokens at US$1/M + 16,384 output tokens at US$4/M).
    const cap = Math.round((0.5 + 8 * ((3_000 + 1_024 + 16_384 * 4) / 1_000_000)) * 1e6) / 1e6;
    expect(calls[1]).toBe(`controls:${JSON.stringify({ monthlyCapUsd: cap })}`);
    expect(records()[0]!.detail).toMatchObject({ capUsd: cap });
  });

  it("says so when the budget never reached its 80% in the window", async () => {
    const { runner, records, advance } = harness({});
    const window = moneyWindow();
    await runner.start(window);
    await runner.tick();
    advance(6 * 60 * minute);
    await runner.end(window);
    expect(records().at(-1)).toMatchObject({
      phase: "end",
      detail: { reached80: false, stage: "filling" }
    });
    expect(records().some((entry) => entry.expect)).toBe(false);
  });

  it("records a failed start when the harness has no priced fake", async () => {
    const { runner, records } = harness(null);
    await runner.start(moneyWindow());
    expect(records()[0]!.detail).toMatchObject({
      error: expect.stringContaining("priced loopback fake")
    });
  });
});

describe("the work a window brings of its own", () => {
  // Gate S of 10-25: the status names a refused connection, a missing decider or a model check only
  // for work they affect, and three windows ended with none for it to name.
  it("queues the backfill of a provider window at once, after the fault is in place, and says how many", async () => {
    const { runner, calls, records } = harness();
    await runner.start(spec({ kind: "refused", params: { backfillRelations: 3 } }));
    expect(calls).toEqual(["lane:start w1 refused 1800000", "work:backfill 3 due 0"]);
    expect(records()[0]!.detail).toMatchObject({ relationsQueued: 3 });
    // The expectation still opens only once a request met the fault.
    expect(records()[0]!.expect).toBeUndefined();
  });

  it("edits the notes of a missing-decider window after the ranker is invalidated, so their match meets no decider", async () => {
    const { runner, calls, records } = harness();
    await runner.start(
      spec({
        kind: "ranker_invalid",
        expect: { class: "no_model", reason: "no_decider" },
        params: { noteEdits: 2 }
      })
    );
    expect(calls).toEqual(["hook:ranker-invalid", "work:edit 2"]);
    expect(records()[0]).toMatchObject({
      expect: { class: "no_model", reason: "no_decider" },
      detail: { notesEdited: 2 }
    });
  });

  it("queues a model-check window's backfill due later, by the minutes the plan states", async () => {
    const { runner, calls, records } = harness();
    await runner.start(
      spec({
        kind: "embedder_verifying",
        params: { backfillRelations: 4, backfillDelayMinutes: 6 }
      })
    );
    expect(calls).toEqual(["hook:embedder-verifying", `work:backfill 4 due ${6 * minute}`]);
    expect(records()[0]!.detail).toMatchObject({ relationsQueued: 4 });
  });

  it("brings nothing when the plan states nothing, and leaves the cap and the money windows to their own queue", async () => {
    const { runner, calls } = harness({});
    await runner.start(spec({ kind: "refused" }));
    await runner.start(
      spec({ id: "w2", kind: "codex_daily_cap", params: { extraCalls: 2, backfillRelations: 6 } })
    );
    // The cap window's six go through its own port, once.
    expect(calls.filter((call) => call.startsWith("work:"))).toEqual([]);
    expect(calls.filter((call) => call.includes("backfill"))).toEqual(["dailyCap:backfill 6"]);
  });

  it("records a failed start, not a silent one, when the plan asks for work the harness cannot queue", async () => {
    const { runner, records } = harness(null, false);
    await runner.start(spec({ kind: "refused", params: { backfillRelations: 3 } }));
    expect(records()[0]!.detail).toMatchObject({
      error: expect.stringContaining("needs a way to queue it")
    });
  });
});
