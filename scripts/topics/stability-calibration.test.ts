import { describe, expect, it } from "vitest";

import { defaultTopicTreeConfig } from "@app/domain/topic-tree";

import {
  CalibrationRowSchema,
  chooseRenameDrift,
  configForGridPoint,
  confirmPoint,
  dailyCallCap,
  gateAPoint,
  gridPointId,
  gridSPoints,
  parseGridPointId,
  rankGrid,
  registeredGridBase,
  summarizeGrid
} from "./stability-calibration.js";
import type {
  E2Row,
  GrowthRow,
  StabilityCalibrationRow,
  WeeklyRow
} from "./stability-calibration.js";

function weekly(point: string, order: string, overrides: Partial<WeeklyRow> = {}): WeeklyRow {
  return {
    kind: "weekly",
    point,
    seed: 7,
    order,
    configHash: "h",
    maxChurn: 0.02,
    medianChurn: 0.01,
    fanOutInTarget: 0.75,
    depthMean: 3.4,
    leafInRange: 0.9,
    reachability: 1,
    hardViolations: 0,
    operations: 100,
    rebuilds: [],
    maxRenameRate: { "0.3": 0.05, "0.5": 0.01 },
    staleness: { "0.3": 0.1, "0.5": 0.2 },
    peakDayCalls: { "0.3": 4, "0.5": 2 },
    seconds: 1,
    ...overrides
  };
}

function e2(point: string, order: string, overrides: Partial<E2Row> = {}): E2Row {
  return {
    kind: "e2",
    point,
    seed: 7,
    order,
    configHash: "h",
    fanOutInTarget: 0.82,
    depthMean: 3.6,
    singleChildTopics: 0,
    reachability: 1,
    hardViolations: 0,
    seconds: 1,
    ...overrides
  };
}

function growth(point: string, dataset: string, calendar: string, purity: number): GrowthRow {
  return {
    kind: "growth",
    point,
    seed: 7,
    dataset,
    calendar,
    configHash: "h",
    leafPurity: purity,
    freshPurity: 0.8,
    leafNmi: 0.7,
    depth1Nmi: 0.6,
    leaves: 8,
    freshLeaves: 9,
    rebuilds: [],
    fixturePasses: dataset === "env-f" ? true : null,
    fixtureExpected: dataset === "env-f" ? 0.9 : null,
    fixtureForbidden: dataset === "env-f" ? 0.1 : null,
    renamed: { "0.3": 2 },
    peakDayCalls: { "0.3": 3 },
    reachability: 1,
    hardViolations: 0
  };
}

function complete(point: string, purity: number, weeklyOverrides: Partial<WeeklyRow> = {}) {
  return [
    weekly(point, "chronological", weeklyOverrides),
    weekly(point, "shuffled"),
    e2(point, "chronological"),
    e2(point, "items"),
    ...["env-g", "env-f"].flatMap((dataset) =>
      ["session", "daily"].map((calendar) => growth(point, dataset, calendar, purity))
    )
  ] satisfies StabilityCalibrationRow[];
}

describe("grid S", () => {
  it("registers 17 configurations, gate A's first, with round-tripping IDs", () => {
    const points = gridSPoints();
    expect(points).toHaveLength(17);
    expect(points[0]).toEqual(gateAPoint);
    expect(new Set(points.map(gridPointId)).size).toBe(17);
    for (const point of points) expect(parseGridPointId(gridPointId(point))).toEqual(point);
    expect(gridPointId(gateAPoint)).toBe("l6-f0-s0-c931");
    const config = configForGridPoint(defaultTopicTreeConfig, parseGridPointId("l4-f24-s0.05-c25"));
    expect(config.stability).toMatchObject({ churnWeight: 4, freshHours: 24 });
    expect(config.repair).toMatchObject({ cooldownShare: 0.05, cooldownInserts: 25 });
    expect(() => parseGridPointId("nope")).toThrow();
    // Grid F's variant of a point.
    const sideways = parseGridPointId("l6-f24-s0.05-c25-t");
    expect(sideways.sidewaysSplitLimit).toBe("targetMax");
    expect(gridPointId(sideways)).toBe("l6-f24-s0.05-c25-t");
    expect(configForGridPoint(defaultTopicTreeConfig, sideways).repair.sidewaysSplitLimit).toBe(
      "targetMax"
    );
    // Grid Q's variant.
    const drop = parseGridPointId("l4-f24-s0.083-c10-t-q0.02");
    expect(drop).toMatchObject({ sidewaysSplitLimit: "targetMax", qualityDrop: 0.02 });
    expect(gridPointId(drop)).toBe("l4-f24-s0.083-c10-t-q0.02");
    expect(configForGridPoint(defaultTopicTreeConfig, drop).rebuild.qualityDrop).toBe(0.02);
  });

  it("validates rows by kind", () => {
    for (const row of complete("l6-f0-s0-c931", 0.7)) {
      expect(CalibrationRowSchema.parse(row)).toEqual(row);
    }
    expect(CalibrationRowSchema.safeParse({ kind: "weekly" }).success).toBe(false);
  });

  it("ranks eligible points by growth purity, then NMI, fan-out and operations", () => {
    const rows = [
      ...complete("a", 0.7),
      ...complete("b", 0.8),
      // Better growth, but one weekly run breaks E3.
      ...complete("c", 0.9, { maxChurn: 0.031 }),
      // Incomplete.
      weekly("d", "chronological")
    ];
    const ranking = rankGrid(summarizeGrid(rows, ["a", "b", "c", "d"], 7));
    expect(ranking.map((summary) => [summary.point, summary.eligible])).toEqual([
      ["b", true],
      ["a", true],
      ["c", false],
      ["d", false]
    ]);
    expect(ranking[2]?.reasons).toEqual(["E3 chronological 3.1%"]);
    expect(ranking[3]?.reasons).toContain("incomplete");
    expect(ranking[0]).toMatchObject({ growthLeafPurity: 0.8, fixturePasses: 2, operations: 200 });
    // An E2 run below the floor makes a point ineligible.
    const low = summarizeGrid(
      [
        ...complete("e", 0.9).filter((row) => row.kind !== "e2"),
        e2("e", "a"),
        e2("e", "b", { fanOutInTarget: 0.74 })
      ],
      ["e"],
      7
    )[0];
    expect(low?.eligible).toBe(false);
  });

  it("confirms a point at the median seed of each order", () => {
    const rows: StabilityCalibrationRow[] = [];
    for (const [seed, churn] of [
      [7, 0.02],
      [8, 0.035],
      [9, 0.025]
    ] as const) {
      rows.push(
        weekly("p", "chronological", { seed, maxChurn: churn }),
        weekly("p", "shuffled", { seed, maxChurn: 0.01 }),
        e2("p", "chronological", { seed }),
        e2("p", "items", { seed, fanOutInTarget: 0.79 })
      );
    }
    const confirmation = confirmPoint(rows, "p", [7, 8, 9]);
    expect(confirmation.medianSeedMaxChurn).toEqual({ chronological: 0.025, shuffled: 0.01 });
    expect(confirmation.passes).toBe(true);
    rows.push(e2("p", "items", { seed: 9, fanOutInTarget: 0.7 }));
    // The later row of a run would replace the earlier one when read from disk; here the extra
    // row only lowers the minimum.
    expect(confirmPoint(rows, "p", [7, 8, 9]).passes).toBe(false);
  });
});

describe("the registered grid base", () => {
  it("keeps the start values of the knobs adopted after the grids were registered", () => {
    const base = registeredGridBase();
    expect(base.repair.sidewaysSplitLimit).toBe("max");
    expect(base.rebuild.qualityDrop).toBe(0.05);
    expect(base.bootstrap.modularityMin).toBe(0.1);
    expect(base.placement.ambiguityMargin).toBe(0.015);
    expect(base.stability).toEqual(defaultTopicTreeConfig.stability);
  });

  it("adds nothing to the adopted defaults at the adopted point (the final readings)", () => {
    const point = parseGridPointId("l4-f24-s0.083-c10-t-q0.03");
    expect(configForGridPoint(defaultTopicTreeConfig, point)).toEqual(defaultTopicTreeConfig);
  });
});

describe("rule R and the daily call cap", () => {
  it("takes the smallest renameDrift whose weekly rename rate stays within 2%", () => {
    const rows = [
      weekly("p", "a", { maxRenameRate: { "0.2": 0.3, "0.3": 0.03, "0.4": 0.01, "0.5": 0 } }),
      weekly("p", "b", { maxRenameRate: { "0.2": 0.2, "0.3": 0.015, "0.4": 0.019, "0.5": 0 } })
    ];
    expect(chooseRenameDrift(rows, [0.2, 0.3, 0.4, 0.5]).chosen).toBe(0.4);
    expect(chooseRenameDrift(rows, [0.2, 0.3]).chosen).toBe(0.3);
    expect(chooseRenameDrift(rows, [0.2, 0.3], 0.001).chosen).toBe(0.3);
  });

  it("is three times the busiest day, rounded up to tens", () => {
    expect(
      dailyCallCap([
        { label: "a", calls: 89 },
        { label: "b", calls: 8 }
      ])
    ).toBe(270);
    expect(dailyCallCap([{ label: "a", calls: 10 }])).toBe(30);
  });
});
