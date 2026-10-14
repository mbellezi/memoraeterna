// Self-check of the Spike B topic-tree algorithms on synthetic hierarchical
// Gaussian clusters (8 groups x 5 clusters x 50 points, 64-d):
//   - every builder satisfies the shape invariants and recovers the clusters
//     (leaf NMI >= 0.8) deterministically for a fixed seed;
//   - incremental insertion keeps reachability at 100% (last 20% into a built
//     tree, and a fully incremental build from an empty tree in two orders).
//
//   npx tsx scripts/spikes/topic-tree/selfcheck.ts
//
// Writes .cache/spikes/topic-tree/selfcheck.json and exits 1 on any failed check.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildLouvain, buildTree } from "./builders.js";
import type { BuilderName } from "./builders.js";
import { defaultTreeConfig } from "./config.js";
import { countOperations, evaluateTree, incrementalRun, orderStability } from "./evaluate.js";
import { IncrementalTopicEngine } from "./incremental.js";
import { leafLabels, nmi, purity, shapeReport, statsDrift } from "./metrics.js";
import { createRng } from "./rng.js";
import type { ShapeReport } from "./metrics.js";
import { defaultSyntheticOptions, gaussianClusters } from "./synthetic.js";

const seed = 20261014;
const config = defaultTreeConfig;
const data = gaussianClusters(defaultSyntheticOptions);
const items = Array.from({ length: data.matrix.count }, (_, index) => index);
const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
};

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

function checkShape(label: string, shape: ShapeReport, strict: boolean): void {
  check(
    `${label} reachability`,
    shape.reachability === 1,
    `${round(shape.reachability * 100, 2)}%`
  );
  check(
    `${label} hard invariants`,
    shape.violations.hard.length === 0,
    shape.violations.hard.slice(0, 3).join("; ") || "none"
  );
  if (!strict) return;
  check(
    `${label} fan-out 2-12`,
    shape.fanOut.inRange === 1,
    `range ${shape.fanOut.min}-${shape.fanOut.max}, in target 4-9: ${round(shape.fanOut.inTarget * 100, 1)}%`
  );
  check(
    `${label} leaf size 3-30`,
    shape.leafSize.inRange === 1,
    `range ${shape.leafSize.min}-${shape.leafSize.max}, median ${shape.leafSize.p50}`
  );
  check(
    `${label} depth <= target ${config.depth.target} (cap ${config.depth.cap})`,
    shape.leafDepth.max <= config.depth.target,
    `max leaf depth ${shape.leafDepth.max}, mean item depth ${round(shape.itemDepth.mean, 2)}`
  );
  check(
    `${label} no single-child chains`,
    shape.singleChildNodes === 0,
    `${shape.singleChildNodes}`
  );
}

const report: Record<string, unknown> = {
  data: {
    ...defaultSyntheticOptions,
    items: items.length,
    clusters: new Set(data.clusters).size
  },
  seed,
  config
};

const builders: BuilderName[] = ["top-down", "bottom-up", "louvain"];
const builderReports: Record<string, unknown> = {};
for (const builder of builders) {
  console.log(`\n== ${builder}`);
  const started = performance.now();
  const { tree, repairs } = buildTree(builder, data.matrix, items, { seed, config });
  const buildMs = performance.now() - started;
  const evaluation = evaluateTree(tree, data.matrix, items, config, {
    seed,
    truth: data.clusters
  });
  checkShape(builder, evaluation.shape, true);
  const leafNmi = evaluation.truth?.leafNmi ?? 0;
  check(
    `${builder} recovers clusters`,
    leafNmi >= 0.8,
    `leaf NMI ${round(leafNmi)}, purity ${round(evaluation.truth?.leafPurity ?? 0)}, ` +
      `cut NMI ${round(evaluation.truth?.cutNmi ?? 0)}`
  );
  const again = buildTree(builder, data.matrix, items, { seed, config }).tree;
  const deterministic = leafLabels(again, items).every(
    (label, index) => label === leafLabels(tree, items)[index]
  );
  check(`${builder} deterministic`, deterministic, deterministic ? "same leaves" : "leaves differ");
  console.log(
    `      ${evaluation.shape.leaves} leaves, ${evaluation.shape.internalNodes} internal, ` +
      `silhouette ${round(evaluation.silhouette)}, ambiguity ${round(evaluation.placement.ambiguityRate * 100, 1)}% ` +
      `(cross-parent ${round(evaluation.placement.crossParentAmbiguityRate * 100, 1)}%), ` +
      `re-placement agreement ${round(evaluation.placement.agreement * 100, 1)}%, ` +
      `${repairs.length} repairs, ${Math.round(buildMs)} ms`
  );

  const run = incrementalRun(builder, data.matrix, items, config, { seed });
  checkShape(`${builder} + 20% incremental`, run.shape, false);
  console.log(
    `      churn ${round(run.churn * 100, 1)}%, insert ambiguity ${round(run.insertAmbiguityRate * 100, 1)}% ` +
      `(cross-parent ${round(run.insertCrossParentAmbiguityRate * 100, 1)}%), ` +
      `unadmitted ${round(run.insertUnadmittedRate * 100, 1)}%, ops ${JSON.stringify(run.operations)}`
  );
  const stability = orderStability(builder, data.matrix, items, config, {
    seeds: [seed, seed + 1]
  });
  console.log(`      order-stability NMI ${round(stability.nmi)}`);

  builderReports[builder] = {
    buildMs: Math.round(buildMs),
    repairs: repairs.length,
    evaluation,
    incremental: {
      churn: run.churn,
      insertAmbiguityRate: run.insertAmbiguityRate,
      insertCrossParentAmbiguityRate: run.insertCrossParentAmbiguityRate,
      insertUnadmittedRate: run.insertUnadmittedRate,
      operations: run.operations,
      shape: run.shape
    },
    orderStabilityNmi: stability.nmi
  };
}
report.builders = builderReports;

console.log("\n== removals (40% of items, then 20% re-inserted)");
{
  const engine = new IncrementalTopicEngine(
    buildTree("top-down", data.matrix, items, { seed, config }).tree,
    data.matrix,
    config,
    seed
  );
  const order = createRng(seed).shuffle([...items]);
  const removed = order.slice(0, Math.round(order.length * 0.4));
  for (const item of removed) engine.remove(item);
  const back = removed.slice(0, Math.round(order.length * 0.2));
  for (const item of back) engine.insert(item);
  const present = items.filter((item) => engine.tree.itemNode.has(item));
  const shape = shapeReport(engine.tree, config, present);
  checkShape("after removals", shape, false);
  const drift = statsDrift(engine.tree, data.matrix);
  check(
    "after removals N/LS consistent",
    drift.maxCountError === 0 && drift.maxSumError < 1e-6,
    `max N error ${drift.maxCountError}, max |LS| error ${drift.maxSumError.toExponential(2)}`
  );
  check(
    "after removals root N",
    engine.tree.node(engine.tree.rootId).n === present.length,
    `${engine.tree.node(engine.tree.rootId).n} of ${present.length}`
  );
  const operations = countOperations(engine.operations);
  console.log(
    `      ${shape.leaves} leaves, leaf ${shape.leafSize.min}-${shape.leafSize.max}, ` +
      `fan-out ${shape.fanOut.min}-${shape.fanOut.max}, ops ${JSON.stringify(operations)}`
  );
  report.removals = { shape, drift, operations };
}

console.log("\n== incremental from an empty tree");
const stability = orderStability("incremental", data.matrix, items, config, {
  seeds: [seed, seed + 1]
});
stability.runs.forEach((run, index) => {
  checkShape(`incremental order ${index + 1}`, run.shape, false);
  const settled = run.engine.settle();
  const settledShape = shapeReport(run.tree, config, items);
  checkShape(`incremental order ${index + 1} settled`, settledShape, false);
  const leaves = leafLabels(run.tree, items);
  console.log(
    `      ${run.shape.leaves} leaves, depth max ${run.shape.leafDepth.max}, fan-out max ${run.shape.fanOut.max}, ` +
      `leaf ${run.shape.leafSize.min}-${run.shape.leafSize.max}, NMI vs truth ${round(nmi(leaves, data.clusters))}, ` +
      `purity ${round(purity(leaves, data.clusters))}, ops ${JSON.stringify(run.operations)}, settle ops ${settled.length}`
  );
});
console.log(`      order-stability NMI ${round(stability.nmi)}`);
report.incrementalFromEmpty = {
  orderStabilityNmi: stability.nmi,
  runs: stability.runs.map((run) => ({
    shape: run.shape,
    insertAmbiguityRate: run.insertAmbiguityRate,
    insertUnadmittedRate: run.insertUnadmittedRate,
    operations: run.operations
  }))
};
console.log("\n== Louvain root with more communities than fan-out.max (Spike B review)");
{
  // 13 well-separated blobs: Louvain finds 13 communities at the root, above fan-out.max (12)
  // but inside the old acceptance window (up to 1.5 x 9). The old root grouping then aimed at
  // round(13 / 6) = 2 super-groups and left 2 Areas.
  const wide = gaussianClusters({
    ...defaultSyntheticOptions,
    groups: 13,
    clustersPerGroup: 1,
    pointsPerCluster: 60,
    seed: 11
  });
  const wideItems = Array.from({ length: wide.matrix.count }, (_, index) => index);
  const fixed = buildLouvain(wide.matrix, wideItems, { seed, config });
  const legacy = buildLouvain(wide.matrix, wideItems, { seed, config, rootGrouping: "legacy" });
  const rootChildren = fixed.diagnostics?.rootChildren ?? 0;
  check(
    "louvain root fan-out within 2-12",
    rootChildren >= config.fanOut.min && rootChildren <= config.fanOut.max,
    `${rootChildren} Areas from ${fixed.diagnostics?.rootCommunities ?? 0} communities` +
      `${fixed.diagnostics?.rootSuperGrouped ? " (grouped)" : ""}`
  );
  check(
    "louvain root keeps at least fan-out.targetMin Areas",
    rootChildren >= config.fanOut.targetMin,
    `${rootChildren} Areas (legacy grouping: ${legacy.diagnostics?.rootChildren ?? 0}, ` +
      `${legacy.diagnostics?.rootCommunities ?? 0} communities)`
  );
  check(
    "legacy root grouping reproduces the collapse",
    (legacy.diagnostics?.rootChildren ?? 99) < config.fanOut.targetMin,
    `${legacy.diagnostics?.rootChildren ?? 0} Areas`
  );
  const shape = shapeReport(fixed.tree, config, wideItems);
  checkShape("louvain wide root", shape, false);
  report.louvainWideRoot = {
    fixed: fixed.diagnostics,
    legacy: legacy.diagnostics,
    rootChildren
  };
}

report.failures = failures;

const outputDir = join(resolve(import.meta.dirname, "../../.."), ".cache", "spikes", "topic-tree");
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "selfcheck.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  `\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`} ` +
    `(report: ${join(outputDir, "selfcheck.json")})`
);
if (failures.length > 0) process.exitCode = 1;
