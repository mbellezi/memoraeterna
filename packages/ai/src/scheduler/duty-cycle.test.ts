import { describe, expect, it, vi } from "vitest";

import { resolveAiLaneRuntimeConfig } from "../runtime-config.js";
import { dutyCycleWaitMs } from "./duty-cycle.js";
import { createAiScheduler, type AiSchedulerHooks } from "./scheduler.js";
import { fakeSchedulerClock, flush } from "./test-clock.js";
import type {
  AiBudgetClass,
  AiPriority,
  AiScheduler,
  LaneAdmission,
  LaneKey,
  LanePermit,
  LaneTicket
} from "./types.js";

function setup(hooks: AiSchedulerHooks = {}) {
  const time = fakeSchedulerClock();
  const scheduler = createAiScheduler(
    resolveAiLaneRuntimeConfig({}, { environment: {} }),
    time.clock,
    hooks
  );
  return { scheduler, ...time };
}

function ticket(
  budgetClass: AiBudgetClass | undefined,
  priority: AiPriority = "P2",
  lane: LaneKey = "local"
): LaneTicket {
  return {
    lane,
    priority,
    workloadClass: "decide",
    label: `${budgetClass ?? "unstated"} ${priority}`,
    ...(budgetClass ? { budgetClass } : {}),
    ...(lane.startsWith("remote:") ? { remoteKind: "api-key" as const } : {})
  };
}

/** A call the test ends by hand; `startedAt` is the scheduler time it got its slot. */
function controlled(
  scheduler: AiScheduler,
  t: LaneTicket,
  name: string,
  log: string[],
  now: () => number
) {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<LanePermit>();
  let startedAt: number | null = null;
  const result = scheduler.run(t, async (permit) => {
    log.push(name);
    startedAt = now();
    started.resolve(permit);
    await gate.promise;
    return name;
  });
  return {
    result,
    started: started.promise,
    startedAt: () => startedAt,
    finish: () => gate.resolve()
  };
}

describe("duty cycle of background calls (F4 D15)", () => {
  it("waits d × (1/duty − 1) after a background call of duration d", () => {
    expect(dutyCycleWaitMs(1_000, 0.5)).toBe(1_000);
    expect(dutyCycleWaitMs(1_000, 0.25)).toBe(3_000);
    expect(dutyCycleWaitMs(1_000, 1)).toBe(0);
    for (const broken of [0, -1, Number.NaN, 2]) expect(dutyCycleWaitMs(1_000, broken)).toBe(0);
  });

  it("holds the next background call while the user is active, and only that one", async () => {
    const duty = { value: 0.5 };
    const { scheduler, advance, now } = setup({ backgroundDutyCycle: () => duty.value });
    const log: string[] = [];
    const first = controlled(scheduler, ticket("background", "P3"), "first", log, now);
    await first.started;
    await advance(2_000);
    const background = controlled(scheduler, ticket("background", "P1"), "background", log, now);
    const unstated = controlled(scheduler, ticket(undefined, "P3"), "unstated", log, now);
    first.finish();
    await first.result;
    // The background call waits 2 s (its predecessor's duration at 50%); the other call starts now.
    await flush();
    expect(log).toEqual(["first", "unstated"]);
    unstated.finish();
    await unstated.result;
    await advance(1_999);
    expect(log).toEqual(["first", "unstated"]);
    await advance(1);
    expect(log).toEqual(["first", "unstated", "background"]);
    expect(background.startedAt()).toBe(4_000);
    background.finish();
    await background.result;
  });

  it("never delays user or interactive calls, a P2 import included, whatever their priority", async () => {
    const { scheduler, advance, now } = setup({ backgroundDutyCycle: () => 0.1 });
    const log: string[] = [];
    const first = controlled(scheduler, ticket("background", "P2"), "background", log, now);
    await first.started;
    await advance(5_000);
    first.finish();
    await first.result;
    // A 90% hold of 45 s follows; user and interactive calls of every priority pass it.
    for (const [index, [budgetClass, priority]] of (
      [
        ["user", "P2"],
        ["user", "P3"],
        ["interactive", "P0"],
        ["user", "P1"]
      ] as const
    ).entries()) {
      const call = controlled(scheduler, ticket(budgetClass, priority), `call-${index}`, log, now);
      await call.started;
      expect(call.startedAt()).toBe(5_000);
      call.finish();
      await call.result;
    }
    const held = controlled(scheduler, ticket("background", "P0"), "held", log, now);
    await flush();
    expect(held.startedAt()).toBeNull();
    await advance(45_000);
    expect(held.startedAt()).toBe(50_000);
    held.finish();
    await held.result;
  });

  it("ends a hold at once when the user goes idle (duty 1) and the scheduler is refreshed", async () => {
    const duty = { value: 0.5 };
    const { scheduler, advance, now } = setup({ backgroundDutyCycle: () => duty.value });
    const log: string[] = [];
    const first = controlled(scheduler, ticket("background"), "first", log, now);
    await first.started;
    await advance(10_000);
    first.finish();
    await first.result;
    const next = controlled(scheduler, ticket("background"), "next", log, now);
    await advance(1_000);
    expect(next.startedAt()).toBeNull();
    duty.value = 1;
    scheduler.refresh();
    await flush();
    expect(next.startedAt()).toBe(11_000);
    next.finish();
    await next.result;
  });

  it("holds nothing without a duty cycle, at duty 1, or on a remote lane", async () => {
    for (const hooks of [{}, { backgroundDutyCycle: () => 1 }] as AiSchedulerHooks[]) {
      const { scheduler, advance, now } = setup(hooks);
      const log: string[] = [];
      const first = controlled(scheduler, ticket("background"), "first", log, now);
      await first.started;
      await advance(3_000);
      first.finish();
      await first.result;
      const next = controlled(scheduler, ticket("background"), "next", log, now);
      await next.started;
      expect(next.startedAt()).toBe(3_000);
      next.finish();
      await next.result;
    }
    const { scheduler, advance, now } = setup({ backgroundDutyCycle: () => 0.5 });
    const log: string[] = [];
    const first = controlled(scheduler, ticket("background", "P2", "remote:a"), "a", log, now);
    await first.started;
    await advance(3_000);
    first.finish();
    await first.result;
    const next = controlled(scheduler, ticket("background", "P2", "remote:a"), "b", log, now);
    await next.started;
    expect(next.startedAt()).toBe(3_000);
    next.finish();
    await next.result;
  });

  it("does not count a backoff off the lane as background time", async () => {
    const { scheduler, advance, now } = setup({ backgroundDutyCycle: () => 0.5 });
    const log: string[] = [];
    const first = scheduler.run(ticket("background"), async (permit) => {
      await advance(1_000);
      // A 5 s wait off the lane (a retry backoff) is not the call's share of the lane.
      await permit.releaseDuring(() => advance(5_000));
      await advance(1_000);
      log.push("first");
    });
    await advance(0);
    await first;
    const next = controlled(scheduler, ticket("background"), "next", log, now);
    await advance(1_999);
    expect(next.startedAt()).toBeNull();
    await advance(1);
    expect(next.startedAt()).toBe(9_000);
    next.finish();
    await next.result;
  });
});

describe("admission hook (F4 D7)", () => {
  it("rejects a refused entry before it waits, without taking a slot or a probe", async () => {
    const seen: LaneAdmission[] = [];
    const refusal = new Error("held");
    const { scheduler } = setup({
      admit: (entry) => {
        seen.push(entry);
        return entry.budgetClass === "background" ? refusal : undefined;
      }
    });
    const execute = vi.fn(async () => "ran");
    await expect(
      scheduler.run({ ...ticket("background", "P3"), jobId: "job-1" }, execute)
    ).rejects.toBe(refusal);
    expect(execute).not.toHaveBeenCalled();
    expect(seen[0]).toEqual({
      lane: "local",
      priority: "P3",
      workloadClass: "decide",
      budgetClass: "background",
      label: "background P3",
      jobId: "job-1"
    });
    await expect(scheduler.run(ticket("user"), execute)).resolves.toBe("ran");
    expect(scheduler.snapshot().find((lane) => lane.lane === "local")?.running).toBe(0);
  });

  it("rejects with what a throwing hook threw, and admits on null", async () => {
    const thrown = new Error("gate bug");
    const throwing = setup({
      admit: () => {
        throw thrown;
      }
    });
    await expect(throwing.scheduler.run(ticket("user"), async () => "ran")).rejects.toBe(thrown);
    const admitting = setup({ admit: () => null });
    await expect(admitting.scheduler.run(ticket("background"), async () => "ran")).resolves.toBe(
      "ran"
    );
  });

  it("does not ask again for the re-wait of a running call between two attempts", async () => {
    const admit = vi.fn(() => undefined);
    const { scheduler, advance } = setup({ admit });
    const done = scheduler.run(ticket("background", "P2", "remote:a"), async (permit) => {
      await permit.releaseDuring(() => advance(1_000));
      return "retried";
    });
    await advance(0);
    await expect(done).resolves.toBe("retried");
    expect(admit).toHaveBeenCalledTimes(1);
  });
});
