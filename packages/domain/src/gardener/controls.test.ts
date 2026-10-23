import { describe, expect, it } from "vitest";

import { defaultGardenerConfig, gardenerConfigWith } from "../gardener-config.js";
import { topicTreePresets } from "../topic-tree/config.js";
import {
  KnowledgeControlsUpdateSchema,
  TreeShapeSchema,
  applyKnowledgeControlsUpdate,
  changedKnowledgeControls,
  defaultKnowledgeControls,
  knowledgeControlsSettingKey,
  readKnowledgeControls
} from "./controls.js";

describe("Knowledge controls (D13)", () => {
  it("defaults to Auto, a US$5 monthly cap, not paused, Balanced, no idle or AC hold (Q3)", () => {
    expect(knowledgeControlsSettingKey).toBe("knowledge.controls.v1");
    expect(defaultKnowledgeControls).toEqual({
      autonomy: "auto",
      monthlyCapUsd: 5,
      paused: false,
      treeShape: "balanced",
      onlyIdle: false,
      onlyOnAc: false
    });
    expect(TreeShapeSchema.options).toEqual([...topicTreePresets]);
  });

  it("reads a stored value field by field: a damaged field never resets the others", () => {
    expect(readKnowledgeControls(null)).toEqual(defaultKnowledgeControls);
    expect(readKnowledgeControls([1, 2])).toEqual(defaultKnowledgeControls);
    expect(
      readKnowledgeControls({
        autonomy: "sometimes",
        monthlyCapUsd: -3,
        paused: true,
        treeShape: "deep",
        onlyIdle: "yes",
        onlyOnAc: true,
        retired: 1
      })
    ).toEqual({
      autonomy: "auto",
      monthlyCapUsd: 5,
      paused: true,
      treeShape: "deep",
      onlyIdle: false,
      onlyOnAc: true
    });
  });

  it("applies a validated change and names what changed", () => {
    const next = applyKnowledgeControlsUpdate(defaultKnowledgeControls, {
      autonomy: "off",
      paused: true
    });
    expect(next).toMatchObject({ autonomy: "off", paused: true, monthlyCapUsd: 5 });
    expect(changedKnowledgeControls(defaultKnowledgeControls, next)).toEqual([
      "autonomy",
      "paused"
    ]);
    expect(() => applyKnowledgeControlsUpdate(defaultKnowledgeControls, { other: 1 })).toThrow();
    expect(KnowledgeControlsUpdateSchema.safeParse({ monthlyCapUsd: 1_000_000 }).success).toBe(
      false
    );
    expect(KnowledgeControlsUpdateSchema.safeParse({ monthlyCapUsd: 0 }).success).toBe(true);
  });
});

describe("gardener configuration (D15, D36)", () => {
  it("holds the start values of the duty cycle, the idle thresholds and the blocker clocks", () => {
    expect(defaultGardenerConfig).toEqual({
      controls: { defaultMonthlyCapUsd: 5, monthlyCapMaxUsd: 1_000 },
      power: {
        activeIdleBelowMs: 60_000,
        onlyIdleAfterMs: 300_000,
        pollMs: 10_000,
        devOverrideBlockMs: 600_000
      },
      dutyCycle: { active: 0.5, idle: 1 },
      blockers: { tickMs: 30_000, recheckMs: 300_000, admissionBlockTtlMs: 3_600_000 }
    });
    expect(Object.isFrozen(defaultGardenerConfig.dutyCycle)).toBe(true);
  });

  it("refuses a duty cycle of zero, an active share above the idle one and inverted idle bounds", () => {
    expect(() => gardenerConfigWith({ dutyCycle: { active: 0 } })).toThrow();
    expect(() => gardenerConfigWith({ dutyCycle: { active: 1, idle: 0.5 } })).toThrow();
    expect(() => gardenerConfigWith({ power: { onlyIdleAfterMs: 30_000 } })).toThrow();
    expect(gardenerConfigWith({ dutyCycle: { active: 0.25 } }).dutyCycle).toEqual({
      active: 0.25,
      idle: 1
    });
  });
});
