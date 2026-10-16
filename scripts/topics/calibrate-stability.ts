// T29b: stability, growth and structure calibration (spec section 9), offline and on calibration
// seeds only (7-12). Every grid and rule here was registered in the T29b evidence file
// (`.cache/topics/reports/t29b/evidence.md`) before it ran.
//
//   npx tsx scripts/topics/calibrate-stability.ts grid --part weekly --orders chronological
//   npx tsx scripts/topics/calibrate-stability.ts grid --part e2 --orders chronological,items
//   npx tsx scripts/topics/calibrate-stability.ts grid --part growth
//   npx tsx scripts/topics/calibrate-stability.ts summarize
//   npx tsx scripts/topics/calibrate-stability.ts grid --points <id> --seed 8 --part weekly ...
//   npx tsx scripts/topics/calibrate-stability.ts confirm --point <id> --seeds 7,8,9
//   npx tsx scripts/topics/calibrate-stability.ts doubling --point <id> --seeds 7,8,9
//   npx tsx scripts/topics/calibrate-stability.ts bootstrap
//   npx tsx scripts/topics/calibrate-stability.ts areas --seeds 7,8,9
//   npx tsx scripts/topics/calibrate-stability.ts presets --seed 7
//
// grid       grid S (stability-calibration.ts): `weekly` is the E3 replay on DS-C with simulated
//            naming, `e2` the E2 growth protocol, `growth` ENV-G and ENV-F grown source by source
//            (growth-quality.ts); one JSONL row per run in `--out` (default
//            .cache/topics/reports/t29b). `--points` runs a subset (default: every point).
// summarize  rule S on seed 7's rows, the ranking in `grid-s.{json,md}`.
// confirm    the confirmation of a point on seeds 7-9 (its rows must exist), rule R (renameDrift)
//            on those runs.
// doubling   `rebuild.doublingMaxItems`: DS-C cold starts grown article by article to 1,000 rows.
// bootstrap  the cold-start rule on DS-G subsets of 11-30 notes (the rating appendix).
// areas      the Areas target and minLevel2Topics with the geometric stand-in grouping on DS-C.
// presets    the shape of Broad, Balanced and Deep on DS-C.
//
// Grid points apply to the registered base (registeredGridBase: the start values of the knobs T29b
// adopted later), so rows replay as they ran; `--base defaults` uses today's defaults (the final
// readings). Datasets are replay stores read through `MEMORA_TOPICS_CACHE` (a worktree points it
// at the main checkout's `.cache`); the ENV-F fixture pairs come from the matching fixture's
// mapping.
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  areaGroupingInput,
  buildLouvain,
  cloneTopicTreeState,
  coldStartKind,
  createRng,
  defaultTopicTreeConfig,
  deriveSeed,
  getTopic,
  level2TopicCount,
  purity,
  rowVectors,
  shapeReport,
  smallLibraryPartition,
  topicTreeConfigForPreset,
  topicTreeConfigWith,
  topicTreePresets
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { measureProposal, standInProposal } from "./areas-proof.js";
import {
  assertSeedAllowed,
  cacheRoot,
  loadReplayDataset,
  repoRoot,
  subsetDataset
} from "./datasets.js";
import type { ArrivalOrder, GrowthKind, ReplayDataset } from "./datasets.js";
import { sourceGrowthRun, sourcesInOrder } from "./growth-quality.js";
import type { FixturePairs, GrowthCalendar } from "./growth-quality.js";
import { NamingSimulator } from "./naming-sim.js";
import { createRealEngineFactory, replayGates } from "./real-engine.js";
import type { ReplayGate } from "./reference-engine.js";
import { summarizeShape } from "./report-data.js";
import { growthRun, weeklyRun } from "./replay.js";
import type { ReplayRun } from "./replay.js";
import { rowKeys, truthSummary } from "./replay-metrics.js";
import {
  CalibrationRowSchema,
  chooseRenameDrift,
  configForGridPoint,
  confirmPoint,
  dailyCallCap,
  gridPointId,
  gridSPoints,
  parseGridPointId,
  rankGrid,
  registeredGridBase,
  renameDriftGrid,
  summarizeGrid
} from "./stability-calibration.js";
import type {
  E2Row,
  GrowthRow,
  StabilityCalibrationRow,
  StabilityGridPoint,
  WeeklyRow
} from "./stability-calibration.js";

const log = (message: string): void => console.info(`[t29b] ${message}`);

/** The configuration grid points apply to (`--base registered|defaults`). */
let gridBase: TopicTreeConfig = registeredGridBase();
const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const seconds = (started: number): number => round((performance.now() - started) / 1000, 1);

async function appendRow(out: string, file: string, row: StabilityCalibrationRow): Promise<void> {
  await mkdir(out, { recursive: true });
  await appendFile(join(out, file), `${JSON.stringify(CalibrationRowSchema.parse(row))}\n`);
}

/** Every row in `rows-*.jsonl` of `out` (the last row of a run wins). */
export async function readRows(out: string): Promise<StabilityCalibrationRow[]> {
  const files = (await readdir(out)).filter((name) => /^rows-.*\.jsonl$/u.test(name)).sort();
  const rows = new Map<string, StabilityCalibrationRow>();
  for (const name of files) {
    for (const line of (await readFile(join(out, name), "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      const row = CalibrationRowSchema.parse(JSON.parse(line));
      const key =
        row.kind === "growth"
          ? `${row.kind}|${row.point}|${row.seed}|${row.dataset}|${row.calendar}`
          : `${row.kind}|${row.point}|${row.seed}|${row.order}`;
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

// ---------------------------------------------------------------------------
// Grid S runs

function pointsOf(value: string | undefined): StabilityGridPoint[] {
  if (!value || value === "all") return gridSPoints();
  return value.split(",").map((id) => parseGridPointId(id.trim()));
}

async function weeklyPart(
  dataset: ReplayDataset,
  points: readonly StabilityGridPoint[],
  seed: number,
  orders: readonly ArrivalOrder[],
  out: string
): Promise<void> {
  const buildCache = new Map();
  for (const order of orders) {
    for (const point of points) {
      const started = performance.now();
      const config = configForGridPoint(gridBase, point);
      const naming = new NamingSimulator(renameDriftGrid, config.naming.maxTopicsPerCall);
      const run: ReplayRun = {
        dataset,
        config,
        seed,
        detect: detectCommunitiesLouvain,
        createEngine: createRealEngineFactory({ gate: "baseline", buildCache })
      };
      const { report } = weeklyRun(run, { order, naming });
      const maxRenameRate: Record<string, number> = {};
      const staleness: Record<string, number> = {};
      for (const threshold of renameDriftGrid) {
        const name = String(threshold);
        const rates = report.weeks.map((week) =>
          week.naming && week.naming.topics > 0
            ? (week.naming.renamed[name] ?? 0) / week.naming.topics
            : 0
        );
        maxRenameRate[name] = round(Math.max(0, ...rates), 6);
        const stale = report.weeks.map((week) => week.naming?.staleness[name] ?? 0);
        staleness[name] = round(stale.reduce((a, b) => a + b, 0) / Math.max(1, stale.length));
      }
      const operations = report.weeks.reduce(
        (total, week) =>
          total + Object.values(week.operations).reduce((sum, value) => sum + (value ?? 0), 0),
        0
      );
      const row: WeeklyRow = {
        kind: "weekly",
        point: gridPointId(point),
        seed,
        order,
        configHash: report.configHash,
        maxChurn: report.maxChurn,
        medianChurn: report.medianChurn,
        fanOutInTarget: report.final.shape.fanOutInTarget,
        depthMean: report.final.shape.depthMean,
        leafInRange: report.final.shape.leafInRange,
        reachability: report.final.shape.reachability,
        hardViolations: report.final.shape.hardViolations,
        operations,
        rebuilds: report.weeks.flatMap((week) => (week.rebuild ? [week.rebuild.trigger] : [])),
        maxRenameRate,
        staleness,
        peakDayCalls: naming.peakDayCalls(),
        seconds: seconds(started)
      };
      await appendRow(out, `rows-weekly-${seed}-${order}.jsonl`, row);
      log(
        `weekly ${row.point} seed ${seed} ${order}: max churn ${(row.maxChurn * 100).toFixed(2)}%, ` +
          `fan-out ${(row.fanOutInTarget * 100).toFixed(1)}%, renames@0.3 ` +
          `${((maxRenameRate["0.3"] ?? 0) * 100).toFixed(2)}%, rebuilds ${row.rebuilds.length}, ` +
          `${row.seconds} s`
      );
    }
  }
}

async function e2Part(
  dataset: ReplayDataset,
  points: readonly StabilityGridPoint[],
  seed: number,
  orders: readonly GrowthKind[],
  out: string
): Promise<void> {
  const buildCache = new Map();
  for (const order of orders) {
    for (const point of points) {
      const started = performance.now();
      const run: ReplayRun = {
        dataset,
        config: configForGridPoint(gridBase, point),
        seed,
        detect: detectCommunitiesLouvain,
        createEngine: createRealEngineFactory({ gate: "baseline", buildCache })
      };
      const { report } = growthRun(run, { kind: order, share: 0.2 });
      const shape = report.settled.shape;
      const row: E2Row = {
        kind: "e2",
        point: gridPointId(point),
        seed,
        order,
        configHash: report.configHash,
        fanOutInTarget: shape.fanOutInTarget,
        depthMean: shape.depthMean,
        singleChildTopics: shape.singleChildTopics,
        reachability: shape.reachability,
        hardViolations: shape.hardViolations,
        seconds: seconds(started)
      };
      await appendRow(out, `rows-e2-${seed}-${order}.jsonl`, row);
      log(
        `e2 ${row.point} seed ${seed} ${order}: fan-out ${(row.fanOutInTarget * 100).toFixed(1)}%, ` +
          `depth ${row.depthMean}, ${row.seconds} s`
      );
    }
  }
}

/** The ENV-F fixture's expected and forbidden root pairs, by the store's root source IDs. */
async function fixturePairs(): Promise<FixturePairs | null> {
  try {
    const mapping = JSON.parse(
      await readFile(join(cacheRoot(), "golden", "matching-fixture", "mapping.json"), "utf8")
    ) as {
      roots: { id: string; title: string }[];
      expectedRootPairs: { pair: [string, string] }[];
      forbiddenRootPairs: { pair: [string, string] }[];
    };
    const exported = JSON.parse(
      await readFile(join(cacheRoot(), "topics", "exports", "env-f", "export.json"), "utf8")
    ) as { roots: { id: string; title: string }[] };
    const byTitle = new Map(exported.roots.map((root) => [root.title, root.id]));
    const sourceOf = new Map<string, string>();
    for (const root of mapping.roots) {
      const id = byTitle.get(root.title);
      if (id) sourceOf.set(root.id, id);
    }
    const map = (pairs: { pair: [string, string] }[]): [string, string][] =>
      pairs.flatMap(({ pair: [a, b] }) => {
        const left = sourceOf.get(a);
        const right = sourceOf.get(b);
        return left && right ? [[left, right] as [string, string]] : [];
      });
    return { expected: map(mapping.expectedRootPairs), forbidden: map(mapping.forbiddenRootPairs) };
  } catch (error) {
    log(`no fixture pairs: ${(error as Error).message}`);
    return null;
  }
}

async function growthPart(
  points: readonly StabilityGridPoint[],
  seed: number,
  out: string,
  datasets: readonly string[] = ["env-g", "env-f"],
  calendars: readonly GrowthCalendar[] = ["session", "daily"],
  gate: ReplayGate = "baseline"
): Promise<void> {
  const pairs = await fixturePairs();
  for (const name of datasets) {
    const dataset = await loadReplayDataset(name, { twins: false });
    for (const calendar of calendars) {
      for (const point of points) {
        const reading = sourceGrowthRun(dataset, {
          calendar,
          seed,
          config: configForGridPoint(gridBase, point),
          detect: detectCommunitiesLouvain,
          renameDrifts: renameDriftGrid,
          gate,
          ...(name === "env-f" && pairs ? { pairs } : {})
        });
        const row: GrowthRow = {
          kind: "growth",
          point: gridPointId(point),
          seed,
          dataset: name,
          calendar,
          configHash: reading.configHash,
          leafPurity: reading.agreement.leafPurity,
          freshPurity: reading.agreement.freshPurity,
          leafNmi: reading.agreement.leafNmi,
          depth1Nmi: reading.agreement.depth1Nmi,
          leaves: reading.grown.leaves,
          freshLeaves: reading.fresh.leaves,
          rebuilds: reading.rebuilds.map((rebuild) => `${rebuild.trigger}@${rebuild.atRows}`),
          fixturePasses: reading.fixture?.grown.passes ?? null,
          fixtureExpected: reading.fixture?.grown.expected.sameLeafOrSibling ?? null,
          fixtureForbidden: reading.fixture?.grown.forbidden.sameLeafOrSibling ?? null,
          renamed: reading.naming.renamed,
          peakDayCalls: reading.naming.peakDayCalls,
          reachability: reading.grown.reachability,
          hardViolations: reading.grown.hardViolations
        };
        await appendRow(out, `rows-growth-${seed}-${name}-${calendar}.jsonl`, row);
        log(
          `growth ${row.point} ${name} ${calendar}${gate === "baseline" ? "" : ` gate ${gate}`}: ` +
            `purity ${row.leafPurity} (fresh ` +
            `${row.freshPurity}), NMI ${row.leafNmi}, leaves ${row.leaves}/${row.freshLeaves}, ` +
            `rebuilds ${row.rebuilds.join(" ") || "-"}` +
            (row.fixturePasses === null
              ? ""
              : `, fixture ${row.fixtureExpected} vs ${row.fixtureForbidden}`)
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summaries

function pct(value: number, digits = 1): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "-";
}

async function summarize(out: string, seed: number): Promise<void> {
  const rows = await readRows(out);
  const points = gridSPoints().map(gridPointId);
  const ranking = rankGrid(summarizeGrid(rows, points, seed));
  await writeFile(join(out, "grid-s.json"), `${JSON.stringify({ seed, ranking }, null, 2)}\n`);
  const header = [
    "Point",
    "Eligible",
    "Worst weekly churn",
    "Weekly fan-out 4-9",
    "E2 min / mean fan-out",
    "Growth leaf purity",
    "Growth leaf NMI",
    "Fixture passes",
    "Ops",
    "Reasons"
  ];
  const line = (cells: readonly (string | number)[]): string => `| ${cells.join(" | ")} |`;
  const markdown = [
    `# T29b grid S (seed ${seed})`,
    "",
    line(header),
    line(header.map(() => "---")),
    ...ranking.map((summary) =>
      line([
        summary.point,
        summary.eligible ? "yes" : "no",
        pct(summary.worstWeeklyChurn, 2),
        pct(summary.medianWeeklyFanOut),
        `${pct(summary.minE2FanOut)} / ${pct(summary.meanE2FanOut)}`,
        summary.growthLeafPurity.toFixed(3),
        summary.growthLeafNmi.toFixed(3),
        summary.fixturePasses,
        summary.operations,
        summary.reasons.join("; ") || "-"
      ])
    ),
    ""
  ].join("\n");
  await writeFile(join(out, "grid-s.md"), markdown);
  for (const summary of ranking.slice(0, 8)) {
    log(
      `${summary.eligible ? "eligible" : "        "} ${summary.point}: purity ` +
        `${summary.growthLeafPurity.toFixed(3)}, NMI ${summary.growthLeafNmi.toFixed(3)}, churn ` +
        `${pct(summary.worstWeeklyChurn, 2)}, weekly fan-out ${pct(summary.medianWeeklyFanOut)}, ` +
        `E2 ${pct(summary.minE2FanOut)} ${summary.reasons.join("; ")}`
    );
  }
}

async function confirm(out: string, point: string, seeds: readonly number[]): Promise<void> {
  const rows = await readRows(out);
  const confirmation = confirmPoint(rows, point, seeds);
  const weekly = rows.filter(
    (row): row is WeeklyRow =>
      row.kind === "weekly" && row.point === point && seeds.includes(row.seed)
  );
  const rename = chooseRenameDrift(weekly);
  const growth = rows.filter(
    (row): row is GrowthRow => row.kind === "growth" && row.point === point
  );
  const peakCalls = (threshold: number): number =>
    Math.max(0, ...[...weekly, ...growth].map((row) => row.peakDayCalls[String(threshold)] ?? 0));
  const evidence = [
    // ENV-C's cold start (export change-sets): 73 naming calls and 7 repairs, the Areas call,
    // and the label vectors of 1,509 topics in 200-label calls on a remote embedding route.
    { label: "ENV-C bootstrap day (80 naming + 1 Areas + 8 remote label calls)", calls: 89 },
    { label: "ENV-G record day (3 naming calls; 8 topic AI calls with labels)", calls: 8 },
    {
      label: `simulated busiest day at renameDrift ${rename.chosen} (weekly and growth replays)`,
      calls: peakCalls(rename.chosen)
    }
  ];
  const cap = dailyCallCap(evidence);
  const result = { confirmation, renameDrift: rename, dailyCalls: { evidence, cap } };
  await writeFile(join(out, `confirm-${point}.json`), `${JSON.stringify(result, null, 2)}\n`);
  log(
    `confirm ${point}: ${confirmation.passes ? "passes" : "fails"}; median-seed max churn ` +
      `${Object.entries(confirmation.medianSeedMaxChurn)
        .map(([order, value]) => `${order} ${pct(value, 2)}`)
        .join(", ")}; E2 median ${pct(confirmation.e2MedianFanOut)} min ` +
      `${pct(confirmation.e2MinFanOut)}; renameDrift ${rename.chosen} ` +
      `(${Object.entries(rename.worstRate)
        .map(([threshold, rate]) => `${threshold}: ${pct(rate, 2)}`)
        .join(", ")}); daily cap ${cap}`
  );
}

// ---------------------------------------------------------------------------
// Rebuild on doubling (DS-C cold starts grown to 1,000 rows)

/** Whole articles of DS-C in a seeded order until `limit` rows, as a dataset in arrival order. */
export function articleGrowthDataset(
  dataset: ReplayDataset,
  seed: number,
  limit: number
): ReplayDataset {
  const byArticle = new Map<number, number[]>();
  for (let row = 0; row < dataset.rows.length; row += 1) {
    const group = dataset.labels.group[row] as number;
    const list = byArticle.get(group) ?? [];
    list.push(row);
    byArticle.set(group, list);
  }
  const articles = createRng(deriveSeed(seed, "t29b-articles")).shuffle([...byArticle.keys()]);
  const rows: number[] = [];
  for (const article of articles) {
    if (rows.length >= limit) break;
    rows.push(...(byArticle.get(article) ?? []));
  }
  const subset = subsetDataset(dataset, rows);
  return {
    ...subset,
    rows: subset.rows.map((row, order) => ({
      ...row,
      order,
      rootSourceId: `article-${subset.labels.group[order]}`
    }))
  };
}

async function doubling(
  out: string,
  point: StabilityGridPoint,
  seeds: readonly number[],
  values: readonly number[],
  limit: number
): Promise<void> {
  const corpus = await loadReplayDataset("corpus-notitle", { twins: false });
  const results: Record<string, unknown>[] = [];
  for (const seed of seeds) {
    assertSeedAllowed(seed, "calibration");
    const dataset = articleGrowthDataset(corpus, seed, limit);
    const rows = dataset.rows.map((_, row) => row);
    for (const value of values) {
      const config = topicTreeConfigWith(
        { rebuild: { doublingMaxItems: value } },
        configForGridPoint(gridBase, point)
      );
      const reading = sourceGrowthRun(dataset, {
        calendar: "daily",
        seed,
        config,
        detect: detectCommunitiesLouvain
      });
      results.push({
        seed,
        doublingMaxItems: value,
        rows: rows.length,
        rebuilds: reading.rebuilds.map((rebuild) => `${rebuild.trigger}@${rebuild.atRows}`),
        leafPurityVsFresh: reading.agreement.leafPurity,
        leafNmiVsFresh: reading.agreement.leafNmi,
        grownLeafDomainPurity: reading.truth.grown?.leafDomainPurity ?? null,
        freshLeafDomainPurity: reading.truth.fresh?.leafDomainPurity ?? null
      });
      log(
        `doubling ${value} seed ${seed}: rebuilds ${reading.rebuilds.length}, purity vs fresh ` +
          `${reading.agreement.leafPurity}, domain purity ${reading.truth.grown?.leafDomainPurity} ` +
          `vs fresh ${reading.truth.fresh?.leafDomainPurity}`
      );
    }
  }
  await writeFile(join(out, "doubling.json"), `${JSON.stringify(results, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Bootstrap on DS-G subsets of 11-30 notes

async function bootstrap(out: string, modularities: readonly number[]): Promise<void> {
  const dataset = await loadReplayDataset("env-g", { twins: false });
  const sources = sourcesInOrder(dataset);
  const sizes = [11, 12, 15, 20, 25, 30];
  const subsets: { name: string; rows: number[] }[] = [];
  for (const size of sizes) {
    // Single source: the first notes of the two sources that have enough.
    for (const source of sources.filter((entry) => entry.rows.length >= size)) {
      subsets.push({
        name: `single ${source.id.slice(0, 8)} n${size}`,
        rows: source.rows.slice(0, size)
      });
    }
    // Mixed: the first notes in manifest order, and seeded draws across the library.
    subsets.push({
      name: `manifest-first n${size}`,
      rows: sources.flatMap((entry) => entry.rows).slice(0, size)
    });
    for (const seed of [7, 8, 9, 10, 11, 12]) {
      const all = createRng(deriveSeed(seed, "t29b-bootstrap")).shuffle(
        sources.flatMap((entry) => entry.rows)
      );
      subsets.push({ name: `mixed s${seed} n${size}`, rows: all.slice(0, size) });
    }
  }
  const sourceOf = new Map<number, string>();
  for (const source of sources) for (const row of source.rows) sourceOf.set(row, source.id);
  const results: Record<string, unknown>[] = [];
  for (const modularityMin of modularities) {
    const config = topicTreeConfigWith({ bootstrap: { modularityMin } });
    let sensible = 0;
    for (const subset of subsets) {
      const kind = coldStartKind(subset.rows.length, config);
      const sorted = [...subset.rows].sort((a, b) => a - b);
      const groups =
        kind === "wait"
          ? []
          : smallLibraryPartition(dataset.matrix, sorted, config, 7, detectCommunitiesLouvain)
              .groups;
      const counts = new Map<string, number>();
      for (const row of subset.rows) {
        const id = sourceOf.get(row) as string;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const bigSources = [...counts.values()].filter((value) => value >= config.leaf.min).length;
      const labels = new Map<number, number>();
      groups.forEach((group, index) => {
        for (const row of group) labels.set(row, index);
      });
      const truth = new Map([...counts.keys()].map((id, index) => [id, index]));
      const topicLabels = Int32Array.from(subset.rows, (row) => labels.get(row) ?? -1);
      const sourceLabels = Int32Array.from(subset.rows, (row) => truth.get(sourceOf.get(row)!)!);
      const sourcePurity = groups.length > 0 ? purity(topicLabels, sourceLabels) : 0;
      // The registered proxy of "sensible": one source stays at most two topics; a mix of sources
      // with leaf.min notes or more splits along them (purity >= 0.9) when two or more do.
      const ok =
        kind === "wait"
          ? subset.rows.length < config.bootstrap.minItems
          : bigSources <= 1
            ? groups.length <= 2
            : groups.length >= 2 && sourcePurity >= 0.9;
      if (ok) sensible += 1;
      results.push({
        modularityMin,
        subset: subset.name,
        rows: subset.rows.length,
        kind,
        topics: groups.length,
        sources: counts.size,
        sourcesWithLeafMin: bigSources,
        sourcePurity: round(sourcePurity),
        sensible: ok
      });
    }
    log(`bootstrap modularityMin ${modularityMin}: ${sensible}/${subsets.length} sensible`);
  }
  await writeFile(join(out, "bootstrap.json"), `${JSON.stringify(results, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Areas: the target and minLevel2Topics with the geometric stand-in

async function areas(
  out: string,
  seeds: readonly number[],
  targets: readonly number[],
  sizes: readonly number[]
): Promise<void> {
  const corpus = await loadReplayDataset("corpus-notitle", { twins: false });
  const results: Record<string, unknown>[] = [];
  for (const seed of seeds) {
    assertSeedAllowed(seed, "calibration");
    const all = corpus.rows.map((_, row) => row);
    const built = buildLouvain(corpus.matrix, all, {
      seed,
      config: defaultTopicTreeConfig,
      detectCommunities: detectCommunitiesLouvain
    });
    const vectors = rowVectors(corpus.matrix);
    for (const target of targets) {
      const config = topicTreeConfigWith({ areas: { target } });
      const state = cloneTopicTreeState(built.state);
      const proposal = standInProposal(state, areaGroupingInput(state), config, seed);
      const reading = measureProposal(state, vectors, corpus, config, seed, proposal);
      results.push({ part: "target", seed, target, ...reading });
      log(
        `areas target ${target} seed ${seed}: accepted ${reading.accepted}, depth-1 NMI ` +
          `${reading.reading?.depth1Nmi}, purity ${reading.reading?.depth1Purity}, mis-parented ` +
          `${reading.reading?.misParented.share}, fan-out ${reading.reading?.shape.fanOutInTarget}`
      );
    }
    for (const size of sizes) {
      const subset = articleGrowthDataset(corpus, seed, size);
      const rows = subset.rows.map((_, row) => row);
      const small = buildLouvain(subset.matrix, rows, {
        seed,
        config: defaultTopicTreeConfig,
        detectCommunities: detectCommunitiesLouvain
      });
      const level2 = level2TopicCount(small.state);
      const proposal = standInProposal(
        small.state,
        areaGroupingInput(small.state),
        defaultTopicTreeConfig,
        seed
      );
      const reading = measureProposal(
        small.state,
        rowVectors(subset.matrix),
        subset,
        defaultTopicTreeConfig,
        seed,
        proposal
      );
      results.push({ part: "size", seed, rows: size, level2, ...reading });
      log(
        `areas size ${size} seed ${seed}: level-2 ${level2}, valid ${reading.valid}, accepted ` +
          `${reading.accepted ?? "-"} ${reading.reasons?.join(",") ?? reading.issues?.join(",") ?? ""}`
      );
    }
  }
  await writeFile(join(out, "areas.json"), `${JSON.stringify(results, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Presets

async function presets(out: string, seed: number): Promise<void> {
  assertSeedAllowed(seed, "calibration");
  const corpus = await loadReplayDataset("corpus-notitle", { twins: false });
  const rows = corpus.rows.map((_, row) => row);
  const results: Record<string, unknown>[] = [];
  for (const preset of topicTreePresets) {
    const config = topicTreeConfigForPreset(preset);
    const built = buildLouvain(corpus.matrix, rows, {
      seed,
      config,
      detectCommunities: detectCommunitiesLouvain
    });
    const report = shapeReport(built.state, config, { expectedItems: rowKeys(rows) });
    const shape = summarizeShape(report, getTopic(built.state, built.state.rootId).children.length);
    const truth = truthSummary(built.state, corpus, rows);
    results.push({ preset, seed, fanOut: config.fanOut, leaf: config.leaf, shape, truth });
    log(
      `preset ${preset}: depth ${shape.depthMean}, fan-out in own target ` +
        `${pct(shape.fanOutInTarget)}, leaves in own range ${pct(shape.leafInRange)}, leaves ` +
        `${shape.leaves}, hard ${shape.hardViolations}, purity ${truth?.leafDomainPurity}`
    );
  }
  await writeFile(join(out, "presets.json"), `${JSON.stringify(results, null, 2)}\n`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      part: { type: "string" },
      points: { type: "string" },
      point: { type: "string" },
      seed: { type: "string" },
      seeds: { type: "string" },
      orders: { type: "string" },
      datasets: { type: "string" },
      calendars: { type: "string" },
      values: { type: "string" },
      targets: { type: "string" },
      sizes: { type: "string" },
      limit: { type: "string" },
      base: { type: "string" },
      // growth only: how gated items are resolved (real-engine.ts; owner decision 19: fallback)
      gate: { type: "string" }
    }
  });
  if (values.base === "defaults") gridBase = defaultTopicTreeConfig;
  else if (values.base !== undefined && values.base !== "registered") {
    throw new Error("--base is registered or defaults");
  }
  const command = positionals[0];
  const out = values.out ?? join(repoRoot, ".cache", "topics", "reports", "t29b");
  await mkdir(out, { recursive: true });
  const seed = Number(values.seed ?? 7);
  const seeds = (values.seeds ?? "7,8,9").split(",").map(Number);
  const list = (value: string | undefined, fallback: string): string[] =>
    (value ?? fallback).split(",").map((entry) => entry.trim());
  switch (command) {
    case "grid": {
      assertSeedAllowed(seed, "calibration");
      const points = pointsOf(values.points);
      const part = values.part ?? "weekly";
      if (part === "weekly") {
        const corpus = await loadReplayDataset("corpus-notitle");
        const orders = list(values.orders, "chronological,shuffled") as ArrivalOrder[];
        await weeklyPart(corpus, points, seed, orders, out);
      } else if (part === "e2") {
        const corpus = await loadReplayDataset("corpus-notitle");
        const orders = list(values.orders, "chronological,items") as GrowthKind[];
        await e2Part(corpus, points, seed, orders, out);
      } else if (part === "growth") {
        const gate = (values.gate ?? "baseline") as ReplayGate;
        if (!replayGates.includes(gate)) throw new Error("--gate is baseline, off or fallback");
        await growthPart(
          points,
          seed,
          out,
          list(values.datasets, "env-g,env-f"),
          list(values.calendars, "session,daily") as GrowthCalendar[],
          gate
        );
      } else {
        throw new Error(`Unknown part ${part}`);
      }
      return 0;
    }
    case "summarize":
      await summarize(out, seed);
      return 0;
    case "confirm":
      if (!values.point) throw new Error("confirm needs --point");
      for (const entry of seeds) assertSeedAllowed(entry, "calibration");
      await confirm(out, values.point, seeds);
      return 0;
    case "doubling":
      await doubling(
        out,
        parseGridPointId(values.point ?? gridPointId(gridSPoints()[0]!)),
        seeds,
        list(values.values, "0,250,500,1000").map(Number),
        Number(values.limit ?? 1000)
      );
      return 0;
    case "bootstrap":
      await bootstrap(out, list(values.values, "0.05,0.1,0.15,0.2").map(Number));
      return 0;
    case "areas":
      await areas(
        out,
        seeds,
        list(values.targets, "8,10,12").map(Number),
        list(values.sizes, "500,1000,2000,4000").map(Number)
      );
      return 0;
    case "presets":
      await presets(out, seed);
      return 0;
    default:
      console.error(
        "Usage: calibrate-stability.ts <grid|summarize|confirm|doubling|bootstrap|areas|presets>"
      );
      return 2;
  }
}

const invokedDirectly = process.argv[1]?.endsWith("calibrate-stability.ts") ?? false;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    }
  );
}
