import { describe, expect, it, vi } from "vitest";

import { createBackgroundPolicy } from "./background-policy.js";
import { devPowerBlocksKnob } from "./power-signals.js";

describe("background policy wiring (T75)", () => {
  it("wires the power override, the gate, the duty cycle and the job policy together", async () => {
    const wake = vi.fn();
    const refreshLanes = vi.fn();
    const policy = createBackgroundPolicy({
      getPool: () => null,
      powerSource: null,
      isPackaged: false,
      env: { [devPowerBlocksKnob]: "battery-active" },
      wake,
      refreshLanes
    });
    expect(policy.power.snapshot()).toMatchObject({ active: true, onBattery: true });
    expect(policy.admission.backgroundDutyCycle?.()).toBe(0.5);
    expect(policy.jobs.heldKinds(["topic-place", "topic-name"]).size).toBe(0);
    expect(
      policy.admission.admit?.({
        lane: "local",
        priority: "P3",
        workloadClass: "write-fast",
        budgetClass: "background",
        label: "naming"
      })
    ).toBeUndefined();
    policy.start();
    policy.start();
    policy.power.setDevOverride(null);
    expect(refreshLanes).toHaveBeenCalledTimes(1);
    // Without a database nothing is read or written, and nothing throws.
    await expect(policy.jobs.regate()).resolves.toBeUndefined();
    policy.stop();
    policy.stop();
  });

  it("refuses an unknown DEV power block, and ignores the knob in a packaged build", () => {
    const options = {
      getPool: () => null,
      powerSource: null,
      env: { [devPowerBlocksKnob]: "asleep" },
      wake: () => undefined
    };
    expect(() => createBackgroundPolicy({ ...options, isPackaged: false })).toThrow(/asleep/u);
    expect(createBackgroundPolicy({ ...options, isPackaged: true }).power.snapshot()).toMatchObject(
      {
        overridden: false
      }
    );
  });
});
