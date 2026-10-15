// One test per invariant I1-I9, plus protected topics and health.
import { describe, expect, it } from "vitest";

import { defaultTopicTreeConfig, topicTreeConfigWith } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import type { TopicTreeEditor } from "./events.js";
import { itemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { checkInvariants, topicHealth, violationsByTopic } from "./invariants.js";
import type { InvariantCode, InvariantReport } from "./invariants.js";
import {
  createTopicTreeState,
  getTopic,
  insertPlacement,
  placementRecord,
  registerItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputeSubtree } from "./stats.js";
import { keyedVectors, matrixFromRows } from "./vectors.js";

const config = defaultTopicTreeConfig;
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const rootId = uuidOf(0);
const at = "2026-10-15T12:00:00.000Z";

interface Tree {
  state: TopicTreeState;
  editor: TopicTreeEditor;
  topic(parentId?: string): string;
  /** Places `count` new notes on `topicId`. */
  fill(topicId: string, count: number): ItemKey[];
}

function tree(): Tree {
  const state = createTopicTreeState({ dim: 2, rootId });
  const editor = createTopicTreeEditor(state, { record: false });
  let topics = 1;
  let items = 0;
  return {
    state,
    editor,
    topic(parentId = rootId) {
      const id = uuidOf(topics++);
      editor.createTopic(id, parentId);
      return id;
    },
    fill(topicId, count) {
      return Array.from({ length: count }, () => {
        const key = itemKey("note", uuidOf(10_000 + items));
        registerItem(state, {
          key,
          kind: "note",
          contentHash: String(items).padStart(6, "0"),
          rootSource: null
        });
        items += 1;
        editor.placeItem(key, placementRecord(topicId));
        return key;
      });
    }
  };
}

/** A healthy two-level tree: the root with 4 leaves of 10 items. */
function healthy(): Tree & { leaves: string[] } {
  const base = tree();
  const leaves = Array.from({ length: 4 }, () => base.topic());
  for (const leaf of leaves) base.fill(leaf, 10);
  return { ...base, leaves };
}

function codes(report: InvariantReport, severity: "hard" | "soft"): InvariantCode[] {
  return report.violations
    .filter((violation) => violation.severity === severity && !violation.awaitingApproval)
    .map((violation) => violation.code);
}

describe("tree invariants", () => {
  it("accepts a healthy tree", () => {
    const report = checkInvariants(healthy().state, config);
    expect(report.violations).toEqual([]);
    expect(report.hard).toBe(0);
  });

  it("I1: every expected item is placed and every topic reachable", () => {
    const { state, leaves } = healthy();
    const stray = itemKey("note", uuidOf(99_999));
    registerItem(state, { key: stray, kind: "note", contentHash: "zz", rootSource: null });
    expect(codes(checkInvariants(state, config), "hard")).toEqual(["I1"]);
    expect(checkInvariants(state, config, { expectedItems: [] }).hard).toBe(0);
    // Corrupt the structure: a leaf no longer listed by its parent is unreachable with its items.
    const root = getTopic(state, rootId);
    root.children.splice(root.children.indexOf(leaves[0] as string), 1);
    const report = checkInvariants(state, config, { expectedItems: [] });
    expect(report.violations.map((violation) => violation.reason)).toEqual(
      expect.arrayContaining(["topic-unreachable", "primary-not-reachable"])
    );
  });

  it("I2: at most two secondaries, never on the primary path, and no cycles", () => {
    const { state, editor, leaves } = healthy();
    const item = getTopic(state, leaves[0] as string).items[0] as ItemKey;
    editor.placeItem(item, placementRecord(leaves[1] as string, { rank: 1 }));
    editor.placeItem(item, placementRecord(leaves[2] as string, { rank: 2 }));
    expect(checkInvariants(state, config).hard).toBe(0);
    insertPlacement(state, item, placementRecord(leaves[3] as string, { rank: 3 }));
    expect(checkInvariants(state, config).violations.map((violation) => violation.reason)).toEqual([
      "too-many-secondaries"
    ]);
    const other = tree();
    const leaf = other.topic();
    const [note] = other.fill(leaf, 3) as [ItemKey];
    insertPlacement(other.state, note, placementRecord(rootId, { rank: 1 }));
    expect(
      checkInvariants(other.state, config).violations.map((violation) => violation.reason)
    ).toContain("secondary-on-primary-path");
    getTopic(state, leaves[1] as string).children.push(leaves[0] as string);
    expect(codes(checkInvariants(state, config), "hard")).toContain("I2");
  });

  it("I3: fan-out soft outside 2-12, hard above 16; the root uses the Areas band once Areas exist", () => {
    const wide = tree();
    for (let index = 0; index < 13; index += 1) wide.fill(wide.topic(), 5);
    expect(codes(checkInvariants(wide.state, config), "soft")).toEqual(["I3"]);
    for (let index = 0; index < 4; index += 1) wide.fill(wide.topic(), 5);
    expect(codes(checkInvariants(wide.state, config), "hard")).toEqual(["I3"]);
    const small = healthy();
    expect(
      checkInvariants(small.state, config, { areasActive: true }).violations.map((v) => v.code)
    ).toEqual(["I3"]);
  });

  it("I4: leaves hold 3-30 direct items (soft), at most 45 (hard); the root is exempt", () => {
    const base = tree();
    const small = base.topic();
    const big = base.topic();
    base.fill(small, 2);
    base.fill(big, 31);
    expect(codes(checkInvariants(base.state, config), "soft")).toEqual(["I4", "I4"]);
    base.fill(big, 15);
    expect(codes(checkInvariants(base.state, config), "hard")).toEqual(["I4"]);
    const coldStart = tree();
    coldStart.fill(rootId, 60);
    expect(checkInvariants(coldStart.state, config).violations).toEqual([]);
  });

  it("I5: depth above 5 is soft, beyond the cap of 7 hard", () => {
    const base = tree();
    let parent = rootId;
    const chain: string[] = [];
    for (let depth = 1; depth <= 8; depth += 1) {
      parent = base.topic(parent);
      chain.push(parent);
      if (depth < 8) base.fill(base.topic(parent), 5);
    }
    base.fill(parent, 5);
    const report = checkInvariants(base.state, config);
    const depths = report.violations.filter((violation) => violation.code === "I5");
    const values = (severity: string): number[] =>
      depths
        .filter((violation) => violation.severity === severity)
        .map((violation) => violation.value as number)
        .sort((a, b) => a - b);
    // Two leaves at depth 8 (beyond the cap); leaves at depths 6 and 7 are above the target.
    expect(values("hard")).toEqual([8, 8]);
    expect(values("soft")).toEqual([6, 7]);
    expect(chain).toHaveLength(8);
  });

  it("I6: single-child chains are soft violations", () => {
    const base = tree();
    const parent = base.topic();
    base.fill(base.topic(parent), 5);
    base.fill(base.topic(), 5);
    const report = checkInvariants(base.state, config);
    expect(
      report.violations.filter((violation) => violation.code === "I6").map((v) => v.topicId)
    ).toEqual([parent]);
  });

  it("I7: sibling titles are unique, case- and accent-insensitively", () => {
    const { state, editor, leaves } = healthy();
    editor.renameTopic(leaves[0] as string, {
      title: "Memória",
      nameState: "named",
      nameSource: "llm"
    });
    editor.renameTopic(leaves[1] as string, {
      title: "memoria",
      nameState: "named",
      nameSource: "llm"
    });
    const report = checkInvariants(state, config);
    expect(codes(report, "hard")).toEqual(["I7"]);
    expect(report.violations[0]?.reason).toBe("duplicate-sibling-title");
  });

  it("I8: leaf coherence below the floor only with the coherence split signal", () => {
    const { state, leaves } = healthy();
    const keys = [...state.items.keys()];
    const vectors = keyedVectors(
      matrixFromRows(keys.map((_, index) => [Math.cos(index), Math.sin(index)])),
      keys
    );
    recomputeSubtree(state, vectors);
    expect(checkInvariants(state, config).violations).toEqual([]);
    const strict = topicTreeConfigWith({ splitSignal: { signal: "coherence", threshold: 0.99 } });
    const report = checkInvariants(state, strict);
    expect(codes(report, "soft").every((code) => code === "I8")).toBe(true);
    expect(report.violations.map((violation) => violation.topicId)).toEqual(
      expect.arrayContaining(leaves)
    );
  });

  it("I9: retired topics are empty redirects to live topics", () => {
    const { state, editor } = healthy();
    const gone = uuidOf(500);
    const other = uuidOf(501);
    editor.createTopic(gone, rootId);
    editor.createTopic(other, rootId);
    editor.retireTopic(other, rootId, at);
    editor.retireTopic(gone, other, at);
    expect(checkInvariants(state, config).hard).toBe(0);
    getTopic(state, other).redirectTo = gone;
    expect(
      checkInvariants(state, config).violations.map((violation) => violation.reason)
    ).toContain("broken-redirect");
    getTopic(state, rootId).redirectTo = gone;
    expect(
      checkInvariants(state, config).violations.map((violation) => violation.reason)
    ).toContain("live-topic-redirects");
  });

  it("lists violations on protected topics as awaiting approval, not as hard", () => {
    const base = tree();
    const pinned = base.topic();
    base.fill(pinned, 46);
    base.fill(base.topic(), 5);
    base.editor.manageTopic(pinned, "pinned");
    const report = checkInvariants(base.state, config);
    expect(report.hard).toBe(0);
    expect(report.awaitingApproval).toBe(1);
    expect(report.violations[0]).toMatchObject({
      code: "I4",
      severity: "hard",
      awaitingApproval: true
    });
    const byTopic = violationsByTopic(report);
    expect(topicHealth(byTopic.get(pinned) ?? [])).toBe("violation");
    expect(topicHealth([])).toBe("good");
  });
});
