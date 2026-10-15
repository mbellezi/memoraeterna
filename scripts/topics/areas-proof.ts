// The Areas measurement of F2 T24 (D12) on the labelled DS-C replay stores, offline:
//
//   npx tsx scripts/topics/areas-proof.ts [--datasets corpus-notitle,corpus] [--seeds 1,2,3,4,5]
//     [--answers <dir>] [--prompts <dir>] [--out <file.json>]
//
// For each store and seed: the Louvain build (the product builder), then
//   built       the tree as built (Louvain Areas);
//   reparented  the Areas-level mis-parent pass alone: REBALANCE's re-parents of the depth-2 topics
//               the deterministic audit finds closer to another Area (what the Areas job runs after
//               a grouping, here without one);
//   standin     a geometric stand-in for the model's grouping (balanced spherical k-means of the
//               level-2 centroids into `areas.target` groups, untitled), put through the same
//               validation, regroup and acceptance: it measures the mechanics and the acceptance
//               bars, not a model;
//   grouped     with `--answers <dir>`: the recorded model answer `<dir>/<dataset>-<seed>.json`
//               (the raw output of the `topic.areas` call for this tree) through the same path.
// `--prompts <dir>` writes the exact `topic.areas` prompt of each built tree
// (`<dir>/<dataset>-<seed>.txt`), so an answer can be recorded through the app's writer route.
//
// Readings per state: Areas, level-2 topics, depth-1 domain purity and NMI, depth-2 NMI, the
// mis-parented depth-2 share, the level-2 centroid silhouette and the E2 shape readings. This is a
// measurement (T24); the Areas parameters are tuned in T29b on calibration seeds. Nothing is
// written but `--out` and `--prompts`; no model, database or network is used.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  areaGroupingInput,
  areaShape,
  buildLouvain,
  centralItems,
  centroidSilhouette,
  cloneTopicTreeState,
  createMatrix,
  defaultTopicTreeConfig,
  getTopic,
  groupsOf,
  level2TopicCount,
  levelOneTopic,
  misParentAudit,
  nmi,
  purity,
  rebalanceTree,
  regroupAreas,
  rowItemKey,
  rowOfItemKey,
  rowVectors,
  silhouettePoints,
  sphericalKMeans,
  subtreeItems,
  validateAreaProposal
} from "@app/domain/topic-tree";
import type {
  AreaGroupingInput,
  AreaProposal,
  AreaShape,
  ItemKey,
  ItemVectorSource,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import {
  buildTopicAreasPrompt,
  parseTopicAreasOutput
} from "../../apps/desktop/src/main/services/topic-tree/topic-prompts.js";
import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { loadReplayDataset } from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import { depthLabels } from "./replay-metrics.js";

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const now = "2026-10-15T12:00:00.000Z";
const day = "2026-10-15";

export interface AreasReading {
  areas: number;
  level2Topics: number;
  /** Spike B's "depth-1 domain purity": the mean over Areas of their top domain's item share. */
  depth1MeanPurity: number;
  /** Item-weighted: the share of items whose Area's top domain is their own. */
  depth1Purity: number;
  depth1Nmi: number;
  depth2Nmi: number;
  misParented: { depth2: number; topics: number; share: number };
  silhouette: number;
  shape: AreaShape;
}

/** The readings of a tree against the store's domain labels. */
export function areasReading(
  state: TopicTreeState,
  dataset: ReplayDataset,
  config: TopicTreeConfig
): AreasReading {
  const rows = Array.from({ length: dataset.rows.length }, (_, row) => row);
  const keys = rows.map(rowItemKey);
  const domain = Int32Array.from(rows, (row) => dataset.labels.domain[row] as number);
  const depth1 = depthLabels(state, keys, 1);
  const audit = misParentAudit(state, config);
  const depth2 = audit.byDepth.find((entry) => entry.depth === 2);
  const points = silhouettePoints(state);
  const areaIds = getTopic(state, state.rootId).children;
  const meanPurity =
    areaIds.reduce((sum, id) => {
      const counts = new Map<number, number>();
      const items = subtreeItems(state, id);
      for (const item of items) {
        const row = rowOfItemKey(item);
        if (row === undefined) continue;
        const label = dataset.labels.domain[row] as number;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const top = Math.max(0, ...counts.values());
      return sum + (items.length > 0 ? top / items.length : 0);
    }, 0) / Math.max(1, areaIds.length);
  return {
    areas: areaIds.length,
    level2Topics: level2TopicCount(state),
    depth1MeanPurity: round(meanPurity),
    depth1Purity: round(purity(depth1, domain)),
    depth1Nmi: round(nmi(depth1, domain)),
    depth2Nmi: round(nmi(depthLabels(state, keys, 2), domain)),
    misParented: {
      depth2: depth2?.misParented ?? 0,
      topics: depth2?.topics ?? 0,
      share: round(depth2?.share ?? 0)
    },
    silhouette: round(centroidSilhouette(state, points, (id) => levelOneTopic(state, id))),
    shape: { ...areaShape(state, config), meanDepth: round(areaShape(state, config).meanDepth) }
  };
}

let idCounter = 0;
/** Fresh topic IDs for the regroups (UUID-shaped, never reused). */
const newId = (): string =>
  `00000000-0000-4000-9000-${(idCounter += 1).toString(16).padStart(12, "0")}`;

/** The Areas-level mis-parent pass without a regroup (the second half of the Areas job). */
export function reparentAreasLevel(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  seed: number
): { reparented: number; ms: number } {
  const started = performance.now();
  const topics = misParentAudit(state, config)
    .findings.filter((finding) => finding.depth === 2 && finding.reparent && !finding.protected)
    .map((finding) => finding.topicId);
  if (topics.length === 0) return { reparented: 0, ms: 0 };
  const result = rebalanceTree({
    state,
    vectors,
    config,
    seed,
    now,
    day,
    newTopicId: newId,
    topics,
    conditions: new Set(["mis-parented"]),
    areasActive: true,
    areaLevelReview: false,
    force: true
  });
  return { reparented: result.applied.length, ms: round(performance.now() - started, 1) };
}

/** A geometric stand-in answer: balanced spherical k-means of the units' centroids. */
export function standInProposal(
  state: TopicTreeState,
  input: AreaGroupingInput,
  config: TopicTreeConfig,
  seed: number
): AreaProposal {
  const units = input.units.filter((unit) => getTopic(state, unit.topicId).stats.n > 0);
  const empty = input.units.filter((unit) => getTopic(state, unit.topicId).stats.n === 0);
  const matrix = createMatrix(units.length, state.dim);
  units.forEach((unit, row) =>
    matrix.data.set(getTopic(state, unit.topicId).stats.centroid, row * state.dim)
  );
  const rows = units.map((_, row) => row);
  const k = Math.max(config.areas.min, Math.min(config.areas.target, units.length));
  const result = sphericalKMeans(matrix, rows, {
    k,
    seed,
    minSize: 2,
    maxSize: config.fanOut.hardMax
  });
  const groups = groupsOf(result, units);
  if (groups.length > 0 && empty.length > 0) groups[0]!.push(...empty);
  return {
    areas: groups.map((group, index) => ({
      new: {
        title: `Área ${String.fromCharCode(65 + index)}`,
        description: "Agrupamento geométrico de referência."
      },
      members: group.map((unit) => unit.alias)
    }))
  };
}

export interface RegroupReading {
  valid: boolean;
  issues?: string[];
  accepted?: boolean;
  reasons?: string[];
  silhouette?: { before: number; after: number };
  reparented?: number;
  churnShare?: number;
  ms?: number;
  reading?: AreasReading;
}

/** A proposal through validation, the regroup on a copy and the acceptance, then the readings. */
export function measureProposal(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  dataset: ReplayDataset,
  config: TopicTreeConfig,
  seed: number,
  proposal: AreaProposal
): RegroupReading {
  const input = areaGroupingInput(state);
  const checked = validateAreaProposal(input, proposal, config);
  if (!checked.ok) {
    return { valid: false, issues: checked.issues.map((issue) => `${issue.code}:${issue.alias}`) };
  }
  const copy = cloneTopicTreeState(state);
  const started = performance.now();
  const result = regroupAreas({
    state: copy,
    vectors,
    config,
    input,
    proposal: checked.proposal,
    seed,
    now,
    day,
    newTopicId: newId,
    changeSetId: newId(),
    contentLanguage: "pt-BR"
  });
  return {
    valid: true,
    accepted: result.acceptance.accepted,
    reasons: result.acceptance.reasons,
    silhouette: {
      before: round(result.acceptance.silhouette.before),
      after: round(result.acceptance.silhouette.after)
    },
    reparented: result.reparented.length,
    churnShare: round(result.churn.share),
    ms: round(performance.now() - started, 1),
    reading: areasReading(copy, dataset, config)
  };
}

/** The `topic.areas` prompt of a tree, with central note titles from the store. */
export function areasPrompt(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  dataset: ReplayDataset,
  config: TopicTreeConfig
): string {
  const input = areaGroupingInput(state);
  const titleOf = (key: ItemKey): string | null => {
    const row = rowOfItemKey(key);
    return row === undefined ? null : (dataset.rows[row]?.title ?? null);
  };
  return buildTopicAreasPrompt({
    contentLanguage: "pt-BR",
    areas: { target: config.areas.target, min: config.areas.min, max: config.areas.max },
    pinned: [],
    topics: input.units.map((unit) => ({
      alias: unit.alias,
      titles: centralItems(state, vectors, unit.topicId, config.areas.centralTitles).flatMap(
        (item) => {
          const title = titleOf(item.key);
          return title ? [title] : [];
        }
      )
    }))
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      datasets: { type: "string" },
      seeds: { type: "string" },
      answers: { type: "string" },
      prompts: { type: "string" },
      out: { type: "string" }
    }
  });
  const datasets = (values.datasets ?? "corpus-notitle,corpus").split(",");
  const seeds = (values.seeds ?? "1,2,3,4,5").split(",").map(Number);
  const config = defaultTopicTreeConfig;
  const report: Record<string, unknown>[] = [];
  if (values.prompts) await mkdir(values.prompts, { recursive: true });
  for (const name of datasets) {
    const dataset = await loadReplayDataset(name, { twins: false });
    const vectors = rowVectors(dataset.matrix);
    const rows = Array.from({ length: dataset.rows.length }, (_, row) => row);
    for (const seed of seeds) {
      const started = performance.now();
      const { state } = buildLouvain(dataset.matrix, rows, {
        seed,
        config,
        detectCommunities: detectCommunitiesLouvain
      });
      const buildMs = round(performance.now() - started, 0);
      const built = areasReading(state, dataset, config);
      if (values.prompts) {
        await writeFile(
          join(values.prompts, `${name}-${seed}.txt`),
          areasPrompt(state, vectors, dataset, config)
        );
      }
      const standin = measureProposal(
        state,
        vectors,
        dataset,
        config,
        seed,
        standInProposal(state, areaGroupingInput(state), config, seed)
      );
      let grouped: RegroupReading | null = null;
      if (values.answers) {
        const file = join(values.answers, `${name}-${seed}.json`);
        const raw = await readFile(file, "utf8").catch(() => null);
        if (raw !== null) {
          grouped = measureProposal(
            state,
            vectors,
            dataset,
            config,
            seed,
            parseTopicAreasOutput(raw)
          );
        }
      }
      const reparentedState = cloneTopicTreeState(state);
      const pass = reparentAreasLevel(reparentedState, vectors, config, seed);
      const reparented = areasReading(reparentedState, dataset, config);
      report.push({
        dataset: name,
        seed,
        buildMs,
        built,
        reparented: { ...reparented, operations: pass.reparented, ms: pass.ms },
        standin,
        grouped
      });
      console.info(
        `${name} seed ${seed}: Areas ${built.areas}, level-2 ${built.level2Topics}; ` +
          `depth-1 mean purity ${built.depth1MeanPurity} -> ${reparented.depth1MeanPurity}, ` +
          `item purity ${built.depth1Purity} -> ${reparented.depth1Purity}, ` +
          `NMI ${built.depth1Nmi} -> ${reparented.depth1Nmi}; mis-parented depth 2 ` +
          `${built.misParented.depth2}/${built.misParented.topics} -> ` +
          `${reparented.misParented.depth2} (${pass.reparented} re-parents, ${pass.ms} ms); ` +
          `silhouette ${built.silhouette} -> ${reparented.silhouette}; stand-in ` +
          `${standin.accepted ? "accepted" : `rejected (${(standin.reasons ?? standin.issues ?? []).join(",")})`}` +
          (grouped
            ? `; model ${grouped.accepted ? "accepted" : `rejected (${(grouped.reasons ?? grouped.issues ?? []).join(",")})`}`
            : "")
      );
    }
  }
  if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
