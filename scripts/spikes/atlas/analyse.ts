// The Atlas spike's analysis of one dataset (F5 D21): exact kNN purity in the vector space, UMAP over
// three seeds and PCA in 2-D, level-1 contiguity and components, Procrustes disparity between seeds,
// and the PNG scatter plots. No I/O besides the plots and the log callback.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { exactKnnGraph } from "@app/domain/topic-tree";

import { atlasCriterion } from "./criterion.js";
import type { DatasetOutcome } from "./criterion.js";
import type { AtlasDataset } from "./dataset.js";
import { branchComponents, chanceShare, nearestNeighbours2d, sharedLabelShare } from "./metrics.js";
import type { SharedLabelReport } from "./metrics.js";
import { pca2d } from "./pca.js";
import { scatterPng } from "./png.js";
import { maxPairwiseDisparity } from "./procrustes.js";
import { runUmap } from "./umap.js";

export interface BranchRow {
  title: string;
  members: number;
  share: number;
  components?: number;
  largestShare?: number;
}

export interface MapReport {
  /** Note-weighted level-1 contiguity (the registered statistic). */
  contiguity: number;
  /** Mean of the branch means (branches with at least `macroMinMembers` members). */
  macro: number;
  lowest: number;
  /** Among branches with at least `macroMinMembers` members. */
  branchesMeasured: number;
  singleComponentBranches: number;
  meanLargestComponentShare: number;
  byBranch: BranchRow[];
  png: string;
}

export interface SeedReport extends MapReport {
  seed: number;
  epochs: number;
  seconds: number;
}

export interface DatasetReport {
  name: string;
  weak: boolean;
  counts: AtlasDataset["counts"];
  branches: number;
  chance: number;
  purity1024: {
    overall: number;
    macro: number;
    lowest: number;
    byBranch: { title: string; members: number; share: number }[];
  };
  knnSeconds: number;
  umap: {
    seeds: SeedReport[];
    contiguityMean: number;
    contiguityMin: number;
    disparityMax: number;
    disparityPairs: { seeds: [number, number]; disparity: number }[];
  };
  pca: MapReport & { explained: [number, number] };
  outcome: DatasetOutcome;
}

function describeMap(points: Float64Array, dataset: AtlasDataset, png: string): MapReport {
  const k = atlasCriterion.neighbours;
  const table = nearestNeighbours2d(points, k);
  const share = sharedLabelShare(table, dataset.labels, k, atlasCriterion.macroMinMembers);
  const components = branchComponents(table, dataset.labels, k);
  const title = new Map(dataset.branches.map((branch) => [branch.index, branch.title] as const));
  const componentOf = new Map(components.map((entry) => [entry.label, entry] as const));
  const large = components.filter((entry) => entry.members >= atlasCriterion.macroMinMembers);
  return {
    contiguity: share.overall,
    macro: share.macro,
    lowest: share.lowest,
    branchesMeasured: large.length,
    singleComponentBranches: large.filter((entry) => entry.components === 1).length,
    meanLargestComponentShare:
      large.length === 0
        ? Number.NaN
        : large.reduce((sum, e) => sum + e.largestShare, 0) / large.length,
    byBranch: share.byLabel.map((entry) => ({
      title: title.get(entry.label) ?? `#${entry.label}`,
      members: entry.members,
      share: entry.share,
      components: componentOf.get(entry.label)?.components ?? 0,
      largestShare: componentOf.get(entry.label)?.largestShare ?? 0
    })),
    png
  };
}

function purityRows(report: SharedLabelReport, dataset: AtlasDataset) {
  const title = new Map(dataset.branches.map((branch) => [branch.index, branch.title] as const));
  return report.byLabel.map((entry) => ({
    title: title.get(entry.label) ?? `#${entry.label}`,
    members: entry.members,
    share: entry.share
  }));
}

export async function analyseDataset(
  dataset: AtlasDataset,
  outDir: string,
  log: (message: string) => void = () => {}
): Promise<DatasetReport> {
  const folder = join(outDir, dataset.name);
  await mkdir(folder, { recursive: true });
  const n = dataset.matrix.count;
  const k = atlasCriterion.neighbours;
  log(`${dataset.name}: ${n} points, ${dataset.branches.length} level-1 branches`);

  const knnStarted = performance.now();
  const rows = Array.from({ length: n }, (_, index) => index);
  const graph = exactKnnGraph(dataset.matrix, rows, atlasCriterion.umap.nNeighbors);
  const knnSeconds = (performance.now() - knnStarted) / 1000;
  log(`${dataset.name}: exact 1024-d kNN in ${knnSeconds.toFixed(1)} s`);
  const purity = sharedLabelShare(
    { neighbors: graph.neighbors, stride: graph.k },
    dataset.labels,
    k,
    atlasCriterion.macroMinMembers
  );

  const seeds: SeedReport[] = [];
  const maps: Float64Array[] = [];
  for (const seed of atlasCriterion.umap.seeds) {
    const run = runUmap(graph, seed, (epoch, epochs) => {
      if (epoch % 100 === 0 || epoch === epochs)
        log(`${dataset.name}: UMAP seed ${seed} epoch ${epoch}/${epochs}`);
    });
    const png = `umap-seed${seed}.png`;
    await writeFile(
      join(folder, png),
      scatterPng(run.points, dataset.labels, { radius: n > 5000 ? 2 : 4 })
    );
    maps.push(run.points);
    const report = describeMap(run.points, dataset, join(dataset.name, png));
    seeds.push({ ...report, seed, epochs: run.epochs, seconds: run.milliseconds / 1000 });
    log(
      `${dataset.name}: UMAP seed ${seed} contiguity ${report.contiguity.toFixed(3)} (${(run.milliseconds / 1000).toFixed(0)} s)`
    );
  }
  const disparity = maxPairwiseDisparity(maps);

  const projection = pca2d(dataset.matrix, 1);
  await writeFile(
    join(folder, "pca.png"),
    scatterPng(projection.points, dataset.labels, { radius: n > 5000 ? 2 : 4 })
  );
  const pca = {
    ...describeMap(projection.points, dataset, join(dataset.name, "pca.png")),
    explained: projection.explained
  };

  const contiguities = seeds.map((seed) => seed.contiguity);
  const contiguityMean = contiguities.reduce((a, b) => a + b, 0) / contiguities.length;
  const report: DatasetReport = {
    name: dataset.name,
    weak: dataset.weak,
    counts: dataset.counts,
    branches: dataset.branches.length,
    chance: chanceShare(dataset.labels),
    purity1024: {
      overall: purity.overall,
      macro: purity.macro,
      lowest: purity.lowest,
      byBranch: purityRows(purity, dataset)
    },
    knnSeconds,
    umap: {
      seeds,
      contiguityMean,
      contiguityMin: Math.min(...contiguities),
      disparityMax: disparity.max,
      disparityPairs: disparity.pairs.map((pair) => ({
        seeds: [atlasCriterion.umap.seeds[pair.a]!, atlasCriterion.umap.seeds[pair.b]!] as [
          number,
          number
        ],
        disparity: pair.disparity
      }))
    },
    pca,
    outcome: {
      name: dataset.name,
      weak: dataset.weak,
      contiguity: contiguityMean,
      disparity: disparity.max
    }
  };
  await writeFile(join(folder, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
