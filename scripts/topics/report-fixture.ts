// Exports of synthetic trees for the report's tests and the CLI's smoke run: a labelled dataset of
// seeded Gaussian clusters is built into a tree with the product's own builder, the tree is written
// through `exportTopicTree` (the same code `topics:export` runs, over a fake source) and the files
// land in a cache folder exactly where `topics:report` looks for them.
//
// `fresh`: the app's tree IS the fresh build (what a single cold-start build gives).
// `incremental`: the tree is built on the first rows and the rest is placed into the nearest leaf,
// as PLACE does between rebalances, so it differs from a fresh build of the same vectors.
import { createHash } from "node:crypto";

import type { TopicSkeleton } from "@app/db";
import {
  buildLouvain,
  defaultTopicTreeConfig,
  rowItemKey,
  rowOfItemKey,
  insertPlacement,
  placementRecord,
  recomputeSubtree,
  registerItem,
  rowContentHash,
  walkTopics
} from "@app/domain/topic-tree";
import type { TopicNode, TopicTreeConfig, TopicTreeState } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { subsetDataset } from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import { exportTopicTree } from "./export-tree.js";
import type { ExportNote, TopicExportSource } from "./export-tree.js";
import { contentKeyOrder, rowVectorSource } from "./report-core.js";
import { syntheticDataset } from "./synthetic-dataset.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const uuid = (kind: number, n: number): string =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export interface FixtureOptions {
  name: string;
  cacheDirectory: string;
  mode: "fresh" | "incremental";
  seed?: number;
  config?: TopicTreeConfig;
  dataset?: ReplayDataset;
  /** Extra change-sets to list, by origin (the export lists what the service recorded). */
  changeSetOrigins?: Record<string, number>;
  /** Daily metrics rows to export. */
  dailyMetrics?: number;
  /** Gate decisions to export: this many accepted (the item still sits in the chosen topic), one "none" and one chosen elsewhere. */
  gateDecisions?: number;
  withVectors?: boolean;
}

export interface FixtureResult {
  noteIds: string[];
  state: TopicTreeState;
  /** The dataset in content-key order: row i is `noteIds[i]`. */
  dataset: ReplayDataset;
}

const space = {
  spaceKey: "fixture-space",
  provider: "test",
  model: "fixture-embed",
  runtime: "none"
};

export async function writeFixtureExport(options: FixtureOptions): Promise<FixtureResult> {
  const config = options.config ?? defaultTopicTreeConfig;
  const seed = options.seed ?? 20261014;
  const base = options.dataset ?? syntheticDataset();
  // Rows get note IDs, and the fixture's rows go in content-key order (D22) from here on.
  const idOf = (row: number): string => uuid(1, row);
  const rows = base.rows.map((row, index) => ({
    ...row,
    id: idOf(index),
    contentHash: sha(`note-${index}`)
  }));
  const dataset = subsetDataset({ ...base, rows }, contentKeyOrder({ rows }));
  const noteIds = dataset.rows.map((row) => row.id);
  const all = Array.from({ length: dataset.rows.length }, (_, row) => row);
  const baseRows = options.mode === "fresh" ? all : all.filter((_, at) => at % 5 < 3);
  const built = buildLouvain(dataset.matrix, baseRows, {
    seed,
    config,
    detectCommunities: detectCommunitiesLouvain
  });
  const state = built.state;
  if (options.mode === "incremental") {
    const vectors = rowVectorSource(dataset.matrix);
    const dim = dataset.matrix.dim;
    const leaves: TopicNode[] = [];
    walkTopics(state, (node) => {
      if (node.children.length === 0 && node.id !== state.rootId) leaves.push(node);
    });
    for (const row of all.filter((_, at) => at % 5 >= 3)) {
      let best = leaves[0]!;
      let bestCosine = -Infinity;
      for (const leaf of leaves) {
        let dot = 0;
        for (let k = 0; k < dim; k += 1)
          dot +=
            (dataset.matrix.data[row * dim + k] as number) * (leaf.stats.centroid[k] as number);
        if (dot > bestCosine) {
          bestCosine = dot;
          best = leaf;
        }
      }
      registerItem(state, {
        key: rowItemKey(row),
        kind: "note",
        contentHash: rowContentHash(row),
        rootSource: null
      });
      insertPlacement(
        state,
        rowItemKey(row),
        placementRecord(best.id, {
          decidedBy: "auto",
          margin: 0.03 + (row % 7) / 100,
          score: bestCosine
        })
      );
    }
    recomputeSubtree(state, vectors);
  }

  const groups = [...new Set(dataset.rows.map((row) => row.rootSourceId))].sort();
  const rootIdOf = (group: string): string => uuid(2, groups.indexOf(group));
  const notes: ExportNote[] = dataset.rows.map((row, index) => ({
    id: row.id,
    title: row.title,
    language: row.lang,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    rootSourceId: rootIdOf(row.rootSourceId),
    rootTitle: `Article ${row.rootSourceId}`
  }));
  const roots = groups.map((group, index) => ({
    id: rootIdOf(group),
    title: `Article ${group}`,
    type: "WebArticle",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, index, 0)).toISOString()
  }));
  const skeleton = skeletonOf(state, dataset, noteIds, roots, config, seed);

  const source: TopicExportSource = {
    loadSkeleton: async () => skeleton,
    listNotes: async () => notes,
    rootSources: async () => roots,
    loadNoteVectors: async () => ({
      dim: dataset.matrix.dim,
      keys: noteIds.map((id) => `note:${id}`),
      contentHashes: dataset.rows.map((row) => row.contentHash),
      matrix: dataset.matrix,
      missing: [],
      stale: []
    }),
    gateDecisions: async () => {
      const total = options.gateDecisions ?? 0;
      if (total === 0) return [];
      const primary = new Map(
        skeleton.placements.filter((p) => p.itemKind === "note").map((p) => [p.itemId, p.topicId])
      );
      const decision = (index: number, chosen: string | null, none: boolean) => ({
        id: uuid(7, index),
        itemKind: "note",
        itemId: noteIds[index]!,
        itemHash: sha(`item-${index}`),
        descriptorSetHash: sha("set"),
        deciderKey: "ranker-fixture",
        candidates: [
          { topicId: primary.get(noteIds[index]!), logOdds: 2.5 },
          { topicId: chosen, logOdds: 0.5 }
        ],
        chosenTopicId: chosen,
        noneOfThese: none,
        createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, index)).toISOString()
      });
      return [
        ...Array.from({ length: total }, (_, index) =>
          decision(index, primary.get(noteIds[index]!)!, false)
        ),
        decision(total, null, true),
        decision(total + 1, skeleton.topics[0]!.id, false)
      ];
    },
    changeSets: async () => {
      const origins = options.changeSetOrigins ?? { build: 1 };
      const items = Object.entries(origins).flatMap(([origin, total], at) =>
        Array.from({ length: total }, (_, index) => ({
          id: uuid(3, at * 1000 + index),
          origin,
          status: "applied",
          risk: "low",
          titleKey: `topics.changeSets.${origin}`,
          undoOf: null,
          generation: at * 1000 + index + 1,
          createdAt: new Date(Date.UTC(2026, 9, 1 + (index % 3), 12, 0, 0)).toISOString(),
          appliedAt: null,
          undoneAt: null,
          summary: {}
        }))
      );
      return {
        items,
        total: items.length,
        byOrigin: origins,
        byStatus: { applied: items.length }
      };
    },
    dailyMetrics: async () =>
      Array.from({ length: options.dailyMetrics ?? 0 }, (_, day) => ({
        day: `2026-10-${String(1 + day).padStart(2, "0")}`,
        opsApplied: 2,
        itemsMoved: day,
        primaryPathChanges: day === 3 ? 6 : 1,
        unsortedShare: 0.01,
        meanDepth: 3.2,
        fanoutInTarget: 0.85,
        hardViolations: 0,
        softViolations: 1,
        gateCalls: day % 2,
        namingCalls: 1
      }))
  };
  await exportTopicTree(source, {
    name: options.name,
    cacheDirectory: options.cacheDirectory,
    vectors: options.withVectors ?? true,
    label: `fixture ${options.mode}`,
    now: () => new Date("2026-10-15T12:00:00.000Z")
  });
  return { noteIds, state, dataset };
}

function skeletonOf(
  state: TopicTreeState,
  dataset: ReplayDataset,
  noteIds: readonly string[],
  roots: ReadonlyArray<{ id: string; title: string }>,
  config: TopicTreeConfig,
  seed: number
): TopicSkeleton {
  const topicIds = new Map<string, string>();
  let counter = 0;
  walkTopics(state, (node) => {
    counter += 1;
    topicIds.set(node.id, uuid(4, counter));
  });
  const topics: TopicSkeleton["topics"] = [];
  walkTopics(state, (node, depth) => {
    topics.push({
      id: topicIds.get(node.id)!,
      parentId: node.parentId === null ? null : topicIds.get(node.parentId)!,
      role: node.parentId === null ? "root" : "topic",
      // Every named topic is named by hand in the fixture; the root has none.
      title: node.parentId === null ? null : `Topic ${topicIds.get(node.id)!.slice(-4)}`,
      nameState: node.parentId === null ? "unnamed" : "named",
      nameSource: node.parentId === null ? null : depth === 1 ? "llm" : "tfidf",
      nameLanguage: node.parentId === null ? null : "en",
      namedChangeSetId: null,
      description: null,
      aliases: [],
      management: "ai",
      position: node.position,
      retiredAt: null,
      redirectTo: null,
      createdChangeSetId: null,
      stats: {
        spaceKey: space.spaceKey,
        n: node.stats.n,
        ls: node.stats.ls,
        cosSqSum: node.stats.cosSqSum,
        lowCosPercentiles: node.stats.lowCosPercentiles,
        coherence: node.stats.n > 0 ? 0.8 : 0,
        directItems: node.items.length,
        children: node.children.length,
        health: "good",
        violations: [],
        dirty: false,
        lastRepairAt: null,
        repairClock: 0,
        computedAt: "2026-10-15T00:00:00.000Z"
      }
    });
  });
  const placements: TopicSkeleton["placements"] = [];
  for (const [item, list] of state.placements) {
    const row = rowOfItemKey(item)!;
    for (const placement of list) {
      placements.push({
        id: uuid(5, placements.length + 1),
        itemKind: "note",
        itemId: noteIds[row]!,
        key: `note:${noteIds[row]!}`,
        topicId: topicIds.get(placement.topicId)!,
        rank: placement.rank,
        management: "ai",
        decidedBy: placement.decidedBy,
        itemFingerprint: dataset.rows[row]!.contentHash,
        score: placement.score,
        margin: placement.margin,
        centrality: 0.8,
        needsGate: placement.needsGate,
        needsSplitCheck: placement.needsSplitCheck,
        needsVector: placement.needsVector,
        movedFromTopicId: null,
        movedAt: null,
        changeSetId: uuid(3, 0)
      });
    }
  }
  // A root source is an item too: it sits with the first of its notes (D8).
  for (const root of roots) {
    const first = dataset.rows.findIndex((row) => `Article ${row.rootSourceId}` === root.title);
    const note = placements.find((placement) => placement.itemId === noteIds[first]);
    placements.push({
      ...note!,
      id: uuid(5, placements.length + 1),
      itemKind: "source",
      itemId: root.id,
      key: `source:${root.id}`,
      decidedBy: "build",
      margin: null,
      score: null
    });
  }
  return {
    tree: {
      id: uuid(6, 1),
      status: "active",
      space: { ...space, dimensions: dataset.matrix.dim },
      config,
      configHash: sha(JSON.stringify(config)),
      seed,
      generation: 7,
      createdAt: "2026-10-01T00:00:00.000Z",
      activatedAt: "2026-10-01T00:00:01.000Z",
      retiredAt: null
    },
    topics,
    placements
  } as unknown as TopicSkeleton;
}
