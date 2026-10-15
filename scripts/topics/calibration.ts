// Calibration of REBALANCE's stability settings on the E3 weekly replay (spec section 9, the
// "lambda, cooldowns, budgets" row): a small grid over typed configuration values, replayed with
// the real engine on the calibration seeds only (7-12) in both arrival orders, and a selection
// rule fixed in code before any evaluation seed is replayed:
//
//   1. eligible: every run (each calibration seed, both orders) has a maximum weekly churn within
//      the E3 bar (3%), reachability 100% and 0 hard violations (E1);
//   2. among eligible points, the best E2: the highest median final fan-out 4-9 share (compared
//      at 0.1-point resolution), then the lowest median mean depth (0.01 resolution);
//   3. then the fewest operations applied over all runs; the point ID breaks a last tie.
//
// With no eligible point nothing is chosen, and the point with the lowest worst-case churn is
// reported as the closest one (gate A's "measured path").
//
// The grid's knobs are the stability settings that exist in typed configuration: lambda
// (`stability.churnWeight`), the daily move budget (`stability.dailyMovedShare`), the per-topic
// cooldown (`repair.cooldownInserts`; the engine's clock counts inserts, so days are inserts at
// the replay's arrival rate) and the re-parent hysteresis (`audit.misParentMargin`, the margin an
// uncle must beat the parent by; the size and fan-out hysteresis is the band model of
// quality.ts and has no separate number).
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { distribution, topicTreeConfigWith } from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import { arrivalOrders } from "./datasets.js";
import type { ArrivalOrder } from "./datasets.js";
import type { WeeklyReport } from "./report-data.js";

/** One combination of the stability settings the grid varies. */
export interface StabilityPoint {
  /** `stability.churnWeight` (lambda in dQ - lambda * churn > 0). */
  churnWeight: number;
  /** `stability.dailyMovedShare`: items a day's soft operations may re-path, as a share. */
  dailyMovedShare: number;
  /** `repair.cooldownInserts`: inserts a topic waits after a repair before a soft one. */
  cooldownInserts: number;
  /** `audit.misParentMargin`: how much closer an uncle must be before a re-parent. */
  misParentMargin: number;
}

export type StabilityGrid = { [K in keyof StabilityPoint]: readonly number[] };

/**
 * The registered grid (60 points), the start values first in every list. 931 inserts are one
 * simulated week of E3 arrivals on DS-C (5% of 18,632 rows); 25 is Spike B's cooldown.
 */
export const stabilityGrid: StabilityGrid = {
  churnWeight: [1, 2, 3, 4, 6],
  dailyMovedShare: [0.02, 0.005, 0.002],
  cooldownInserts: [25, 931],
  misParentMargin: [0.05, 0.1]
};

export function gridPoints(grid: StabilityGrid = stabilityGrid): StabilityPoint[] {
  const points: StabilityPoint[] = [];
  for (const churnWeight of grid.churnWeight) {
    for (const dailyMovedShare of grid.dailyMovedShare) {
      for (const cooldownInserts of grid.cooldownInserts) {
        for (const misParentMargin of grid.misParentMargin) {
          points.push({ churnWeight, dailyMovedShare, cooldownInserts, misParentMargin });
        }
      }
    }
  }
  return points;
}

/** A short stable name: `l2-m0.005-c931-h0.1`. */
export function pointId(point: StabilityPoint): string {
  return (
    `l${point.churnWeight}-m${point.dailyMovedShare}-c${point.cooldownInserts}` +
    `-h${point.misParentMargin}`
  );
}

export function configForPoint(base: TopicTreeConfig, point: StabilityPoint): TopicTreeConfig {
  return topicTreeConfigWith(
    {
      stability: { churnWeight: point.churnWeight, dailyMovedShare: point.dailyMovedShare },
      repair: { cooldownInserts: point.cooldownInserts },
      audit: { misParentMargin: point.misParentMargin }
    },
    base
  );
}

/** The point a configuration sits on (its values of the four knobs). */
export function pointOfConfig(config: TopicTreeConfig): StabilityPoint {
  return {
    churnWeight: config.stability.churnWeight,
    dailyMovedShare: config.stability.dailyMovedShare,
    cooldownInserts: config.repair.cooldownInserts,
    misParentMargin: config.audit.misParentMargin
  };
}

// ---------------------------------------------------------------------------
// Rows: one weekly replay of one point

export const CalibrationRowSchema = z
  .object({
    point: z.string().min(1),
    seed: z.number().int(),
    order: z.enum(arrivalOrders),
    configHash: z.string().length(64),
    engine: z.string(),
    gate: z.string(),
    maxChurn: z.number().min(0).max(1),
    medianChurn: z.number().min(0).max(1),
    depthMean: z.number().min(0),
    fanOutInTarget: z.number().min(0).max(1),
    leafInRange: z.number().min(0).max(1),
    reachability: z.number().min(0).max(1),
    hardViolations: z.number().int().min(0),
    operations: z.number().int().min(0),
    proposals: z.number().int().min(0)
  })
  .strict();
export type CalibrationRow = z.infer<typeof CalibrationRowSchema>;

export function calibrationRow(point: StabilityPoint, report: WeeklyReport): CalibrationRow {
  const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
  return {
    point: pointId(point),
    seed: report.seed,
    order: report.arrival as ArrivalOrder,
    configHash: report.configHash,
    engine: report.engine,
    gate: report.gate,
    maxChurn: report.maxChurn,
    medianChurn: report.medianChurn,
    depthMean: report.final.shape.depthMean,
    fanOutInTarget: report.final.shape.fanOutInTarget,
    leafInRange: report.final.shape.leafInRange,
    reachability: report.final.shape.reachability,
    hardViolations: report.final.shape.hardViolations,
    operations: sum(report.weeks.map((week) => sum(Object.values(week.operations)))),
    proposals: sum(report.weeks.map((week) => week.proposals ?? 0))
  };
}

/** Rows from every `calibration-rows-*.jsonl` in `dir` (the last row of a run wins). */
export async function readCalibrationRows(dir: string): Promise<CalibrationRow[]> {
  const files = (await readdir(dir))
    .filter((name) => name.startsWith("calibration-rows-") && name.endsWith(".jsonl"))
    .sort();
  const rows = new Map<string, CalibrationRow>();
  for (const name of files) {
    for (const line of (await readFile(join(dir, name), "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      const row = CalibrationRowSchema.parse(JSON.parse(line));
      rows.set(`${row.point}|${row.seed}|${row.order}`, row);
    }
  }
  return [...rows.values()];
}

// ---------------------------------------------------------------------------
// The selection rule

export interface PointSummary {
  point: string;
  values: StabilityPoint;
  configHash: string | null;
  runs: number;
  complete: boolean;
  /** Every run within the churn bar with E1 holding (rule step 1). */
  eligible: boolean;
  worstMaxChurn: number;
  medianMaxChurn: number;
  medianChurn: number;
  medianFanOut: number;
  medianDepth: number;
  medianLeafInRange: number;
  /** Runs that broke E1 (reachability below 100% or a hard violation). */
  e1Failures: number;
  operations: number;
  proposals: number;
}

export interface CalibrationChoice {
  bar: number;
  seeds: number[];
  orders: ArrivalOrder[];
  ranking: PointSummary[];
  chosen: PointSummary | null;
  /** The point with the lowest worst-case churn (the measured path when nothing is eligible). */
  closest: PointSummary | null;
}

const median = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : distribution(values).p50;
const at = (value: number, digits: number): number => Number(value.toFixed(digits));

export function summarizePoints(
  rows: readonly CalibrationRow[],
  points: readonly StabilityPoint[],
  expected: { seeds: readonly number[]; orders: readonly ArrivalOrder[] },
  bar = 0.03
): PointSummary[] {
  return points.map((values) => {
    const point = pointId(values);
    const mine = rows.filter(
      (row) =>
        row.point === point &&
        expected.seeds.includes(row.seed) &&
        expected.orders.includes(row.order)
    );
    const complete = expected.seeds.every((seed) =>
      expected.orders.every((order) => mine.some((row) => row.seed === seed && row.order === order))
    );
    const e1Failures = mine.filter((row) => row.reachability < 1 || row.hardViolations > 0).length;
    const maxima = mine.map((row) => row.maxChurn);
    return {
      point,
      values,
      configHash: mine[0]?.configHash ?? null,
      runs: mine.length,
      complete,
      eligible:
        complete && mine.length > 0 && e1Failures === 0 && maxima.every((value) => value <= bar),
      worstMaxChurn: maxima.length > 0 ? Math.max(...maxima) : Number.NaN,
      medianMaxChurn: median(maxima),
      medianChurn: median(mine.map((row) => row.medianChurn)),
      medianFanOut: median(mine.map((row) => row.fanOutInTarget)),
      medianDepth: median(mine.map((row) => row.depthMean)),
      medianLeafInRange: median(mine.map((row) => row.leafInRange)),
      e1Failures,
      operations: mine.reduce((total, row) => total + row.operations, 0),
      proposals: mine.reduce((total, row) => total + row.proposals, 0)
    };
  });
}

/** Rule steps 2 and 3 (see the file header): the eligible points, best first. */
export function compareEligible(a: PointSummary, b: PointSummary): number {
  return (
    at(b.medianFanOut, 3) - at(a.medianFanOut, 3) ||
    at(a.medianDepth, 2) - at(b.medianDepth, 2) ||
    a.operations - b.operations ||
    (a.point < b.point ? -1 : a.point > b.point ? 1 : 0)
  );
}

export function chooseStabilityPoint(
  summaries: readonly PointSummary[],
  expected: { seeds: readonly number[]; orders: readonly ArrivalOrder[] },
  bar = 0.03
): CalibrationChoice {
  const eligible = summaries.filter((summary) => summary.eligible).sort(compareEligible);
  const rest = summaries
    .filter((summary) => !summary.eligible)
    .sort(
      (a, b) =>
        Number(b.complete) - Number(a.complete) ||
        a.worstMaxChurn - b.worstMaxChurn ||
        (a.point < b.point ? -1 : 1)
    );
  const complete = summaries.filter((summary) => summary.complete && summary.runs > 0);
  const closest =
    [...complete].sort(
      (a, b) => a.worstMaxChurn - b.worstMaxChurn || (a.point < b.point ? -1 : 1)
    )[0] ?? null;
  return {
    bar,
    seeds: [...expected.seeds],
    orders: [...expected.orders],
    ranking: [...eligible, ...rest],
    chosen: eligible[0] ?? null,
    closest
  };
}

// ---------------------------------------------------------------------------
// Report

const pct = (value: number, digits = 2): string =>
  Number.isNaN(value) ? "-" : `${(value * 100).toFixed(digits)}%`;

export function renderCalibrationMarkdown(
  choice: CalibrationChoice,
  context: { dataset: string; engine: string; gate: string; createdAt: string }
): string {
  const header = [
    "Point",
    "lambda",
    "Moved/day",
    "Cooldown",
    "Re-parent margin",
    "Runs",
    "Worst max churn",
    "Median max churn",
    "Median fan-out 4-9",
    "Median depth",
    "Median leaves 3-30",
    "Ops",
    "Proposals",
    "Eligible"
  ];
  const rows = choice.ranking.map((summary) => [
    summary.point,
    summary.values.churnWeight,
    summary.values.dailyMovedShare,
    summary.values.cooldownInserts,
    summary.values.misParentMargin,
    summary.runs,
    pct(summary.worstMaxChurn),
    pct(summary.medianMaxChurn),
    pct(summary.medianFanOut, 1),
    Number.isNaN(summary.medianDepth) ? "-" : summary.medianDepth.toFixed(3),
    pct(summary.medianLeafInRange, 1),
    summary.operations,
    summary.proposals,
    summary.eligible ? "yes" : summary.complete ? "no" : "incomplete"
  ]);
  const line = (cells: readonly (string | number)[]): string => `| ${cells.join(" | ")} |`;
  const verdict = choice.chosen
    ? `Chosen: **${choice.chosen.point}** (config ${choice.chosen.configHash?.slice(0, 12) ?? "-"}).`
    : `No point is eligible; the closest is ${choice.closest?.point ?? "-"} ` +
      `(worst max churn ${pct(choice.closest?.worstMaxChurn ?? Number.NaN)}).`;
  return [
    `# Stability calibration on ${context.dataset}`,
    "",
    `Engine ${context.engine} (gate ${context.gate}), calibration seeds ${choice.seeds.join(", ")}, ` +
      `orders ${choice.orders.join(" and ")}, E3 bar ${pct(choice.bar, 1)}, ${context.createdAt}.`,
    "",
    "Rule (registered before any evaluation seed): every run within the bar with E1 holding; then " +
      "the highest median fan-out 4-9 share (0.1 point), the lowest median depth (0.01), the " +
      "fewest operations.",
    "",
    verdict,
    "",
    line(header),
    line(header.map(() => "---")),
    ...rows.map(line),
    ""
  ].join("\n");
}
