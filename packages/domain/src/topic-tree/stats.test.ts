import { describe, expect, it } from "vitest";

import { defaultTopicTreeConfig, topicTreeConfigWith } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import { itemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { statsDrift } from "./metrics.js";
import { createRng } from "./rng.js";
import {
  createTopicTreeState,
  getTopic,
  pathOf,
  placementRecord,
  primaryPlacement,
  registerItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import {
  addItemToPath,
  admissionThreshold,
  coherenceOf,
  countsInStats,
  recomputePaths,
  recomputeSubtree,
  spreadOf,
  statsDump,
  subtractItemFromPath
} from "./stats.js";
import { keyedVectors, matrixFromRows } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

const uuidOf = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const rootId = uuidOf(0);
const topics = [uuidOf(1), uuidOf(2), uuidOf(3)];

interface Fixture {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  keys: ItemKey[];
}

/** Root -> A, B; A -> C. 60 notes spread over A, B and C in the given order. */
function fixture(order: readonly number[]): Fixture {
  const data = gaussianClusters({
    groups: 3,
    clustersPerGroup: 1,
    pointsPerCluster: 20,
    dim: 16,
    groupSpread: 0.6,
    pointNoise: 0.4,
    seed: 9
  });
  const keys = Array.from({ length: data.matrix.count }, (_, index) =>
    itemKey("note", uuidOf(100 + index))
  );
  const state = createTopicTreeState({ dim: 16, rootId });
  keys.forEach((key, index) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: `c${(index * 37) % 61}`,
      rootSource: null
    })
  );
  const editor = createTopicTreeEditor(state, { record: false });
  editor.createTopic(topics[0] as string, rootId);
  editor.createTopic(topics[1] as string, rootId);
  editor.createTopic(topics[2] as string, topics[0] as string);
  const homes = [topics[1], topics[2], topics[0]] as string[];
  for (const index of order) {
    editor.placeItem(
      keys[index] as ItemKey,
      placementRecord(homes[(data.clusters[index] as number) % 3] as string)
    );
  }
  return { state, vectors: keyedVectors(data.matrix, keys), keys };
}

describe("topic statistics", () => {
  it("recomputes exact statistics bit-identically whatever the insertion order", () => {
    const forward = fixture(Array.from({ length: 60 }, (_, index) => index));
    const shuffled = fixture(createRng(4).shuffle(Array.from({ length: 60 }, (_, index) => index)));
    recomputeSubtree(forward.state, forward.vectors);
    recomputeSubtree(shuffled.state, shuffled.vectors);
    expect(statsDump(shuffled.state)).toBe(statsDump(forward.state));
    expect(getTopic(forward.state, rootId).stats.n).toBe(60);
    expect(getTopic(forward.state, topics[0] as string).stats.n).toBe(40);
  });

  it("recomputes touched paths to the same bits as a full recompute", () => {
    const { state, vectors, keys } = fixture(Array.from({ length: 60 }, (_, index) => index));
    recomputeSubtree(state, vectors);
    const editor = createTopicTreeEditor(state);
    editor.updatePlacement(keys[0] as ItemKey, 0, { topicId: topics[1] as string });
    editor.updatePlacement(keys[1] as ItemKey, 0, { topicId: topics[2] as string });
    recomputePaths(state, vectors, editor.touched);
    const partial = statsDump(state);
    recomputeSubtree(state, vectors);
    expect(partial).toBe(statsDump(state));
  });

  it("keeps in-memory add and subtract within 1e-9 of the exact recompute", () => {
    const { state, vectors, keys } = fixture(Array.from({ length: 60 }, (_, index) => index));
    recomputeSubtree(state, vectors);
    const editor = createTopicTreeEditor(state, { record: false });
    const rng = createRng(12);
    for (let step = 0; step < 500; step += 1) {
      const key = keys[rng.int(keys.length)] as ItemKey;
      const placement = primaryPlacement(state, key);
      if (placement) {
        subtractItemFromPath(state, vectors, key, placement.topicId);
        editor.unplaceItem(key, 0);
      } else {
        const target = [rootId, ...topics][rng.int(4)] as string;
        editor.placeItem(key, placementRecord(target));
        addItemToPath(state, vectors, key, target);
      }
    }
    const drift = statsDrift(state, vectors);
    expect(drift.maxCountError).toBe(0);
    expect(drift.maxSumError).toBeLessThan(1e-9);
  });

  it("counts a root source only while none of its notes is placed (D8)", () => {
    const source = itemKey("source", uuidOf(900));
    const note = itemKey("note", uuidOf(901));
    const state = createTopicTreeState({ dim: 2, rootId });
    registerItem(state, { key: source, kind: "source", contentHash: "s", rootSource: null });
    registerItem(state, { key: note, kind: "note", contentHash: "n", rootSource: source });
    const vectors = keyedVectors(
      matrixFromRows([
        [1, 0],
        [0, 1]
      ]),
      [source, note]
    );
    const editor = createTopicTreeEditor(state, { record: false });
    editor.placeItem(source, placementRecord(rootId));
    expect(countsInStats(state, source)).toBe(true);
    editor.placeItem(note, placementRecord(rootId));
    expect(countsInStats(state, source)).toBe(false);
    recomputeSubtree(state, vectors);
    expect(getTopic(state, rootId).stats.n).toBe(1);
    expect(Array.from(getTopic(state, rootId).stats.centroid)).toEqual([0, 1]);
    editor.unplaceItem(note, 0);
    expect(countsInStats(state, source)).toBe(true);
    recomputeSubtree(state, vectors);
    expect(Array.from(getTopic(state, rootId).stats.centroid)).toEqual([1, 0]);
  });

  it("leaves members without a current vector out of the statistics (D7)", () => {
    const { state, keys, vectors } = fixture(Array.from({ length: 60 }, (_, index) => index));
    const missing = keys[5] as ItemKey;
    const partial: ItemVectorSource = {
      matrix: vectors.matrix,
      rowOf: (item) => (item === missing ? undefined : vectors.rowOf(item))
    };
    recomputeSubtree(state, partial);
    expect(getTopic(state, rootId).stats.n).toBe(59);
    expect(primaryPlacement(state, missing)).toBeDefined();
  });

  it("derives coherence, spread and node-relative admission", () => {
    const state = createTopicTreeState({ dim: 2, rootId });
    const keys = [itemKey("note", uuidOf(1)), itemKey("note", uuidOf(2))];
    keys.forEach((key) =>
      registerItem(state, { key, kind: "note", contentHash: key, rootSource: null })
    );
    const editor = createTopicTreeEditor(state, { record: false });
    const leaf = uuidOf(3);
    editor.createTopic(leaf, rootId);
    expect(admissionThreshold(getTopic(state, leaf), defaultTopicTreeConfig)).toBe(
      Number.POSITIVE_INFINITY
    );
    for (const key of keys) editor.placeItem(key, placementRecord(leaf));
    const same = keyedVectors(
      matrixFromRows([
        [1, 0],
        [1, 0]
      ]),
      keys
    );
    recomputeSubtree(state, same);
    const { stats } = getTopic(state, leaf);
    expect(coherenceOf(stats)).toBeCloseTo(1, 12);
    expect(spreadOf(stats)).toBeCloseTo(0, 6);
    // m - z * max(s, floor) = 1 - 2.5 * 0.03; the leaf-only floor binds on the leaf alone.
    const config = topicTreeConfigWith({ placement: { leaveOneOutMean: false, leafFloor: 0.95 } });
    expect(admissionThreshold(getTopic(state, leaf), config)).toBeCloseTo(0.95, 6);
    expect(admissionThreshold(getTopic(state, rootId), config)).toBeCloseTo(0.925, 6);
    expect(pathOf(state, leaf)).toEqual([rootId, leaf]);
  });
});
