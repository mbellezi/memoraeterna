import { describe, expect, it } from "vitest";

import { defaultTopicTreeConfig } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { productTree } from "./fixtures/trees.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import {
  acceptsChange,
  areDuplicateLeaves,
  bandCost,
  fanOutBand,
  isMovableDirectItem,
  netGain,
  subtreeQuality,
  treeQuality
} from "./quality.js";
import { getTopic, placementRecord } from "./state.js";
import { recomputeSubtree } from "./stats.js";
import { norm } from "./vectors.js";

const config = defaultTopicTreeConfig;
const data = gaussianClusters({
  groups: 4,
  clustersPerGroup: 3,
  pointsPerCluster: 20,
  dim: 24,
  groupSpread: 0.8,
  pointNoise: 0.5,
  seed: 21
});

describe("band costs", () => {
  it("are zero inside the band and grow with the relative distance outside it", () => {
    expect(bandCost(20, 20, 3, 30, 3)).toBe(0);
    expect(bandCost(33, 33, 3, 30, 3)).toBeCloseTo(33 * (1 + 3 / 30), 12);
    // Affected items are floored at the unit (leaf.min): a tiny leaf costs a minimum leaf.
    expect(bandCost(1, 1, 3, 30, 3)).toBeCloseTo(3 * (1 + 2 / 3), 12);
    expect(bandCost(0, 0, 3, 30, 3)).toBeCloseTo(3 * 2, 12);
  });

  it("make acceptance a function of lambda only", () => {
    const unit = { ...config, stability: { ...config.stability, churnWeight: 1 } };
    expect(acceptsChange(10, 9, unit)).toBe(true);
    expect(acceptsChange(10, 10, unit)).toBe(false);
    expect(netGain(10, 4, { ...config, stability: { ...config.stability, churnWeight: 3 } })).toBe(
      -2
    );
  });
});

describe("tree quality", () => {
  it("is the fit of every item minus the soft-condition costs", () => {
    const tree = productTree(data, config, { seed: 7 });
    const report = treeQuality(tree.state, tree.vectors, config);
    let leafFit = 0;
    for (const node of tree.state.topics.values()) {
      if (node.children.length === 0 && node.id !== tree.state.rootId)
        leafFit += norm(node.stats.ls);
    }
    expect(report.fit).toBeCloseTo(leafFit, 9);
    expect(report.total).toBeCloseTo(report.fit - report.cost, 9);
    expect(report.items).toBe(data.matrix.count);
    // The top-down build cut clusters into near-duplicate sibling leaves.
    expect(report.duplicates).toBeGreaterThan(0);
  });

  it("charges oversized leaves, single children, direct items and the Areas band", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state, vectors } = tree;
    const editor = createTopicTreeEditor(state, { record: false });
    const root = getTopic(state, state.rootId);
    const [first, second] = root.children as [string, string];
    const firstNode = getTopic(state, first);
    const leaf = firstNode.children[0] ?? first;
    // Pile items of the second Area into one leaf of the first: leaf above leaf.max.
    const moved = [...getTopic(state, getTopic(state, second).children[0] ?? second).items];
    const extra = [...getTopic(state, getTopic(state, second).children[1] ?? second).items];
    for (const item of [...moved, ...extra]) editor.updatePlacement(item, 0, { topicId: leaf });
    recomputeSubtree(state, vectors);
    const size = getTopic(state, leaf).items.length;
    expect(size).toBeGreaterThan(config.leaf.max);
    expect(treeQuality(state, vectors, config).leafSize).toBeGreaterThanOrEqual(
      size * (1 + (size - config.leaf.max) / config.leaf.max) - 1e-9
    );
    // A single-child chain costs its subtree twice (I3 below the band and I6).
    const holder = tree.newTopicId();
    editor.createTopic(holder, state.rootId);
    editor.moveTopic(second, holder);
    recomputeSubtree(state, vectors);
    const chain = treeQuality(state, vectors, config);
    const n = getTopic(state, holder).items.length + getTopic(state, second).stats.n;
    expect(chain.singleChild).toBeCloseTo(n, 9);
    // Direct items on an internal topic count once there are directItemsSplitAt movable ones.
    const direct = getTopic(state, leaf).items.slice(0, config.repair.directItemsSplitAt);
    for (const item of direct) editor.updatePlacement(item, 0, { topicId: first });
    const flagged = getTopic(state, leaf).items[0] as string;
    editor.updatePlacement(flagged, 0, { topicId: first, needsGate: true });
    recomputeSubtree(state, vectors);
    expect(isMovableDirectItem(state, flagged)).toBe(false);
    const withDirect = treeQuality(state, vectors, config);
    expect(withDirect.directItems).toBeCloseTo(
      config.repair.directItemsSplitAt * (1 + 1 / (config.repair.directItemsSplitAt - 1)),
      9
    );
    // The root follows the Areas band once Areas exist.
    expect(fanOutBand(state, config, state.rootId, { areasActive: true })).toEqual({
      low: config.areas.min,
      high: config.areas.max
    });
    const areas = treeQuality(state, vectors, config, { areasActive: true });
    expect(areas.fanOut).toBeGreaterThan(withDirect.fanOut);
  });

  it("costs nothing for a root without children (the cold start)", () => {
    const tree = productTree(data, config, { seed: 7, rows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(getTopic(tree.state, tree.state.rootId).children).toEqual([]);
    expect(treeQuality(tree.state, tree.vectors, config).total).toBe(0);
  });

  it("finds duplicate sibling leaves only within repair.mergeMaxSize", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state, vectors } = tree;
    const editor = createTopicTreeEditor(state, { record: false });
    const leaf = getTopic(state, state.rootId)
      .children.map((id) => getTopic(state, id))
      .find((node) => node.children.length === 0 && node.items.length >= 12);
    if (!leaf) throw new Error("fixture has no top-level leaf");
    const twin = tree.newTopicId();
    editor.createTopic(twin, state.rootId);
    for (const item of leaf.items.slice(0, Math.floor(leaf.items.length / 2))) {
      editor.updatePlacement(item, 0, { topicId: twin });
    }
    recomputeSubtree(state, vectors);
    const duplicate = areDuplicateLeaves(config, leaf, getTopic(state, twin));
    expect(duplicate?.cosine).toBeGreaterThanOrEqual(config.repair.siblingMergeCosine);
    const strict = { ...config, repair: { ...config.repair, mergeMaxSize: 3 } };
    expect(areDuplicateLeaves(strict, leaf, getTopic(state, twin))).toBeNull();
  });

  it("measures a scope: changes inside a child's subtree give the whole tree's difference", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state, vectors } = tree;
    const area = getTopic(state, state.rootId).children.find(
      (id) => getTopic(state, id).children.length >= 2
    ) as string;
    const [left, right] = getTopic(state, area).children as [string, string];
    const wholeBefore = treeQuality(state, vectors, config).total;
    const scopeBefore = subtreeQuality(state, vectors, config, state.rootId).total;
    const areaBefore = subtreeQuality(state, vectors, config, area).total;
    const editor = createTopicTreeEditor(state, { record: false });
    for (const item of getTopic(state, left).items.slice(0, 3)) {
      editor.updatePlacement(item, 0, { topicId: right });
    }
    recomputeSubtree(state, vectors);
    const whole = treeQuality(state, vectors, config).total - wholeBefore;
    expect(subtreeQuality(state, vectors, config, state.rootId).total - scopeBefore).toBeCloseTo(
      whole,
      9
    );
    // Items moving between two leaves leave their parent's centroid as it was, so the parent's
    // subtree already holds the whole change.
    expect(subtreeQuality(state, vectors, config, area).total - areaBefore).toBeCloseTo(whole, 9);
    // Placing a secondary changes nothing in Q.
    const before = treeQuality(state, vectors, config).total;
    const item = getTopic(state, left).items[0] as string;
    editor.placeItem(item, placementRecord(right, { rank: 1 }));
    expect(treeQuality(state, vectors, config).total).toBe(before);
  });
});
