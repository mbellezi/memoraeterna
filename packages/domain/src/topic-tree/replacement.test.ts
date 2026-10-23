import { describe, expect, it } from "vitest";

import { auditLintConfigWith } from "../gardener/lints/config.js";
import { replacementCandidates } from "./audit-lints.js";
import { createTopicTreeEditor, invertEvents, applyEvents } from "./events.js";
import { createWorld, worldConfig, worldNow } from "./fixtures/placement-world.js";
import type { World } from "./fixtures/placement-world.js";
import { rebalanceTree } from "./repair.js";
import type { RebalanceResult } from "./repair.js";
import type { MisplacedItem } from "./operations.js";
import {
  canonicalStateDump,
  getTopic,
  isLive,
  isProtected,
  placementsOf,
  primaryPlacement
} from "./state.js";
import { recomputeSubtree, statsDump } from "./stats.js";

/**
 * The audit's rolling re-placement hands REBALANCE the notes PLACE would put in another leaf
 * (F4 D19 (4)); REBALANCE moves them only when its acceptance rule says so, and never touches a
 * human placement, a protected leaf or a note that moved meanwhile.
 */
const everything = auditLintConfigWith({
  replacement: { share: 1, perRun: 10_000, candidates: 10_000, minGain: 0.1 }
});

function leavesOf(world: World): string[] {
  return [...world.state.topics.values()]
    .filter((node) => isLive(node) && node.children.length === 0 && node.parentId !== null)
    .map((node) => node.id)
    .sort();
}

/** The first note of the world, put into a leaf of another branch, as a stale placement would be. */
function misplaceFirstNote(world: World): { note: string; origin: string; wrong: string } {
  const note = world.notes[0] as string;
  const origin = primaryPlacement(world.state, note)!.topicId;
  const wrong = leavesOf(world).find(
    (leaf) => getTopic(world.state, leaf).parentId !== getTopic(world.state, origin).parentId
  ) as string;
  createTopicTreeEditor(world.state, { record: false }).updatePlacement(note, 0, {
    topicId: wrong
  });
  recomputeSubtree(world.state, world.vectors);
  return { note, origin, wrong };
}

function candidatesOf(world: World): Map<string, MisplacedItem[]> {
  const report = replacementCandidates(world.state, world.vectors, worldConfig, everything, 0);
  const byLeaf = new Map<string, MisplacedItem[]>();
  for (const candidate of report.candidates) {
    byLeaf.set(candidate.from, [
      ...(byLeaf.get(candidate.from) ?? []),
      { item: candidate.item, to: candidate.to }
    ]);
  }
  return byLeaf;
}

function rebalance(world: World, misplaced: Map<string, MisplacedItem[]>): RebalanceResult {
  return rebalanceTree({
    state: world.state,
    vectors: world.vectors,
    config: worldConfig,
    seed: 1,
    now: worldNow,
    day: "2026-10-15",
    newTopicId: world.newTopicId,
    topics: [...misplaced.keys()],
    misplaced,
    conditions: new Set(["misplaced"]),
    force: true
  });
}

describe("REBALANCE and the misplaced notes", () => {
  it("moves a note the tree clearly holds in the wrong leaf back, as one invertible operation", () => {
    const world = createWorld({ seed: 21, placedShare: 1 });
    const { note, origin, wrong } = misplaceFirstNote(world);
    const misplaced = candidatesOf(world);
    expect(misplaced.get(wrong)).toContainEqual({ item: note, to: origin });
    const before = canonicalStateDump(world.state);
    const result = rebalance(world, misplaced);
    const replace = result.applied.find((operation) => operation.kind === "replace");
    expect(replace).toMatchObject({ condition: "misplaced", trigger: "soft", topicId: wrong });
    expect(replace?.netGain).toBeGreaterThan(0);
    expect(primaryPlacement(world.state, note)?.topicId).toBe(origin);
    expect(placementsOf(world.state, note).filter((entry) => entry.rank > 0)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ topicId: origin })])
    );
    // The result is the change-set: its inverse gives the misplaced tree back, statistics included.
    const after = statsDump(world.state);
    applyEvents(world.state, invertEvents(result.events));
    recomputeSubtree(world.state, world.vectors);
    expect(canonicalStateDump(world.state)).toBe(before);
    expect(statsDump(world.state)).not.toBe(after);
  });

  it("applies the acceptance rule: a candidate whose move does not pay stays where it is", () => {
    const world = createWorld({ seed: 21, placedShare: 1 });
    misplaceFirstNote(world);
    const misplaced = candidatesOf(world);
    const result = rebalance(world, misplaced);
    const rejected = result.skipped.filter((skip) => skip.reason === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    for (const skip of rejected) {
      expect(skip.condition).toBe("misplaced");
      expect(skip.netGain).toBeLessThanOrEqual(0);
    }
  });

  it("moves nothing a human placed, nothing that moved since, and nothing into a protected leaf", () => {
    const world = createWorld({ seed: 21, placedShare: 1 });
    const { note, origin, wrong } = misplaceFirstNote(world);
    const misplaced = candidatesOf(world);
    const editor = createTopicTreeEditor(world.state, { record: false });

    // A human placed it: untouched.
    editor.updatePlacement(note, 0, { management: "human" });
    expect(rebalance(world, misplaced).events).toEqual([]);
    editor.updatePlacement(note, 0, { management: "ai" });

    // It moved since the audit saw it.
    const elsewhere = leavesOf(world).find((leaf) => leaf !== wrong && leaf !== origin) as string;
    editor.updatePlacement(note, 0, { topicId: elsewhere });
    expect(rebalance(world, misplaced).events).toEqual([]);
    editor.updatePlacement(note, 0, { topicId: wrong });

    // Its right leaf is pinned: automation does not move anything into it.
    editor.manageTopic(origin, "pinned");
    expect(isProtected(getTopic(world.state, origin))).toBe(true);
    const result = rebalance(world, misplaced);
    expect(result.applied).toEqual([]);
    expect(primaryPlacement(world.state, note)?.topicId).toBe(wrong);
  });

  it("does nothing without candidates, and leaves the other conditions as they were", () => {
    const world = createWorld({ seed: 21, placedShare: 1 });
    const empty = rebalance(world, new Map());
    expect(empty).toMatchObject({ applied: [], events: [], skipped: [] });
    const plain = rebalanceTree({
      state: world.state,
      vectors: world.vectors,
      config: worldConfig,
      seed: 1,
      now: worldNow,
      day: "2026-10-15",
      newTopicId: world.newTopicId,
      force: true
    });
    expect(plain.applied.every((operation) => operation.condition !== "misplaced")).toBe(true);
  });
});
