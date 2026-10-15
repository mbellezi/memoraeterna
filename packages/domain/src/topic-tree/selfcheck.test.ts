// The 47 Spike B self-check checks (scripts/spikes/topic-tree/selfcheck.ts) on the ported engine:
// 8 groups x 5 clusters x 50 points (64-d). For each builder: strict shape, cluster recovery
// (leaf NMI >= 0.8), determinism, +20% incremental growth; removals with exact N/LS; incremental
// from an empty tree in two orders; the wide-root Louvain case. The incremental driver below is a
// reference beam-descent placement (the product PLACE is decidePlacement, T07) over the ported
// shape operations. Louvain uses the reference detector here; apps/desktop repeats the Louvain
// checks with graphology, the product detector.
import { beforeAll, describe, expect, it } from "vitest";

import { buildBottomUp, buildLouvain, buildTopDown, repairAll, repairDirty } from "./build.js";
import type { BuildResult, ShapeContext } from "./build.js";
import { defaultTopicTreeConfig } from "./config.js";
import type { TopicTreeConfig } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { compareStrings, rowContentHash, rowItemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { leafLabels, nmi, purity, shapeReport, statsDrift } from "./metrics.js";
import type { ShapeReport } from "./metrics.js";
import { createRng, deriveSeed } from "./rng.js";
import {
  createTopicTreeState,
  getTopic,
  placementRecord,
  primaryPlacement,
  registerItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { addItemToPath, admissionThreshold, subtractItemFromPath } from "./stats.js";
import { defaultSyntheticOptions, gaussianClusters } from "./fixtures/synthetic.js";
import type { SyntheticData } from "./fixtures/synthetic.js";
import { referenceLouvain } from "./fixtures/reference-louvain.js";
import { dotRowVec, rowVectors } from "./vectors.js";

const seed = 20261014;
const config = defaultTopicTreeConfig;
type BuilderName = "top-down" | "bottom-up" | "louvain";

function build(
  name: BuilderName,
  data: SyntheticData,
  rows: readonly number[],
  buildSeed = seed
): BuildResult {
  switch (name) {
    case "top-down":
      return buildTopDown(data.matrix, rows, { seed: buildSeed, config });
    case "bottom-up":
      return buildBottomUp(data.matrix, rows, { seed: buildSeed, config });
    case "louvain":
      return buildLouvain(data.matrix, rows, {
        seed: buildSeed,
        config,
        detectCommunities: referenceLouvain
      });
  }
}

/** Reference incremental engine: beam descent with node-relative admission plus local repair. */
class ReferenceEngine {
  readonly context: ShapeContext;
  private readonly dirty = new Set<string>();

  constructor(
    readonly state: TopicTreeState,
    data: SyntheticData,
    engineConfig: TopicTreeConfig,
    engineSeed: number
  ) {
    let next = Math.max(...[...state.topics.keys()].map(Number)) + 1;
    this.context = {
      state,
      vectors: rowVectors(data.matrix),
      config: engineConfig,
      seed: engineSeed,
      editor: createTopicTreeEditor(state, { record: false }),
      newTopicId: () => String(next++),
      now: "2026-10-15T00:00:00.000Z",
      seedLabel: (topicId) => topicId,
      readmit: (item, from) => {
        const target = this.place(item, from);
        return target === from ? null : target;
      }
    };
  }

  static empty(
    data: SyntheticData,
    engineConfig: TopicTreeConfig,
    engineSeed: number
  ): ReferenceEngine {
    return new ReferenceEngine(
      createTopicTreeState({ dim: data.matrix.dim, rootId: "0" }),
      data,
      engineConfig,
      engineSeed
    );
  }

  /** The admitted leaf with the best score, else the deepest admitted internal topic. */
  place(item: ItemKey, from = this.state.rootId): string {
    const { state, config: engineConfig, vectors } = this.context;
    const row = vectors.rowOf(item) as number;
    const score = (id: string): number =>
      dotRowVec(vectors.matrix, row, getTopic(state, id).stats.centroid);
    type Candidate = { id: string; score: number; admitted: boolean; leaf: boolean; depth: number };
    const start = getTopic(state, from);
    let frontier: Candidate[] = [
      {
        id: from,
        score: start.stats.n > 0 ? score(from) : 0,
        admitted: true,
        leaf: start.children.length === 0,
        depth: 0
      }
    ];
    const terminals: Candidate[] = [];
    while (frontier.length > 0) {
      const next: Candidate[] = [];
      for (const current of frontier) {
        const node = getTopic(state, current.id);
        if (node.children.length === 0) {
          terminals.push({ ...current, leaf: true });
          continue;
        }
        let admittedChild = false;
        for (const childId of node.children) {
          const child = getTopic(state, childId);
          const childScore = score(childId);
          const leaf = child.children.length === 0;
          const candidate = { id: childId, score: childScore, leaf, depth: current.depth + 1 };
          if (childScore >= admissionThreshold(child, engineConfig)) {
            admittedChild = true;
            next.push({ ...candidate, admitted: true });
          } else if (leaf) {
            terminals.push({ ...candidate, admitted: false });
          }
        }
        if (!admittedChild) terminals.push({ ...current, leaf: false });
      }
      next.sort((a, b) => b.score - a.score || compareStrings(a.id, b.id));
      frontier = next.slice(0, engineConfig.placement.beam);
    }
    const admittedLeaves = terminals
      .filter((candidate) => candidate.leaf && candidate.admitted)
      .sort((a, b) => b.score - a.score || compareStrings(a.id, b.id));
    if (admittedLeaves[0]) return admittedLeaves[0].id;
    const internal = terminals
      .filter((candidate) => !candidate.leaf && candidate.admitted)
      .sort((a, b) => b.depth - a.depth || b.score - a.score || compareStrings(a.id, b.id));
    return internal[0]?.id ?? from;
  }

  insert(row: number): void {
    const { state, vectors, editor } = this.context;
    const item = rowItemKey(row);
    if (!state.items.has(item)) {
      registerItem(state, {
        key: item,
        kind: "note",
        contentHash: rowContentHash(row),
        rootSource: null
      });
    }
    state.clock += 1;
    const topicId = this.place(item);
    editor.placeItem(item, placementRecord(topicId, { decidedBy: "auto" }));
    addItemToPath(state, vectors, item, topicId);
    this.dirty.add(topicId);
    repairDirty(this.context, this.dirty);
  }

  remove(row: number): void {
    const { state, vectors, editor } = this.context;
    const item = rowItemKey(row);
    state.clock += 1;
    const topicId = primaryPlacement(state, item)?.topicId as string;
    subtractItemFromPath(state, vectors, item, topicId);
    editor.unplaceItem(item, 0);
    this.dirty.add(topicId);
    repairDirty(this.context, this.dirty);
  }

  settle(): number {
    this.dirty.clear();
    return repairAll(this.context, { force: true }).length;
  }
}

/** Builds on 80% of a seeded shuffle (or starts empty) and inserts the rest one by one. */
function incrementalRun(
  name: BuilderName | "incremental",
  data: SyntheticData,
  rows: readonly number[],
  runSeed: number
): ReferenceEngine {
  const order = createRng(deriveSeed(runSeed, "order")).shuffle([...rows]);
  const cut = name === "incremental" ? 0 : Math.round(order.length * 0.8);
  const engine =
    name === "incremental"
      ? ReferenceEngine.empty(data, config, runSeed)
      : new ReferenceEngine(
          build(name, data, order.slice(0, cut), runSeed).state,
          data,
          config,
          runSeed
        );
  for (const row of order.slice(cut)) engine.insert(row);
  return engine;
}

function expectShape(shape: ShapeReport, strict: boolean): void {
  expect(shape.reachability).toBe(1);
  expect(shape.violations.hard).toEqual([]);
  if (!strict) return;
  expect(shape.fanOut.inRange).toBe(1);
  expect(shape.leafSize.inRange).toBe(1);
  expect(shape.leafDepth.max).toBeLessThanOrEqual(config.depth.target);
  expect(shape.singleChildTopics).toBe(0);
}

describe("topic tree engine self-check (Spike B, 47 checks)", () => {
  let data: SyntheticData;
  let rows: number[];
  let keys: ItemKey[];
  beforeAll(() => {
    data = gaussianClusters(defaultSyntheticOptions);
    rows = Array.from({ length: data.matrix.count }, (_, index) => index);
    keys = rows.map(rowItemKey);
  });

  describe.each(["top-down", "bottom-up", "louvain"] as const)("%s builder", (name) => {
    let result: BuildResult;
    beforeAll(() => {
      result = build(name, data, rows);
    });

    it("satisfies the strict shape invariants (6 checks)", () => {
      expectShape(shapeReport(result.state, config, { expectedItems: keys }), true);
    });

    it("recovers the synthetic clusters (leaf NMI >= 0.8)", () => {
      const leaves = leafLabels(result.state, keys);
      expect(nmi(leaves, data.clusters)).toBeGreaterThanOrEqual(0.8);
      expect(purity(leaves, data.clusters)).toBeGreaterThanOrEqual(0.95);
    });

    it("is deterministic for a fixed seed", () => {
      expect(Array.from(leafLabels(build(name, data, rows).state, keys))).toEqual(
        Array.from(leafLabels(result.state, keys))
      );
    });

    it("keeps reachability and no hard violations after +20% incremental growth", () => {
      const engine = incrementalRun(name, data, rows, seed);
      expectShape(shapeReport(engine.state, config, { expectedItems: keys }), false);
    });
  });

  it("removes 40% and re-inserts 20% with exact statistics (drift < 1e-9)", () => {
    const engine = new ReferenceEngine(build("top-down", data, rows).state, data, config, seed);
    const order = createRng(seed).shuffle([...rows]);
    const removed = order.slice(0, Math.round(order.length * 0.4));
    for (const row of removed) engine.remove(row);
    for (const row of removed.slice(0, Math.round(order.length * 0.2))) engine.insert(row);
    const present = keys.filter((item) => primaryPlacement(engine.state, item) !== undefined);
    expectShape(shapeReport(engine.state, config, { expectedItems: present }), false);
    const drift = statsDrift(engine.state, engine.context.vectors);
    expect(drift.maxCountError).toBe(0);
    expect(drift.maxSumError).toBeLessThan(1e-9);
    expect(getTopic(engine.state, engine.state.rootId).stats.n).toBe(present.length);
  });

  it.each([seed, seed + 1])(
    "builds incrementally from an empty tree (order seed %i), before and after settling",
    (runSeed) => {
      const engine = incrementalRun("incremental", data, rows, runSeed);
      expectShape(shapeReport(engine.state, config, { expectedItems: keys }), false);
      engine.settle();
      expectShape(shapeReport(engine.state, config, { expectedItems: keys }), false);
      expect(nmi(leafLabels(engine.state, keys), data.clusters)).toBeGreaterThanOrEqual(0.8);
    }
  );

  it("keeps the Louvain root within fan-out when there are more communities than fanOut.max", () => {
    // 13 well-separated blobs: more root communities than fanOut.max (12). The legacy grouping
    // aimed at round(13 / 6) = 2 super-groups and left 2 Areas.
    const wide = gaussianClusters({
      ...defaultSyntheticOptions,
      groups: 13,
      clustersPerGroup: 1,
      pointsPerCluster: 60,
      seed: 11
    });
    const wideRows = Array.from({ length: wide.matrix.count }, (_, index) => index);
    const fixed = buildLouvain(wide.matrix, wideRows, {
      seed,
      config,
      detectCommunities: referenceLouvain
    });
    const legacy = buildLouvain(wide.matrix, wideRows, {
      seed,
      config,
      detectCommunities: referenceLouvain,
      rootGrouping: "legacy"
    });
    const rootChildren = fixed.diagnostics?.rootChildren ?? 0;
    expect(rootChildren).toBeGreaterThanOrEqual(config.fanOut.min);
    expect(rootChildren).toBeLessThanOrEqual(config.fanOut.max);
    expect(rootChildren).toBeGreaterThanOrEqual(config.fanOut.targetMin);
    expect(legacy.diagnostics?.rootChildren ?? 99).toBeLessThan(config.fanOut.targetMin);
    expectShape(shapeReport(fixed.state, config), false);
  });
});
