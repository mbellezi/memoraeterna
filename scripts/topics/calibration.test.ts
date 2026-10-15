import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultTopicTreeConfig } from "@app/domain/topic-tree";

import {
  chooseStabilityPoint,
  compareEligible,
  configForPoint,
  gridPoints,
  pointId,
  pointOfConfig,
  readCalibrationRows,
  renderCalibrationMarkdown,
  stabilityGrid,
  summarizePoints
} from "./calibration.js";
import type { CalibrationRow, StabilityPoint } from "./calibration.js";
import type { ArrivalOrder } from "./datasets.js";

const seeds = [7, 8];
const orders: ArrivalOrder[] = ["chronological", "shuffled"];
const expected = { seeds, orders };

const point = (churnWeight: number, dailyMovedShare = 0.02): StabilityPoint => ({
  churnWeight,
  dailyMovedShare,
  cooldownInserts: 25,
  misParentMargin: 0.05
});

function rowsOf(
  values: StabilityPoint,
  fields: Partial<CalibrationRow> = {},
  only: { seed?: number; order?: ArrivalOrder } = {}
): CalibrationRow[] {
  return seeds.flatMap((seed) =>
    orders
      .filter(
        (order) =>
          (only.seed === undefined || only.seed === seed) && (only.order ?? order) === order
      )
      .map((order) => ({
        point: pointId(values),
        seed,
        order,
        configHash: "a".repeat(64),
        engine: "t07-t08/gate-baseline",
        gate: "baseline",
        maxChurn: 0.02,
        medianChurn: 0.015,
        depthMean: 3.5,
        fanOutInTarget: 0.8,
        leafInRange: 0.95,
        reachability: 1,
        hardViolations: 0,
        operations: 100,
        proposals: 3,
        ...fields
      }))
  );
}

describe("the grid", () => {
  it("has 60 distinct points with today's start values first", () => {
    const points = gridPoints();
    expect(points).toHaveLength(60);
    expect(new Set(points.map(pointId)).size).toBe(60);
    expect(points[0]).toEqual({
      churnWeight: 1,
      dailyMovedShare: 0.02,
      cooldownInserts: 25,
      misParentMargin: 0.05
    });
    for (const list of Object.values(stabilityGrid)) expect(list.length).toBeGreaterThan(1);
  });

  it("maps a point onto a valid configuration and back", () => {
    const values = {
      churnWeight: 3,
      dailyMovedShare: 0.005,
      cooldownInserts: 931,
      misParentMargin: 0.1
    };
    const config = configForPoint(defaultTopicTreeConfig, values);
    expect(pointOfConfig(config)).toEqual(values);
    expect(config.leaf).toEqual(defaultTopicTreeConfig.leaf);
    expect(pointId(values)).toBe("l3-m0.005-c931-h0.1");
  });
});

describe("the selection rule", () => {
  it("keeps only points whose every run is within the bar with E1 holding", () => {
    const ok = point(3);
    const churny = point(1);
    const broken = point(2);
    const partial = point(4);
    const rows = [
      ...rowsOf(ok),
      ...rowsOf(churny, { maxChurn: 0.031 }, { seed: 8, order: "shuffled" }),
      ...rowsOf(churny, {}, { seed: 7 }),
      ...rowsOf(churny, {}, { seed: 8, order: "chronological" }),
      ...rowsOf(broken, { hardViolations: 1 }, { seed: 7, order: "chronological" }),
      ...rowsOf(broken, {}, { seed: 7, order: "shuffled" }),
      ...rowsOf(broken, {}, { seed: 8 }),
      ...rowsOf(partial, {}, { seed: 7 })
    ];
    const summaries = summarizePoints(rows, [ok, churny, broken, partial], expected);
    const byId = new Map(summaries.map((summary) => [summary.point, summary]));
    expect(byId.get(pointId(ok))?.eligible).toBe(true);
    expect(byId.get(pointId(churny))).toMatchObject({ eligible: false, worstMaxChurn: 0.031 });
    expect(byId.get(pointId(broken))).toMatchObject({ eligible: false, e1Failures: 1 });
    expect(byId.get(pointId(partial))).toMatchObject({ eligible: false, complete: false, runs: 2 });
    const choice = chooseStabilityPoint(summaries, expected);
    expect(choice.chosen?.point).toBe(pointId(ok));
    expect(choice.ranking[0]?.point).toBe(pointId(ok));
  });

  it("ranks eligible points by fan-out share, then depth, then operations", () => {
    const a = point(1);
    const b = point(2);
    const c = point(3);
    const d = point(4);
    const rows = [
      ...rowsOf(a, { fanOutInTarget: 0.8, depthMean: 3.6, operations: 50 }),
      // 0.0004 of fan-out is below the rule's resolution: depth decides between b and a.
      ...rowsOf(b, { fanOutInTarget: 0.8004, depthMean: 3.5, operations: 90 }),
      ...rowsOf(c, { fanOutInTarget: 0.79, depthMean: 3.0, operations: 10 }),
      ...rowsOf(d, { fanOutInTarget: 0.8, depthMean: 3.5, operations: 80 })
    ];
    const summaries = summarizePoints(rows, [a, b, c, d], expected);
    const ranked = [...summaries].sort(compareEligible).map((summary) => summary.point);
    expect(ranked).toEqual([pointId(d), pointId(b), pointId(a), pointId(c)]);
    expect(chooseStabilityPoint(summaries, expected).chosen?.point).toBe(pointId(d));
  });

  it("chooses nothing without an eligible point and names the closest one", () => {
    const a = point(1);
    const b = point(2);
    const rows = [...rowsOf(a, { maxChurn: 0.05 }), ...rowsOf(b, { maxChurn: 0.035 })];
    const choice = chooseStabilityPoint(summarizePoints(rows, [a, b], expected), expected);
    expect(choice.chosen).toBeNull();
    expect(choice.closest?.point).toBe(pointId(b));
    const markdown = renderCalibrationMarkdown(choice, {
      dataset: "corpus-notitle",
      engine: "t07-t08/gate-baseline",
      gate: "baseline",
      createdAt: "2026-10-15T00:00:00.000Z"
    });
    expect(markdown).toContain(`No point is eligible; the closest is ${pointId(b)}`);
    expect(markdown).toContain("| l2-m0.02-c25-h0.05 | 2 | 0.02 | 25 | 0.05 | 4 | 3.50% |");
  });
});

describe("calibration rows on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "calibration-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads every rows file, the last row of a run winning", async () => {
    const [first, second] = rowsOf(point(1), {}, { seed: 7 });
    await appendFile(
      join(dir, "calibration-rows-7-chronological.jsonl"),
      `${JSON.stringify(first)}\n`
    );
    await appendFile(
      join(dir, "calibration-rows-7-chronological.jsonl"),
      `${JSON.stringify({ ...first, maxChurn: 0.01 })}\n\n`
    );
    await appendFile(join(dir, "calibration-rows-7-shuffled.jsonl"), `${JSON.stringify(second)}\n`);
    await appendFile(join(dir, "other.jsonl"), "not json\n");
    const rows = await readCalibrationRows(dir);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.order === "chronological")?.maxChurn).toBe(0.01);
  });
});
