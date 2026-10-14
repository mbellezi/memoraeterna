// Spike B on real embeddings: builders, incremental engine and calibration per
// dataset (public corpus, benchmark, owner pseudo-notes, mixed).
//
//   npx tsx scripts/spikes/topic-tree/embed-real.ts      (vectors first)
//   npx tsx scripts/spikes/topic-tree/run-real.ts [--only corpus,corpus-notitle,benchmark,owner,mixed]
//       [--skip incremental,churn,calibration]
//
// Writes .cache/spikes/topic-tree/real-results.json (merged per dataset) and
// real-results.md (tables). Datasets: corpus (titled pseudo-notes), corpus-notitle (same
// notes embedded without the article-title prefix), benchmark, owner, mixed.
//
// Growth runs (80/20) use four arrival orders: items (random notes), chronological (the
// import order), articles (whole new articles with their pt/en twins) and domains (whole
// new domains). Calibration holds out random items (optimistic: siblings of the same
// article stay in the base) and whole articles with their twins (new topics).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildTree } from "./builders.js";
import type { BuilderName } from "./builders.js";
import { defaultTreeConfig } from "./config.js";
import { evaluateTree } from "./evaluate.js";
import type { GrowthKind } from "./real-eval.js";
import { leafLabels, nmi } from "./metrics.js";
import type { ShapeReport } from "./metrics.js";
import { spikeDir } from "./real-data.js";
import { loadDatasets, seed } from "./real-datasets.js";
import {
  buildThenInsert,
  calibrate,
  chronological,
  growthSplit,
  insertFromEmpty,
  labelIds,
  languageReport,
  pocketReport,
  round,
  shuffled,
  truthReport,
  unitCount
} from "./real-eval.js";

const builders: BuilderName[] = ["top-down", "bottom-up", "louvain"];
const config = defaultTreeConfig;
const args = process.argv.slice(2);
const listArg = (flag: string): Set<string> | null => {
  const index = args.indexOf(flag);
  return index >= 0 ? new Set((args[index + 1] ?? "").split(",")) : null;
};
const only =
  listArg("--only") ?? new Set(["corpus", "corpus-notitle", "benchmark", "owner", "mixed"]);
const skip = listArg("--skip") ?? new Set<string>();

function shapeRow(shape: ShapeReport) {
  return {
    reachability: shape.reachability,
    nodes: shape.nodes,
    internal: shape.internalNodes,
    leaves: shape.leaves,
    depthMean: round(shape.itemDepth.mean, 2),
    depthP95: shape.itemDepth.p95,
    depthMax: shape.itemDepth.max,
    fanOut: {
      min: shape.fanOut.min,
      p50: shape.fanOut.p50,
      max: shape.fanOut.max,
      histogram: shape.fanOut.histogram,
      inTarget4to9: round(shape.fanOut.inTarget, 3)
    },
    leafSize: {
      min: shape.leafSize.min,
      p10: shape.leafSize.p10,
      p50: shape.leafSize.p50,
      p90: shape.leafSize.p90,
      max: shape.leafSize.max,
      histogram: shape.leafSize.histogram,
      inRange3to30: round(shape.leafSize.inRange, 3)
    },
    singleChildChains: shape.singleChildNodes,
    unsortedShare: round(shape.unsortedShare, 4),
    coherence: {
      leafMean: round(shape.coherence.leafWeightedMean, 3),
      leafP10: round(shape.coherence.leafP10, 3),
      internalMean: round(shape.coherence.internalMean, 3)
    },
    hardViolations: shape.violations.hard.length,
    hardExamples: shape.violations.hard.slice(0, 3)
  };
}

const resultsPath = join(spikeDir, "real-results.json");
const previous = await readFile(resultsPath, "utf8")
  .then((text) => JSON.parse(text) as Record<string, unknown>)
  .catch(() => ({}) as Record<string, unknown>);
const results: Record<string, unknown> = {
  ...previous,
  seed,
  config,
  updatedAt: new Date().toISOString(),
  datasets: { ...(previous.datasets as Record<string, unknown> | undefined) }
};
const datasetResults = results.datasets as Record<string, Record<string, unknown>>;

const datasets = await loadDatasets(only);
for (const [name, data] of datasets) {
  console.log(`\n=== ${name}: ${data.items.length} items`);
  const entry: Record<string, unknown> = {
    items: data.items.length,
    languages: {
      pt: data.lang.filter((lang) => lang === "pt").length,
      en: data.lang.filter((lang) => lang === "en").length
    },
    domains: new Set(data.domain).size,
    groups: new Set(data.group).size,
    twinGroups: new Set(data.twin).size,
    builders: {}
  };
  const builderResults = entry.builders as Record<string, unknown>;
  const domainIds = labelIds(data.domain);
  for (const builder of builders) {
    const started = performance.now();
    const { tree, repairs, diagnostics } = buildTree(builder, data.matrix, data.items, {
      seed,
      config
    });
    const buildMs = performance.now() - started;
    const evaluation = evaluateTree(tree, data.matrix, data.items, config, {
      seed,
      truth: domainIds,
      silhouetteSample: 2000
    });
    const again = buildTree(builder, data.matrix, data.items, { seed, config }).tree;
    const deterministic = leafLabels(again, data.items).every(
      (label, index) => label === leafLabels(tree, data.items)[index]
    );
    const result: Record<string, unknown> = {
      buildMs: Math.round(buildMs),
      finalRepairs: repairs.length,
      deterministic,
      shape: shapeRow(evaluation.shape),
      rootDiagnostics: diagnostics ?? null,
      silhouette: round(evaluation.silhouette, 4),
      // In-sample: the re-placed items are inside their own leaf's centroid. A diagnostic of
      // the tree's self-consistency only, never evidence for the ambiguity bar.
      placementInSample: {
        ambiguityRate: round(evaluation.placement.ambiguityRate, 4),
        crossParentAmbiguityRate: round(evaluation.placement.crossParentAmbiguityRate, 4),
        unadmittedRate: round(evaluation.placement.unadmittedRate, 4),
        replacementAgreement: round(evaluation.placement.agreement, 4)
      },
      truth: {
        leafNmiDomain: round(evaluation.truth?.leafNmi ?? 0, 4),
        cutNmiDomain: round(evaluation.truth?.cutNmi ?? 0, 4),
        ...Object.fromEntries(
          Object.entries(truthReport(tree, data)).map(([key, value]) => [key, round(value, 4)])
        )
      },
      language: Object.fromEntries(
        Object.entries(languageReport(tree, data)).map(([key, value]) => [key, round(value, 4)])
      )
    };
    if (name === "mixed") {
      result.pockets = ["owner", "benchmark"].map((dataset) => {
        const pocket = pocketReport(tree, data, dataset);
        return {
          ...pocket,
          leafPocketShare: round(pocket.leafPocketShare, 3),
          largestTopTopicShare: round(pocket.largestTopTopicShare, 3)
        };
      });
    }
    if (!skip.has("churn") && data.items.length >= 40) {
      const runs: Record<string, unknown> = {};
      for (const kind of ["items", "chronological", "articles", "domains"] as GrowthKind[]) {
        if ((kind === "articles" || kind === "domains") && unitCount(data, kind) < 5) continue;
        const { base, tail } = growthSplit(data, kind, 0.2, seed);
        const run = buildThenInsert(builder, data.matrix, base, tail, config, seed, { data });
        runs[kind] = {
          base: run.base,
          inserted: run.inserted,
          churn: round(run.churn, 4),
          insertMsPerItem: round(run.insertMsPerItem, 2),
          insertAmbiguityRate: round(run.insertAmbiguityRate, 4),
          insertCrossParentAmbiguityRate: round(run.insertCrossParentAmbiguityRate, 4),
          insertUnadmittedRate: round(run.insertUnadmittedRate, 4),
          insertGatedAtMargin: run.insertGatedAtMargin,
          operations: run.operations,
          reachability: run.shape.reachability,
          hardViolations: run.shape.violations.hard.length,
          leafSizeMax: run.shape.leafSize.max,
          fanOutMax: run.shape.fanOut.max,
          unsortedShare: round(run.shape.unsortedShare, 4),
          before: run.before,
          after: run.after,
          rootDiagnostics: run.rootDiagnostics ?? null
        };
      }
      result.churn80to20 = runs;
    }
    builderResults[builder] = result;
    const shape = result.shape as ReturnType<typeof shapeRow>;
    console.log(
      `${builder.padEnd(9)} ${Math.round(buildMs)} ms, reach ${shape.reachability}, ` +
        `depth ${shape.depthMean}/${shape.depthP95}, fan-out 4-9 ${shape.fanOut.inTarget4to9}, ` +
        `leaf 3-30 ${shape.leafSize.inRange3to30}, coh ${shape.coherence.leafMean}, ` +
        `sil ${result.silhouette as number}, amb(in-sample) ${JSON.stringify(result.placementInSample)}, ` +
        `truth ${JSON.stringify(result.truth)}, lang ${JSON.stringify(result.language)}` +
        (result.churn80to20
          ? `, growth ${JSON.stringify(result.churn80to20, (key, value) => (key === "operations" ? undefined : value))}`
          : "")
    );
  }

  if (!skip.has("incremental")) {
    const orders = { chronological: chronological(data), shuffled: shuffled(data, seed) };
    const runs = Object.fromEntries(
      Object.entries(orders).map(([label, order]) => [
        label,
        insertFromEmpty(data.matrix, order, config, seed)
      ])
    );
    const chrono = runs.chronological;
    const shuffle = runs.shuffled;
    const incremental: Record<string, unknown> = {};
    for (const [label, run] of Object.entries(runs)) {
      const evaluation = evaluateTree(run.engine.tree, data.matrix, data.items, config, {
        seed,
        truth: domainIds,
        silhouetteSample: 2000
      });
      incremental[label] = {
        insertMsPerItem: round(run.insertMsPerItem, 2),
        insertMsTotal: Math.round(run.insertMs),
        settleMs: Math.round(run.settleMs),
        settleOperations: run.settleOperations,
        insertAmbiguityRate: round(run.insertAmbiguityRate, 4),
        insertCrossParentAmbiguityRate: round(run.insertCrossParentAmbiguityRate, 4),
        insertUnadmittedRate: round(run.insertUnadmittedRate, 4),
        operations: run.operations,
        beforeSettle: shapeRow(run.shapeBeforeSettle),
        shape: shapeRow(run.shape),
        silhouette: round(evaluation.silhouette, 4),
        placementInSample: {
          ambiguityRate: round(evaluation.placement.ambiguityRate, 4),
          crossParentAmbiguityRate: round(evaluation.placement.crossParentAmbiguityRate, 4),
          unadmittedRate: round(evaluation.placement.unadmittedRate, 4)
        },
        truth: {
          leafNmiDomain: round(evaluation.truth?.leafNmi ?? 0, 4),
          cutNmiDomain: round(evaluation.truth?.cutNmi ?? 0, 4),
          ...Object.fromEntries(
            Object.entries(truthReport(run.engine.tree, data)).map(([key, value]) => [
              key,
              round(value, 4)
            ])
          )
        },
        language: Object.fromEntries(
          Object.entries(languageReport(run.engine.tree, data)).map(([key, value]) => [
            key,
            round(value, 4)
          ])
        )
      };
    }
    if (chrono && shuffle) {
      incremental.orderNmiLeaves = round(
        nmi(
          leafLabels(chrono.engine.tree, data.items),
          leafLabels(shuffle.engine.tree, data.items)
        ),
        4
      );
    }
    entry.incremental = incremental;
    console.log(
      `incremental ${JSON.stringify(incremental, (key, value) => (key === "histogram" ? undefined : value))}`
    );
  }

  if (!skip.has("calibration") && data.items.length >= 500) {
    const calibration: Record<string, unknown> = {};
    for (const builder of builders) {
      const reports = {
        items: calibrate(builder, data, config, seed, { holdout: "items" }),
        articles: calibrate(builder, data, config, seed, { holdout: "articles" })
      };
      calibration[builder] = reports;
      for (const [holdout, report] of Object.entries(reports)) {
        console.log(
          `calibration ${builder} (${holdout} held out): top1 domain ${round(report.top1DomainAccuracy)}, ` +
            `admitted ${round(report.admittedLeafRate)}, ` +
            `margins ${JSON.stringify(report.marginCurve.map((point) => [point.margin, round(point.gated), round(point.autoDomainPrecision)]))}`
        );
      }
    }
    entry.calibration = calibration;
  }
  datasetResults[name] = entry;
  // Re-read before writing so concurrent runs on other datasets are kept.
  const latest = await readFile(resultsPath, "utf8")
    .then((text) => JSON.parse(text) as { datasets?: Record<string, unknown> })
    .catch(() => ({}) as { datasets?: Record<string, unknown> });
  results.datasets = { ...latest.datasets, [name]: entry };
  await mkdir(spikeDir, { recursive: true });
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
}
console.log(`\nResults: ${resultsPath}`);
