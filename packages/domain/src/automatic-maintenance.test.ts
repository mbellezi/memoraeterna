import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  AutomaticMaintenanceCommandSchema,
  automaticRoutinePresets,
  automaticNext,
  automaticClock,
  AutomaticMaintenanceCheckpointSchema,
  AutomaticRoutinePolicySchema
} from "./automatic-maintenance.js";
const defaults = automaticRoutinePresets(randomUUID(), randomUUID(), "scope", "Europe/London");
describe("automatic maintenance clock and calendar", () => {
  it("publishes the four calibrated defaults with one shared monthly authority and unavailable cost", () => {
    expect(defaults.map((p) => [p.kind, p.startWindowMs / 60000, p.executionMs / 60000])).toEqual([
      ["incremental", 15, 10],
      ["daily", 360, 20],
      ["weekly", 1440, 45],
      ["monthly", 4320, 90]
    ]);
    expect(new Set(defaults.map((p) => JSON.stringify(p.monthAllowance))).size).toBe(1);
    expect(
      defaults.every((p) => p.allowance.spend === null && p.monthAllowance.spend === null)
    ).toBe(true);
  });
  it("starts new profiles with the weekly and monthly routines off and no operating-system idle gate", () => {
    expect(defaults.map((p) => [p.kind, p.enabled, p.idleSeconds])).toEqual([
      ["incremental", true, 0],
      ["daily", true, 0],
      ["weekly", false, 0],
      ["monthly", false, 0]
    ]);
  });
  it("leaves stored routines alone: a stored policy keeps its own idle gate and switches", () => {
    const stored = structuredClone(defaults[2]!) as Record<string, unknown>;
    // A routine saved before the defaults changed carries its own values, or none for the gate.
    stored.enabled = true;
    stored.idleSeconds = 120;
    expect(AutomaticRoutinePolicySchema.parse(stored)).toMatchObject({
      enabled: true,
      idleSeconds: 120
    });
    delete stored.idleSeconds;
    expect(AutomaticRoutinePolicySchema.parse(stored).idleSeconds).toBe(60);
  });
  it("debounces incremental work and computes daily, Sunday and first-of-month local instants", () => {
    const after = new Date("2026-09-12T00:00:00Z");
    expect(defaults.map((p) => automaticNext(p, after))).toEqual([
      "2026-09-12T00:02:00.000Z",
      "2026-09-12T01:00:00.000Z",
      "2026-09-13T02:00:00.000Z",
      "2026-10-01T03:00:00.000Z"
    ]);
  });
  it("clamps month days and runs gaps/folds once", () => {
    const monthly = structuredClone(defaults[3]!);
    monthly.cadence.day = 31;
    expect(automaticNext(monthly, new Date("2026-02-01T05:00:00Z"))).toBe(
      "2026-02-28T04:00:00.000Z"
    );
    const daily = structuredClone(defaults[1]!);
    daily.cadence.hour = 1;
    daily.cadence.minute = 30;
    expect(automaticNext(daily, new Date("2026-03-29T00:00:00Z"))).toBe("2026-03-29T01:00:00.000Z");
    const fold = automaticNext(daily, new Date("2026-10-25T00:00:00Z"));
    expect(fold).toBe("2026-10-25T00:30:00.000Z");
    expect(automaticNext(daily, new Date(fold))).toBe("2026-10-26T01:30:00.000Z");
  });
  it("separates eligible, idle, closed and backward-clock time without inventing execution", () => {
    let c = AutomaticMaintenanceCheckpointSchema.parse({ lastTickAt: "2026-09-12T00:00:00Z" });
    c = automaticClock(c, new Date("2026-09-12T00:00:10Z"), true, null);
    expect(c.eligibleMs).toBe(10000);
    c = automaticClock(c, new Date("2026-09-12T00:00:20Z"), false, "maintenance.errors.idle");
    expect(c.deferredMs).toBe(10000);
    c = automaticClock(c, new Date("2026-09-19T00:00:20Z"), true, null);
    expect(c.eligibleMs).toBe(10000);
    expect(c.closedMs).toBe(604800000);
    c = automaticClock(c, new Date("2026-09-18T00:00:20Z"), true, null);
    expect(c.eligibleMs).toBe(10000);
    expect(c.executionMs).toBe(0);
  });
  it("rejects timezone and group-limit escalation", () => {
    expect(
      AutomaticRoutinePolicySchema.safeParse({ ...defaults[0], groupMs: 600001 }).success
    ).toBe(false);
    expect(
      AutomaticRoutinePolicySchema.safeParse({
        ...defaults[0],
        cadence: { ...defaults[0]!.cadence, timezone: "invalid" }
      }).success
    ).toBe(false);
  });
});

it("validates monthly edits before crossing IPC, including revision coverage and numeric bounds", () => {
  const input = {
    command: "automaticBudgetSave",
    policyId: randomUUID(),
    expectedSchedules: [{ id: randomUUID(), revision: 1 }],
    allowance: { calls: 250, tokens: 4000000 }
  };
  expect(AutomaticMaintenanceCommandSchema.safeParse(input).success).toBe(true);
  for (const allowance of [
    { calls: -1, tokens: 1 },
    { calls: 1.5, tokens: 10 },
    { calls: 1001, tokens: 10 },
    { calls: 1, tokens: 10000001 },
    { calls: 1, tokens: 1, spend: 100 }
  ])
    expect(AutomaticMaintenanceCommandSchema.safeParse({ ...input, allowance }).success).toBe(
      false
    );
  expect(
    AutomaticMaintenanceCommandSchema.safeParse({ ...input, expectedSchedules: [] }).success
  ).toBe(false);
  expect(
    AutomaticMaintenanceCommandSchema.safeParse({
      ...input,
      expectedSchedules: [input.expectedSchedules[0], input.expectedSchedules[0]]
    }).success
  ).toBe(false);
});
