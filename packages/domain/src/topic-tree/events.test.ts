import { describe, expect, it } from "vitest";

import {
  StructureEventConflictError,
  StructureEventSchema,
  applyEvents,
  createTopicTreeEditor,
  invertEvent,
  invertEvents
} from "./events.js";
import type { StructureEvent, TopicTreeEditor } from "./events.js";
import { itemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { createRng } from "./rng.js";
import type { Rng } from "./rng.js";
import {
  TopicTreeStateError,
  canonicalStateDump,
  cloneTopicTreeState,
  createTopicTreeState,
  getTopic,
  isLive,
  liveTopicIds,
  pathOf,
  placementRecord,
  placementsOf,
  registerItem,
  subtreeItems
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputeSubtree, statsDump } from "./stats.js";
import { keyedVectors, matrixFromRows } from "./vectors.js";

const uuidOf = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const rootId = uuidOf(0);
const at = "2026-10-15T12:00:00.000Z";

function freshState(items = 12): { state: TopicTreeState; keys: ItemKey[] } {
  const state = createTopicTreeState({ dim: 4, rootId });
  const keys = Array.from({ length: items }, (_, index) => itemKey("note", uuidOf(1000 + index)));
  keys.forEach((key, index) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: `h${(index * 7) % items}`,
      rootSource: null
    })
  );
  return { state, keys };
}

function pick<T>(rng: Rng, values: readonly T[]): T | undefined {
  return values.length > 0 ? values[rng.int(values.length)] : undefined;
}

/** One random valid editor operation; returns false when the drawn operation does not apply. */
function randomOperation(
  editor: TopicTreeEditor,
  rng: Rng,
  keys: ItemKey[],
  nextId: () => string
): boolean {
  const { state } = editor;
  const live = liveTopicIds(state);
  const nonRoot = live.filter((id) => id !== state.rootId);
  switch (rng.int(9)) {
    case 0: {
      const parent = pick(rng, live) as string;
      const named = rng.next() < 0.5;
      editor.createTopic(nextId(), parent, {
        title: named ? `Topic ${rng.int(1000)}` : null,
        nameState: named ? "named" : "unnamed",
        nameSource: named ? "llm" : null
      });
      return true;
    }
    case 1: {
      const id = pick(rng, nonRoot);
      if (!id) return false;
      const subtree = new Set<string>();
      const collect = (topic: string): void => {
        subtree.add(topic);
        getTopic(state, topic).children.forEach(collect);
      };
      collect(id);
      const target = pick(
        rng,
        live.filter((topic) => !subtree.has(topic))
      );
      if (!target) return false;
      editor.moveTopic(id, target);
      return true;
    }
    case 2: {
      const id = pick(rng, nonRoot);
      if (!id) return false;
      editor.renameTopic(id, {
        title: `Renamed ${rng.int(1000)}`,
        nameState: "named",
        nameSource: "human",
        nameLanguage: "pt-BR",
        aliases: [`alias ${rng.int(10)}`]
      });
      return true;
    }
    case 3: {
      const id = pick(rng, nonRoot);
      if (!id) return false;
      if (rng.next() < 0.5)
        editor.describeTopic(id, rng.next() < 0.5 ? null : `About ${rng.int(99)}`);
      else editor.manageTopic(id, pick(rng, ["ai", "human", "pinned"] as const) as "ai");
      return true;
    }
    case 4: {
      const item = pick(
        rng,
        keys.filter((key) => placementsOf(state, key).length === 0)
      );
      const topic = pick(rng, live);
      if (!item || !topic) return false;
      editor.placeItem(
        item,
        placementRecord(topic, { score: rng.next(), margin: rng.next() / 10 })
      );
      return true;
    }
    case 5: {
      const item = pick(
        rng,
        keys.filter((key) => placementsOf(state, key).length === 1)
      );
      if (!item) return false;
      const primary = placementsOf(state, item)[0]?.topicId as string;
      const onPath = new Set(pathOf(state, primary));
      const topic = pick(
        rng,
        live.filter((id) => !onPath.has(id))
      );
      if (!topic) return false;
      editor.placeItem(item, placementRecord(topic, { rank: 1, decidedBy: "auto" }));
      return true;
    }
    case 6: {
      const item = pick(
        rng,
        keys.filter((key) => placementsOf(state, key).length > 0)
      );
      if (!item) return false;
      const placements = placementsOf(state, item);
      const placement = placements[placements.length - 1];
      if (!placement) return false;
      if (rng.next() < 0.5) {
        editor.unplaceItem(item, placement.rank);
      } else {
        const used = new Set(placements.map((entry) => entry.topicId));
        const topic = pick(
          rng,
          live.filter((id) => !used.has(id))
        );
        if (!topic) return false;
        editor.updatePlacement(item, placement.rank, {
          topicId: topic,
          needsGate: rng.next() < 0.3,
          movedFromTopicId: placement.topicId,
          movedAt: at
        });
      }
      return true;
    }
    case 7: {
      const id = pick(
        rng,
        nonRoot.filter((topic) => {
          const node = getTopic(state, topic);
          return (
            node.children.length === 0 &&
            node.items.length === 0 &&
            node.secondaryItems.length === 0
          );
        })
      );
      if (!id) return false;
      editor.retireTopic(id, getTopic(state, id).parentId, at);
      return true;
    }
    default: {
      const id = pick(
        rng,
        [...state.topics.values()]
          .filter(
            (node) =>
              !isLive(node) && node.parentId !== null && isLive(getTopic(state, node.parentId))
          )
          .map((node) => node.id)
      );
      if (!id) return false;
      editor.restoreTopic(id);
      return true;
    }
  }
}

describe("structure events", () => {
  it("invertEvents after applyEvents is the identity (1,000 random sequences)", () => {
    const rng = createRng(20261014);
    let checked = 0;
    for (let sequence = 0; sequence < 1000; sequence += 1) {
      const { state, keys } = freshState();
      let counter = 1;
      const nextId = (): string => uuidOf(counter++);
      const warmup = createTopicTreeEditor(state);
      for (let step = 0; step < 15; step += 1) randomOperation(warmup, rng, keys, nextId);
      const before = canonicalStateDump(state);
      const initial = cloneTopicTreeState(state);
      const editor = createTopicTreeEditor(state);
      for (let step = 0; step < 25; step += 1) randomOperation(editor, rng, keys, nextId);
      const after = canonicalStateDump(state);
      for (const event of editor.events)
        expect(StructureEventSchema.safeParse(event).success).toBe(true);

      applyEvents(state, invertEvents(editor.events));
      expect(canonicalStateDump(state)).toBe(before);

      applyEvents(initial, editor.events);
      expect(canonicalStateDump(initial)).toBe(after);
      checked += editor.events.length;
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("restores bit-equal statistics after an undo", () => {
    const { state, keys } = freshState(8);
    const vectors = keyedVectors(
      matrixFromRows(keys.map((_, index) => [1, index, index % 3, -index])),
      keys
    );
    const editor = createTopicTreeEditor(state);
    const a = uuidOf(1);
    const b = uuidOf(2);
    editor.createTopic(a, rootId);
    editor.createTopic(b, rootId);
    keys.forEach((key, index) => editor.placeItem(key, placementRecord(index % 2 ? a : b)));
    recomputeSubtree(state, vectors);
    const statsBefore = statsDump(state);
    const undoable = createTopicTreeEditor(state);
    undoable.moveTopic(b, a);
    undoable.updatePlacement(keys[0] as ItemKey, 0, { topicId: a });
    recomputeSubtree(state, vectors);
    expect(statsDump(state)).not.toBe(statsBefore);
    applyEvents(state, invertEvents(undoable.events));
    recomputeSubtree(state, vectors);
    expect(statsDump(state)).toBe(statsBefore);
  });

  it("pairs place with unplace and retire with restore when inverted", () => {
    const { state, keys } = freshState(1);
    const editor = createTopicTreeEditor(state);
    const topic = uuidOf(1);
    editor.createTopic(topic, rootId);
    editor.placeItem(keys[0] as ItemKey, placementRecord(topic));
    editor.unplaceItem(keys[0] as ItemKey, 0);
    editor.retireTopic(topic, rootId, at);
    const ops = editor.events.map((event) => invertEvent(event).op);
    expect(ops).toEqual(["topic.create", "item.unplace", "item.place", "topic.restore"]);
    expect(invertEvent(editor.events[0] as StructureEvent).after).toBeNull();
  });

  it("applies all or nothing and names the conflicting event", () => {
    const { state, keys } = freshState(2);
    const topic = uuidOf(1);
    const editor = createTopicTreeEditor(state);
    editor.createTopic(topic, rootId);
    const before = canonicalStateDump(state);
    const events: StructureEvent[] = [
      {
        op: "item.place",
        item: keys[0] as ItemKey,
        topicId: topic,
        before: null,
        after: placementRecord(topic)
      },
      {
        op: "topic.manage",
        topicId: topic,
        before: { management: "pinned" },
        after: { management: "ai" }
      }
    ];
    expect(() => applyEvents(state, events)).toThrow(StructureEventConflictError);
    try {
      applyEvents(state, events);
    } catch (error) {
      expect((error as StructureEventConflictError).index).toBe(1);
    }
    expect(canonicalStateDump(state)).toBe(before);
  });

  it("rejects malformed events at the boundary", () => {
    const placement = placementRecord(uuidOf(1));
    const note = itemKey("note", uuidOf(9));
    expect(
      StructureEventSchema.safeParse({
        op: "topic.create",
        topicId: uuidOf(1),
        before: null,
        after: null
      }).success
    ).toBe(false);
    expect(
      StructureEventSchema.safeParse({
        op: "item.place",
        item: note,
        topicId: uuidOf(1),
        before: placement,
        after: placement
      }).success
    ).toBe(false);
    expect(
      StructureEventSchema.safeParse({
        op: "item.place",
        item: "row:1",
        topicId: uuidOf(1),
        before: null,
        after: placement
      }).success
    ).toBe(false);
    expect(
      StructureEventSchema.safeParse({
        op: "topic.rename",
        topicId: uuidOf(1),
        before: {
          title: null,
          nameState: "unnamed",
          nameSource: null,
          nameLanguage: null,
          namedChangeSetId: null,
          aliases: []
        },
        after: {
          title: "x".repeat(121),
          nameState: "named",
          nameSource: "llm",
          nameLanguage: "pt-BR",
          namedChangeSetId: null,
          aliases: []
        }
      }).success
    ).toBe(false);
  });
});

describe("state primitives", () => {
  it("never reuses a topic ID, even a retired one (I9)", () => {
    const { state } = freshState(0);
    const editor = createTopicTreeEditor(state);
    const topic = uuidOf(1);
    editor.createTopic(topic, rootId);
    editor.retireTopic(topic, rootId, at);
    expect(() => editor.createTopic(topic, rootId)).toThrow(StructureEventConflictError);
  });

  it("refuses cycles, non-empty retirements and moving the root", () => {
    const { state, keys } = freshState(1);
    const editor = createTopicTreeEditor(state);
    const a = uuidOf(1);
    const b = uuidOf(2);
    editor.createTopic(a, rootId);
    editor.createTopic(b, a);
    expect(() => editor.moveTopic(a, b)).toThrow(StructureEventConflictError);
    expect(() => editor.moveTopic(a, a)).toThrow(StructureEventConflictError);
    expect(() => editor.retireTopic(a, rootId, at)).toThrow(StructureEventConflictError);
    editor.placeItem(keys[0] as ItemKey, placementRecord(b));
    expect(() => editor.retireTopic(b, a, at)).toThrow(StructureEventConflictError);
    expect(() => editor.moveTopic(rootId, a)).toThrow(TopicTreeStateError);
    expect(() => editor.placeItem(keys[0] as ItemKey, placementRecord(a))).toThrow(
      StructureEventConflictError
    );
    expect(() => editor.placeItem(keys[0] as ItemKey, placementRecord(b, { rank: 1 }))).toThrow(
      StructureEventConflictError
    );
  });

  it("keeps children in sibling order and items in content-key order", () => {
    const { state, keys } = freshState(6);
    const editor = createTopicTreeEditor(state);
    const ids = [uuidOf(3), uuidOf(1), uuidOf(2)];
    for (const id of ids) editor.createTopic(id, rootId);
    expect(getTopic(state, rootId).children).toEqual(ids);
    editor.moveTopic(ids[0] as string, rootId, 5);
    expect(getTopic(state, rootId).children).toEqual([ids[1], ids[2], ids[0]]);
    for (const key of [...keys].reverse()) editor.placeItem(key, placementRecord(ids[1] as string));
    const hashes = getTopic(state, ids[1] as string).items.map(
      (key) => state.items.get(key)?.contentHash
    );
    expect(hashes).toEqual([...hashes].sort());
    registerItem(state, {
      key: keys[0] as ItemKey,
      kind: "note",
      contentHash: "zzz",
      rootSource: null
    });
    expect(getTopic(state, ids[1] as string).items.at(-1)).toBe(keys[0]);
    expect(subtreeItems(state, rootId)).toHaveLength(6);
  });

  it("clones deeply, label vectors and budgets included", () => {
    const { state, keys } = freshState(1);
    const editor = createTopicTreeEditor(state);
    const topic = uuidOf(1);
    editor.createTopic(topic, rootId);
    editor.placeItem(keys[0] as ItemKey, placementRecord(topic));
    getTopic(state, topic).label = { vector: Float32Array.from([1, 0, 0, 0]), textHash: "t" };
    state.budget = { day: "2026-10-15", operations: 2, movedItems: 9 };
    const copy = cloneTopicTreeState(state);
    getTopic(state, topic).label?.vector.fill(0);
    getTopic(state, topic).items.length = 0;
    state.budget.operations = 5;
    expect(Array.from(getTopic(copy, topic).label?.vector ?? [])).toEqual([1, 0, 0, 0]);
    expect(getTopic(copy, topic).items).toEqual([keys[0]]);
    expect(copy.budget).toEqual({ day: "2026-10-15", operations: 2, movedItems: 9 });
  });

  it("reports the topics a batch touched", () => {
    const { state, keys } = freshState(1);
    const a = uuidOf(1);
    const b = uuidOf(2);
    const setup = createTopicTreeEditor(state);
    setup.createTopic(a, rootId);
    setup.createTopic(b, rootId);
    setup.placeItem(keys[0] as ItemKey, placementRecord(a));
    const result = applyEvents(state, [
      {
        op: "item.move",
        item: keys[0] as ItemKey,
        topicId: b,
        before: placementRecord(a),
        after: placementRecord(b)
      }
    ]);
    expect(new Set(result.touchedTopics)).toEqual(new Set([a, b]));
  });
});
