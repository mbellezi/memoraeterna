// Experiment helpers shared by the self-check and the real-embedding runs.
import { buildTree } from "./builders.js";
import type { BuilderName, LouvainBuildOptions } from "./builders.js";
import type { TreeConfig } from "./config.js";
import { IncrementalTopicEngine } from "./incremental.js";
import {
  churn,
  cutLabels,
  leafLabels,
  nmi,
  placementStats,
  primaryPaths,
  purity,
  sampledSilhouette,
  shapeReport
} from "./metrics.js";
import type { PlacementStats, ShapeReport } from "./metrics.js";
import type { RepairKind, RepairOperation } from "./repair.js";
import { createRng, deriveSeed } from "./rng.js";
import type { TopicTree } from "./tree.js";
import type { EmbeddingMatrix } from "./vectors.js";

export interface TruthScores {
  leafNmi: number;
  leafPurity: number;
  /** NMI of a frontier cut with about as many topics as true clusters. */
  cutNmi: number;
}

export interface TreeEvaluation {
  shape: ShapeReport;
  silhouette: number;
  placement: PlacementStats;
  truth?: TruthScores;
}

export interface EvaluateOptions {
  seed: number;
  /** Ground-truth labels aligned with `items` (e.g. synthetic clusters or domains). */
  truth?: ArrayLike<number>;
  silhouetteSample?: number;
}

export function evaluateTree(
  tree: TopicTree,
  matrix: EmbeddingMatrix,
  items: readonly number[],
  config: TreeConfig,
  options: EvaluateOptions
): TreeEvaluation {
  const engine = new IncrementalTopicEngine(tree, matrix, config, options.seed);
  const evaluation: TreeEvaluation = {
    shape: shapeReport(tree, config, items),
    silhouette: sampledSilhouette(tree, matrix, {
      seed: options.seed,
      sample: options.silhouetteSample ?? 1000
    }),
    placement: placementStats(engine, items)
  };
  if (options.truth) {
    const truth = options.truth;
    const leaves = leafLabels(tree, items);
    evaluation.truth = {
      leafNmi: nmi(leaves, truth),
      leafPurity: purity(leaves, truth),
      cutNmi: nmi(cutLabels(tree, items, new Set(Array.from(truth)).size), truth)
    };
  }
  return evaluation;
}

export function countOperations(
  operations: readonly RepairOperation[]
): Record<RepairKind, number> {
  const counts: Record<RepairKind, number> = {
    "leaf-split": 0,
    "internal-split": 0,
    "push-down": 0,
    merge: 0,
    dissolve: 0,
    collapse: 0,
    lift: 0,
    "absorb-direct": 0
  };
  for (const operation of operations) counts[operation.kind] += 1;
  return counts;
}

export interface IncrementalRun {
  tree: TopicTree;
  engine: IncrementalTopicEngine;
  baseItems: number[];
  insertedItems: number[];
  /** Share of base items whose primary path changed while the rest was inserted. */
  churn: number;
  insertAmbiguityRate: number;
  insertCrossParentAmbiguityRate: number;
  insertUnadmittedRate: number;
  operations: Record<RepairKind, number>;
  shape: ShapeReport;
}

/**
 * Builds on the first (1 - holdoutShare) of a seeded shuffle of `items` with
 * `builder` (or starts empty with "incremental") and inserts the rest one by one.
 */
export function incrementalRun(
  builder: BuilderName | "incremental",
  matrix: EmbeddingMatrix,
  items: readonly number[],
  config: TreeConfig,
  options: { seed: number; holdoutShare?: number; build?: Omit<LouvainBuildOptions, "seed"> }
): IncrementalRun {
  const order = createRng(deriveSeed(options.seed, "order")).shuffle([...items]);
  const holdout = builder === "incremental" ? 1 : (options.holdoutShare ?? 0.2);
  const cut = Math.round(order.length * (1 - holdout));
  const baseItems = order.slice(0, cut);
  const insertedItems = order.slice(cut);
  const engine =
    builder === "incremental"
      ? IncrementalTopicEngine.empty(matrix, config, options.seed)
      : new IncrementalTopicEngine(
          buildTree(builder, matrix, baseItems, { ...options.build, seed: options.seed, config })
            .tree,
          matrix,
          config,
          options.seed
        );
  const before = primaryPaths(engine.tree, baseItems);
  let ambiguous = 0;
  let crossParent = 0;
  let unadmitted = 0;
  for (const item of insertedItems) {
    const placement = engine.insert(item);
    if (placement.ambiguous) ambiguous += 1;
    if (placement.crossParentAmbiguous) crossParent += 1;
    if (!placement.admittedLeaf) unadmitted += 1;
  }
  const after = primaryPaths(engine.tree, baseItems);
  return {
    tree: engine.tree,
    engine,
    baseItems,
    insertedItems,
    churn: churn(before, after),
    insertAmbiguityRate: insertedItems.length > 0 ? ambiguous / insertedItems.length : 0,
    insertCrossParentAmbiguityRate:
      insertedItems.length > 0 ? crossParent / insertedItems.length : 0,
    insertUnadmittedRate: insertedItems.length > 0 ? unadmitted / insertedItems.length : 0,
    operations: countOperations(engine.operations),
    shape: shapeReport(engine.tree, config, items)
  };
}

export interface OrderStability {
  /** NMI between the leaf partitions of two insertion orders (over all items). */
  nmi: number;
  runs: [IncrementalRun, IncrementalRun];
}

export function orderStability(
  builder: BuilderName | "incremental",
  matrix: EmbeddingMatrix,
  items: readonly number[],
  config: TreeConfig,
  options: { seeds: [number, number]; holdoutShare?: number }
): OrderStability {
  const runs = options.seeds.map((seed) =>
    incrementalRun(builder, matrix, items, config, {
      seed,
      ...(options.holdoutShare === undefined ? {} : { holdoutShare: options.holdoutShare })
    })
  ) as [IncrementalRun, IncrementalRun];
  return {
    nmi: nmi(leafLabels(runs[0].tree, items), leafLabels(runs[1].tree, items)),
    runs
  };
}
