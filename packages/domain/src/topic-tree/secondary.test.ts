import { describe, expect, it } from "vitest";

import { topicTreeConfigWith } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { uuidOf } from "./fixtures/placement-world.js";
import { itemKey } from "./ids.js";
import type { PlacementCandidate } from "./place.js";
import {
  chooseSecondaries,
  freeSecondaryRank,
  invalidSecondaries,
  maxSecondaries
} from "./secondary.js";
import { createTopicTreeState, placementRecord, registerItem } from "./state.js";

const t = (n: number): string => uuidOf(n);
const config = topicTreeConfigWith({ secondary: { maxScoreGap: 0.05 } });

/** root ── 1 ── 2, 3, 4 (leaves); root ── 5 (leaf); 6 retired under 1. */
function tree() {
  const state = createTopicTreeState({ dim: 2, rootId: t(0) });
  const editor = createTopicTreeEditor(state);
  editor.createTopic(t(1), t(0));
  for (const id of [2, 3, 4, 6]) editor.createTopic(t(id), t(1));
  editor.createTopic(t(5), t(0));
  editor.retireTopic(t(6), t(2), "2026-10-15T00:00:00.000Z");
  const item = itemKey("note", uuidOf(100));
  registerItem(state, { key: item, kind: "note", contentHash: "a", rootSource: null });
  return { state, editor, item };
}

function candidate(id: number, score: number, fields: Partial<PlacementCandidate> = {}) {
  return {
    topicId: t(id),
    cosine: score,
    labelCosine: null,
    score,
    threshold: 0.2,
    admitted: true,
    leaf: true,
    depth: 2,
    ...fields
  };
}

describe("secondary placements", () => {
  it("chooses admitted live leaves within the gap, off the primary path, best first", () => {
    const { state } = tree();
    const chosen = chooseSecondaries(state, config, { topicId: t(2), score: 0.8 }, [
      candidate(2, 0.8),
      candidate(1, 0.79, { leaf: false }),
      candidate(3, 0.76),
      candidate(4, 0.78),
      candidate(5, 0.77, { admitted: false }),
      candidate(6, 0.79),
      candidate(0, 0.79),
      candidate(4, 0.78)
    ]);
    expect(chosen.map((entry) => entry.topicId)).toEqual([t(4), t(3)]);
    expect(
      chooseSecondaries(state, config, { topicId: t(2), score: 0.9 }, [candidate(3, 0.84)])
    ).toEqual([]);
    const none = topicTreeConfigWith({ secondary: { max: 0 } });
    expect(maxSecondaries(none)).toBe(0);
    expect(
      chooseSecondaries(state, none, { topicId: t(2), score: 0.8 }, [candidate(3, 0.8)])
    ).toEqual([]);
  });

  it("caps the choice at secondary.max", () => {
    const { state } = tree();
    const one = topicTreeConfigWith({ secondary: { max: 1, maxScoreGap: 0.5 } });
    expect(
      chooseSecondaries(state, one, { topicId: t(2), score: 0.8 }, [
        candidate(3, 0.7),
        candidate(4, 0.75),
        candidate(5, 0.72)
      ]).map((entry) => entry.topicId)
    ).toEqual([t(4)]);
  });

  it("finds secondaries that break I2 and the free ranks", () => {
    const { state, editor, item } = tree();
    expect(freeSecondaryRank(state, config, item)).toBe(1);
    editor.placeItem(item, placementRecord(t(2)));
    editor.placeItem(item, placementRecord(t(3), { rank: 1 }));
    expect(invalidSecondaries(state, config, item)).toEqual([]);
    expect(freeSecondaryRank(state, config, item)).toBe(2);
    editor.placeItem(item, placementRecord(t(1), { rank: 2 }));
    expect(freeSecondaryRank(state, config, item)).toBeNull();
    expect(invalidSecondaries(state, config, item).map((placement) => placement.rank)).toEqual([2]);
    const tight = topicTreeConfigWith({ secondary: { max: 1 } });
    editor.unplaceItem(item, 2);
    editor.placeItem(item, placementRecord(t(5), { rank: 2 }));
    expect(invalidSecondaries(state, tight, item).map((placement) => placement.rank)).toEqual([2]);
    editor.unplaceItem(item, 0);
    expect(invalidSecondaries(state, config, item).map((placement) => placement.rank)).toEqual([
      1, 2
    ]);
  });
});
