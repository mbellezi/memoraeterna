import { describe, expect, it } from "vitest";

import {
  createTopicTreeEditor,
  defaultSyntheticOptions,
  depthOf,
  getTopic,
  isLive,
  leafTopics,
  moveTopic,
  pathOf,
  pinTopic,
  recomputePaths,
  renameTopic,
  topicTreeConfigWith,
  walkTopics
} from "@app/domain/topic-tree";
import type { TopicManagement } from "@app/domain";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { shuffledOrder } from "./datasets.js";
import { createRealEngineFactory, neutralStability } from "./real-engine.js";
import { syntheticDataset } from "./synthetic-dataset.js";

// T26 proof: what a person moved, renamed or pinned is never changed by REBALANCE, however many
// inserts follow. The real engine replays 1,000 arrivals with local repairs after every insert, a
// REBALANCE after every hundred, and a forced pass at the end; small leaves keep it busy.
const dataset = syntheticDataset({ ...defaultSyntheticOptions, dim: 32 }, "human-protection");
const order = shuffledOrder(dataset, 5);
const busy = neutralStability(
  topicTreeConfigWith({
    leaf: { min: 2, target: 3, max: 5, hardMax: 9 },
    bootstrap: { singleTopicMaxItems: 9 },
    repair: { cooldownInserts: 0, mergeMaxSize: 9 }
  })
);

interface Kept {
  id: string;
  parentId: string | null;
  title: string | null;
  management: TopicManagement;
}

describe("human structure survives REBALANCE", () => {
  it("never moves, renames or retires a topic a person moved, renamed or pinned over 1,000 inserts", () => {
    const engine = createRealEngineFactory({ audit: true })({
      matrix: dataset.matrix,
      config: busy,
      seed: 11,
      detect: detectCommunitiesLouvain
    });
    engine.build(order.slice(0, 400));
    const { state } = engine;
    const editor = createTopicTreeEditor(state, { record: false });
    const context = { state, config: busy, editor };

    // Three leaves with a few items each: one moved, one renamed, one pinned by hand.
    const leaves = leafTopics(state).filter(
      (node) => node.id !== state.rootId && node.items.length >= 3
    );
    expect(leaves.length).toBeGreaterThan(8);
    const [moved, renamed, pinned] = leaves;
    if (!moved || !renamed || !pinned) throw new Error("the build has too few leaves");
    const target = [...state.topics.values()].find(
      (node) =>
        isLive(node) &&
        node.id !== state.rootId &&
        node.children.length > 0 &&
        node.id !== moved.parentId &&
        !pathOf(state, node.id).includes(moved.id) &&
        depthOf(state, node.id) + 1 <= busy.depth.cap
    );
    expect(target).toBeDefined();
    const oldParent = moved.parentId as string;
    moveTopic(context, moved.id, target!.id);
    renameTopic(context, renamed.id, "Escolhido por mim");
    pinTopic(context, pinned.id);
    recomputePaths(state, engine.vectors, [moved.id, oldParent, target!.id, renamed.id, pinned.id]);

    const keep = (id: string): Kept => {
      const node = getTopic(state, id);
      return {
        id,
        parentId: node.parentId,
        title: node.title,
        management: node.management
      };
    };
    const kept = [moved.id, renamed.id, pinned.id].map(keep);
    // The automatic topics around them, to show that REBALANCE does move what it may.
    const automatic = new Map(
      [...state.topics.values()]
        .filter((node) => isLive(node) && node.management === "ai" && node.parentId !== null)
        .map((node) => [node.id, node.parentId])
    );
    expect(kept.map((topic) => topic.management)).toEqual(["human", "human", "pinned"]);
    const expectUnchanged = (): void => {
      for (const topic of kept) {
        const node = getTopic(state, topic.id);
        expect(isLive(node)).toBe(true);
        expect(keep(topic.id)).toEqual(topic);
      }
    };

    // 1,000 arrivals, REBALANCE after every hundred, the audit before each.
    let operations = 0;
    const stream = order.slice(400, 1400);
    for (let from = 0, day = 1; from < stream.length; from += 100, day += 1) {
      const placed = engine.place(stream.slice(from, from + 100), { localRepair: true });
      operations += Object.values(placed.operations).reduce<number>(
        (total, count) => total + (count ?? 0),
        0
      );
      const result = engine.rebalance({ day });
      operations += Object.values(result.operations).reduce<number>(
        (total, count) => total + (count ?? 0),
        0
      );
      expectUnchanged();
    }
    operations += Object.values(engine.settle()).reduce<number>(
      (total, count) => total + (count ?? 0),
      0
    );
    expectUnchanged();

    // The test is only worth something if REBALANCE worked on the tree around them.
    expect(operations).toBeGreaterThan(20);
    const changed = [...automatic].filter(([id, parentId]) => {
      const node = state.topics.get(id);
      return !node || !isLive(node) || node.parentId !== parentId;
    });
    expect(changed.length).toBeGreaterThan(0);
    expect(state.items.size).toBe(1400);
    let live = 0;
    walkTopics(state, () => {
      live += 1;
    });
    expect(live).toBeGreaterThan(40);
  }, 120_000);
});
