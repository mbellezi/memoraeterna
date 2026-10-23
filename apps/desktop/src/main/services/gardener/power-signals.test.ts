import { describe, expect, it, vi } from "vitest";

import {
  PowerSignals,
  devPowerBlocksKnob,
  parseDevPowerBlocks,
  powerSourceEvents,
  readDevPowerOverride,
  type PowerSnapshot,
  type PowerSource,
  type PowerSourceEvent
} from "./power-signals.js";

function fakeSource(idleSeconds = 0, onBattery = false) {
  const state = { idleSeconds, onBattery };
  const listeners = new Map<PowerSourceEvent, Set<() => void>>();
  const source: PowerSource = {
    getSystemIdleTime: () => state.idleSeconds,
    isOnBatteryPower: () => state.onBattery,
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener: (event, listener) => listeners.get(event)?.delete(listener)
  };
  const emit = (event: PowerSourceEvent) => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  return { state, source, listeners, emit };
}

function manualTimers() {
  const intervals: Array<() => void> = [];
  return {
    tick: () => intervals.forEach((callback) => callback()),
    timers: {
      setInterval: (callback: () => void) => intervals.push(callback),
      clearInterval: () => {
        intervals.length = 0;
      }
    }
  };
}

describe("power signals (D15)", () => {
  it("reads active below 60 s of idle time and the battery, with the duty cycle they imply", () => {
    const { state, source } = fakeSource(10, false);
    const signals = new PowerSignals({ source, isPackaged: true });
    expect(signals.snapshot()).toEqual({
      active: true,
      onBattery: false,
      idleMs: 10_000,
      overridden: false
    });
    expect(signals.dutyCycle()).toBe(0.5);
    state.idleSeconds = 60;
    state.onBattery = true;
    signals.poll();
    expect(signals.snapshot()).toMatchObject({ active: false, onBattery: true });
    expect(signals.dutyCycle()).toBe(1);
    expect(signals.idleLongEnough()).toBe(false);
    state.idleSeconds = 300;
    signals.poll();
    expect(signals.idleLongEnough()).toBe(true);
  });

  it("publishes when activity, the power source or the only-idle threshold moves, not otherwise", () => {
    const { state, source, emit } = fakeSource(0, false);
    const { tick, timers } = manualTimers();
    const signals = new PowerSignals({ source, isPackaged: true, timers });
    const heard: Array<[PowerSnapshot, PowerSnapshot]> = [];
    signals.subscribe((snapshot, previous) => heard.push([snapshot, previous]));
    signals.start();
    state.idleSeconds = 30;
    tick();
    expect(heard).toHaveLength(0);
    state.idleSeconds = 90;
    tick();
    expect(heard).toHaveLength(1);
    state.idleSeconds = 299;
    tick();
    expect(heard).toHaveLength(1);
    state.idleSeconds = 301;
    tick();
    expect(heard).toHaveLength(2);
    // An event reads the source at once.
    state.onBattery = true;
    emit("on-battery");
    expect(heard).toHaveLength(3);
    expect(heard[2]![0].onBattery).toBe(true);
    signals.stop();
    state.idleSeconds = 0;
    emit("user-did-become-active");
    tick();
    expect(heard).toHaveLength(3);
  });

  it("listens to every power monitor event while started, and to none after", () => {
    const { source, listeners } = fakeSource();
    const signals = new PowerSignals({ source, isPackaged: true, timers: manualTimers().timers });
    signals.start();
    for (const event of powerSourceEvents) expect(listeners.get(event)?.size).toBe(1);
    signals.stop();
    for (const event of powerSourceEvents) expect(listeners.get(event)?.size).toBe(0);
  });

  it("reads as idle and on AC without a power monitor (scripts)", () => {
    const signals = new PowerSignals({ source: null, isPackaged: false });
    expect(signals.snapshot()).toMatchObject({ active: false, onBattery: false });
    expect(signals.idleLongEnough()).toBe(true);
    expect(signals.dutyCycle()).toBe(1);
  });

  it("keeps the last reading when the source fails", () => {
    const { source } = fakeSource(0);
    const logger = { warn: vi.fn() };
    const signals = new PowerSignals({ source, isPackaged: true, logger });
    source.getSystemIdleTime = () => {
      throw new Error("unavailable");
    };
    expect(signals.poll()).toMatchObject({ active: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("DEV power override (soak knob only)", () => {
  it("parses one word per 10-minute block and refuses an unknown one", () => {
    expect(parseDevPowerBlocks(undefined)).toBeNull();
    expect(parseDevPowerBlocks(" ")).toBeNull();
    expect(parseDevPowerBlocks("active, idle,battery,battery-active,real")).toEqual([
      { active: true, onBattery: false },
      { active: false, onBattery: false },
      { active: false, onBattery: true },
      { active: true, onBattery: true },
      "real"
    ]);
    expect(() => parseDevPowerBlocks("active,sleepy")).toThrow(/sleepy/u);
  });

  it("is read from the environment of an unpackaged run only", () => {
    const env = { [devPowerBlocksKnob]: "active,idle" };
    expect(readDevPowerOverride(env, { isPackaged: true, now: 0 })).toBeNull();
    expect(readDevPowerOverride(env, { isPackaged: false, now: 5 })).toEqual({
      startedAt: 5,
      blocks: [
        { active: true, onBattery: false },
        { active: false, onBattery: false }
      ]
    });
  });

  it("alternates the blocks every 10 minutes, repeating, and lets `real` read the machine", () => {
    let now = 1_000_000;
    const { source } = fakeSource(0, false);
    const signals = new PowerSignals({
      source,
      isPackaged: false,
      now: () => now,
      override: {
        startedAt: now,
        blocks: [{ active: true, onBattery: false }, "real", { active: false, onBattery: true }]
      }
    });
    expect(signals.snapshot()).toMatchObject({ active: true, overridden: true, idleMs: 0 });
    now += 600_000;
    expect(signals.poll()).toMatchObject({ active: true, overridden: false });
    now += 600_000 + 60_000;
    // An idle block reads as idle for longer than only-idle asks, from the block's start.
    expect(signals.poll()).toMatchObject({
      active: false,
      onBattery: true,
      overridden: true,
      idleMs: 360_000
    });
    expect(signals.idleLongEnough()).toBe(true);
    now += 540_000;
    expect(signals.poll()).toMatchObject({ active: true, overridden: true });
  });

  it("is set at run time by the soak driver, and refused in a packaged build", () => {
    const { source } = fakeSource(500, false);
    const dev = new PowerSignals({ source, isPackaged: false, now: () => 0 });
    const heard = vi.fn();
    dev.subscribe(heard);
    dev.setDevOverride({ startedAt: 0, blocks: [{ active: true, onBattery: true }] });
    expect(dev.snapshot()).toMatchObject({ active: true, onBattery: true, overridden: true });
    expect(heard).toHaveBeenCalledTimes(1);
    dev.setDevOverride(null);
    expect(dev.snapshot()).toMatchObject({ active: false, overridden: false });
    const packaged = new PowerSignals({
      source,
      isPackaged: true,
      override: { startedAt: 0, blocks: [{ active: true, onBattery: true }] }
    });
    expect(packaged.snapshot().overridden).toBe(false);
    expect(() => packaged.setDevOverride(null)).toThrow("power_override_refused_packaged");
  });
});
