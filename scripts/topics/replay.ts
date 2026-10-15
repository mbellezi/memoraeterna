// Offline replay and calibration harness of the Topic Tree Engine (T09).
//
//   npm run topics:replay -- parity   --dataset corpus-notitle --seed 20261014 [--repeat]
//   npm run topics:replay -- growth   --dataset corpus-notitle --arrival chronological --share 0.2
//   npm run topics:replay -- weekly   --dataset corpus-notitle --arrival shuffled --seeds evaluation
//   npm run topics:replay -- knn      --dataset corpus-notitle --sample 3000,6000 --nprobe 8,16,32
//   npm run topics:replay -- list
//
// parity   builds the Louvain tree and holds it to Spike B (depth, fan-out, leaf purity, build time).
// growth   builds on a base, inserts the rest with the Spike B local repair, settles (E1, E2).
// weekly   the E3 protocol: a 60% base, then 8 simulated weeks of 5% arrivals, each day a PLACE and a
//          REBALANCE with a daily budget and a freeze on the fastest-growing topics; weekly churn.
// knn      IVF recall@10 against exact kNN (subset samples, and the production setting).
// --audit  adds the E1 audit (reachability, orphans, hard violations) of the final tree.
//
// Datasets are replay stores (export-vectors.ts): the Spike B stores in `.cache/spikes/topic-tree/
// vectors` and the app exports of T22a/T22b in `.cache/topics/vectors`. Reports go to
// `.cache/topics/reports/` (report-data.ts). Calibration runs (T29a, T29b) use seeds 7-12 and
// evaluation runs 20261014 and 1-5; a run refuses the other role's seeds.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  buildLouvain,
  canonicalPartition,
  defaultTopicTreeConfig,
  distribution,
  shapeReport
} from "@app/domain/topic-tree";
import type { DetectCommunities, TopicTreeConfig, TopicTreeState } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import {
  arrivalOrder,
  arrivalOrders,
  assertSeedAllowed,
  calibrationSeeds,
  defaultVectorDirs,
  evaluationSeeds,
  growthKinds,
  growthSplit,
  listReplayDatasets,
  loadReplayDataset,
  reportsDir,
  seedRole,
  subsetDataset,
  weeklySchedule
} from "./datasets.js";
import type { ArrivalOrder, GrowthKind, ReplayDataset, SimulatedSchedule } from "./datasets.js";
import {
  measureQueryRecall,
  measureSubsetRecall,
  sampleRows,
  smallestNprobeReaching
} from "./knn-recall.js";
import { check, configHash, partitionHash, summarizeShape, writeReport } from "./report-data.js";
import type {
  AuditReport,
  Check,
  GrowthReport,
  KnnRecallReport,
  ParityReport,
  ReplayReport,
  WeekRow,
  WeeklyReport
} from "./report-data.js";
import {
  auditState,
  churnSince,
  fastestGrowingTopics,
  pathSnapshot,
  rootChildCount,
  rowKeys,
  truthSummary
} from "./replay-metrics.js";
import { createReferenceEngine } from "./reference-engine.js";
import type { OperationCounts, ReplayEngineFactory } from "./reference-engine.js";

export interface ReplayRun {
  dataset: ReplayDataset;
  config: TopicTreeConfig;
  seed: number;
  detect: DetectCommunities;
  createEngine: ReplayEngineFactory;
  /** Clock of the reports; tests pin it. */
  now?: () => string;
}

const allRows = (dataset: Pick<ReplayDataset, "rows">): number[] =>
  Array.from({ length: dataset.rows.length }, (_, row) => row);

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

function baseFields(run: ReplayRun, engine: string) {
  return {
    schema: "topics-report/v1" as const,
    createdAt: (run.now ?? (() => new Date().toISOString()))(),
    dataset: {
      name: run.dataset.name,
      rows: run.dataset.rows.length,
      dim: run.dataset.matrix.dim,
      model: run.dataset.meta.model.name,
      runtime: run.dataset.meta.runtime,
      spaceKey: run.dataset.meta.spaceKey ?? null
    },
    seed: run.seed,
    seedRole: seedRole(run.seed),
    configHash: configHash(run.config),
    engine
  };
}

function stripUndefined(counts: OperationCounts): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).filter((entry): entry is [string, number] => entry[1] !== undefined)
  );
}

// ---------------------------------------------------------------------------
// Parity with Spike B

/** What Spike B measured for the Louvain builder at seed 20261014 on the whole corpus (±). */
export const spikeBParity = {
  seed: 20261014,
  datasets: {
    "corpus-notitle": { depthMean: 3.69, fanOutInTarget: 0.85, leafDomainPurity: 0.92 },
    corpus: { depthMean: 3.66, fanOutInTarget: 0.79, leafDomainPurity: 0.97 }
  } as Record<string, { depthMean: number; fanOutInTarget: number; leafDomainPurity: number }>,
  tolerance: { depthMean: 0.05, fanOutInTarget: 0.02, leafDomainPurity: 0.01 },
  /** T09 proof: the 18.6k build, kNN included. */
  maxBuildSeconds: 50
} as const;

export function parityChecks(
  datasetName: string,
  seed: number,
  wholeDataset: boolean,
  measured: {
    depthMean: number;
    fanOutInTarget: number;
    leafDomainPurity: number | null;
    reachability: number;
    hardViolations: number;
    buildSeconds: number;
  }
): Check[] {
  const checks: Check[] = [
    check("reachability", measured.reachability, { min: 1 }),
    check("hard violations", measured.hardViolations, { max: 0 })
  ];
  const target = spikeBParity.datasets[datasetName];
  if (!target || seed !== spikeBParity.seed || !wholeDataset) return checks;
  const { tolerance } = spikeBParity;
  checks.push(
    check("depth mean (Spike B)", measured.depthMean, {
      min: target.depthMean - tolerance.depthMean,
      max: target.depthMean + tolerance.depthMean
    }),
    check("fan-out 4-9 share (Spike B)", measured.fanOutInTarget, {
      min: target.fanOutInTarget - tolerance.fanOutInTarget,
      max: target.fanOutInTarget + tolerance.fanOutInTarget
    })
  );
  if (measured.leafDomainPurity !== null) {
    checks.push(
      check("leaf domain purity (Spike B)", measured.leafDomainPurity, {
        min: target.leafDomainPurity - tolerance.leafDomainPurity,
        max: target.leafDomainPurity + tolerance.leafDomainPurity
      })
    );
  }
  checks.push(check("build seconds", measured.buildSeconds, { max: spikeBParity.maxBuildSeconds }));
  return checks;
}

export interface ParityOptions {
  /** Rows to build on (default: all). */
  rows?: readonly number[];
  /** Build twice and compare the canonical partitions. */
  repeat?: boolean;
}

export function parityRun(
  run: ReplayRun,
  options: ParityOptions = {}
): { report: ParityReport; state: TopicTreeState; rows: number[] } {
  const rows = [...(options.rows ?? allRows(run.dataset))];
  const build = () =>
    buildLouvain(run.dataset.matrix, rows, {
      seed: run.seed,
      config: run.config,
      detectCommunities: run.detect
    });
  const started = performance.now();
  const result = build();
  const totalMs = performance.now() - started;
  const shape = shapeReport(result.state, run.config, { expectedItems: rowKeys(rows) });
  const summary = summarizeShape(shape, rootChildCount(result.state));
  const truth = truthSummary(result.state, run.dataset, rows);
  const diagnostics = result.diagnostics;
  const deterministic = options.repeat
    ? canonicalPartition(build().state) === canonicalPartition(result.state)
    : null;
  const checks = parityChecks(run.dataset.name, run.seed, rows.length === run.dataset.rows.length, {
    depthMean: summary.depthMean,
    fanOutInTarget: summary.fanOutInTarget,
    leafDomainPurity: truth?.leafDomainPurity ?? null,
    reachability: summary.reachability,
    hardViolations: summary.hardViolations,
    buildSeconds: totalMs / 1000
  });
  if (deterministic !== null)
    checks.push(check("repeatable build", deterministic ? 1 : 0, { min: 1 }));
  const report: ParityReport = {
    ...baseFields(run, "louvain-build"),
    kind: "parity",
    shape: summary,
    truth,
    timings: {
      knnMs: result.timings.knnMs,
      communitiesMs: result.timings.communitiesMs,
      repairMs: result.timings.repairMs,
      totalMs
    },
    knnExact: result.knnExact ?? true,
    partitionHash: partitionHash(result.state),
    deterministic,
    root: {
      communities: diagnostics?.rootCommunities ?? 0,
      children: diagnostics?.rootChildren ?? 0,
      superGrouped: diagnostics?.rootSuperGrouped ?? false,
      kmeansFallback: diagnostics?.rootKmeansFallback ?? false
    },
    checks,
    passes: checks.every((entry) => entry.pass)
  };
  return { report, state: result.state, rows };
}

// ---------------------------------------------------------------------------
// Growth (E1, E2)

export interface GrowthOptions {
  kind: GrowthKind;
  /** Share of the rows inserted after the build (E2: 0.2). */
  share?: number;
}

export function growthRun(
  run: ReplayRun,
  options: GrowthOptions
): { report: GrowthReport; state: TopicTreeState; rows: number[] } {
  const split = growthSplit(run.dataset, options.kind, options.share ?? 0.2, run.seed);
  const engine = run.createEngine({
    matrix: run.dataset.matrix,
    config: run.config,
    seed: run.seed,
    detect: run.detect
  });
  const build = engine.build(split.base);
  const observe = (rows: readonly number[]) => ({
    shape: summarizeShape(
      shapeReport(engine.state, run.config, { expectedItems: rowKeys(rows) }),
      rootChildCount(engine.state)
    ),
    truth: truthSummary(engine.state, run.dataset, rows)
  });
  const before = observe(split.base);
  const snapshot = pathSnapshot(engine.state, split.base);
  const place = engine.place(split.tail, { localRepair: true });
  const everything = [...split.base, ...split.tail];
  const after = observe(everything);
  const { churn } = churnSince(snapshot, engine.state);
  const settleOperations = engine.settle();
  const settled = { ...observe(everything), operations: stripUndefined(settleOperations) };
  const n = Math.max(1, split.tail.length);
  const checks = [
    check("E1 reachability", settled.shape.reachability, { min: 1 }),
    check("E1 hard violations", settled.shape.hardViolations, { max: 0 }),
    check("E2 mean depth", settled.shape.depthMean, { max: 4.5 }),
    // The 80% bar is met by the median over seeds (aggregateGrowth); a seed may not fall under 75%.
    check("E2 fan-out 4-9 share (per-seed floor)", settled.shape.fanOutInTarget, { min: 0.75 }),
    check("E2 single-child chains", settled.shape.singleChildTopics, { max: 0 })
  ];
  const report: GrowthReport = {
    ...baseFields(run, engine.name),
    kind: "growth",
    arrival: options.kind,
    base: split.base.length,
    inserted: split.tail.length,
    buildMs: build.totalMs,
    insertMsPerItem: place.ms / n,
    churn: round(churn),
    ambiguousRate: round(place.ambiguous / n),
    unadmittedRate: round(place.unadmitted / n),
    gatedAtMargin: Object.fromEntries(
      Object.entries(place.gatedAtMargin).map(([margin, count]) => [margin, round(count / n)])
    ),
    operations: stripUndefined(place.operations),
    before,
    after,
    settled,
    checks,
    passes: checks.every((entry) => entry.pass)
  };
  return { report, state: engine.state, rows: everything };
}

const median = (values: readonly number[]): number => distribution(values).p50;

/**
 * E2 over several seeds (spec section 8): the median meets both bars, no seed is below 75%, and
 * there are no single-child chains.
 */
export function aggregateGrowth(reports: readonly GrowthReport[]): Check[] {
  const shapes = reports.map((report) => report.settled.shape);
  return [
    check("E2 median of mean depths", median(shapes.map((shape) => shape.depthMean)), { max: 4.5 }),
    check("E2 median fan-out 4-9 share", median(shapes.map((shape) => shape.fanOutInTarget)), {
      min: 0.8
    }),
    check("E2 lowest fan-out 4-9 share", Math.min(...shapes.map((shape) => shape.fanOutInTarget)), {
      min: 0.75
    }),
    check("E2 single-child chains", Math.max(...shapes.map((shape) => shape.singleChildTopics)), {
      max: 0
    })
  ];
}

/** E3 over several seeds: the maximum weekly churn at the median seed is within the bar. */
export function aggregateWeekly(reports: readonly WeeklyReport[], bar = 0.03): Check[] {
  return [
    check("E3 maximum weekly churn at the median seed", median(reports.map((r) => r.maxChurn)), {
      max: bar
    })
  ];
}

// ---------------------------------------------------------------------------
// Weekly replay (E3)

export interface WeeklyOptions {
  order: ArrivalOrder;
  baseShare?: number;
  weeks?: number;
  weeklyShare?: number;
  daysPerWeek?: number;
  /** Topics frozen for soft operations each day: the fastest-growing of the last week. */
  freezeTopics?: number;
  /** Use this calendar instead of `weeklySchedule` (source days for ENV-G and ENV-F). */
  schedule?: SimulatedSchedule;
  /** E3 bar: the largest weekly churn (*cal.*, spec 8). */
  maxWeeklyChurn?: number;
}

export function weeklyRun(
  run: ReplayRun,
  options: WeeklyOptions
): { report: WeeklyReport; state: TopicTreeState; rows: number[] } {
  const daysPerWeek = options.daysPerWeek ?? 7;
  const freezeTopics = options.freezeTopics ?? 50;
  const order = arrivalOrder(run.dataset, options.order, run.seed);
  const schedule =
    options.schedule ??
    weeklySchedule(order, {
      baseShare: options.baseShare ?? 0.6,
      weeks: options.weeks ?? 8,
      weeklyShare: options.weeklyShare ?? 0.05,
      daysPerWeek
    });
  const engine = run.createEngine({
    matrix: run.dataset.matrix,
    config: run.config,
    seed: run.seed,
    detect: run.detect
  });
  const build = engine.build(schedule.base);
  engine.settle();
  const baseShape = summarizeShape(
    shapeReport(engine.state, run.config, { expectedItems: rowKeys(schedule.base) }),
    rootChildCount(engine.state)
  );

  const weeks: WeekRow[] = [];
  const present = [...schedule.base];
  const recent: number[][] = [];
  let snapshot = pathSnapshot(engine.state, present);
  let week = {
    number: 1,
    started: performance.now(),
    arrivals: 0,
    atStart: present.length,
    operations: {} as OperationCounts,
    skippedFrozen: 0,
    skippedBudget: 0,
    ambiguous: 0,
    unadmitted: 0
  };
  const flush = (rebuild: WeekRow["rebuild"]): void => {
    const rows = [...present];
    const measurement = churnSince(snapshot, engine.state);
    const shape = shapeReport(engine.state, run.config, { expectedItems: rowKeys(rows) });
    weeks.push({
      week: week.number,
      arrivals: week.arrivals,
      itemsAtStart: week.atStart,
      itemsAtEnd: rows.length,
      growth: round(week.atStart > 0 ? week.arrivals / week.atStart : 0),
      churn: round(measurement.churn, 6),
      changedItems: measurement.changed,
      operations: stripUndefined(week.operations),
      skippedFrozen: week.skippedFrozen,
      skippedBudget: week.skippedBudget,
      ambiguous: week.ambiguous,
      unadmitted: week.unadmitted,
      rebuild,
      topics: shape.topics,
      rootChildren: rootChildCount(engine.state),
      depthMean: round(shape.itemDepth.mean),
      fanOutInTarget: round(shape.fanOut.inTarget),
      hardViolations: shape.violations.hardCount,
      ms: performance.now() - week.started
    });
  };

  const addCounts = (into: OperationCounts, from: OperationCounts): void => {
    for (const [kind, count] of Object.entries(from)) {
      const key = kind as keyof OperationCounts;
      into[key] = (into[key] ?? 0) + (count ?? 0);
    }
  };
  const lastDayOfWeek = (index: number): boolean =>
    schedule.days[index + 1]?.week !== schedule.days[index]?.week;

  schedule.days.forEach((day, index) => {
    if (day.week !== week.number) {
      week = {
        number: day.week,
        started: performance.now(),
        arrivals: 0,
        atStart: present.length,
        operations: {},
        skippedFrozen: 0,
        skippedBudget: 0,
        ambiguous: 0,
        unadmitted: 0
      };
      snapshot = pathSnapshot(engine.state, present);
    }
    // The synthetic "recently viewed" set: where the last week's arrivals went.
    engine.setFrozen(
      new Set(fastestGrowingTopics(engine.state, recent.slice(-daysPerWeek).flat(), freezeTopics))
    );
    const placed = engine.place(day.rows);
    const rebalanced = engine.rebalance({ day: day.day });
    for (const row of day.rows) present.push(row);
    recent.push(day.rows);
    week.arrivals += day.rows.length;
    week.ambiguous += placed.ambiguous;
    week.unadmitted += placed.unadmitted;
    week.skippedFrozen += rebalanced.skippedFrozen;
    week.skippedBudget += rebalanced.skippedBudget;
    addCounts(week.operations, placed.operations);
    addCounts(week.operations, rebalanced.operations);
    if (lastDayOfWeek(index)) {
      const rebuild = engine.evaluateRebuild?.({ day: day.day }) ?? null;
      flush(rebuild);
    }
  });

  const churns = weeks.map((entry) => entry.churn);
  const maxChurn = churns.length > 0 ? Math.max(...churns) : 0;
  const medianChurn = churns.length > 0 ? distribution(churns).p50 : 0;
  const finalShape = summarizeShape(
    shapeReport(engine.state, run.config, { expectedItems: rowKeys(present) }),
    rootChildCount(engine.state)
  );
  const bar = options.maxWeeklyChurn ?? 0.03;
  const checks = [
    check("E3 maximum weekly churn", maxChurn, { max: bar }),
    check("E1 reachability", finalShape.reachability, { min: 1 }),
    check("E1 hard violations", finalShape.hardViolations, { max: 0 })
  ];
  const report: WeeklyReport = {
    ...baseFields(run, engine.name),
    kind: "weekly-replay",
    arrival: options.order,
    gate: "off",
    schedule: {
      baseRows: schedule.base.length,
      weeks: schedule.weeks,
      weeklyShare: options.weeklyShare ?? 0.05,
      daysPerWeek,
      frozenTopics: freezeTopics
    },
    base: {
      shape: baseShape,
      timings: {
        knnMs: build.knnMs,
        communitiesMs: build.communitiesMs,
        repairMs: build.repairMs,
        totalMs: build.totalMs
      }
    },
    weeks,
    maxChurn: round(maxChurn, 6),
    medianChurn: round(medianChurn, 6),
    final: { shape: finalShape, truth: truthSummary(engine.state, run.dataset, present) },
    checks,
    passes: checks.every((entry) => entry.pass)
  };
  return { report, state: engine.state, rows: present };
}

// ---------------------------------------------------------------------------
// Audit (E1)

export function auditRun(
  run: ReplayRun,
  state: TopicTreeState,
  rows: readonly number[]
): AuditReport {
  return {
    ...baseFields(run, "audit"),
    kind: "audit",
    ...auditState(state, run.config, rows)
  };
}

// ---------------------------------------------------------------------------
// IVF recall

export interface KnnOptions {
  samples: readonly number[];
  nprobes: readonly number[];
  /** Exact scans for the production-setting measurement; 0 skips it. */
  queries: number;
  /** nprobe values measured on the full dataset (default: the configured one). */
  fullNprobes?: readonly number[];
  target?: number;
  k?: number;
}

export function knnRun(run: ReplayRun, options: KnnOptions): KnnRecallReport {
  const target = options.target ?? 0.9;
  const k = options.k ?? 10;
  const { matrix } = run.dataset;
  const configured = run.config.knn.nprobe;
  const subsets = options.samples
    .filter((sample) => sample <= matrix.count)
    .map((sample) => {
      const measured = measureSubsetRecall(matrix, {
        sampleSize: sample,
        nprobes: options.nprobes,
        k,
        seed: run.seed
      });
      return {
        sample: measured.sample,
        exactMs: measured.exactMs,
        points: measured.points,
        smallestPassing: smallestNprobeReaching(measured.points, target)
      };
    });
  const queries =
    options.queries > 0
      ? (options.fullNprobes ?? [configured]).map((nprobe) => {
          const measured = measureQueryRecall(matrix, {
            queries: options.queries,
            nprobe,
            k,
            seed: run.seed
          });
          return {
            rows: measured.rows,
            queries: measured.queries,
            minRecall: measured.minRecall,
            point: measured.point,
            exactMs: measured.exactMs
          };
        })
      : [];
  // Adopt the configured nprobe when it reaches the target everywhere it was measured; else the
  // smallest probed value that does on every measurement.
  const measuredAt = (nprobe: number): boolean[] => [
    ...subsets.flatMap((subset) =>
      subset.points
        .filter((point) => point.nprobe === nprobe)
        .map((point) => point.recall >= target)
    ),
    ...queries
      .filter((query) => query.point.nprobe === nprobe)
      .map((query) => query.point.recall >= target)
  ];
  const candidates = [
    ...new Set([configured, ...options.nprobes, ...(options.fullNprobes ?? [])])
  ].sort((a, b) => a - b);
  const passing = candidates.filter((nprobe) => {
    const results = measuredAt(nprobe);
    return results.length > 0 && results.every(Boolean);
  });
  const recommended = passing.includes(configured) ? configured : (passing[0] ?? null);
  return {
    ...baseFields(run, "ivf-knn"),
    kind: "knn-recall",
    k,
    target,
    configuredNprobe: configured,
    subsets,
    queries,
    recommendedNprobe: recommended,
    passes: measuredAt(configured).length > 0 && measuredAt(configured).every(Boolean)
  };
}

// ---------------------------------------------------------------------------
// Command line

const usage = `Usage: npm run topics:replay -- <command> [options]

Commands:
  parity   build the Louvain tree and hold it to Spike B
  growth   build on a base, insert the rest (Spike B local repair), settle (E1, E2)
  weekly   E3: base + simulated weeks of arrivals, weekly primary-path churn
  knn      IVF recall@10 against exact kNN
  list     replay stores found in the vector directories

Options:
  --dataset <name>        replay store (default corpus-notitle)
  --vectors-dir <dir>     directory of the store (repeatable; default .cache/topics/vectors, then the Spike B stores)
  --seed <n>              seed (default 20261014)
  --seeds <set>           evaluation | calibration | comma-separated list (runs each)
  --role <role>           evaluation | calibration: refuse the other role's seeds
  --limit <n>             use a seeded sample of n rows (smoke runs)
  --out <dir>             reports directory (default .cache/topics/reports)
  --audit                 also write the E1 audit of the final tree
  --repeat                parity: build twice and compare the partitions
  --arrival <order>       growth/weekly: chronological | shuffled | domain (growth also: items | articles | domains)
  --share <x>             growth: share inserted after the build (default 0.2)
  --weeks <n> --weekly-share <x> --base-share <x> --days-per-week <n> --freeze <n>   weekly (E3: 8, 0.05, 0.6, 7, 50)
  --max-churn <x>         weekly: the E3 bar (default 0.03)
  --sample <n,n> --nprobe <n,n> --queries <n> --full-nprobe <n,n> --target <x>        knn (3000,6000; 4,8,16,32; 300)
`;

function numberList(value: string | undefined, fallback: readonly number[]): number[] {
  if (value === undefined) return [...fallback];
  return value.split(",").map((entry) => {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed)) throw new RangeError(`Not a number: ${entry}`);
    return parsed;
  });
}

function seedsFrom(value: string | undefined, single: string | undefined): number[] {
  if (value === "evaluation") return [...evaluationSeeds];
  if (value === "calibration") return [...calibrationSeeds];
  if (value !== undefined) return numberList(value, []);
  return [Number(single ?? "20261014")];
}

function summaryLine(report: ReplayReport): string {
  switch (report.kind) {
    case "parity":
      return `depth ${report.shape.depthMean}, fan-out 4-9 ${(report.shape.fanOutInTarget * 100).toFixed(1)}%, purity ${
        report.truth ? (report.truth.leafDomainPurity * 100).toFixed(1) : "-"
      }%, reachability ${report.shape.reachability}, hard ${report.shape.hardViolations}, build ${(report.timings.totalMs / 1000).toFixed(1)} s, areas ${report.shape.rootChildren}`;
    case "growth":
      return `churn ${(report.churn * 100).toFixed(1)}%, ambiguous ${(report.ambiguousRate * 100).toFixed(1)}%, depth ${report.settled.shape.depthMean}, fan-out ${(report.settled.shape.fanOutInTarget * 100).toFixed(1)}%`;
    case "weekly-replay":
      return `max weekly churn ${(report.maxChurn * 100).toFixed(2)}%, median ${(report.medianChurn * 100).toFixed(2)}%, final depth ${report.final.shape.depthMean}, hard ${report.final.shape.hardViolations}`;
    case "audit":
      return `reachability ${report.reachability}, orphans ${JSON.stringify(report.orphans)}, hard ${report.hardViolationCount}`;
    case "knn-recall":
      return `recommended nprobe ${report.recommendedNprobe ?? "none"} (configured ${report.configuredNprobe})`;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      dataset: { type: "string" },
      "vectors-dir": { type: "string", multiple: true },
      seed: { type: "string" },
      seeds: { type: "string" },
      role: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      audit: { type: "boolean" },
      repeat: { type: "boolean" },
      arrival: { type: "string" },
      share: { type: "string" },
      weeks: { type: "string" },
      "weekly-share": { type: "string" },
      "base-share": { type: "string" },
      "days-per-week": { type: "string" },
      freeze: { type: "string" },
      "max-churn": { type: "string" },
      sample: { type: "string" },
      nprobe: { type: "string" },
      queries: { type: "string" },
      "full-nprobe": { type: "string" },
      target: { type: "string" },
      help: { type: "boolean" }
    }
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.info(usage);
    return command ? 0 : 2;
  }
  const dirs = values["vectors-dir"]?.map((dir) => resolve(dir)) ?? defaultVectorDirs();
  if (command === "list") {
    for (const entry of await listReplayDatasets(dirs)) console.info(`${entry.name}\t${entry.dir}`);
    return 0;
  }
  if (!["parity", "growth", "weekly", "knn"].includes(command)) {
    console.error(`Unknown command ${command}\n\n${usage}`);
    return 2;
  }
  const role = values.role as "evaluation" | "calibration" | undefined;
  if (role !== undefined && role !== "evaluation" && role !== "calibration") {
    console.error("--role is evaluation or calibration");
    return 2;
  }
  const seeds = seedsFrom(values.seeds, values.seed);
  if (role) for (const seed of seeds) assertSeedAllowed(seed, role);

  const datasetName = values.dataset ?? "corpus-notitle";
  const fullDataset = await loadReplayDataset(datasetName, { dirs });
  const limit = values.limit === undefined ? null : Number(values.limit);
  const out = resolve(values.out ?? reportsDir());
  const config = defaultTopicTreeConfig;
  console.info(
    `[topics:replay] ${command} on ${datasetName}: ${fullDataset.rows.length} rows x ` +
      `${fullDataset.matrix.dim}, seeds ${seeds.join(",")}`
  );
  const limitTag = limit === null ? undefined : `n${limit}`;
  const suffixOf = (...parts: (string | undefined)[]): string | undefined => {
    const joined = [...parts, limitTag]
      .filter((part) => part !== undefined && part !== "")
      .join("-");
    return joined === "" ? undefined : joined;
  };

  let failed = false;
  const summaries: string[] = [];
  const growthReports: GrowthReport[] = [];
  const weeklyReports: WeeklyReport[] = [];
  const maxChurnBar = values["max-churn"] === undefined ? 0.03 : Number(values["max-churn"]);
  // Over several seeds E2 and E3 are judged on the median (aggregates below); a run then fails
  // on its own only for E1.
  const medianJudged = (report: ReplayReport): boolean =>
    seeds.length > 1 && (report.kind === "growth" || report.kind === "weekly-replay");
  const record = async (run: ReplayRun, report: ReplayReport, suffix?: string): Promise<void> => {
    const path = await writeReport(out, report, suffix);
    if (report.kind === "growth") growthReports.push(report);
    if (report.kind === "weekly-replay") weeklyReports.push(report);
    const passes =
      !("passes" in report) ||
      (medianJudged(report) && "checks" in report
        ? report.checks.every((entry) => !entry.name.startsWith("E1") || entry.pass)
        : report.passes);
    if (!passes) failed = true;
    summaries.push(
      `seed ${run.seed}${suffix ? ` ${suffix}` : ""}: ${summaryLine(report)} -> ${path}`
    );
    console.info(`[topics:replay] ${report.kind} seed ${run.seed}: ${summaryLine(report)}`);
    console.info(`[topics:replay]   ${passes ? "ok" : "FAILED"} ${path}`);
  };

  for (const seed of seeds) {
    const dataset =
      limit === null
        ? fullDataset
        : subsetDataset(fullDataset, sampleRows(fullDataset.rows.length, limit, seed, "limit"));
    const run: ReplayRun = {
      dataset,
      config,
      seed,
      detect: detectCommunitiesLouvain,
      createEngine: createReferenceEngine
    };
    if (command === "parity") {
      const parity = parityRun(run, { repeat: values.repeat === true });
      await record(run, parity.report, suffixOf());
      if (values.audit) {
        await record(run, auditRun(run, parity.state, parity.rows), suffixOf("parity"));
      }
    } else if (command === "growth") {
      const kind = (values.arrival ?? "items") as GrowthKind;
      if (!growthKinds.includes(kind)) {
        console.error(`--arrival for growth is one of ${growthKinds.join(", ")}`);
        return 2;
      }
      const growth = growthRun(run, {
        kind,
        share: values.share === undefined ? 0.2 : Number(values.share)
      });
      await record(run, growth.report, suffixOf(kind));
      if (values.audit) {
        await record(run, auditRun(run, growth.state, growth.rows), suffixOf(kind));
      }
    } else if (command === "weekly") {
      const order = (values.arrival ?? "chronological") as ArrivalOrder;
      if (!arrivalOrders.includes(order)) {
        console.error(`--arrival for weekly is one of ${arrivalOrders.join(", ")}`);
        return 2;
      }
      const weekly = weeklyRun(run, {
        order,
        baseShare: values["base-share"] === undefined ? 0.6 : Number(values["base-share"]),
        weeks: values.weeks === undefined ? 8 : Number(values.weeks),
        weeklyShare: values["weekly-share"] === undefined ? 0.05 : Number(values["weekly-share"]),
        daysPerWeek: values["days-per-week"] === undefined ? 7 : Number(values["days-per-week"]),
        freezeTopics: values.freeze === undefined ? 50 : Number(values.freeze),
        maxWeeklyChurn: maxChurnBar
      });
      await record(run, weekly.report, suffixOf(order));
      if (values.audit) {
        await record(run, auditRun(run, weekly.state, weekly.rows), suffixOf(order));
      }
    } else {
      const report = knnRun(run, {
        samples: numberList(values.sample, [3000, 6000]),
        nprobes: numberList(values.nprobe, [4, 8, 16, 32]),
        queries: values.queries === undefined ? 300 : Number(values.queries),
        fullNprobes: numberList(values["full-nprobe"], [config.knn.nprobe]),
        target: values.target === undefined ? 0.9 : Number(values.target)
      });
      await record(run, report, suffixOf());
    }
  }
  const aggregates = [
    ...(seeds.length > 1 && growthReports.length > 0 ? aggregateGrowth(growthReports) : []),
    ...(seeds.length > 1 && weeklyReports.length > 0
      ? aggregateWeekly(weeklyReports, maxChurnBar)
      : [])
  ];
  for (const entry of aggregates) {
    console.info(
      `[topics:replay] over ${seeds.length} seeds: ${entry.name} = ${entry.value} ` +
        `(${entry.min ?? "-"} to ${entry.max ?? "-"}) ${entry.pass ? "ok" : "FAILED"}`
    );
    if (!entry.pass) failed = true;
  }
  console.info(`[topics:replay] ${summaries.length} report(s) in ${out}`);
  return failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`[topics:replay] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  );
}
