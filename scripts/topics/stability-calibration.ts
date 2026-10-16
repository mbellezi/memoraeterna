// T29b calibration core (spec section 9: lambda, cooldowns, budgets, freezeHours and rebuild
// triggers; renameDrift; D34's daily call cap): the registered grid, its rows and the adoption
// rules, as pure functions. `calibrate-stability.ts` runs them; the rules were written into the
// T29b evidence file before any grid run, and only calibration seeds (7-12) are replayed.
//
// Grid S varies the knobs this task added or owns: lambda (`stability.churnWeight`), fresh items
// (`stability.freshHours`) and the cooldown that scales with the library (`repair.cooldownShare`
// with the floor `repair.cooldownInserts`). The daily budgets and the re-parent margin keep gate
// A's values. Each point is replayed three ways:
//   weekly  the E3 protocol on DS-C (seed 7, chronological and shuffled), with simulated naming;
//   e2      the E2 growth protocol (80% build, 20% inserted with REBALANCE after each, settled;
//           seed 7, chronological and random items);
//   growth  ENV-G and ENV-F grown source by source in manifest order, `session` and `daily`
//           calendars, against a fresh build of the same items (growth-quality.ts).
import { z } from "zod";

import { defaultTopicTreeConfig, distribution, topicTreeConfigWith } from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

export interface StabilityGridPoint {
  /** `stability.churnWeight` (lambda). */
  churnWeight: number;
  /** `stability.freshHours`: 0 = no fresh items. */
  freshHours: number;
  /** `repair.cooldownShare`: the cooldown as a share of the placed items. */
  cooldownShare: number;
  /** `repair.cooldownInserts`: the cooldown's floor (inserts). */
  cooldownInserts: number;
  /** Grid F: `repair.sidewaysSplitLimit` (absent: the configured `max`). */
  sidewaysSplitLimit?: "max" | "targetMax";
  /** Grid Q: `rebuild.qualityDrop` (absent: the configured value). */
  qualityDrop?: number;
}

/** The registered grid S: 16 points plus gate A's configuration (the reference). */
export const stabilityGridS = {
  churnWeight: [4, 6],
  freshHours: [0, 24],
  cooldownShare: [0.05, 0.083],
  cooldownInserts: [10, 25]
} as const;

/** Gate A's stability values (a fixed 931-insert cooldown, no fresh items). */
export const gateAPoint: StabilityGridPoint = {
  churnWeight: 6,
  freshHours: 0,
  cooldownShare: 0,
  cooldownInserts: 931
};

export function gridSPoints(): StabilityGridPoint[] {
  const points: StabilityGridPoint[] = [gateAPoint];
  for (const churnWeight of stabilityGridS.churnWeight) {
    for (const freshHours of stabilityGridS.freshHours) {
      for (const cooldownShare of stabilityGridS.cooldownShare) {
        for (const cooldownInserts of stabilityGridS.cooldownInserts) {
          points.push({ churnWeight, freshHours, cooldownShare, cooldownInserts });
        }
      }
    }
  }
  return points;
}

/** `l6-f24-s0.05-c25`, with `-t` when leaves split sideways only below fanOut.targetMax. */
export function gridPointId(point: StabilityGridPoint): string {
  return (
    `l${point.churnWeight}-f${point.freshHours}-s${point.cooldownShare}` +
    `-c${point.cooldownInserts}${point.sidewaysSplitLimit === "targetMax" ? "-t" : ""}` +
    (point.qualityDrop === undefined ? "" : `-q${point.qualityDrop}`)
  );
}

export function parseGridPointId(id: string): StabilityGridPoint {
  const match = /^l([\d.]+)-f([\d.]+)-s([\d.]+)-c(\d+)(-t)?(?:-q([\d.]+))?$/u.exec(id);
  if (!match) throw new Error(`Not a grid point: ${id}`);
  return {
    churnWeight: Number(match[1]),
    freshHours: Number(match[2]),
    cooldownShare: Number(match[3]),
    cooldownInserts: Number(match[4]),
    ...(match[5] ? { sidewaysSplitLimit: "targetMax" as const } : {}),
    ...(match[6] ? { qualityDrop: Number(match[6]) } : {})
  };
}

/**
 * The base the grids were registered on: today's defaults with the start values of the knobs
 * T29b adopted later (sideways splits up to fanOut.max, a 0.05 quality drop, a 0.1 cold-start
 * modularity, T29a's 0.015 ambiguity margin), so a grid row replays as it ran. `--base defaults`
 * replays on today's defaults.
 */
export function registeredGridBase(
  config: TopicTreeConfig = defaultTopicTreeConfig
): TopicTreeConfig {
  return topicTreeConfigWith(
    {
      placement: { ambiguityMargin: 0.015 },
      repair: { sidewaysSplitLimit: "max" },
      rebuild: { qualityDrop: 0.05 },
      bootstrap: { modularityMin: 0.1 }
    },
    config
  );
}

export function configForGridPoint(
  base: TopicTreeConfig,
  point: StabilityGridPoint
): TopicTreeConfig {
  return topicTreeConfigWith(
    {
      stability: { churnWeight: point.churnWeight, freshHours: point.freshHours },
      repair: {
        cooldownShare: point.cooldownShare,
        cooldownInserts: point.cooldownInserts,
        ...(point.sidewaysSplitLimit ? { sidewaysSplitLimit: point.sidewaysSplitLimit } : {})
      },
      ...(point.qualityDrop === undefined ? {} : { rebuild: { qualityDrop: point.qualityDrop } })
    },
    base
  );
}

/** The renameDrift values simulated side by side in every run (rule R). */
export const renameDriftGrid = [0.2, 0.25, 0.3, 0.4, 0.5] as const;

// ---------------------------------------------------------------------------
// Rows

const share = z.number().min(0).max(1);
const count = z.number().int().min(0);

export const WeeklyRowSchema = z
  .object({
    kind: z.literal("weekly"),
    point: z.string(),
    seed: z.number().int(),
    order: z.string(),
    configHash: z.string(),
    maxChurn: share,
    medianChurn: share,
    fanOutInTarget: share,
    depthMean: z.number().min(0),
    leafInRange: share,
    reachability: share,
    hardViolations: count,
    operations: count,
    rebuilds: z.array(z.string()),
    /** Per renameDrift: the largest weekly share of live topics renamed. */
    maxRenameRate: z.record(z.string(), share),
    /** Per renameDrift: the mean name staleness (drift) at the end of the weeks. */
    staleness: z.record(z.string(), share),
    /** Per renameDrift: the most naming calls in one simulated day. */
    peakDayCalls: z.record(z.string(), count),
    seconds: z.number().min(0)
  })
  .strict();
export type WeeklyRow = z.infer<typeof WeeklyRowSchema>;

export const E2RowSchema = z
  .object({
    kind: z.literal("e2"),
    point: z.string(),
    seed: z.number().int(),
    order: z.string(),
    configHash: z.string(),
    fanOutInTarget: share,
    depthMean: z.number().min(0),
    singleChildTopics: count,
    reachability: share,
    hardViolations: count,
    seconds: z.number().min(0)
  })
  .strict();
export type E2Row = z.infer<typeof E2RowSchema>;

export const GrowthRowSchema = z
  .object({
    kind: z.literal("growth"),
    point: z.string(),
    seed: z.number().int(),
    dataset: z.string(),
    calendar: z.string(),
    configHash: z.string(),
    leafPurity: share,
    freshPurity: share,
    leafNmi: share,
    depth1Nmi: share,
    leaves: count,
    freshLeaves: count,
    rebuilds: z.array(z.string()),
    fixturePasses: z.boolean().nullable(),
    fixtureExpected: share.nullable(),
    fixtureForbidden: share.nullable(),
    renamed: z.record(z.string(), count),
    peakDayCalls: z.record(z.string(), count),
    reachability: share,
    hardViolations: count
  })
  .strict();
export type GrowthRow = z.infer<typeof GrowthRowSchema>;

export const CalibrationRowSchema = z.discriminatedUnion("kind", [
  WeeklyRowSchema,
  E2RowSchema,
  GrowthRowSchema
]);
export type StabilityCalibrationRow = z.infer<typeof CalibrationRowSchema>;

// ---------------------------------------------------------------------------
// Rule S (registered): the stability point

export interface GridSummary {
  point: string;
  /** Runs found of each kind (complete: 2 weekly, 2 E2, 4 growth). */
  runs: { weekly: number; e2: number; growth: number };
  complete: boolean;
  eligible: boolean;
  reasons: string[];
  worstWeeklyChurn: number;
  medianWeeklyFanOut: number;
  minE2FanOut: number;
  meanE2FanOut: number;
  growthLeafPurity: number;
  growthLeafNmi: number;
  fixturePasses: number;
  operations: number;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
const median = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : distribution(values).p50;
const at = (value: number, digits: number): number => Number(value.toFixed(digits));

export const ruleS = {
  e3Bar: 0.03,
  e2Floor: 0.75,
  depthBar: 4.5,
  weeklyRuns: 2,
  e2Runs: 2,
  growthRuns: 4
} as const;

export function summarizeGrid(
  rows: readonly StabilityCalibrationRow[],
  points: readonly string[],
  seed: number
): GridSummary[] {
  return points.map((point) => {
    const weekly = rows.filter(
      (row): row is WeeklyRow => row.kind === "weekly" && row.point === point && row.seed === seed
    );
    const e2 = rows.filter(
      (row): row is E2Row => row.kind === "e2" && row.point === point && row.seed === seed
    );
    const growth = rows.filter(
      (row): row is GrowthRow => row.kind === "growth" && row.point === point && row.seed === seed
    );
    const reasons: string[] = [];
    const complete =
      weekly.length >= ruleS.weeklyRuns &&
      e2.length >= ruleS.e2Runs &&
      growth.length >= ruleS.growthRuns;
    if (!complete) reasons.push("incomplete");
    for (const row of weekly) {
      if (row.maxChurn > ruleS.e3Bar) reasons.push(`E3 ${row.order} ${at(row.maxChurn * 100, 2)}%`);
      if (row.reachability < 1 || row.hardViolations > 0) reasons.push(`E1 weekly ${row.order}`);
    }
    for (const row of e2) {
      if (row.fanOutInTarget < ruleS.e2Floor) {
        reasons.push(`E2 ${row.order} ${at(row.fanOutInTarget * 100, 1)}%`);
      }
      if (row.depthMean > ruleS.depthBar) reasons.push(`E2 depth ${row.order}`);
      if (row.singleChildTopics > 0) reasons.push(`E2 chains ${row.order}`);
      if (row.reachability < 1 || row.hardViolations > 0) reasons.push(`E1 e2 ${row.order}`);
    }
    for (const row of growth) {
      if (row.reachability < 1 || row.hardViolations > 0) {
        reasons.push(`E1 growth ${row.dataset} ${row.calendar}`);
      }
    }
    return {
      point,
      runs: { weekly: weekly.length, e2: e2.length, growth: growth.length },
      complete,
      eligible: reasons.length === 0,
      reasons,
      worstWeeklyChurn: Math.max(0, ...weekly.map((row) => row.maxChurn)),
      medianWeeklyFanOut: median(weekly.map((row) => row.fanOutInTarget)),
      minE2FanOut: Math.min(...e2.map((row) => row.fanOutInTarget)),
      meanE2FanOut: mean(e2.map((row) => row.fanOutInTarget)),
      growthLeafPurity: mean(growth.map((row) => row.leafPurity)),
      growthLeafNmi: mean(growth.map((row) => row.leafNmi)),
      fixturePasses: growth.filter((row) => row.fixturePasses === true).length,
      operations: weekly.reduce((total, row) => total + row.operations, 0)
    };
  });
}

/**
 * Rule S steps 2-3: the eligible points, best first: growth leaf purity (0.01), then growth leaf
 * NMI (0.01), then the median weekly fan-out 4-9 (0.001), then the fewest weekly operations, then
 * the point ID.
 */
export function compareGridSummaries(a: GridSummary, b: GridSummary): number {
  return (
    at(b.growthLeafPurity, 2) - at(a.growthLeafPurity, 2) ||
    at(b.growthLeafNmi, 2) - at(a.growthLeafNmi, 2) ||
    at(b.medianWeeklyFanOut, 3) - at(a.medianWeeklyFanOut, 3) ||
    a.operations - b.operations ||
    (a.point < b.point ? -1 : a.point > b.point ? 1 : 0)
  );
}

export function rankGrid(summaries: readonly GridSummary[]): GridSummary[] {
  const eligible = summaries.filter((summary) => summary.eligible).sort(compareGridSummaries);
  const rest = summaries
    .filter((summary) => !summary.eligible)
    .sort(
      (a, b) =>
        Number(b.complete) - Number(a.complete) ||
        a.worstWeeklyChurn - b.worstWeeklyChurn ||
        compareGridSummaries(a, b)
    );
  return [...eligible, ...rest];
}

// ---------------------------------------------------------------------------
// Confirmation (registered): the winner on calibration seeds 7, 8 and 9

export interface Confirmation {
  point: string;
  seeds: number[];
  /** Per order: the maximum weekly churn at the median seed. */
  medianSeedMaxChurn: Record<string, number>;
  e2MedianFanOut: number;
  e2MinFanOut: number;
  e2MedianDepth: number;
  e1Failures: number;
  passes: boolean;
}

export function confirmPoint(
  rows: readonly StabilityCalibrationRow[],
  point: string,
  seeds: readonly number[]
): Confirmation {
  const weekly = rows.filter(
    (row): row is WeeklyRow =>
      row.kind === "weekly" && row.point === point && seeds.includes(row.seed)
  );
  const e2 = rows.filter(
    (row): row is E2Row => row.kind === "e2" && row.point === point && seeds.includes(row.seed)
  );
  const orders = [...new Set(weekly.map((row) => row.order))].sort();
  const medianSeedMaxChurn: Record<string, number> = {};
  for (const order of orders) {
    medianSeedMaxChurn[order] = median(
      weekly.filter((row) => row.order === order).map((row) => row.maxChurn)
    );
  }
  const e1Failures = [...weekly, ...e2].filter(
    (row) => row.reachability < 1 || row.hardViolations > 0
  ).length;
  const fanOuts = e2.map((row) => row.fanOutInTarget);
  const confirmation: Confirmation = {
    point,
    seeds: [...seeds],
    medianSeedMaxChurn,
    e2MedianFanOut: median(fanOuts),
    e2MinFanOut: Math.min(...fanOuts),
    e2MedianDepth: median(e2.map((row) => row.depthMean)),
    e1Failures,
    passes: false
  };
  confirmation.passes =
    weekly.length === seeds.length * 2 &&
    e2.length === seeds.length * 2 &&
    Object.values(medianSeedMaxChurn).every((value) => value <= ruleS.e3Bar) &&
    confirmation.e2MedianFanOut >= 0.8 &&
    confirmation.e2MinFanOut >= ruleS.e2Floor &&
    confirmation.e2MedianDepth <= ruleS.depthBar &&
    e1Failures === 0;
  return confirmation;
}

// ---------------------------------------------------------------------------
// Rule R (registered): renameDrift

/** The smallest renameDrift whose largest weekly rename rate stays within `bar` in every run. */
export function chooseRenameDrift(
  rows: readonly WeeklyRow[],
  thresholds: readonly number[] = renameDriftGrid,
  bar = 0.02
): { chosen: number; worstRate: Record<string, number> } {
  const worstRate: Record<string, number> = {};
  for (const threshold of thresholds) {
    const name = String(threshold);
    worstRate[name] = Math.max(0, ...rows.map((row) => row.maxRenameRate[name] ?? 1));
  }
  const passing = thresholds.filter((threshold) => (worstRate[String(threshold)] ?? 1) <= bar);
  const chosen = passing.length > 0 ? Math.min(...passing) : Math.max(...thresholds);
  return { chosen, worstRate };
}

// ---------------------------------------------------------------------------
// D34 (registered): the daily cap of background topic AI calls

export interface DailyCallEvidence {
  label: string;
  calls: number;
}

/** 3 x the busiest observed or simulated day, rounded up to a multiple of 10. */
export function dailyCallCap(evidence: readonly DailyCallEvidence[], margin = 3): number {
  const busiest = Math.max(0, ...evidence.map((entry) => entry.calls));
  return Math.ceil((margin * busiest) / 10) * 10;
}
