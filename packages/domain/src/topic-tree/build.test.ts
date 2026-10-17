import { describe, expect, it } from "vitest";

import {
  buildLouvain,
  buildTopDown,
  canonicalPartition,
  communityGraphOf,
  contentAnchor,
  louvainNeighbours,
  partitionOf,
  planSplit,
  repairAll,
  repairDirty
} from "./build.js";
import type { DetectCommunities, ShapeContext } from "./build.js";
import { defaultTopicTreeConfig, topicTreeConfigWith } from "./config.js";
import type { TopicTreeConfig } from "./config.js";
import {
  StructureEventSchema,
  applyEvents,
  createTopicTreeEditor,
  invertEvents
} from "./events.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import type { SyntheticData } from "./fixtures/synthetic.js";
import { itemKey, rowItemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { checkInvariants } from "./invariants.js";
import { knnGraph } from "./knn.js";
import { shapeReport } from "./metrics.js";
import {
  canonicalStateDump,
  createTopicTreeState,
  getTopic,
  isLive,
  liveTopicIds,
  placementRecord,
  placementsOf,
  registerItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { cooldownInsertsFor } from "./stability.js";
import { recomputeSubtree, statsDump } from "./stats.js";
import { keyedVectors } from "./vectors.js";

const config = defaultTopicTreeConfig;
const now = "2026-10-15T12:00:00.000Z";
const data = gaussianClusters({
  groups: 4,
  clustersPerGroup: 3,
  pointsPerCluster: 20,
  dim: 24,
  groupSpread: 0.8,
  pointNoise: 0.5,
  seed: 21
});
const rows = Array.from({ length: data.matrix.count }, (_, index) => index);

/** A product-like state: UUID topics, note keys, all items on the root (a cold start). */
function uuidState(
  source: SyntheticData,
  offset: number
): { context: ShapeContext; keys: ItemKey[] } {
  const uuidOf = (n: number): string =>
    `00000000-0000-4000-8000-${(offset + n).toString(16).padStart(12, "0")}`;
  const state = createTopicTreeState({ dim: source.matrix.dim, rootId: uuidOf(0) });
  const keys = Array.from({ length: source.matrix.count }, (_, row) =>
    itemKey("note", uuidOf(1_000_000 + row))
  );
  keys.forEach((key, row) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: `content-${(row * 7919) % 9973}`,
      rootSource: null
    })
  );
  let next = 1;
  const context: ShapeContext = {
    state,
    vectors: keyedVectors(source.matrix, keys),
    config,
    seed: 7,
    editor: createTopicTreeEditor(state),
    newTopicId: () => uuidOf(next++),
    now,
    markMoves: true
  };
  const setup = createTopicTreeEditor(state, { record: false });
  for (const key of keys) setup.placeItem(key, placementRecord(state.rootId));
  recomputeSubtree(state, context.vectors);
  return { context, keys };
}

/** The tree in content terms only (no IDs): topics as sorted content hashes plus children. */
function contentShape(state: TopicTreeState): string {
  const encode = (id: string): string => {
    const node = getTopic(state, id);
    const hashes = node.items.map((item) => state.items.get(item)?.contentHash).sort();
    return `(${hashes.join(",")}|${node.children.map(encode).sort().join("")})`;
  };
  return encode(state.rootId);
}

describe("split planning", () => {
  it("keeps small sets as one leaf and prefers the target fan-out at the last level", () => {
    expect(planSplit(30, 0, config)).toBeNull();
    expect(planSplit(500, config.depth.cap, config)).toBeNull();
    expect(planSplit(31, 0, config)?.k).toBe(2);
    expect(planSplit(40, 2, config)?.k).toBe(4);
    expect(planSplit(5000, 0, config)?.k).toBe(config.fanOut.rootTarget);
    const deep = planSplit(5000, 2, config);
    expect(deep?.k).toBeGreaterThanOrEqual(config.fanOut.targetMin);
    expect(deep?.k).toBeLessThanOrEqual(config.fanOut.max);
  });
});

describe("shape operations", () => {
  it("split a cold-start root into a valid tree with schema-valid, invertible events", () => {
    const { context } = uuidState(data, 0);
    const { state } = context;
    const before = canonicalStateDump(state);
    const statsBefore = statsDump(state);
    const operations = repairAll(context, { force: true });
    expect(operations.length).toBeGreaterThan(0);
    expect(operations[0]?.kind).toBe("leaf-split");
    const report = shapeReport(state, config);
    expect(report.reachability).toBe(1);
    expect(report.violations.hard).toEqual([]);
    expect(report.leafSize.max).toBeLessThanOrEqual(config.leaf.max);
    for (const event of context.editor.events)
      expect(StructureEventSchema.parse(event)).toEqual(event);
    applyEvents(state, invertEvents(context.editor.events));
    expect(canonicalStateDump(state)).toBe(before);
    recomputeSubtree(state, context.vectors);
    expect(statsDump(state)).toBe(statsBefore);
  });

  it("merge tiny leaves, collapse single-child chains and evacuate secondaries before retiring", () => {
    const { context, keys } = uuidState(data, 0);
    const { state, editor } = context;
    const root = state.rootId;
    const a = context.newTopicId();
    const b = context.newTopicId();
    const c = context.newTopicId();
    const d = context.newTopicId();
    editor.createTopic(a, root);
    editor.createTopic(b, a);
    editor.createTopic(c, root);
    editor.createTopic(d, root);
    keys.slice(0, 10).forEach((key) => editor.updatePlacement(key, 0, { topicId: b }));
    keys.slice(10, 12).forEach((key) => editor.updatePlacement(key, 0, { topicId: c }));
    keys.slice(12).forEach((key) => editor.updatePlacement(key, 0, { topicId: d }));
    const roaming = keys[0] as ItemKey;
    editor.placeItem(roaming, placementRecord(c, { rank: 1 }));
    recomputeSubtree(state, context.vectors);
    const before = canonicalStateDump(state);
    const start = editor.events.length;
    const kinds = repairAll(context, { force: true }).map((operation) => operation.kind);
    expect(kinds).toEqual(expect.arrayContaining(["collapse", "merge"]));
    expect(isLive(getTopic(state, b))).toBe(false);
    expect(getTopic(state, b).redirectTo).toBe(a);
    expect(isLive(getTopic(state, c))).toBe(false);
    expect(checkInvariants(state, config).hard).toBe(0);
    const secondary = placementsOf(state, roaming).find((placement) => placement.rank === 1);
    if (secondary) expect(isLive(getTopic(state, secondary.topicId))).toBe(true);
    const moved = keys.slice(10, 12).map((key) => placementsOf(state, key)[0]);
    expect(
      moved.every((placement) => placement?.movedFromTopicId === c && placement.movedAt === now)
    ).toBe(true);
    applyEvents(state, invertEvents(editor.events.slice(start)));
    expect(canonicalStateDump(state)).toBe(before);
  });

  it("respects cooldowns for soft repairs but never for hard ones", () => {
    const { context, keys } = uuidState(data, 0);
    const { state, editor } = context;
    const leaf = context.newTopicId();
    const other = context.newTopicId();
    editor.createTopic(leaf, state.rootId);
    editor.createTopic(other, state.rootId);
    keys.slice(0, 31).forEach((key) => editor.updatePlacement(key, 0, { topicId: leaf }));
    keys.slice(31).forEach((key) => editor.updatePlacement(key, 0, { topicId: other }));
    recomputeSubtree(state, context.vectors);
    getTopic(state, leaf).control.repairClock = 90;
    const cooldown = cooldownInsertsFor(config, state.placements.size);
    state.clock = 90 + cooldown - 1;
    expect(repairDirty(context, new Set([leaf]))).toEqual([]);
    state.clock = 90 + cooldown;
    expect(repairDirty(context, new Set([leaf])).map((operation) => operation.kind)).toContain(
      "leaf-split"
    );
    getTopic(state, other).control.repairClock = state.clock;
    expect(getTopic(state, other).items.length).toBeGreaterThan(config.leaf.hardMax);
    expect(repairDirty(context, new Set([other])).map((operation) => operation.kind)).toContain(
      "leaf-split"
    );
  });

  it("derive random choices from content, so fresh UUIDs rebuild the same tree (D22)", () => {
    const first = uuidState(data, 0);
    const second = uuidState(data, 5_000_000);
    repairAll(first.context, { force: true });
    repairAll(second.context, { force: true });
    expect(liveTopicIds(first.context.state)).not.toEqual(liveTopicIds(second.context.state));
    expect(contentShape(second.context.state)).toBe(contentShape(first.context.state));
    expect(contentAnchor(first.context.state, first.context.state.rootId)).toBe(
      contentAnchor(second.context.state, second.context.state.rootId)
    );
  });
});

describe("Louvain builder", () => {
  it("builds the community graph once per pair, with the larger weight, source < target", () => {
    const graph = knnGraph(data.matrix, rows, 5, { seed: 1 });
    const position = new Map(graph.rows.map((row, index) => [row, index]));
    const subset = rows.slice(0, 40);
    const community = communityGraphOf(graph, position, subset);
    const seen = new Set<string>();
    for (let e = 0; e < community.sources.length; e += 1) {
      const a = community.sources[e] as number;
      const b = community.targets[e] as number;
      expect(a).toBeLessThan(b);
      expect(seen.has(`${a}:${b}`)).toBe(false);
      seen.add(`${a}:${b}`);
      expect(community.weights[e]).toBeGreaterThan(0);
    }
    expect(community.nodeCount).toBe(40);
  });

  it("falls back to k-means when the detector finds one community, and stays valid", () => {
    const oneCommunity: DetectCommunities = (graph) => new Int32Array(graph.nodeCount);
    const result = buildLouvain(data.matrix, rows, {
      seed: 4,
      config,
      detectCommunities: oneCommunity
    });
    expect(result.diagnostics?.rootKmeansFallback).toBe(true);
    expect(result.knnExact).toBe(true);
    const report = shapeReport(result.state, config);
    expect(report.reachability).toBe(1);
    expect(report.violations.hard).toEqual([]);
    expect(result.timings.knnMs).toBeGreaterThanOrEqual(0);
  });

  it("uses the small-library neighbour count up to its threshold, louvain.knn above", () => {
    const small = topicTreeConfigWith({
      louvain: { smallLibraryKnn: 3, smallLibraryMaxItems: rows.length }
    });
    expect(louvainNeighbours(rows.length, small)).toBe(3);
    expect(louvainNeighbours(rows.length + 1, small)).toBe(config.louvain.knn);
    const rootEdges = (buildConfig: TopicTreeConfig, libraryItems?: number): number => {
      const edges: number[] = [];
      const recording: DetectCommunities = (graph) => {
        edges.push(graph.sources.length);
        return Int32Array.from({ length: graph.nodeCount }, (_, node) => node % 4);
      };
      buildLouvain(data.matrix, rows, {
        seed: 4,
        config: buildConfig,
        detectCommunities: recording,
        ...(libraryItems === undefined ? {} : { libraryItems })
      });
      return edges[0] as number;
    };
    const above = topicTreeConfigWith({
      louvain: { smallLibraryKnn: 3, smallLibraryMaxItems: rows.length - 1 }
    });
    const tenNn = topicTreeConfigWith({ louvain: { smallLibraryMaxItems: 0 } });
    expect(rootEdges(small)).toBeLessThanOrEqual(rows.length * 3);
    expect(rootEdges(above)).toBe(rootEdges(tenNn));
    expect(rootEdges(tenNn)).toBeGreaterThan(rows.length * 3);
    // A part of a larger library (a chapter-seeded cold start) uses the library's count.
    expect(rootEdges(small, rows.length + 1)).toBe(rootEdges(tenNn));
  });

  it("draws randomness only from the injected rng", () => {
    const calls: number[] = [];
    const recording: DetectCommunities = (graph, { rng }) => {
      calls.push(rng());
      return Int32Array.from({ length: graph.nodeCount }, (_, node) => node % 4);
    };
    buildLouvain(data.matrix, rows, { seed: 4, config, detectCommunities: recording });
    const first = [...calls];
    calls.length = 0;
    buildLouvain(data.matrix, rows, { seed: 4, config, detectCommunities: recording });
    expect(calls).toEqual(first);
  });
});

describe("partitions", () => {
  it("serialize a build as pre-order nodes with rows and an ID-free canonical form", () => {
    const { state } = buildTopDown(data.matrix, rows, { seed: 3, config });
    const nodes = partitionOf(state);
    expect(nodes[0]).toMatchObject({ key: 0, parent: null });
    for (const node of nodes.slice(1)) expect(node.parent).toBeLessThan(node.key);
    expect(nodes.flatMap((node) => node.items).sort((a, b) => a - b)).toEqual(rows);
    const again = buildTopDown(data.matrix, rows, { seed: 3, config });
    expect(canonicalPartition(again.state)).toBe(canonicalPartition(state));
    const editor = createTopicTreeEditor(state, { record: false });
    const leaf = nodes.find((node) => node.items.length > 0 && node.key !== 0) as {
      items: number[];
    };
    const target = liveTopicIds(state).find(
      (id) =>
        getTopic(state, id).children.length === 0 &&
        !getTopic(state, id).items.includes(rowItemKey(leaf.items[0] as number))
    ) as string;
    editor.updatePlacement(rowItemKey(leaf.items[0] as number), 0, { topicId: target });
    expect(canonicalPartition(state)).not.toBe(canonicalPartition(again.state));
  });

  it("accept other configurations", () => {
    const deep: TopicTreeConfig = { ...config, leaf: { ...config.leaf, max: 20, target: 10 } };
    const { state } = buildTopDown(data.matrix, rows, { seed: 3, config: deep });
    expect(shapeReport(state, deep).leafSize.max).toBeLessThanOrEqual(20);
  });
});
