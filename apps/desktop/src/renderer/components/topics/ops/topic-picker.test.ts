import { describe, expect, it } from "vitest";

import { FakeTopics, id, settle, type FakeTopic } from "../topic-fixtures";
import { foldName, matchesFilter } from "./topic-ops";
import { TopicPickerController } from "./topic-picker";

const R = id(1);
const A = id(2);
const B = id(3);
const A1 = id(4);
const A2 = id(5);

function library(extra: FakeTopic[] = []): FakeTopics {
  return new FakeTopics({
    rootId: R,
    topics: [
      { id: R, parentId: null, title: null, children: [A, B, ...extra.map((topic) => topic.id)] },
      { id: A, parentId: R, title: "Memória", children: [A1, A2] },
      { id: B, parentId: R, title: "Ciência aberta" },
      { id: A1, parentId: A, title: "Decaimento" },
      { id: A2, parentId: A, title: null },
      ...extra
    ]
  });
}

const titles = (picker: TopicPickerController) => picker.visible().map((node) => node.title);

describe("the topic browser behind Move to and Place in topic", () => {
  it("reads the root, goes into a subtopic and up again, one level at a time", async () => {
    const fake = library();
    const picker = new TopicPickerController(() => fake.api, null);
    expect(picker.getSnapshot().phase).toBe("loading");
    picker.open();
    await settle();
    expect(picker.getSnapshot()).toMatchObject({ phase: "ready", trail: [{ id: R, title: null }] });
    expect(titles(picker)).toEqual(["Memória", "Ciência aberta"]);

    picker.enter(picker.getSnapshot().nodes[0]!);
    await settle();
    expect(picker.getSnapshot().trail.map((crumb) => crumb.id)).toEqual([R, A]);
    expect(titles(picker)).toEqual(["Decaimento", null]);
    expect(picker.here).toEqual({ id: A, title: "Memória" });

    picker.enter(picker.getSnapshot().nodes[0]!);
    await settle();
    expect(picker.getSnapshot().trail.map((crumb) => crumb.id)).toEqual([R, A, A1]);
    expect(picker.getSnapshot().nodes).toEqual([]);

    picker.up();
    await settle();
    expect(picker.getSnapshot().trail.map((crumb) => crumb.id)).toEqual([R, A]);
    // Back to a step of the path, or to the root.
    picker.goTo(0);
    await settle();
    expect(picker.getSnapshot().trail.map((crumb) => crumb.id)).toEqual([R]);
    picker.up();
    expect(fake.calls.tree.at(-1)).toMatchObject({ parentId: null });
  });

  it("never offers the topic being moved, so neither it nor anything under it can be chosen", async () => {
    const fake = library();
    const picker = new TopicPickerController(() => fake.api, A);
    picker.open();
    await settle();
    expect(titles(picker)).toEqual(["Ciência aberta"]);
    picker.enter({ id: A, title: "Memória" });
    await settle();
    expect(picker.getSnapshot().trail.map((crumb) => crumb.id)).toEqual([R]);
  });

  it("filters the level on show without case or accents, and a new level starts unfiltered", async () => {
    const fake = library();
    const picker = new TopicPickerController(() => fake.api, null);
    picker.open();
    await settle();
    picker.setFilter("  CIENCIA ");
    expect(titles(picker)).toEqual(["Ciência aberta"]);
    picker.setFilter("zzz");
    expect(titles(picker)).toEqual([]);
    picker.setFilter("mem");
    picker.enter(picker.visible()[0]!);
    await settle();
    expect(picker.getSnapshot().filter).toBe("");
    expect(matchesFilter(null, "a")).toBe(false);
    expect(matchesFilter(null, "")).toBe(true);
    expect(foldName("ÉCOLE Ñandú")).toBe("ecole nandu");
  });

  it("shows a failed read, tries it again, and drops an answer that was overtaken", async () => {
    const fake = library();
    const picker = new TopicPickerController(() => fake.api, null);
    fake.failNext.tree = "boom";
    picker.open();
    await settle();
    expect(picker.getSnapshot().phase).toBe("error");
    picker.retry();
    await settle();
    expect(picker.getSnapshot().phase).toBe("ready");

    // A slow answer for a level the person already left is not shown.
    picker.enter(picker.getSnapshot().nodes[0]!);
    await settle();
    expect(picker.getSnapshot().trail.map((crumb) => crumb.id)).toEqual([R, A]);
    const release: Array<() => void> = [];
    fake.hold = release;
    picker.enter(picker.getSnapshot().nodes[0]!);
    await settle();
    fake.hold = null;
    picker.goTo(0);
    await settle();
    expect(picker.getSnapshot().trail.map((crumb) => crumb.id)).toEqual([R]);
    release.forEach((go) => go());
    await settle();
    expect(picker.getSnapshot().trail.map((crumb) => crumb.id)).toEqual([R]);
  });

  it("pages a long level and adds each topic once", async () => {
    const many: FakeTopic[] = Array.from({ length: 5 }, (_, n) => ({
      id: id(100 + n),
      parentId: R,
      title: `Topic ${n}`
    }));
    const fake = library(many);
    // Three per page for the test: the fake honours the limit it is given.
    const small = {
      tree: (input: Parameters<typeof fake.api.tree>[0]) => fake.api.tree({ ...input, limit: 3 })
    };
    const picker = new TopicPickerController(() => small, null);
    picker.open();
    await settle();
    expect(picker.getSnapshot().nodes).toHaveLength(3);
    expect(picker.getSnapshot().nextCursor).not.toBeNull();
    await picker.loadMore();
    expect(picker.getSnapshot().nodes).toHaveLength(6);
    await picker.loadMore();
    expect(picker.getSnapshot()).toMatchObject({ nextCursor: null, more: "idle" });
    expect(picker.getSnapshot().nodes).toHaveLength(7);
    expect(new Set(picker.getSnapshot().nodes.map((node) => node.id)).size).toBe(7);
    // Nothing is left to read: asking again does nothing.
    const calls = fake.calls.tree.length;
    await picker.loadMore();
    expect(fake.calls.tree).toHaveLength(calls);
  });
});
