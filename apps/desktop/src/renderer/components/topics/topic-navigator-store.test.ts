import { describe, expect, it } from "vitest";
import {
  FakeTopics,
  historyEntry,
  id,
  noteLeaf,
  settle,
  sourceLeaf,
  type FakeTopic
} from "./topic-fixtures";
import { TopicNavigatorStore } from "./topic-navigator-store";
import { rootBranchKey, topicRows, unsortedKey, unsortedRows } from "./topic-navigation";

const R = id(1);
const A = id(2);
const B = id(3);
const C = id(4);
const A1 = id(5);
const A2 = id(6);

const manyLeaves = (count: number) => Array.from({ length: count }, (_, n) => noteLeaf(n));

/** Root with three areas; A holds two subtopics and eight leaves; the root holds two unsorted items. */
function sample(extra: FakeTopic[] = []): FakeTopics {
  return new FakeTopics({
    rootId: R,
    topics: [
      {
        id: R,
        parentId: null,
        title: null,
        children: [A, B, C],
        leaves: [sourceLeaf(1, { unsorted: true }), noteLeaf(90, { unsorted: true })]
      },
      { id: A, parentId: R, title: "Memory", children: [A1, A2], leaves: manyLeaves(8) },
      { id: B, parentId: R, title: "Literature", leaves: [noteLeaf(40), noteLeaf(41)] },
      { id: C, parentId: R, title: "Open science" },
      { id: A1, parentId: A, title: "Decay models", leaves: [noteLeaf(50)] },
      { id: A2, parentId: A, title: "Replications", leaves: [noteLeaf(60), noteLeaf(61)] },
      ...extra
    ]
  });
}

const open = async (fake: FakeTopics) => {
  const store = new TopicNavigatorStore(fake.api);
  store.setActive(true);
  await settle();
  return store;
};

const titles = (store: TopicNavigatorStore) =>
  topicRows(store.getSnapshot().branches, store.getSnapshot().expanded).map((row) =>
    row.type === "topic"
      ? (row.node.title ?? "?")
      : row.type === "leaf"
        ? row.leaf.title
        : `<${row.type}>`
  );

describe("the first load", () => {
  it("reads nothing while the Wiki is hidden", async () => {
    const fake = sample();
    const store = new TopicNavigatorStore(fake.api);
    store.handleChanged({ topicIds: null });
    store.handleHistoryChanged();
    store.setActive(false);
    await settle();
    expect(fake.calls.tree).toHaveLength(0);
    expect(fake.calls.history).toHaveLength(0);
    expect(fake.calls.status).toBe(0);
  });

  it("reads the root with its leaves, the places and the status once it is shown", async () => {
    const fake = sample();
    const store = await open(fake);
    expect(fake.calls.tree).toEqual([
      { parentId: null, limit: 100, includeItems: true, itemLimit: 5 }
    ]);
    expect(fake.calls.history).toEqual([{ limit: 10, kinds: ["topic", "note", "source"] }]);
    expect(fake.calls.status).toBe(1);
    const root = store.getSnapshot().branches.get(rootBranchKey)!;
    expect(root.phase).toBe("ready");
    expect(titles(store)).toEqual(["Memory", "Literature", "Open science"]);
    // The root's own leaves are the Unsorted group.
    expect(unsortedRows(store.getSnapshot().branches, new Set())).toHaveLength(1);
  });

  it("shows a failed first load as failed and reads it again on retry", async () => {
    const fake = sample();
    fake.failNext.tree = "boom";
    const store = await open(fake);
    expect(store.getSnapshot().branches.get(rootBranchKey)?.phase).toBe("error");
    store.retryBranch(null);
    expect(store.getSnapshot().branches.get(rootBranchKey)?.phase).toBe("loading");
    await settle();
    expect(store.getSnapshot().branches.get(rootBranchKey)?.phase).toBe("ready");
  });

  it("says there is no tree yet when the root answers nothing", async () => {
    const fake = sample();
    fake.topics.get(R)!.redirectTo = A;
    const store = await open(fake);
    const root = store.getSnapshot().branches.get(rootBranchKey)!;
    expect(root.phase).toBe("ready");
    expect(root.data).toBeNull();
  });

  it("reads a failed load again when the Wiki is shown again, and refreshes a good one in place", async () => {
    const fake = sample();
    fake.failNext.tree = "boom";
    const store = await open(fake);
    store.setActive(false);
    store.setActive(true);
    await settle();
    expect(store.getSnapshot().branches.get(rootBranchKey)?.phase).toBe("ready");
    const reads = fake.calls.tree.length;
    store.setActive(false);
    store.setActive(true);
    await settle();
    // Nothing was pushed meanwhile, so a good tree is not read again.
    expect(fake.calls.tree).toHaveLength(reads);
  });
});

describe("open branches", () => {
  it("reads a branch with its leaves when it opens, once", async () => {
    const fake = sample();
    const store = await open(fake);
    store.expand(A);
    expect(store.getSnapshot().branches.get(A)?.phase).toBe("loading");
    await settle();
    expect(fake.calls.tree.at(-1)).toEqual({
      parentId: A,
      limit: 100,
      includeItems: true,
      itemLimit: 5
    });
    expect(titles(store).slice(0, 4)).toEqual(["Memory", "Decay models", "Replications", "Note 0"]);
    store.collapse(A);
    store.expand(A);
    await settle();
    expect(fake.calls.tree.filter((call) => call.parentId === A)).toHaveLength(1);
  });

  it("reads the open branches under a topic that was opened before its parent", async () => {
    const fake = sample();
    const store = await open(fake);
    store.expand(A);
    store.expand(A1);
    await settle();
    expect(fake.calls.tree.filter((call) => call.parentId === A1)).toHaveLength(1);
    store.collapseAll();
    expect(store.getSnapshot().expanded.size).toBe(0);
  });

  it("shows a branch that failed to load and reads it again on retry", async () => {
    const fake = sample();
    const store = await open(fake);
    fake.failNext.tree = "boom";
    store.expand(A);
    await settle();
    expect(store.getSnapshot().branches.get(A)?.phase).toBe("error");
    store.retryBranch(A);
    await settle();
    expect(store.getSnapshot().branches.get(A)?.phase).toBe("ready");
  });

  it("forgets a topic that left the tree and refreshes what was shown", async () => {
    const fake = sample();
    const store = await open(fake);
    store.expand(B);
    await settle();
    fake.topics.get(R)!.children = [A, C];
    fake.topics.delete(B);
    fake.generation = 2;
    store.handleChanged({ topicIds: [R] });
    await settle();
    expect(titles(store)).toEqual(["Memory", "Open science"]);
  });
});

describe("more topics and more leaves", () => {
  it("reads the rest of a long branch page by page", async () => {
    const children = Array.from({ length: 130 }, (_, n) => id(1000 + n));
    const fake = sample(
      children.map((child, n) => ({ id: child, parentId: C, title: `Child ${n}` }) as FakeTopic)
    );
    fake.topics.get(C)!.children = children;
    const store = await open(fake);
    store.expand(C);
    await settle();
    expect(store.getSnapshot().branches.get(C)?.data?.nodes).toHaveLength(100);
    expect(store.getSnapshot().branches.get(C)?.data?.nextCursor).toBe("100");
    await store.loadMoreTopics(C);
    expect(store.getSnapshot().branches.get(C)?.data?.nodes).toHaveLength(130);
    expect(store.getSnapshot().branches.get(C)?.data?.nextCursor).toBeNull();
    expect(fake.calls.tree.at(-1)).toMatchObject({
      parentId: C,
      cursor: "100",
      includeItems: false
    });
  });

  it("reads the topic again from the start when its cursor went stale", async () => {
    const children = Array.from({ length: 130 }, (_, n) => id(1000 + n));
    const fake = sample(
      children.map((child, n) => ({ id: child, parentId: C, title: `Child ${n}` }) as FakeTopic)
    );
    fake.topics.get(C)!.children = children;
    const store = await open(fake);
    store.expand(C);
    await settle();
    fake.failNext.tree = "Error invoking remote method: Error: topics.errors.stale";
    await store.loadMoreTopics(C);
    await settle();
    expect(store.getSnapshot().branches.get(C)?.phase).toBe("ready");
    expect(store.getSnapshot().branches.get(C)?.moreTopics).toBe("idle");
    expect(fake.calls.tree.filter((call) => call.parentId === C).length).toBeGreaterThanOrEqual(3);
  });

  it("marks a failed page and lets it be asked for again", async () => {
    const children = Array.from({ length: 130 }, (_, n) => id(1000 + n));
    const fake = sample(
      children.map((child, n) => ({ id: child, parentId: C, title: `Child ${n}` }) as FakeTopic)
    );
    fake.topics.get(C)!.children = children;
    const store = await open(fake);
    store.expand(C);
    await settle();
    fake.failNext.tree = "boom";
    await store.loadMoreTopics(C);
    expect(store.getSnapshot().branches.get(C)?.moreTopics).toBe("error");
    await store.loadMoreTopics(C);
    expect(store.getSnapshot().branches.get(C)?.data?.nodes).toHaveLength(130);
  });

  it("reads past the first five leaves of a topic", async () => {
    const fake = sample();
    const store = await open(fake);
    store.expand(A);
    await settle();
    expect(store.getSnapshot().branches.get(A)?.data?.moreItems).toBe(3);
    await store.loadMoreItems(A);
    const data = store.getSnapshot().branches.get(A)!.data!;
    expect(data.items).toHaveLength(8);
    expect(data.moreItems).toBe(0);
    expect(fake.calls.notes).toEqual([{ id: A, scope: "direct", kind: "all", limit: 50 }]);
  });

  it("reads the Unsorted group's leaves through the root", async () => {
    const fake = sample();
    fake.topics.get(R)!.leaves = [
      ...Array.from({ length: 7 }, (_, n) => sourceLeaf(n, { unsorted: true }))
    ];
    const store = await open(fake);
    expect(store.getSnapshot().branches.get(rootBranchKey)?.data?.moreItems).toBe(2);
    await store.loadMoreItems(null);
    expect(store.getSnapshot().branches.get(rootBranchKey)?.data?.items).toHaveLength(7);
    expect(fake.calls.notes[0]?.id).toBe(R);
    store.expand(unsortedKey);
    expect(store.getSnapshot().expanded.has(unsortedKey)).toBe(true);
  });

  it("pages leaves with the cursor when there are more than a page", async () => {
    const fake = sample();
    fake.topics.get(B)!.leaves = manyLeaves(120);
    const store = await open(fake);
    store.expand(B);
    await settle();
    await store.loadMoreItems(B);
    expect(store.getSnapshot().branches.get(B)?.data?.items).toHaveLength(50);
    expect(store.getSnapshot().branches.get(B)?.data?.moreItems).toBe(70);
    await store.loadMoreItems(B);
    expect(store.getSnapshot().branches.get(B)?.data?.items).toHaveLength(100);
    await store.loadMoreItems(B);
    const data = store.getSnapshot().branches.get(B)!.data!;
    expect(data.items).toHaveLength(120);
    expect(data.moreItems).toBe(0);
  });
});

describe("pushed changes", () => {
  it("reads again only the shown branches that show a changed topic", async () => {
    const fake = sample();
    const store = await open(fake);
    store.expand(A);
    store.expand(B);
    await settle();
    const before = fake.calls.tree.length;
    fake.generation = 2;
    store.handleChanged({ topicIds: [A2, A, R] });
    await settle();
    const refreshed = fake.calls.tree.slice(before).map((call) => call.parentId);
    // The root lists A, and A lists A2; B was not named and stays as it was.
    expect(refreshed.sort()).toEqual([A, null].sort());
  });

  it("does not read a branch that is closed, but drops it so it is read when opened", async () => {
    const fake = sample();
    const store = await open(fake);
    store.expand(A);
    await settle();
    store.collapse(A);
    const before = fake.calls.tree.length;
    fake.generation = 2;
    store.handleChanged({ topicIds: [A] });
    await settle();
    const refreshed = fake.calls.tree.slice(before).map((call) => call.parentId);
    expect(refreshed).toEqual([null]);
    expect(store.getSnapshot().branches.has(A)).toBe(false);
    store.expand(A);
    await settle();
    expect(store.getSnapshot().branches.get(A)?.phase).toBe("ready");
  });

  it("reads every shown branch when the change was too broad to list", async () => {
    const fake = sample();
    const store = await open(fake);
    store.expand(A);
    await settle();
    const before = fake.calls.tree.length;
    store.handleChanged({ topicIds: null });
    await settle();
    expect(fake.calls.tree.length - before).toBe(2);
  });

  it("ignores a change that names topics no branch shows", async () => {
    const fake = sample();
    const store = await open(fake);
    const before = fake.calls.tree.length;
    store.handleChanged({ topicIds: [id(999)] });
    await settle();
    expect(fake.calls.tree).toHaveLength(before);
    // The status line still follows, as it is cheap.
    expect(fake.calls.status).toBe(2);
  });

  it("keeps changes pushed while hidden and applies them when shown", async () => {
    const fake = sample();
    const store = await open(fake);
    store.setActive(false);
    const before = fake.calls.tree.length;
    fake.generation = 2;
    store.handleChanged({ topicIds: [R] });
    store.handleChanged({ topicIds: [A] });
    await settle();
    expect(fake.calls.tree).toHaveLength(before);
    store.setActive(true);
    await settle();
    // One read of the root for both events.
    expect(fake.calls.tree.slice(before)).toHaveLength(1);
  });

  it("runs one refresh at a time and follows with one more for what arrived meanwhile", async () => {
    const fake = sample();
    const store = await open(fake);
    const before = fake.calls.tree.length;
    fake.hold = [];
    store.handleChanged({ topicIds: [R] });
    await settle();
    store.handleChanged({ topicIds: [R] });
    store.handleChanged({ topicIds: [R] });
    await settle();
    expect(fake.calls.tree.length - before).toBe(1);
    const held = fake.hold;
    fake.hold = null;
    held.forEach((release) => release());
    await settle();
    await settle();
    expect(fake.calls.tree.length - before).toBe(2);
  });

  it("keeps what is shown when a refresh fails, and drops an answer a newer read overtook", async () => {
    const fake = sample();
    const store = await open(fake);
    fake.failNext.tree = "boom";
    store.handleChanged({ topicIds: [R] });
    await settle();
    expect(store.getSnapshot().branches.get(rootBranchKey)?.phase).toBe("ready");
    expect(titles(store)).toEqual(["Memory", "Literature", "Open science"]);
    // An answer older than the one shown is not applied.
    fake.generation = 0;
    fake.topics.get(R)!.children = [C];
    store.handleChanged({ topicIds: [R] });
    await settle();
    expect(titles(store)).toEqual(["Memory", "Literature", "Open science"]);
  });

  it("applies the newest of two reads of the same branch even when the older answers last", async () => {
    const fake = sample();
    const store = await open(fake);
    fake.hold = [];
    fake.generation = 2;
    fake.topics.get(R)!.children = [A, B];
    store.handleChanged({ topicIds: [R] });
    await settle();
    // The tree moves on while that read is held; a second read is asked for and answers first.
    fake.generation = 3;
    fake.topics.get(R)!.children = [A];
    store.retryBranch(null);
    await settle();
    const [older, newer] = fake.hold;
    fake.hold = null;
    newer!();
    await settle();
    older!();
    await settle();
    expect(titles(store)).toEqual(["Memory"]);
    expect(store.getSnapshot().branches.get(rootBranchKey)?.data?.generation).toBe(3);
  });
});

describe("revealing a topic", () => {
  it("opens the path to it, reads each branch and asks for a scroll", async () => {
    const fake = sample();
    const store = await open(fake);
    await store.reveal(A2);
    const snapshot = store.getSnapshot();
    expect(snapshot.expanded.has(A)).toBe(true);
    expect(snapshot.branches.get(A)?.phase).toBe("ready");
    expect(snapshot.reveal).toEqual({ key: `t:${A2}`, token: 1 });
    await store.reveal(A2);
    expect(store.getSnapshot().reveal?.token).toBe(2);
  });

  it("follows a retired topic to its successor", async () => {
    const fake = sample([{ id: id(77), parentId: A, title: "Old", redirectTo: A2 }]);
    const store = await open(fake);
    await store.reveal(id(77));
    expect(store.getSnapshot().reveal?.key).toBe(`t:${A2}`);
  });

  it("gives up quietly for a topic that is gone or beyond the pages looked through", async () => {
    const fake = sample();
    const store = await open(fake);
    await store.reveal(id(12345));
    expect(store.getSnapshot().reveal).toBeNull();
    fake.failNext.path = "boom";
    await store.reveal(A);
    expect(store.getSnapshot().reveal).toBeNull();
  });

  it("looks through further pages of a long branch for the topic", async () => {
    const children = Array.from({ length: 250 }, (_, n) => id(2000 + n));
    const extra = children.map(
      (child, n) => ({ id: child, parentId: R, title: `Area ${n}` }) as FakeTopic
    );
    const fake = sample(extra);
    fake.topics.get(R)!.children = [A, ...children];
    const store = await open(fake);
    await store.reveal(children[220]!);
    expect(store.getSnapshot().reveal?.key).toBe(`t:${children[220]!}`);
  });
});

describe("pinned and recent items", () => {
  it("lists pins and recents, resolving topics to live ones and dropping the ones that are gone", async () => {
    const gone = id(4040);
    const fake = sample([{ id: id(77), parentId: A, title: "Old", redirectTo: A2 }]);
    fake.history = [
      historyEntry({
        address: `memora://topic/${A}`,
        kind: "topic",
        id: A,
        title: "Memory",
        pinned: true
      }),
      historyEntry({
        address: `memora://topic/${id(77)}`,
        kind: "topic",
        id: id(77),
        title: "Old"
      }),
      historyEntry({ address: `memora://topic/${gone}`, kind: "topic", id: gone, title: "Gone" }),
      historyEntry({ address: `memora://source/${id(8)}`, kind: "source", id: id(8), title: "S" })
    ];
    const store = await open(fake);
    const { pinned, recents } = store.getSnapshot().places;
    expect(store.getSnapshot().places.phase).toBe("ready");
    expect(pinned.map((place) => [place.title, place.count])).toEqual([["Memory", 11]]);
    expect(recents.map((place) => [place.kind, place.title, place.id])).toEqual([
      ["topic", "Replications", A2],
      ["source", "S", id(8)]
    ]);
  });

  it("reads them again when the history changes, and keeps the list if that fails", async () => {
    const fake = sample();
    const store = await open(fake);
    const before = fake.calls.history.length;
    fake.history = [historyEntry()];
    store.handleHistoryChanged();
    await settle();
    expect(fake.calls.history).toHaveLength(before + 1);
    expect(store.getSnapshot().places.recents).toHaveLength(1);
    fake.failNext.history = "boom";
    store.handleHistoryChanged();
    await settle();
    expect(store.getSnapshot().places.phase).toBe("ready");
    expect(store.getSnapshot().places.recents).toHaveLength(1);
  });

  it("reads again only the topics a change touched", async () => {
    const fake = sample();
    fake.history = [
      historyEntry({ address: `memora://topic/${A}`, kind: "topic", id: A, title: "Memory" }),
      historyEntry({ address: `memora://topic/${B}`, kind: "topic", id: B, title: "Literature" })
    ];
    const store = await open(fake);
    expect(fake.calls.path.map((call) => call.id).sort()).toEqual([A, B].sort());
    fake.calls.path.length = 0;
    store.handleChanged({ topicIds: [R, B] });
    await settle();
    expect(fake.calls.path.map((call) => call.id)).toEqual([B]);
  });

  it("says so when the first load failed, and reads again on request", async () => {
    const fake = sample();
    fake.failNext.history = "boom";
    const store = await open(fake);
    expect(store.getSnapshot().places.phase).toBe("error");
    store.retryPlaces();
    await settle();
    expect(store.getSnapshot().places.phase).toBe("ready");
  });
});

describe("the status line", () => {
  it("follows each change and keeps the last status when a read fails", async () => {
    const fake = sample();
    const store = await open(fake);
    expect(store.getSnapshot().status?.phase).toBe("active");
    fake.status = {
      phase: "building",
      counts: { items: 10, placed: 4, pending: 6, needsGate: 0 }
    };
    store.handleChanged({ topicIds: [R] });
    await settle();
    expect(store.getSnapshot().status?.phase).toBe("building");
    fake.failNext.status = "boom";
    store.handleChanged({ topicIds: [R] });
    await settle();
    expect(store.getSnapshot().status?.phase).toBe("building");
  });

  it("asks before re-embedding, then queues it, and starts over once the model is settled", async () => {
    const fake = sample();
    fake.status = {
      phase: "active",
      blocked: "space_changed",
      reembedNotes: 120,
      counts: { items: 10, placed: 10, pending: 0, needsGate: 0 }
    };
    const store = await open(fake);
    await store.confirmReembed();
    expect(fake.calls.reembed).toBe(0);
    store.askReembed();
    expect(store.getSnapshot().reembed).toBe("confirming");
    store.cancelReembed();
    expect(store.getSnapshot().reembed).toBe("idle");
    store.askReembed();
    await store.confirmReembed();
    expect(fake.calls.reembed).toBe(1);
    expect(store.getSnapshot().reembed).toBe("queued");
    fake.status = { phase: "active", counts: { items: 10, placed: 10, pending: 0, needsGate: 0 } };
    store.handleChanged({ topicIds: [R] });
    await settle();
    expect(store.getSnapshot().reembed).toBe("idle");
  });

  it("reports a failed re-embedding and lets it be asked again", async () => {
    const fake = sample();
    const store = await open(fake);
    store.askReembed();
    fake.failNext.reembed = "topics.errors.unavailable";
    await store.confirmReembed();
    expect(store.getSnapshot().reembed).toBe("failed");
    store.askReembed();
    expect(store.getSnapshot().reembed).toBe("confirming");
  });
});
