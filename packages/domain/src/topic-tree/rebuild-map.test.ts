import { describe, expect, it } from "vitest";

import { buildTopDown } from "./build.js";
import { defaultTopicTreeConfig, topicTreeConfigWith } from "./config.js";
import type { TopicTreeConfig } from "./config.js";
import {
  StructureEventSchema,
  applyEvents,
  createTopicTreeEditor,
  invertEvents
} from "./events.js";
import { fixtureNow, productTree, topicsByKind } from "./fixtures/trees.js";
import type { ProductTree } from "./fixtures/trees.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import { itemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { checkInvariants } from "./invariants.js";
import { applyRebuild, planRebuild, RebuildMappingError } from "./rebuild-map.js";
import type { RebuildPartitionNode, RebuildResult } from "./rebuild-map.js";
import { createRng } from "./rng.js";
import {
  canonicalStateDump,
  getTopic,
  isLive,
  liveTopicIds,
  placementRecord,
  placementsOf,
  primaryPlacement,
  registerItem,
  resolveTopicId,
  walkTopics
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputeSubtree, statsDump } from "./stats.js";

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

interface MutableNode {
  key: number;
  parent: number | null;
  items: ItemKey[];
}

/** The live tree as a partition (pre-order keys), optionally visiting children in reverse. */
function partitionWithKeys(
  state: TopicTreeState,
  reverse = false
): { nodes: MutableNode[]; keyOf: Map<string, number> } {
  const nodes: MutableNode[] = [];
  const keyOf = new Map<string, number>();
  const visit = (id: string, parent: string | null): void => {
    const node = getTopic(state, id);
    const key = nodes.length * 7 + 3;
    keyOf.set(id, key);
    nodes.push({
      key,
      parent: parent === null ? null : (keyOf.get(parent) as number),
      items: [...node.items]
    });
    const children = reverse ? [...node.children].reverse() : node.children;
    for (const child of children) visit(child, id);
  };
  visit(state.rootId, null);
  return { nodes, keyOf };
}

function partitionOf(state: TopicTreeState, reverse = false): MutableNode[] {
  return partitionWithKeys(state, reverse).nodes;
}

/** Parents before children: sorted by depth, then by the original order. */
function preOrdered(nodes: MutableNode[]): MutableNode[] {
  const depthOf = (node: MutableNode): number => {
    let depth = 0;
    for (let current = node.parent; current !== null; depth += 1) {
      current = (nodes.find((entry) => entry.key === current) as MutableNode).parent;
    }
    return depth;
  };
  return nodes
    .map((node, index) => ({ node, index, depth: depthOf(node) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((entry) => entry.node);
}

function rebuild(
  tree: ProductTree,
  partition: readonly RebuildPartitionNode[],
  overrides: { config?: TopicTreeConfig; dryRun?: boolean; freshItems?: Set<ItemKey> } = {}
): RebuildResult {
  return applyRebuild({
    state: tree.state,
    vectors: tree.vectors,
    config: overrides.config ?? config,
    partition,
    newTopicId: tree.newTopicId,
    now: fixtureNow,
    ...(overrides.dryRun === undefined ? {} : { dryRun: overrides.dryRun }),
    ...(overrides.freshItems === undefined ? {} : { freshItems: overrides.freshItems })
  });
}

function nodeWith(partition: MutableNode[], item: ItemKey): MutableNode {
  return partition.find((node) => node.items.includes(item)) as MutableNode;
}

describe("rebuild mapping", () => {
  it("keeps every ID with churn 0 for an identical partition, in any sibling order", () => {
    for (const reverse of [false, true]) {
      const tree = productTree(data, config, { seed: 7 });
      const before = canonicalStateDump(tree.state);
      const ids = liveTopicIds(tree.state);
      const result = rebuild(tree, partitionOf(tree.state, reverse));
      expect(result.events).toEqual([]);
      expect(result.churn.items).toEqual([]);
      expect(result.plan.createdKeys).toEqual([]);
      expect(result.plan.unmatchedTopics).toEqual([]);
      expect(result.plan.exact).toBe(true);
      expect(result.plan.matched.every((match) => match.jaccard === 1)).toBe(true);
      expect(liveTopicIds(tree.state)).toEqual(ids);
      expect(canonicalStateDump(tree.state)).toBe(before);
    }
  });

  it("keeps IDs greedily above rebuild.hungarianExactMaxTopics", () => {
    const tree = productTree(data, config, { seed: 7 });
    const greedy = topicTreeConfigWith({ rebuild: { hungarianExactMaxTopics: 1 } });
    const result = rebuild(tree, partitionOf(tree.state), { config: greedy });
    expect(result.events).toEqual([]);
    expect(result.plan.matched.every((match) => match.jaccard === 1)).toBe(true);
  });

  it("maps a changed partition: survivors keep IDs, retired topics redirect, undo is exact", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const before = canonicalStateDump(state);
    const beforeStats = statsDump(state);
    const partition = partitionOf(state);
    const leaves = partition.filter(
      (node) => node.parent !== null && !partition.some((other) => other.parent === node.key)
    );
    // Split the biggest leaf in two (a new node takes its smaller part) ...
    const big = [...leaves].sort((a, b) => b.items.length - a.items.length)[0] as MutableNode;
    const bigTopic = getTopic(
      state,
      primaryPlacement(state, big.items[0] as ItemKey)?.topicId as string
    );
    const part = big.items.splice(0, Math.floor(big.items.length / 3));
    partition.push({ key: 9_999, parent: big.parent, items: part });
    // ... and fold the smallest leaf into a sibling.
    const small = [...leaves].sort((a, b) => a.items.length - b.items.length)[0] as MutableNode;
    const smallTopic = primaryPlacement(state, small.items[0] as ItemKey)?.topicId as string;
    const sibling = leaves.find(
      (node) => node !== small && node !== big && node.parent === small.parent
    ) as MutableNode;
    const siblingTopic = primaryPlacement(state, sibling.items[0] as ItemKey)?.topicId as string;
    const folded = [...small.items];
    sibling.items.push(...folded);
    small.items.length = 0;
    const result = rebuild(
      tree,
      partition.filter((node) => node !== small)
    );
    for (const event of result.events) expect(StructureEventSchema.parse(event)).toEqual(event);
    // Survivors keep their IDs; the new node is a new topic under the same parent.
    expect(isLive(bigTopic)).toBe(true);
    expect(bigTopic.items.length).toBe(big.items.length);
    expect(result.plan.createdKeys).toEqual([9_999]);
    const created = result.plan.topicIdOfKey.get(9_999) as string;
    expect(getTopic(state, created).parentId).toBe(bigTopic.parentId);
    // The folded leaf retires and redirects to the holder of its members.
    expect(result.retired).toEqual([{ topicId: smallTopic, redirectTo: siblingTopic }]);
    expect(resolveTopicId(state, smallTopic)).toBe(siblingTopic);
    // Every partition item sits on its node's topic; churn counts exactly the moved items.
    for (const node of partition.filter((entry) => entry !== small)) {
      for (const item of node.items) {
        expect(primaryPlacement(state, item)?.topicId).toBe(result.plan.topicIdOfKey.get(node.key));
      }
    }
    expect(new Set(result.churn.items)).toEqual(new Set([...part, ...folded]));
    expect(checkInvariants(state, config).hard).toBe(0);
    applyEvents(state, invertEvents(result.events));
    expect(canonicalStateDump(state)).toBe(before);
    recomputeSubtree(state, tree.vectors);
    expect(statsDump(state)).toBe(beforeStats);
  });

  it("redirects a retired topic to the deepest topic that holds a majority of its members", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const area = getTopic(state, state.rootId).children.find(
      (id) => getTopic(state, id).children.length >= 4
    ) as string;
    // y and z are the largest leaves, x and w the smallest: the receivers keep a majority of
    // their own members, so they keep their IDs.
    const bySize = [...getTopic(state, area).children].sort(
      (a, b) => getTopic(state, b).items.length - getTopic(state, a).items.length
    );
    const [y, z] = bySize as [string, string];
    const [x, w] = bySize.slice(-2).reverse() as [string, string];
    const partition = partitionOf(state);
    const of = (topic: string): MutableNode =>
      nodeWith(partition, getTopic(state, topic).items[0] as ItemKey);
    const xItems = [...getTopic(state, x).items];
    // 70% of x goes to y, 30% to z: y holds the majority of x.
    const xNode = of(x);
    const split = Math.ceil(xItems.length * 0.7);
    of(y).items.push(...xItems.slice(0, split));
    of(z).items.push(...xItems.slice(split));
    const first = rebuild(
      tree,
      partition.filter((node) => node !== xNode)
    );
    expect(first.retired).toEqual([{ topicId: x, redirectTo: y }]);
    // No leaf holds a majority of w: it redirects to their common parent.
    const again = partitionOf(state);
    const wNode = nodeWith(again, getTopic(state, w).items[0] as ItemKey);
    const wItems = [...wNode.items];
    wNode.items.length = 0;
    const third = Math.ceil(wItems.length / 3);
    nodeWith(again, getTopic(state, y).items[0] as ItemKey).items.push(...wItems.slice(0, third));
    nodeWith(again, getTopic(state, z).items[0] as ItemKey).items.push(
      ...wItems.slice(third, 2 * third)
    );
    const others = getTopic(state, area).children.filter((id) => ![y, z, w].includes(id));
    nodeWith(again, getTopic(state, others[0] as string).items[0] as ItemKey).items.push(
      ...wItems.slice(2 * third)
    );
    const second = rebuild(
      tree,
      again.filter((node) => node !== wNode)
    );
    expect(second.retired).toEqual([{ topicId: w, redirectTo: area }]);
  });

  it("flags protected structure and large moves for review, and dry runs change nothing", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const other = buildTopDown(
      data.matrix,
      Array.from({ length: data.matrix.count }, (_, r) => r),
      {
        seed: 99,
        config: topicTreeConfigWith({ leaf: { max: 12, target: 8 } })
      }
    ).state;
    // A different clustering of the same items (row keys mapped to note keys).
    const keyOf = (row: string): ItemKey => tree.keys[Number(row.slice(4))] as ItemKey;
    const partition: RebuildPartitionNode[] = [];
    const keys = new Map<string, number>();
    walkTopics(other, (node) => {
      keys.set(node.id, partition.length);
      partition.push({
        key: partition.length,
        parent: node.parentId === null ? null : (keys.get(node.parentId) as number),
        items: node.items.map(keyOf)
      });
    });
    const before = canonicalStateDump(state);
    const dry = rebuild(tree, partition, { dryRun: true });
    expect(canonicalStateDump(state)).toBe(before);
    expect(dry.movedShare).toBeGreaterThan(config.rebuild.reviewChurnShare);
    expect(dry.review).toMatchObject({ largeShare: true, required: true });
    expect(dry.establishedShare).toBe(dry.movedShare);
    expect(dry.events.length).toBeGreaterThan(0);
    // Fresh items (placed recently, never seen) leave the review share: the same move of a
    // library that arrived in this session needs no review.
    const fresh = rebuild(tree, partition, { dryRun: true, freshItems: new Set(tree.keys) });
    expect(fresh.movedShare).toBe(dry.movedShare);
    expect(fresh.establishedShare).toBe(0);
    expect(fresh.churn.weighted).toBe(0);
    expect(fresh.review).toMatchObject({ largeShare: false, required: false });
    expect(canonicalStateDump(state)).toBe(before);
    // The dry run's events apply exactly to the unchanged state.
    applyEvents(state, dry.events);
    expect(checkInvariants(state, config).hard).toBe(0);
    applyEvents(state, invertEvents(dry.events));
    expect(canonicalStateDump(state)).toBe(before);
    const pinned = topicsByKind(state).leaves[0] as string;
    createTopicTreeEditor(state, { record: false }).manageTopic(pinned, "pinned");
    expect(rebuild(tree, partition, { dryRun: true }).review.protectedTouched).toBe(true);
  });

  it("keeps human placements, places new items and clears colliding AI titles", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const editor = createTopicTreeEditor(state, { record: false });
    const [a, b] = getTopic(state, state.rootId).children.filter(
      (id) => getTopic(state, id).children.length >= 2
    ) as [string, string];
    const childA = getTopic(state, a).children[0] as string;
    const childB = getTopic(state, b).children[0] as string;
    editor.renameTopic(childA, { title: "Música", nameState: "named", nameSource: "llm" });
    editor.renameTopic(childB, { title: "musica", nameState: "named", nameSource: "human" });
    const human = getTopic(state, childA).items[0] as ItemKey;
    editor.updatePlacement(human, 0, { management: "human" });
    const fresh = itemKey("note", "00000000-0000-4000-8000-0000000fffff");
    registerItem(state, { key: fresh, kind: "note", contentHash: "zzz", rootSource: null });
    const { nodes, keyOf } = partitionWithKeys(state);
    // childA moves under b, next to the human-named childB; the human item and a new item go to
    // childB in the partition.
    const nodeA = nodes.find((node) => node.key === keyOf.get(childA)) as MutableNode;
    nodeA.parent = keyOf.get(b) as number;
    nodeA.items = nodeA.items.filter((entry) => entry !== human);
    const nodeB = nodes.find((node) => node.key === keyOf.get(childB)) as MutableNode;
    nodeB.items.push(human, fresh);
    const ordered = preOrdered(nodes);
    const result = rebuild(tree, ordered);
    expect(result.keptItems).toEqual([human]);
    expect(placementsOf(state, human)[0]?.topicId).toBe(childA);
    expect(primaryPlacement(state, fresh)?.decidedBy).toBe("rebuild");
    expect(result.churn.items).not.toContain(fresh);
    expect(getTopic(state, childA).parentId).toBe(b);
    expect(result.unnamed).toEqual([childA]);
    expect(getTopic(state, childA).title).toBeNull();
    expect(getTopic(state, childB).title).toBe("musica");
    expect(checkInvariants(state, config).hard).toBe(0);
  });

  it("rejects malformed partitions", () => {
    const tree = productTree(data, config, { seed: 7 });
    const partition = partitionOf(tree.state);
    const plan = (nodes: RebuildPartitionNode[]) => () =>
      planRebuild(tree.state, nodes, config, tree.newTopicId);
    expect(plan([])).toThrow(RebuildMappingError);
    expect(plan(partition.slice(1))).toThrow(RebuildMappingError);
    expect(plan([...partition, { ...(partition[1] as RebuildPartitionNode) }])).toThrow(
      RebuildMappingError
    );
    const unknown = itemKey("note", "00000000-0000-4000-8000-00000000eeee");
    expect(plan([{ key: 0, parent: null, items: [unknown] }])).toThrow(RebuildMappingError);
  });

  it("keeps the hard invariants and stays exactly invertible on random partitions", () => {
    for (let seed = 1; seed <= 15; seed += 1) {
      const tree = productTree(data, config, { seed: 7, offset: seed * 1_000 });
      const { state } = tree;
      const rng = createRng(seed);
      const editor = createTopicTreeEditor(state, { record: false });
      for (const id of topicsByKind(state).leaves.slice(0, 2)) {
        editor.renameTopic(id, { title: `Topic ${seed}`, nameState: "named", nameSource: "llm" });
      }
      const item = getTopic(state, topicsByKind(state).leaves[3] as string).items[0] as ItemKey;
      editor.placeItem(item, placementRecord(topicsByKind(state).leaves[4] as string, { rank: 1 }));
      const before = canonicalStateDump(state);
      const fresh = buildTopDown(
        data.matrix,
        Array.from({ length: data.matrix.count }, (_, r) => r),
        {
          seed: seed * 13,
          config: topicTreeConfigWith({ leaf: { max: 10 + rng.int(25), target: 8 + rng.int(6) } })
        }
      ).state;
      const partition: RebuildPartitionNode[] = [];
      const keys = new Map<string, number>();
      walkTopics(fresh, (node) => {
        keys.set(node.id, partition.length);
        partition.push({
          key: partition.length,
          parent: node.parentId === null ? null : (keys.get(node.parentId) as number),
          items: node.items.map((row) => tree.keys[Number(row.slice(4))] as ItemKey)
        });
      });
      const result = rebuild(tree, partition);
      expect(checkInvariants(state, config).hard).toBe(0);
      for (const node of partition) {
        const topicId = result.plan.topicIdOfKey.get(node.key) as string;
        expect(isLive(getTopic(state, topicId))).toBe(true);
        for (const member of node.items) {
          expect(primaryPlacement(state, member)?.topicId).toBe(topicId);
        }
      }
      for (const retired of result.retired) {
        expect(isLive(getTopic(state, resolveTopicId(state, retired.topicId)))).toBe(true);
      }
      applyEvents(state, invertEvents(result.events));
      expect(canonicalStateDump(state)).toBe(before);
    }
  });
});
