import { describe, expect, it } from "vitest";

import {
  createTopicTreeEditor,
  createTopicTreeState,
  insertPlacement,
  insertTopic,
  placementRecord,
  registerItem,
  rowContentHash,
  rowItemKey,
  topicRecord
} from "@app/domain/topic-tree";
import type { TopicTreeState } from "@app/domain/topic-tree";

import { NamingSimulator, itemHash, replaySketch } from "./naming-sim.js";

/** Root -> A -> {A1, A2}, root -> B; 10 rows per leaf. */
function tree(): TopicTreeState {
  const state = createTopicTreeState({ dim: 4, rootId: "0" });
  for (const [id, parent] of [
    ["A", "0"],
    ["A1", "A"],
    ["A2", "A"],
    ["B", "0"]
  ] as const) {
    insertTopic(state, topicRecord(id, parent));
  }
  let row = 0;
  for (const leaf of ["A1", "A2", "B"]) {
    for (let index = 0; index < 10; index += 1) {
      const key = rowItemKey(row);
      registerItem(state, {
        key,
        kind: "note",
        contentHash: rowContentHash(row),
        rootSource: null
      });
      insertPlacement(state, key, placementRecord(leaf));
      row += 1;
    }
  }
  return state;
}

describe("simulated naming", () => {
  it("hashes item keys apart (replay content hashes are not hexadecimal)", () => {
    const hashes = new Set(Array.from({ length: 1000 }, (_, row) => itemHash(rowItemKey(row))));
    expect(hashes.size).toBe(1000);
    const state = tree();
    expect(replaySketch(state, "A")).toMatchObject({ n: 20 });
    expect(replaySketch(state, "A").hashes).toHaveLength(20);
  });

  it("names new topics once and renames when members drift past the threshold", () => {
    const state = tree();
    const naming = new NamingSimulator([0.2, 0.5], 2);
    const first = naming.step(state);
    expect(first.named).toBe(4);
    // Two levels: A and B (2 topics, 1 call), A1 and A2 (2 topics, 1 call).
    expect(first.calls).toEqual({ "0.2": 2, "0.5": 2 });
    expect(naming.step(state)).toMatchObject({ named: 0, renamed: { "0.2": 0, "0.5": 0 } });
    // Three of A1's ten members are replaced by B's (A1 keeps its size).
    const editor = createTopicTreeEditor(state, { record: false });
    for (let row = 0; row < 3; row += 1) {
      editor.updatePlacement(rowItemKey(row), 0, { topicId: "A2" });
    }
    for (let row = 20; row < 23; row += 1) {
      editor.updatePlacement(rowItemKey(row), 0, { topicId: "A1" });
    }
    const drifted = naming.step(state);
    // A1 drifts 6/13, A2 3/13 (three joined), B 3/10 (three left), A 3/23 (three joined): three
    // pass 0.2, none passes 0.5.
    expect(drifted.renamed).toEqual({ "0.2": 3, "0.5": 0 });
    const week = naming.takeWeek(state);
    expect(week.named).toBe(4);
    expect(week.renamed).toEqual({ "0.2": 3, "0.5": 0 });
    expect(week.topics).toBe(4);
    // Staleness: the mean drift of the names; only A is stale under 0.2.
    expect(week.staleness["0.2"]).toBeCloseTo(3 / 23 / 4, 9);
    expect(week.staleness["0.5"]).toBeCloseTo((6 / 13 + 3 / 13 + 3 / 10 + 3 / 23) / 4, 9);
    expect(naming.peakDayCalls()).toEqual({ "0.2": 2, "0.5": 2 });
  });
});
