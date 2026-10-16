import { describe, expect, it } from "vitest";

import {
  areasActive,
  areasGroupingDue,
  chapterSeedGroups,
  coldStartKind,
  dominantRootSource,
  frozenSubtrees,
  hasTopics,
  isTriggerRebuild,
  isYoungLibrary,
  judgeTriggerRebuild,
  level2TopicCount,
  modularity,
  notesInLeaves,
  protectedSubtrees,
  rebuildNeedsReview,
  rebuildPartitionOf,
  rebuildQuality,
  rebuildTrigger,
  rejectedRebuildBaseline,
  smallLibraryPartition,
  smallPartitionNodes,
  structureSignals,
  unadmittedTopics
} from "./bootstrap.js";
import type {
  BuildBaseline,
  ChapterSeedItem,
  RebuildQuality,
  StructureSignals
} from "./bootstrap.js";
import type { CommunityGraph, DetectCommunities } from "./build.js";
import { defaultTopicTreeConfig, topicTreeConfigWith } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import { itemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { applyRebuild } from "./rebuild-map.js";
import { rebalanceTree } from "./repair.js";
import {
  canonicalStateDump,
  cloneTopicTreeState,
  createTopicTreeState,
  getTopic,
  placementRecord,
  registerItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputeSubtree } from "./stats.js";
import { keyedVectors } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

const config = defaultTopicTreeConfig;
const now = "2026-10-15T12:00:00.000Z";
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** A graph of edges given as [a, b, weight]. */
function graphOf(nodeCount: number, edges: [number, number, number][]): CommunityGraph {
  return {
    nodeCount,
    sources: Int32Array.from(edges.map((edge) => edge[0])),
    targets: Int32Array.from(edges.map((edge) => edge[1])),
    weights: Float64Array.from(edges.map((edge) => edge[2]))
  };
}

/** Rows of `groups` well separated clusters of `size` points each (content order = row order). */
function separated(groups: number, size: number, seed = 31): EmbeddingMatrix {
  return gaussianClusters({
    groups,
    clustersPerGroup: 1,
    pointsPerCluster: size,
    dim: 32,
    groupSpread: 0.05,
    pointNoise: 0.25,
    seed
  }).matrix;
}

const rowsOf = (count: number): number[] => Array.from({ length: count }, (_, row) => row);

describe("the cold start (D39)", () => {
  it("waits below bootstrap.minItems, keeps small libraries in process, builds the rest", () => {
    expect(coldStartKind(0, config)).toBe("wait");
    expect(coldStartKind(11, config)).toBe("wait");
    expect(coldStartKind(12, config)).toBe("small");
    expect(coldStartKind(30, config)).toBe("small");
    expect(coldStartKind(31, config)).toBe("build");
    const larger = topicTreeConfigWith({ bootstrap: { minItems: 20, singleTopicMaxItems: 40 } });
    expect(coldStartKind(19, larger)).toBe("wait");
    expect(coldStartKind(40, larger)).toBe("small");
  });

  it("scores modularity: 0 for one community, 1/2 for two disconnected triangles", () => {
    const triangles = graphOf(6, [
      [0, 1, 1],
      [0, 2, 1],
      [1, 2, 1],
      [3, 4, 1],
      [3, 5, 1],
      [4, 5, 1]
    ]);
    expect(modularity(triangles, [0, 0, 0, 1, 1, 1])).toBeCloseTo(0.5, 12);
    expect(modularity(triangles, [0, 0, 0, 0, 0, 0])).toBeCloseTo(0, 12);
    expect(modularity(triangles, [0, 1, 0, 1, 0, 1])).toBeLessThan(0);
    expect(modularity(graphOf(3, []), [0, 1, 2])).toBe(0);
  });

  it("gives subsets of 12, 20 and 30 notes the expected topic counts", () => {
    // One tight subject: one topic.
    const one = smallLibraryPartition(separated(1, 12), rowsOf(12), config, 7);
    expect(one.groups).toEqual([rowsOf(12)]);
    expect(one.modularity).toBe(0);
    // Two and three separated subjects: one topic each.
    const two = smallLibraryPartition(separated(2, 10), rowsOf(20), config, 7);
    expect(two.groups.map((group) => group.length)).toEqual([10, 10]);
    expect(two.groups[0]).toEqual(rowsOf(10));
    expect(two.modularity).toBeGreaterThanOrEqual(config.bootstrap.modularityMin);
    const three = smallLibraryPartition(separated(3, 10), rowsOf(30), config, 7);
    expect(three.groups.map((group) => group.length)).toEqual([10, 10, 10]);
    expect(three.candidates.map((candidate) => candidate.k)).toEqual([2, 3, 4]);
  });

  it("keeps a single topic when no split reaches bootstrap.modularityMin", () => {
    const strict = topicTreeConfigWith({ bootstrap: { modularityMin: 0.99 } });
    const kept = smallLibraryPartition(separated(2, 10), rowsOf(20), strict, 7);
    expect(kept.groups).toEqual([rowsOf(20)]);
    expect(kept.candidates.length).toBeGreaterThan(0);
    // Fewer than 2 x leaf.min notes cannot split at all.
    expect(smallLibraryPartition(separated(1, 5), rowsOf(5), config, 7).candidates).toEqual([]);
  });

  it("also weighs community-detector splits and keeps the best one", () => {
    const matrix = separated(2, 10, 9);
    const resolutions: number[] = [];
    // A poor detector: it interleaves the two subjects and leaves two notes alone (folded).
    const interleaved: DetectCommunities = (graph, { resolution }) => {
      resolutions.push(resolution);
      return Int32Array.from({ length: graph.nodeCount }, (_, node) =>
        node === 3 ? 90 : node === 15 ? 91 : node % 2
      );
    };
    const result = smallLibraryPartition(matrix, rowsOf(20), config, 7, interleaved);
    expect(resolutions).toHaveLength(config.louvain.resolutionTries);
    expect(Math.min(...resolutions)).toBeLessThan(config.louvain.resolution);
    expect(Math.max(...resolutions)).toBeGreaterThan(config.louvain.resolution);
    const louvain = result.candidates.filter((candidate) => candidate.method === "louvain");
    // Every resolution gave the same split: it is scored once.
    expect(louvain).toHaveLength(1);
    expect(louvain[0]?.modularity).toBeLessThan(result.modularity);
    expect(result.groups).toEqual([rowsOf(10), rowsOf(20).slice(10)]);
    expect(result.modularity).toBe(
      Math.max(...result.candidates.map((candidate) => candidate.modularity))
    );
    // A detector that finds one community proposes nothing.
    const flat = smallLibraryPartition(
      matrix,
      rowsOf(20),
      config,
      7,
      (graph) => new Int32Array(graph.nodeCount)
    );
    expect(flat.candidates.every((candidate) => candidate.method === "kmeans")).toBe(true);
  });

  it("is a function of content order and seed, not of identity", () => {
    const matrix = separated(3, 9, 5);
    const first = smallLibraryPartition(matrix, rowsOf(27), config, 11);
    const again = smallLibraryPartition(matrix, rowsOf(27), config, 11);
    expect(again).toEqual(first);
    expect(smallPartitionNodes(first.groups)).toEqual([
      { key: 0, parent: null, items: [] },
      ...first.groups.map((items, index) => ({ key: index + 1, parent: 0, items }))
    ]);
  });
});

describe("chapter seeding", () => {
  const item = (n: number, rootSource: string | null, chapter: string | null): ChapterSeedItem => ({
    key: itemKey("note", uuid(1000 + n)),
    contentHash: `hash-${String(n).padStart(4, "0")}`,
    rootSource,
    chapter
  });
  const book = uuid(1);
  const other = uuid(2);
  const chapters = [uuid(11), uuid(12), uuid(13)];

  it("seeds one group per chapter of a dominant hierarchical root", () => {
    const items = [
      ...Array.from({ length: 8 }, (_, n) => item(n, book, chapters[0]!)),
      ...Array.from({ length: 6 }, (_, n) => item(10 + n, book, chapters[1]!)),
      ...Array.from({ length: 2 }, (_, n) => item(20 + n, book, chapters[2]!)),
      item(30, book, null),
      ...Array.from({ length: 3 }, (_, n) => item(40 + n, other, null))
    ];
    expect(dominantRootSource(items)).toEqual({ rootSource: book, share: 17 / 20 });
    const seeding = chapterSeedGroups(items, () => 3, config, 64);
    // The two-note chapter and the book's own note stay loose (fewer than leaf.min notes).
    expect(seeding?.groups.map((group) => group.length)).toEqual([8, 6]);
    expect(seeding?.groups[0]?.[0]).toBe(itemKey("note", uuid(1000)));
    // At most maxGroups groups: the largest.
    expect(chapterSeedGroups(items, () => 3, config, 1)).toBeNull();
  });

  it("needs a share of bootstrap.chapterSeedShare and bootstrap.chapterMinChildren children", () => {
    const mixed = [
      ...Array.from({ length: 6 }, (_, n) => item(n, book, chapters[0]!)),
      ...Array.from({ length: 6 }, (_, n) => item(10 + n, book, chapters[1]!)),
      ...Array.from({ length: 4 }, (_, n) => item(20 + n, other, null))
    ];
    expect(chapterSeedGroups(mixed, () => 3, config, 64)).toBeNull();
    const single = mixed.slice(0, 12);
    expect(chapterSeedGroups(single, () => 3, config, 64)?.groups).toHaveLength(2);
    expect(chapterSeedGroups(single, () => 1, config, 64)).toBeNull();
    expect(dominantRootSource([])).toBeNull();
  });
});

/** A two-level tree: `areas` Areas under the root, each with leaves of the given size. */
function areaTree(areas: number, leavesPerArea: number, leafSize: number) {
  const data = gaussianClusters({
    groups: areas,
    clustersPerGroup: leavesPerArea,
    pointsPerCluster: leafSize,
    dim: 24,
    groupSpread: 0.4,
    pointNoise: 0.25,
    seed: 17
  });
  const keys = Array.from({ length: data.matrix.count }, (_, row) =>
    itemKey("note", uuid(100_000 + row))
  );
  const state = createTopicTreeState({ dim: 24, rootId: uuid(0) });
  const editor = createTopicTreeEditor(state, { record: false });
  keys.forEach((key, row) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: `c-${String(row).padStart(5, "0")}`,
      rootSource: null
    })
  );
  let next = 1;
  let row = 0;
  for (let area = 0; area < areas; area += 1) {
    const areaId = uuid(next++);
    editor.createTopic(areaId, state.rootId);
    for (let leaf = 0; leaf < leavesPerArea; leaf += 1) {
      const leafId = uuid(next++);
      editor.createTopic(leafId, areaId);
      for (let index = 0; index < leafSize; index += 1) {
        editor.placeItem(keys[row++]!, placementRecord(leafId, { decidedBy: "build" }));
      }
    }
  }
  const vectors = keyedVectors(data.matrix, keys);
  recomputeSubtree(state, vectors);
  return { state, vectors, keys, newTopicId: () => uuid(next++) };
}

describe("the Areas level (D12)", () => {
  it("exists once a level-1 topic has children", () => {
    const flat = createTopicTreeState({ dim: 4, rootId: uuid(0) });
    expect(hasTopics(flat)).toBe(false);
    expect(areasActive(flat)).toBe(false);
    const editor = createTopicTreeEditor(flat, { record: false });
    editor.createTopic(uuid(1), flat.rootId);
    expect(hasTopics(flat)).toBe(true);
    expect(areasActive(flat)).toBe(false);
    editor.createTopic(uuid(2), uuid(1));
    expect(areasActive(flat)).toBe(true);
    expect(level2TopicCount(flat)).toBe(1);
  });

  it("asks for the Areas grouping from areas.minLevel2Topics level-2 topics", () => {
    const { state } = areaTree(10, 2, 4);
    expect(level2TopicCount(state)).toBe(20);
    expect(areasGroupingDue(state, config)).toBe(true);
    expect(areasGroupingDue(state, topicTreeConfigWith({ areas: { minLevel2Topics: 21 } }))).toBe(
      false
    );
  });

  it.each([13, 14, 16])("never pushes down a root with %i Areas", (count) => {
    const { state, vectors, newTopicId } = areaTree(count, 2, 6);
    expect(areasActive(state)).toBe(true);
    const root = state.rootId;
    const areasBefore = [...getTopic(state, root).children];
    const input = {
      vectors,
      config,
      seed: 7,
      now,
      day: "2026-10-15",
      newTopicId,
      force: true
    };
    // Without the Areas band the root's fan-out above fanOut.max calls for a push-down...
    const flat = rebalanceTree({ ...input, state: cloneTopicTreeState(state), areasActive: false });
    const tried = [...flat.applied, ...flat.skipped, ...flat.proposals].filter(
      (entry) => entry.kind === "push-down" && entry.topicId === root
    );
    expect(tried.length).toBeGreaterThan(0);
    // ...with it (bootstrap.ts areasActive), the root is in its band and is never pushed down.
    const result = rebalanceTree({ ...input, state, areasActive: areasActive(state) });
    const rootOperations = [...result.applied, ...result.skipped, ...result.proposals].filter(
      (entry) => entry.kind === "push-down" && entry.topicId === root
    );
    expect(rootOperations).toEqual([]);
    expect(getTopic(state, root).children).toEqual(areasBefore);
  });
});

describe("rebuild triggers", () => {
  const baseline: BuildBaseline = { notes: 100, leafCoherence: 0.8 };
  const signals = (overrides: Partial<StructureSignals>): StructureSignals => ({
    notes: 120,
    leafCoherence: 0.79,
    decidedSinceBuild: 40,
    unadmitted: 0,
    ...overrides
  });

  it("rebuilds on doubling while the library holds at most rebuild.doublingMaxItems notes", () => {
    expect(rebuildTrigger(signals({ notes: 199 }), baseline, config)).toBeNull();
    expect(rebuildTrigger(signals({ notes: 200 }), baseline, config)).toBe("doubling");
    expect(
      rebuildTrigger(signals({ notes: 1_200 }), { notes: 600, leafCoherence: 0.8 }, config)
    ).toBeNull();
  });

  it("rebuilds on a drop of the weighted leaf coherence", () => {
    // rebuild.qualityDrop (0.03) below the baseline's 0.8.
    expect(rebuildTrigger(signals({ leafCoherence: 0.775 }), baseline, config)).toBeNull();
    expect(rebuildTrigger(signals({ leafCoherence: 0.77 }), baseline, config)).toBe("quality-drop");
    expect(
      rebuildTrigger(signals({ leafCoherence: 0.1 }), { notes: 100, leafCoherence: null }, config)
    ).toBeNull();
  });

  it("rebuilds on a burst of unadmitted placements", () => {
    expect(
      rebuildTrigger(signals({ unadmitted: 19, decidedSinceBuild: 40 }), baseline, config)
    ).toBeNull();
    expect(
      rebuildTrigger(signals({ unadmitted: 20, decidedSinceBuild: 400 }), baseline, config)
    ).toBeNull();
    expect(
      rebuildTrigger(signals({ unadmitted: 20, decidedSinceBuild: 200 }), baseline, config)
    ).toBe("unadmitted-burst");
  });

  it("reads the signals from the tree: placed notes, leaf coherence and PLACE decisions", () => {
    const { state, keys } = areaTree(2, 2, 5);
    const built = structureSignals(state);
    expect(built).toMatchObject({ notes: 20, decidedSinceBuild: 0, unadmitted: 0 });
    expect(built.leafCoherence).toBeGreaterThan(0.5);
    const editor = createTopicTreeEditor(state, { record: false });
    editor.updatePlacement(keys[0]!, 0, { decidedBy: "auto" });
    editor.updatePlacement(keys[1]!, 0, { decidedBy: "fallback", topicId: state.rootId });
    editor.updatePlacement(keys[2]!, 0, { decidedBy: "fallback", needsGate: true });
    editor.updatePlacement(keys[3]!, 0, { decidedBy: "fallback", needsVector: true });
    expect(structureSignals(state)).toMatchObject({ decidedSinceBuild: 3, unadmitted: 1 });
  });

  it("counts only the unadmitted items that still wait above the leaves", () => {
    const { state, keys } = areaTree(2, 2, 5);
    const editor = createTopicTreeEditor(state, { record: false });
    const area = getTopic(state, state.rootId).children[0]!;
    // Unadmitted at the root and at an Area (internal) topic: both wait.
    editor.updatePlacement(keys[0]!, 0, { decidedBy: "fallback", topicId: state.rootId });
    editor.updatePlacement(keys[1]!, 0, { decidedBy: "fallback", topicId: area });
    // A fallback REBALANCE has since moved into a leaf (it keeps decided_by) no longer waits.
    editor.updatePlacement(keys[2]!, 0, { decidedBy: "fallback" });
    // Nor does a gate "none" waiting for a split check.
    editor.updatePlacement(keys[3]!, 0, {
      decidedBy: "fallback",
      topicId: state.rootId,
      needsSplitCheck: true
    });
    expect(structureSignals(state)).toMatchObject({ decidedSinceBuild: 4, unadmitted: 2 });
    expect(unadmittedTopics(state)).toEqual([area, state.rootId].sort());
  });

  it("counts a burst from the baseline a rejected rebuild left", () => {
    const rejected: BuildBaseline = { ...baseline, decided: 150, unadmitted: 25 };
    // 25 items already waited when the rebuild was rejected: 19 more are not a burst.
    expect(
      rebuildTrigger(signals({ unadmitted: 44, decidedSinceBuild: 200 }), rejected, config)
    ).toBeNull();
    // 20 more of 50 new decisions are.
    expect(
      rebuildTrigger(signals({ unadmitted: 45, decidedSinceBuild: 200 }), rejected, config)
    ).toBe("unadmitted-burst");
    // ... but not when they are under 10% of the decisions since the rejection.
    expect(
      rebuildTrigger(signals({ unadmitted: 45, decidedSinceBuild: 400 }), rejected, config)
    ).toBeNull();
    const moved = rejectedRebuildBaseline(
      signals({ notes: 160, leafCoherence: 0.78, unadmitted: 21, decidedSinceBuild: 79 })
    );
    expect(moved).toEqual({ notes: 160, leafCoherence: 0.78, decided: 79, unadmitted: 21 });
    // The same tree triggers nothing against its own baseline.
    expect(
      rebuildTrigger(
        signals({ notes: 160, leafCoherence: 0.78, unadmitted: 21, decidedSinceBuild: 79 }),
        moved,
        config
      )
    ).toBeNull();
    expect(["doubling", "quality-drop", "unadmitted-burst"].every(isTriggerRebuild)).toBe(true);
    expect(["config", "space", "cold-start"].some(isTriggerRebuild)).toBe(false);
  });

  it("asks for review for protected structure, and for a large share only on a mature trigger", () => {
    expect(rebuildNeedsReview("config", { largeShare: true, protectedTouched: false })).toBe(false);
    expect(rebuildNeedsReview("config", { largeShare: false, protectedTouched: true })).toBe(true);
    // A young library keeps up with its growth: a doubling is reviewed for protection only.
    expect(rebuildNeedsReview("doubling", { largeShare: true, protectedTouched: false })).toBe(
      false
    );
    expect(rebuildNeedsReview("doubling", { largeShare: false, protectedTouched: true })).toBe(
      true
    );
    expect(rebuildNeedsReview("quality-drop", { largeShare: false, protectedTouched: false })).toBe(
      false
    );
    expect(rebuildNeedsReview("quality-drop", { largeShare: true, protectedTouched: false })).toBe(
      true
    );
    expect(
      rebuildNeedsReview("unadmitted-burst", { largeShare: true, protectedTouched: false })
    ).toBe(true);
    // A young library restructures freely; protection still waits for the owner.
    const large = { largeShare: true, protectedTouched: false };
    expect(rebuildNeedsReview("quality-drop", large, true)).toBe(false);
    expect(rebuildNeedsReview("unadmitted-burst", large, true)).toBe(false);
    expect(rebuildNeedsReview("quality-drop", { ...large, protectedTouched: true }, true)).toBe(
      true
    );
    const config = defaultTopicTreeConfig;
    expect(isYoungLibrary(config.rebuild.doublingMaxItems, config)).toBe(true);
    expect(isYoungLibrary(config.rebuild.doublingMaxItems + 1, config)).toBe(false);
  });
});

describe("trigger rebuild acceptance", () => {
  const quality = (overrides: Partial<RebuildQuality> = {}): RebuildQuality => ({
    notes: 2_000,
    leafCoherence: 0.78,
    shape: {
      meanDepth: 3.6,
      fanOutInTarget: 0.85,
      internalTopics: 40,
      singleChildTopics: 0,
      areas: 9
    },
    hardViolations: 0,
    ...overrides
  });
  const shape = (overrides: Partial<RebuildQuality["shape"]>) => ({
    ...quality().shape,
    ...overrides
  });

  it("rejects a rebuild whose weighted leaf coherence falls by more than the tolerance", () => {
    const tolerance = config.rebuild.acceptCoherenceTolerance;
    expect(tolerance).toBe(0.005);
    expect(judgeTriggerRebuild(quality(), quality({ leafCoherence: 0.78 }), config)).toMatchObject({
      accepted: true,
      reasons: []
    });
    // Summation noise and small losses within the tolerance pass; the ENV-G merge (0.78 -> 0.73)
    // does not.
    expect(
      judgeTriggerRebuild(quality(), quality({ leafCoherence: 0.7756 }), config).accepted
    ).toBe(true);
    expect(judgeTriggerRebuild(quality(), quality({ leafCoherence: 0.73 }), config)).toMatchObject({
      accepted: false,
      reasons: ["coherence"]
    });
    expect(
      judgeTriggerRebuild(quality(), quality({ leafCoherence: null }), config).reasons
    ).toEqual(["coherence"]);
    const strict = topicTreeConfigWith({ rebuild: { acceptCoherenceTolerance: 0 } });
    expect(
      judgeTriggerRebuild(quality(), quality({ leafCoherence: 0.7799 }), strict).accepted
    ).toBe(false);
  });

  it("keeps the E2 bars past a young library, and never adds single children or hard violations", () => {
    const deep = quality({ shape: shape({ meanDepth: 4.6 }) });
    const thin = quality({ shape: shape({ fanOutInTarget: 0.79 }) });
    expect(judgeTriggerRebuild(quality(), deep, config).reasons).toEqual(["mean-depth"]);
    expect(judgeTriggerRebuild(quality(), thin, config).reasons).toEqual(["fan-out"]);
    // Below a bar already, a rebuild may not get worse there, and may get better.
    const below = quality({ shape: shape({ meanDepth: 4.8, fanOutInTarget: 0.7 }) });
    expect(
      judgeTriggerRebuild(
        below,
        quality({ shape: shape({ meanDepth: 4.9, fanOutInTarget: 0.6 }) }),
        config
      ).reasons
    ).toEqual(["mean-depth", "fan-out"]);
    expect(
      judgeTriggerRebuild(
        below,
        quality({ shape: shape({ meanDepth: 4.7, fanOutInTarget: 0.75 }) }),
        config
      ).accepted
    ).toBe(true);
    // A young library (at most rebuild.doublingMaxItems notes) is not held to E2's corpus bars.
    const young = { notes: config.rebuild.doublingMaxItems };
    expect(judgeTriggerRebuild(quality(young), { ...thin, ...young }, config).accepted).toBe(true);
    expect(
      judgeTriggerRebuild(
        quality(young),
        quality({ ...young, shape: shape({ singleChildTopics: 1 }) }),
        config
      ).reasons
    ).toEqual(["single-child"]);
    expect(
      judgeTriggerRebuild(quality(young), quality({ ...young, hardViolations: 1 }), config).reasons
    ).toEqual(["hard-violation"]);
  });

  it("measures a mixed rebuild of a tree as worse and the tree itself as no worse", () => {
    const { state, vectors, keys, newTopicId } = areaTree(2, 2, 5);
    const judged = notesInLeaves(state, vectors);
    expect(judged.size).toBe(20);
    const before = rebuildQuality(state, vectors, config, judged);
    expect(before).toMatchObject({ notes: 20, hardViolations: 0 });
    // On the notes a tree holds in leaves, the measure is its weighted leaf coherence.
    expect(before.leafCoherence).toBeCloseTo(structureSignals(state).leafCoherence!, 6);
    // The same partition: nothing changes.
    const same = cloneTopicTreeState(state);
    applyRebuild({
      state: same,
      vectors,
      config,
      partition: partitionOfTree(state),
      newTopicId,
      now
    });
    expect(
      judgeTriggerRebuild(before, rebuildQuality(same, vectors, config, judged), config).accepted
    ).toBe(true);
    // Leaves that mix two clusters each: lower coherence, rejected.
    const mixed = cloneTopicTreeState(state);
    applyRebuild({
      state: mixed,
      vectors,
      config,
      partition: [
        { key: 0, parent: null, items: [] },
        { key: 1, parent: 0, items: [] },
        { key: 2, parent: 1, items: [...keys.slice(0, 3), ...keys.slice(5, 8)] },
        { key: 3, parent: 1, items: [...keys.slice(3, 5), ...keys.slice(8, 10)] },
        { key: 4, parent: 0, items: [] },
        { key: 5, parent: 4, items: keys.slice(10, 15) },
        { key: 6, parent: 4, items: keys.slice(15, 20) }
      ],
      newTopicId,
      now
    });
    const verdict = judgeTriggerRebuild(
      before,
      rebuildQuality(mixed, vectors, config, judged),
      config
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain("coherence");
  });

  it("judges a burst rebuild on the notes the current tree placed, not on those left waiting", () => {
    const { state, vectors, keys, newTopicId } = areaTree(2, 2, 5);
    // The notes of the second Area's second leaf wait unadmitted at the root instead.
    const area = getTopic(state, state.rootId).children[1]!;
    const leaf = getTopic(state, area).children[1]!;
    const waiting = [...getTopic(state, leaf).items];
    expect(waiting).toEqual(keys.slice(15, 20));
    const editor = createTopicTreeEditor(state, { record: false });
    for (const item of waiting) {
      editor.updatePlacement(item, 0, { decidedBy: "fallback", topicId: state.rootId });
    }
    editor.retireTopic(leaf, area, now);
    recomputeSubtree(state, vectors);
    expect(structureSignals(state).unadmitted).toBe(5);
    const judged = notesInLeaves(state, vectors);
    expect([...judged].sort()).toEqual(keys.slice(0, 15).sort());
    const before = rebuildQuality(state, vectors, config, judged);
    // The rebuild gives the waiting notes a leaf and keeps the rest: it is judged on the 15
    // notes that had a leaf, so the less central newcomers do not count against it.
    const rebuilt = cloneTopicTreeState(state);
    applyRebuild({
      state: rebuilt,
      vectors,
      config,
      partition: [
        { key: 0, parent: null, items: [] },
        { key: 1, parent: 0, items: [] },
        { key: 2, parent: 1, items: keys.slice(0, 5) },
        { key: 3, parent: 1, items: keys.slice(5, 10) },
        { key: 4, parent: 0, items: [] },
        { key: 5, parent: 4, items: keys.slice(10, 15) },
        { key: 6, parent: 4, items: waiting }
      ],
      newTopicId,
      now
    });
    expect(structureSignals(rebuilt).unadmitted).toBe(0);
    const verdict = judgeTriggerRebuild(
      before,
      rebuildQuality(rebuilt, vectors, config, judged),
      config
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.after.leafCoherence).toBeCloseTo(verdict.before.leafCoherence!, 6);
  });
});

/** The pre-order partition of a live tree (items as they are placed now). */
function partitionOfTree(state: TopicTreeState) {
  const nodes: { key: number; parent: number | null; items: ItemKey[] }[] = [];
  const keyOf = new Map<string, number>();
  const visit = (id: string): void => {
    const node = getTopic(state, id);
    keyOf.set(id, nodes.length);
    nodes.push({
      key: nodes.length,
      parent: node.parentId === null ? null : (keyOf.get(node.parentId) as number),
      items: [...node.items]
    });
    for (const child of node.children) visit(child);
  };
  visit(state.rootId);
  return nodes;
}

describe("protected subtrees in a rebuild", () => {
  /** root -> A (pinned) -> A1; A holds x3, A1 holds x1 and x2; root -> B holds y1..y4. */
  function pinnedTree(): {
    state: TopicTreeState;
    vectors: ReturnType<typeof keyedVectors>;
    keys: ItemKey[];
    ids: { a: string; a1: string; b: string };
  } {
    const data = gaussianClusters({
      groups: 2,
      clustersPerGroup: 1,
      pointsPerCluster: 4,
      dim: 16,
      groupSpread: 0.1,
      pointNoise: 0.2,
      seed: 3
    });
    const keys = Array.from({ length: 7 }, (_, row) => itemKey("note", uuid(500 + row)));
    const all = [...keys, itemKey("note", uuid(600))];
    const state = createTopicTreeState({ dim: 16, rootId: uuid(0) });
    all.forEach((key, row) =>
      registerItem(state, { key, kind: "note", contentHash: `h-${row}`, rootSource: null })
    );
    const editor = createTopicTreeEditor(state, { record: false });
    const ids = { a: uuid(1), a1: uuid(2), b: uuid(3) };
    editor.createTopic(ids.a, state.rootId, { management: "pinned" });
    editor.createTopic(ids.a1, ids.a);
    editor.createTopic(ids.b, state.rootId);
    editor.placeItem(keys[0]!, placementRecord(ids.a1));
    editor.placeItem(keys[1]!, placementRecord(ids.a1));
    editor.placeItem(keys[2]!, placementRecord(ids.a));
    for (const key of keys.slice(3)) editor.placeItem(key, placementRecord(ids.b));
    editor.placeItem(all[7]!, placementRecord(ids.b));
    const vectors = keyedVectors(data.matrix, all);
    recomputeSubtree(state, vectors);
    return { state, vectors, keys, ids };
  }

  it("keeps a pinned subtree whole: its rows are a frozen group and map onto it unchanged", () => {
    const { state, vectors, keys, ids } = pinnedTree();
    expect(protectedSubtrees(state)).toEqual([ids.a]);
    const rowOf = new Map(keys.map((key, row) => [key, row]));
    const frozen = frozenSubtrees(state, rowOf);
    expect(frozen).toEqual([{ topicId: ids.a, rows: [0, 1, 2] }]);
    // A worker result: the loose rows in one topic, the frozen group as one leaf.
    const partition = rebuildPartitionOf(
      [
        { key: 0, parent: null, items: [] },
        { key: 1, parent: 0, items: [3, 4, 5, 6] },
        { key: 2, parent: 0, items: [0, 1, 2] }
      ],
      keys,
      { state, frozen, frozenNodes: [2] }
    );
    expect(partition).toEqual([
      { key: 0, parent: null, items: [] },
      { key: 1, parent: 0, items: keys.slice(3) },
      { key: 2, parent: 0, items: [keys[2]] },
      { key: 3, parent: 2, items: [keys[0], keys[1]] }
    ]);
    const before = canonicalStateDump(state);
    const rebuilt = applyRebuild({
      state,
      vectors,
      config,
      partition,
      newTopicId: () => uuid(99),
      now
    });
    expect(rebuilt.events).toEqual([]);
    expect(rebuilt.review.required).toBe(false);
    expect(canonicalStateDump(state)).toBe(before);
  });

  it("maps worker rows to items without frozen groups", () => {
    const keys = [itemKey("note", uuid(1)), itemKey("note", uuid(2))];
    expect(
      rebuildPartitionOf(
        [
          { key: 0, parent: null, items: [] },
          { key: 1, parent: 0, items: [1, 0] }
        ],
        keys
      )
    ).toEqual([
      { key: 0, parent: null, items: [] },
      { key: 1, parent: 0, items: [keys[1], keys[0]] }
    ]);
    expect(() => rebuildPartitionOf([], keys)).toThrow(/no root/);
  });
});
