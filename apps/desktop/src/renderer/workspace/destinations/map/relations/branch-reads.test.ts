import { describe, expect, it } from "vitest";

import { branchId, branchTopics, sampleBranch } from "./branch-fixtures";
import {
  LiveRereads,
  branchChoices,
  sameBranchRead,
  type BranchRead,
  type RereadTimers
} from "./branch-reads";

const read = (overrides: Partial<BranchRead> = {}): BranchRead => ({
  target: { kind: "topic", id: branchTopics.fermentation },
  depth: 1,
  answer: sampleBranch(),
  sourceTitle: null,
  ...overrides
});

/** Timers the test runs by hand. */
function manualTimers() {
  const waiting = new Map<number, () => void>();
  let next = 0;
  const timers: RereadTimers = {
    set: (callback) => {
      next += 1;
      waiting.set(next, callback);
      return next;
    },
    clear: (handle) => {
      waiting.delete(handle as number);
    }
  };
  return {
    timers,
    pending: () => waiting.size,
    run: () => {
      const callbacks = [...waiting.values()];
      waiting.clear();
      for (const callback of callbacks) callback();
    }
  };
}

describe("a live re-read of the branch", () => {
  it("keeps what is on screen when the answer came back the same", () => {
    // A link job on another source publishes note refs every second or two: an unchanged answer
    // must not hand the canvas a new model, or it fits, re-settles and drops the cursor each time.
    expect(sameBranchRead(read(), read())).toBe(true);
  });

  it("draws again when a relation, a title, the depth or the branch changed", () => {
    const answer = sampleBranch();
    const fewer = { ...answer, edges: answer.edges.slice(1) };
    expect(sameBranchRead(read(), read({ answer: fewer }))).toBe(false);
    const renamed = {
      ...answer,
      topics: answer.topics.map((topic, index) =>
        index === 0 ? { ...topic, title: "Fermentação láctica" } : topic
      )
    };
    expect(sameBranchRead(read(), read({ answer: renamed }))).toBe(false);
    expect(sameBranchRead(read(), read({ depth: 2 }))).toBe(false);
    expect(
      sameBranchRead(read(), read({ target: { kind: "topic", id: branchTopics.lactic } }))
    ).toBe(false);
    expect(sameBranchRead(read(), read({ sourceTitle: "Wild Fermentation" }))).toBe(false);
  });

  it("reads once a burst of pushed changes settles", () => {
    const clock = manualTimers();
    let reads = 0;
    const rereads = new LiveRereads(() => (reads += 1), 1_000, clock.timers);
    rereads.answer();
    rereads.push();
    rereads.push();
    rereads.push();
    expect(clock.pending()).toBe(1);
    clock.run();
    expect(reads).toBe(1);
  });

  it("keeps a change pushed during the first read and reads it once that read answers", () => {
    const clock = manualTimers();
    let reads = 0;
    const rereads = new LiveRereads(() => (reads += 1), 1_000, clock.timers);
    // A link job committed while the first answer was on its way to the renderer.
    rereads.push();
    expect(clock.pending()).toBe(0);
    rereads.answer();
    expect(clock.pending()).toBe(1);
    clock.run();
    expect(reads).toBe(1);
    // Nothing more is owed: a later answer reads nothing again by itself.
    rereads.answer();
    expect(clock.pending()).toBe(0);
  });

  it("reads nothing after the lens is gone", () => {
    const clock = manualTimers();
    let reads = 0;
    const rereads = new LiveRereads(() => (reads += 1), 1_000, clock.timers);
    rereads.answer();
    rereads.push();
    rereads.dispose();
    clock.run();
    expect(reads).toBe(0);
  });
});

describe("the branch menu's neighbours", () => {
  interface Topic {
    id: string;
    parentId: string | null;
    title: string | null;
  }
  const root: Topic = { id: branchId("topic:root"), parentId: null, title: null };
  const nutrition = { id: branchId("topic:nutrition"), parentId: root.id, title: "Nutrição" };
  const history = { id: branchId("topic:history"), parentId: root.id, title: "História" };
  const fermentation = {
    id: branchTopics.fermentation,
    parentId: nutrition.id,
    title: "Fermentação"
  };
  const cooking = { id: branchId("topic:cooking"), parentId: nutrition.id, title: "Cozinha" };
  const level = (parent: Topic, nodes: Topic[]) =>
    ({ parent, nodes }) as unknown as Parameters<typeof branchChoices>[0];
  const named = (node: { id: string; title: string | null }) => ({
    id: node.id,
    title: node.title ?? "?"
  });
  const titles = (items: { title: string }[]) => items.map((item) => item.title);

  it("lists a top-level branch's neighbours once, under the areas, and nothing above", () => {
    // The default branch is the largest area: its siblings are the root's children, the areas.
    const areas = level(root, [nutrition, history]);
    const choices = branchChoices(areas, areas, nutrition.id, root.id, named);
    expect(choices.above).toBeNull();
    expect(choices.beside).toEqual([]);
    expect(titles(choices.areas)).toEqual(["História"]);
  });

  it("names the parent above, the siblings beside and the areas apart from the parent", () => {
    const choices = branchChoices(
      level(nutrition, [fermentation, cooking]),
      level(root, [nutrition, history]),
      fermentation.id,
      nutrition.id,
      named
    );
    expect(choices.above?.title).toBe("Nutrição");
    expect(titles(choices.beside)).toEqual(["Cozinha"]);
    expect(titles(choices.areas)).toEqual(["História"]);
  });

  it("offers only the areas for a source", () => {
    const choices = branchChoices(null, level(root, [nutrition, history]), null, null, named);
    expect(choices.above).toBeNull();
    expect(choices.beside).toEqual([]);
    expect(titles(choices.areas)).toEqual(["Nutrição", "História"]);
  });
});
