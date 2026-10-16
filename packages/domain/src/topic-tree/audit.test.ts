import { describe, expect, it } from "vitest";

import {
  auditTopicTree,
  exactRecomputeSample,
  misParentAudit,
  parentFit,
  parentMargin,
  reparentTarget
} from "./audit.js";
import { defaultTopicTreeConfig, topicTreeConfigWith } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { productState, productTree } from "./fixtures/trees.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import type { SyntheticData } from "./fixtures/synthetic.js";
import { itemKey } from "./ids.js";
import { createRng } from "./rng.js";
import { getTopic, placementRecord, registerItem } from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputeSubtree } from "./stats.js";
import type { ItemVectorSource } from "./vectors.js";

const config = defaultTopicTreeConfig;

/**
 * The tree the data was generated from: root -> one topic per group -> one leaf per cluster.
 * Returns the state, its vectors and the group topic of every cluster leaf.
 */
function trueTree(
  data: SyntheticData,
  offset = 0
): {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  groupOf: Map<string, string>;
  groups: string[];
  clusters: string[];
} {
  const { state, keys, vectors, next } = productState(data.matrix, offset);
  const editor = createTopicTreeEditor(state, { record: false });
  const groupTopics = new Map<number, string>();
  const clusterTopics = new Map<number, string>();
  const groupOf = new Map<string, string>();
  keys.forEach((key, row) => {
    const group = data.groups[row] as number;
    const cluster = data.clusters[row] as number;
    if (!groupTopics.has(group)) {
      const id = next();
      editor.createTopic(id, state.rootId);
      groupTopics.set(group, id);
    }
    if (!clusterTopics.has(cluster)) {
      const id = next();
      editor.createTopic(id, groupTopics.get(group) as string);
      clusterTopics.set(cluster, id);
      groupOf.set(id, groupTopics.get(group) as string);
    }
    editor.placeItem(key, placementRecord(clusterTopics.get(cluster) as string));
  });
  recomputeSubtree(state, vectors);
  return {
    state,
    vectors,
    groupOf,
    groups: [...groupTopics.values()],
    clusters: [...clusterTopics.values()]
  };
}

describe("mis-parent audit", () => {
  it("recalls topics planted under the wrong parent and targets their true parent", () => {
    let planted = 0;
    let recalled = 0;
    let targeted = 0;
    let falseFlags = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const data = gaussianClusters({
        groups: 6,
        clustersPerGroup: 4,
        pointsPerCluster: 12,
        dim: 32,
        groupSpread: 0.6,
        pointNoise: 0.6,
        seed
      });
      const tree = trueTree(data, seed * 100_000);
      const { state } = tree;
      expect(misParentAudit(state, config).findings).toEqual([]);
      const rng = createRng(seed);
      const editor = createTopicTreeEditor(state, { record: false });
      const moved = new Set<string>();
      // Plant 4 errors: a cluster leaf moved under another group (at most one per source group).
      const sources = rng.shuffle([...tree.groups]).slice(0, 4);
      for (const source of sources) {
        const cluster = getTopic(state, source).children[rng.int(4)] as string;
        const targets = tree.groups.filter((group) => group !== source);
        editor.moveTopic(cluster, targets[rng.int(targets.length)] as string);
        moved.add(cluster);
      }
      recomputeSubtree(state, tree.vectors);
      const audit = misParentAudit(state, config);
      planted += moved.size;
      for (const finding of audit.findings) {
        if (moved.has(finding.topicId)) {
          recalled += 1;
          if (finding.reparent?.uncleId === tree.groupOf.get(finding.topicId)) targeted += 1;
        } else {
          falseFlags += 1;
        }
      }
      const depth2 = audit.byDepth.find((summary) => summary.depth === 2);
      expect(depth2?.topics).toBe(24);
      expect(depth2?.share).toBeCloseTo((depth2?.misParented ?? 0) / 24, 12);
    }
    expect(recalled / planted).toBeGreaterThanOrEqual(0.95);
    expect(targeted / planted).toBeGreaterThanOrEqual(0.9);
    expect(falseFlags).toBeLessThanOrEqual(2);
  });

  it("flags with any uncle but re-parents only under an internal uncle beyond the margin", () => {
    const data = gaussianClusters({
      groups: 3,
      clustersPerGroup: 3,
      pointsPerCluster: 10,
      dim: 16,
      groupSpread: 0.6,
      pointNoise: 0.5,
      seed: 3
    });
    const tree = trueTree(data);
    const { state } = tree;
    const [first, second] = tree.groups as [string, string];
    const cluster = getTopic(state, first).children[0] as string;
    createTopicTreeEditor(state, { record: false }).moveTopic(cluster, second);
    recomputeSubtree(state, tree.vectors);
    const fit = parentFit(state, cluster);
    expect(fit?.parentId).toBe(second);
    expect(fit?.internalUncleId).toBe(first);
    expect(parentMargin(fit as NonNullable<typeof fit>)).toBeLessThan(0);
    expect(reparentTarget(state, config, cluster)?.uncleId).toBe(first);
    const wide = topicTreeConfigWith({ audit: { misParentMargin: 2 } });
    expect(reparentTarget(state, wide, cluster)).toBeNull();
    // Level-1 topics have no uncles; the root has no parent.
    expect(parentFit(state, first)).toBeNull();
    expect(parentFit(state, state.rootId)).toBeNull();
  });
});

describe("audit", () => {
  const data = gaussianClusters({
    groups: 3,
    clustersPerGroup: 2,
    pointsPerCluster: 20,
    dim: 16,
    groupSpread: 0.8,
    pointNoise: 0.5,
    seed: 9
  });

  it("finds drifted statistics in a seeded, content-ordered sample", () => {
    const tree = productTree(data, config, { seed: 1 });
    const all = topicTreeConfigWith({ audit: { exactRecomputeSample: 1000 } });
    expect(
      exactRecomputeSample(tree.state, tree.vectors, all, 5).every((check) => !check.drifted)
    ).toBe(true);
    const victim = getTopic(tree.state, tree.state.rootId).children[0] as string;
    getTopic(tree.state, victim).stats.ls[0] += 0.5;
    const checks = exactRecomputeSample(tree.state, tree.vectors, all, 5);
    expect(checks.filter((check) => check.drifted).map((check) => check.topicId)).toEqual([victim]);
    // The sample is chosen by content, so fresh UUIDs pick the same topics.
    const other = productTree(data, config, { seed: 1, offset: 5_000_000 });
    const small = topicTreeConfigWith({ audit: { exactRecomputeSample: 3 } });
    const anchors = (state: TopicTreeState, ids: string[]): string[] =>
      ids.map((id) =>
        [...getTopic(state, id).items]
          .map((item) => state.items.get(item)?.contentHash)
          .sort()
          .join()
      );
    expect(
      anchors(
        other.state,
        exactRecomputeSample(other.state, other.vectors, small, 5).map((check) => check.topicId)
      )
    ).toEqual(
      anchors(
        tree.state,
        exactRecomputeSample(tree.state, tree.vectors, small, 5).map((check) => check.topicId)
      )
    );
  });

  it("reports reachability, flagged items and the topics to recompute", () => {
    const tree = productTree(data, config, { seed: 1 });
    const { state } = tree;
    const orphan = itemKey("source", "00000000-0000-4000-8000-00000000abcd");
    registerItem(state, { key: orphan, kind: "source", contentHash: "zz", rootSource: null });
    const editor = createTopicTreeEditor(state, { record: false });
    const leaf = getTopic(state, getTopic(state, state.rootId).children[0] as string);
    const flagged = leaf.items[0] as string;
    editor.updatePlacement(flagged, 0, { needsGate: true, needsSplitCheck: true });
    getTopic(state, leaf.id).control.dirty = true;
    const audit = auditTopicTree(state, tree.vectors, config, { seed: 1 });
    expect(audit.reachability).toBeCloseTo(data.matrix.count / (data.matrix.count + 1), 12);
    expect(audit.unreachable.map((violation) => violation.item)).toEqual([orphan]);
    expect(audit.flaggedItems).toEqual({
      needsGate: 1,
      needsSplitCheck: 1,
      needsVector: 0,
      fallbackNone: 0
    });
    expect(audit.recomputeTopics).toContain(leaf.id);
    expect(audit.invariants.hard).toBe(1);
    const expected = auditTopicTree(state, tree.vectors, config, {
      seed: 1,
      expectedItems: [flagged]
    });
    expect(expected.reachability).toBe(1);
  });
});
