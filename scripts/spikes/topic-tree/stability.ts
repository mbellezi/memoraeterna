// Spike B robustness runs (review follow-up): does the Louvain tree depend on the seed and
// on the sample, and does it keep its shape when the library grows?
//
//   npx tsx scripts/spikes/topic-tree/stability.ts --dataset corpus --mode build
//       [--grouping fixed|legacy] [--seeds 20261014,1,2,3,4,5] [--conditions full,items80,...]
//   npx tsx scripts/spikes/topic-tree/stability.ts --dataset corpus --mode growth
//   npx tsx scripts/spikes/topic-tree/stability.ts --dataset corpus --mode calibration
//   npx tsx scripts/spikes/topic-tree/stability.ts --summary
//
// build mode: builds Louvain for every seed on the whole library and on 80% bases (random
//   notes, the first 80% by import order, 80% of the articles with their pt/en twins). The
//   seed changes the build (kNN lists, Louvain order, k-means) and, where the base is
//   sampled, the sample. Reports the root fan-out and the depth-1 NMI per run.
// growth mode: build on 80%, insert the other 20% one by one, for each arrival order
//   (items, chronological, articles, domains), with the shape before and after.
// calibration mode: the F2 calibration (margin curve, z, a_min, leaf floor) on a different
//   held-out 20% of articles per seed, so settings picked on the main seed are validated on
//   other articles instead of the split they were tuned on.
//
// "legacy" grouping reproduces the root grouping of the first Spike B run (the 13 communities
// that collapsed to 2 Areas); "fixed" is the current code. Results are appended to
// .cache/spikes/topic-tree/stability-<mode>-<dataset>-<grouping>.json (a re-run skips finished
// runs); --summary prints the tables and writes stability.md.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildLouvain } from "./builders.js";
import { defaultTreeConfig } from "./config.js";
import { spikeDir } from "./real-data.js";
import { loadDatasets, seed as mainSeed } from "./real-datasets.js";
import {
  buildThenInsert,
  calibrate,
  growthSplit,
  observeTree,
  round,
  unitCount
} from "./real-eval.js";
import type { CalibrationReport, GrowthKind, HoldoutKind, TreeObservation } from "./real-eval.js";

const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const config = defaultTreeConfig;

interface BuildRun {
  condition: string;
  seed: number;
  items: number;
  rootCommunities: number;
  rootChildren: number;
  rootSuperGrouped: boolean;
  rootKmeansFallback: boolean;
  innerSuperGroupings: number;
  observation: TreeObservation;
  buildMs: number;
}

interface GrowthRun {
  kind: GrowthKind;
  seed: number;
  base: number;
  inserted: number;
  churn: number;
  insertUnadmittedRate: number;
  insertGatedAtMargin: Record<string, number>;
  insertMsPerItem: number;
  before: TreeObservation;
  after: TreeObservation;
  rootCommunities: number | null;
  rootSuperGrouped: boolean | null;
}

interface CalibrationRun {
  seed: number;
  holdout: HoldoutKind;
  report: CalibrationReport;
}

type RunFile<T> = { dataset: string; mode: string; grouping: string; runs: T[] };

const filePath = (mode: string, dataset: string, grouping: string): string =>
  join(spikeDir, `stability-${mode}-${dataset}-${grouping}.json`);

async function readRuns<T>(path: string): Promise<T[]> {
  try {
    return (JSON.parse(await readFile(path, "utf8")) as RunFile<T>).runs;
  } catch {
    return [];
  }
}

async function runExperiments(): Promise<void> {
  const dataset = argOf("--dataset") ?? "corpus";
  const mode = argOf("--mode") ?? "build";
  const grouping = (argOf("--grouping") ?? "fixed") as "fixed" | "legacy";
  const seeds = (argOf("--seeds") ?? `${mainSeed},1,2,3,4,5`).split(",").map(Number);
  const data = (await loadDatasets(new Set([dataset]))).get(dataset);
  if (!data) throw new Error(`No vectors for dataset ${dataset}`);
  const path = filePath(mode, dataset, grouping);
  await mkdir(spikeDir, { recursive: true });

  if (mode === "build") {
    const conditions = (argOf("--conditions") ?? "full,items80,chrono80,articles80").split(",");
    const runs = await readRuns<BuildRun>(path);
    for (const condition of conditions) {
      for (const seed of seeds) {
        if (runs.some((run) => run.condition === condition && run.seed === seed)) continue;
        let items: number[];
        if (condition === "full") items = data.items;
        else if (condition === "items80") items = growthSplit(data, "items", 0.2, seed).base;
        else if (condition === "chrono80")
          items = growthSplit(data, "chronological", 0.2, seed).base;
        else if (condition === "articles80") items = growthSplit(data, "articles", 0.2, seed).base;
        else throw new Error(`Unknown condition ${condition}`);
        const started = performance.now();
        const { tree, diagnostics } = buildLouvain(data.matrix, items, {
          seed,
          config,
          rootGrouping: grouping
        });
        const run: BuildRun = {
          condition,
          seed,
          items: items.length,
          rootCommunities: diagnostics?.rootCommunities ?? 0,
          rootChildren: diagnostics?.rootChildren ?? 0,
          rootSuperGrouped: diagnostics?.rootSuperGrouped ?? false,
          rootKmeansFallback: diagnostics?.rootKmeansFallback ?? false,
          innerSuperGroupings: diagnostics?.innerSuperGroupings.length ?? 0,
          observation: observeTree(tree, data, items, config),
          buildMs: Math.round(performance.now() - started)
        };
        runs.push(run);
        await writeFile(path, `${JSON.stringify({ dataset, mode, grouping, runs }, null, 2)}\n`);
        console.log(
          `${dataset} ${grouping} ${condition} seed ${seed}: root ${run.rootChildren} ` +
            `(communities ${run.rootCommunities}${run.rootSuperGrouped ? ", super-grouped" : ""}), ` +
            `depth ${run.observation.depthMean}, depth-1 NMI ${run.observation.depth1NmiDomain}, ${run.buildMs} ms`
        );
      }
    }
  } else if (mode === "growth") {
    const kinds = (argOf("--kinds") ?? "items,chronological,articles,domains").split(
      ","
    ) as GrowthKind[];
    const runs = await readRuns<GrowthRun>(path);
    for (const kind of kinds) {
      if ((kind === "articles" || kind === "domains") && unitCount(data, kind) < 5) continue;
      for (const seed of seeds) {
        if (runs.some((run) => run.kind === kind && run.seed === seed)) continue;
        const { base, tail } = growthSplit(data, kind, 0.2, seed);
        const result = buildThenInsert("louvain", data.matrix, base, tail, config, seed, {
          data,
          rootGrouping: grouping
        });
        const run: GrowthRun = {
          kind,
          seed,
          base: result.base,
          inserted: result.inserted,
          churn: round(result.churn, 4),
          insertUnadmittedRate: round(result.insertUnadmittedRate, 4),
          insertGatedAtMargin: result.insertGatedAtMargin,
          insertMsPerItem: round(result.insertMsPerItem, 3),
          before: result.before as TreeObservation,
          after: result.after as TreeObservation,
          rootCommunities: result.rootDiagnostics?.rootCommunities ?? null,
          rootSuperGrouped: result.rootDiagnostics?.rootSuperGrouped ?? null
        };
        runs.push(run);
        await writeFile(path, `${JSON.stringify({ dataset, mode, grouping, runs }, null, 2)}\n`);
        console.log(
          `${dataset} ${grouping} growth ${kind} seed ${seed}: churn ${run.churn}, ` +
            `root ${run.before.rootChildren}->${run.after.rootChildren}, ` +
            `depth ${run.before.depthMean}->${run.after.depthMean}, ` +
            `unadmitted ${run.insertUnadmittedRate}, gated@0.03 ${run.insertGatedAtMargin["0.03"]}`
        );
      }
    }
  } else if (mode === "calibration") {
    const runs = await readRuns<CalibrationRun>(path);
    for (const holdout of ["articles", "articles-twin-in-base", "items"] as const) {
      for (const seed of seeds) {
        if (runs.some((run) => run.holdout === holdout && run.seed === seed)) continue;
        const report = calibrate("louvain", data, config, seed, {
          holdout,
          rootGrouping: grouping
        });
        runs.push({ seed, holdout, report });
        await writeFile(path, `${JSON.stringify({ dataset, mode, grouping, runs }, null, 2)}\n`);
        const at = (margin: number) => report.marginCurve.find((point) => point.margin === margin);
        console.log(
          `${dataset} calibration ${holdout} seed ${seed}: top1 ${round(report.top1DomainAccuracy, 3)}, ` +
            `admitted ${round(report.admittedLeafRate, 3)}, gated@0.03 ${round(at(0.03)?.gated ?? 0, 3)}, ` +
            `auto precision@0.03 ${round(at(0.03)?.autoDomainPrecision ?? 0, 3)}`
        );
      }
    }
  } else {
    throw new Error(`Unknown mode ${mode}`);
  }
}

// ---------------------------------------------------------------------------
// Summary

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};
const range = (values: number[], digits = 2): string => {
  if (values.length === 0) return "-";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const fmt = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(digits);
  return min === max ? fmt(min) : `${fmt(min)} / ${fmt(median(values))} / ${fmt(max)}`;
};
const pct = (values: number[], digits = 1): string =>
  values.length === 0
    ? "-"
    : (() => {
        const f = (v: number): string => `${(v * 100).toFixed(digits)}%`;
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        return lo === hi ? f(lo) : `${f(lo)} / ${f(median(values))} / ${f(hi)}`;
      })();

async function summarize(): Promise<void> {
  const names = (await readdir(spikeDir)).filter((name) =>
    /^stability-(build|growth|calibration)-.*\.json$/.test(name)
  );
  const lines: string[] = [
    "# Spike B robustness (min / median / max over seeds)",
    "",
    "Root children = Areas under the root. Depth-1 NMI = depth-1 partition against Wikipedia domains.",
    ""
  ];
  for (const name of names.sort()) {
    const file = JSON.parse(await readFile(join(spikeDir, name), "utf8")) as RunFile<
      BuildRun | GrowthRun | CalibrationRun
    >;
    if (file.mode === "calibration") {
      const runs = file.runs as CalibrationRun[];
      lines.push(
        `## Calibration, ${file.dataset}, ${file.grouping} root grouping (a different held-out 20% per seed)`,
        "",
        "| Held out | Seeds | Top-1 domain | Admitted to a leaf | Gated at 0.02 | Gated at 0.03 | Gated at 0.05 | Auto precision at 0.03 | Reference leaf kept at z=2.5 | Other-domain admitted at z=2.5 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
      );
      for (const holdout of ["articles", "articles-twin-in-base", "items"] as const) {
        const group = runs.filter((run) => run.holdout === holdout).map((run) => run.report);
        if (group.length === 0) continue;
        const gated = (margin: number): number[] =>
          group.map(
            (report) => report.marginCurve.find((point) => point.margin === margin)?.gated ?? 0
          );
        const z25 = group.map((report) => report.zCurve.find((point) => point.z === 2.5));
        lines.push(
          `| ${holdout} | ${group.length} | ${pct(group.map((report) => report.top1DomainAccuracy))} | ${pct(group.map((report) => report.admittedLeafRate))} | ` +
            `${pct(gated(0.02))} | ${pct(gated(0.03))} | ${pct(gated(0.05))} | ` +
            `${pct(group.map((report) => report.marginCurve.find((point) => point.margin === 0.03)?.autoDomainPrecision ?? 0))} | ` +
            `${pct(z25.map((point) => point?.ownAdmitted ?? 0))} | ${pct(z25.map((point) => point?.otherAdmitted ?? 0))} |`
        );
      }
      lines.push("");
    } else if (file.mode === "build") {
      const runs = file.runs as BuildRun[];
      lines.push(
        `## Build, ${file.dataset}, ${file.grouping} root grouping`,
        "",
        "| Base | Seeds | Root communities | Root children | Runs with at most 3 Areas | Depth-1 NMI | Depth-2 NMI | Depth mean | Fan-out 4-9 | Leaf purity |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
      );
      for (const condition of [...new Set(runs.map((run) => run.condition))]) {
        const group = runs.filter((run) => run.condition === condition);
        lines.push(
          `| ${condition} (${group[0]?.items} notes) | ${group.length} | ${range(group.map((run) => run.rootCommunities))} | ` +
            `${range(group.map((run) => run.rootChildren))} | ${group.filter((run) => run.rootChildren <= 3).length} | ` +
            `${range(group.map((run) => run.observation.depth1NmiDomain))} | ${range(group.map((run) => run.observation.depth2NmiDomain))} | ` +
            `${range(group.map((run) => run.observation.depthMean))} | ${pct(
              group.map((run) => run.observation.fanOutInTarget),
              0
            )} | ` +
            `${pct(
              group.map((run) => run.observation.leafDomainPurity),
              1
            )} |`
        );
      }
      lines.push("");
    } else {
      const runs = file.runs as GrowthRun[];
      lines.push(
        `## Growth 80/20, ${file.dataset}, ${file.grouping} root grouping`,
        "",
        "| Arrival | Seeds | Root children before -> after | Depth mean before | Depth mean after | Depth-1 NMI before -> after | Fan-out 4-9 before -> after | Churn | Insert unadmitted | Insert gated at 0.03 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
      );
      for (const kind of [...new Set(runs.map((run) => run.kind))]) {
        const group = runs.filter((run) => run.kind === kind);
        lines.push(
          `| ${kind} | ${group.length} | ${range(group.map((run) => run.before.rootChildren))} -> ${range(group.map((run) => run.after.rootChildren))} | ` +
            `${range(group.map((run) => run.before.depthMean))} | ${range(group.map((run) => run.after.depthMean))} | ` +
            `${range(group.map((run) => run.before.depth1NmiDomain))} -> ${range(group.map((run) => run.after.depth1NmiDomain))} | ` +
            `${pct(
              group.map((run) => run.before.fanOutInTarget),
              0
            )} -> ${pct(
              group.map((run) => run.after.fanOutInTarget),
              0
            )} | ` +
            `${pct(group.map((run) => run.churn))} | ${pct(group.map((run) => run.insertUnadmittedRate))} | ` +
            `${pct(group.map((run) => run.insertGatedAtMargin["0.03"] ?? 0))} |`
        );
      }
      lines.push("");
    }
  }
  const out = join(spikeDir, "stability.md");
  await writeFile(out, `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  console.log(`Wrote ${out}`);
}

if (args.includes("--summary")) await summarize();
else await runExperiments();
