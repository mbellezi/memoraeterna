import { describe, expect, it } from "vitest";
import {
  loadPlaces,
  placesFromEntries,
  recentsShown,
  resolveTopic,
  type ResolvedTopic
} from "./topic-places";
import { FakeTopics, historyEntry, id, noteLeaf } from "./topic-fixtures";

const topicEntry = (n: number, overrides = {}) =>
  historyEntry({
    address: `memora://topic/${id(n)}`,
    kind: "topic",
    id: id(n),
    title: `Stored ${n}`,
    ...overrides
  });
const resolved = (n: number, overrides: Partial<ResolvedTopic> = {}): ResolvedTopic => ({
  id: id(n),
  title: `Topic ${n}`,
  count: n * 10,
  health: "good",
  management: "ai",
  ...overrides
});

describe("pins and recents from the history", () => {
  it("splits the entries into pinned and recent, in the history's order", () => {
    const entries = [
      topicEntry(1, { pinned: true }),
      topicEntry(2),
      historyEntry({ id: id(8), address: `memora://source/${id(8)}`, pinned: true }),
      topicEntry(3)
    ];
    const places = placesFromEntries(
      entries,
      new Map([
        [id(1), resolved(1)],
        [id(2), resolved(2)],
        [id(3), resolved(3)]
      ])
    );
    expect(places.pinned.map((place) => place.id)).toEqual([id(1), id(8)]);
    expect(places.recents.map((place) => place.id)).toEqual([id(2), id(3)]);
  });

  it("shows the live name and count of a topic, not the stored title", () => {
    const places = placesFromEntries(
      [topicEntry(1)],
      new Map([[id(1), resolved(1, { title: null, health: "attention", management: "human" })]])
    );
    expect(places.recents[0]).toMatchObject({
      kind: "topic",
      title: null,
      count: 10,
      health: "attention",
      management: "human",
      source: null
    });
  });

  it("leads a retired topic to its successor and lists it once", () => {
    const places = placesFromEntries(
      [topicEntry(1), topicEntry(2)],
      new Map([
        [id(1), resolved(9)],
        [id(2), resolved(9)]
      ])
    );
    expect(places.recents).toHaveLength(1);
    expect(places.recents[0]).toMatchObject({ id: id(9), address: `memora://topic/${id(9)}` });
  });

  it("drops a topic that no longer exists", () => {
    const places = placesFromEntries(
      [topicEntry(1), topicEntry(2)],
      new Map([
        [id(1), null],
        [id(2), resolved(2)]
      ])
    );
    expect(places.recents.map((place) => place.id)).toEqual([id(2)]);
  });

  it("keeps a topic that could not be read with its stored title and no count", () => {
    const places = placesFromEntries([topicEntry(1)], new Map(), new Set([id(1)]));
    expect(places.recents[0]).toMatchObject({ title: "Stored 1", count: null, health: null });
  });

  it("opens a note in its source, and drops a note that has no source to open in", () => {
    const note = historyEntry({
      address: `memora://note/${id(4)}`,
      kind: "note",
      id: id(4),
      title: "A note",
      parentAddress: `memora://source/${id(5)}`
    });
    const orphan = historyEntry({ address: `memora://note/${id(6)}`, kind: "note", id: id(6) });
    const places = placesFromEntries([note, orphan], new Map());
    expect(places.recents).toHaveLength(1);
    expect(places.recents[0]?.source).toEqual({ sourceItemId: id(5), atomicNoteId: id(4) });
  });

  it("ignores kinds the navigator does not list, and shows only a few recents", () => {
    const question = historyEntry({
      address: `memora://question/${id(7)}`,
      kind: "question",
      id: id(7)
    });
    const many = Array.from({ length: 9 }, (_, n) =>
      historyEntry({ address: `memora://source/${id(100 + n)}`, id: id(100 + n) })
    );
    const places = placesFromEntries([question, ...many], new Map());
    expect(places.recents).toHaveLength(recentsShown);
    expect(places.pinned).toEqual([]);
  });
});

describe("resolving topics against the tree", () => {
  const fake = () =>
    new FakeTopics({
      rootId: id(1),
      topics: [
        { id: id(1), parentId: null, title: null, children: [id(2)] },
        { id: id(2), parentId: id(1), title: "Memory", leaves: [noteLeaf(1)] },
        { id: id(3), parentId: id(1), title: "Old", redirectTo: id(2) }
      ]
    });

  it("reads the live topic with two small calls", async () => {
    const topics = fake();
    expect(await resolveTopic(topics.api, id(2))).toEqual({
      id: id(2),
      title: "Memory",
      count: 1,
      health: "good",
      management: "ai"
    });
    expect(topics.calls.path).toEqual([{ id: id(2) }]);
    expect(topics.calls.tree).toEqual([
      { parentId: id(2), limit: 1, includeItems: false, itemLimit: 0 }
    ]);
  });

  it("follows a redirect and answers nothing for a topic that is gone", async () => {
    const topics = fake();
    expect((await resolveTopic(topics.api, id(3)))?.id).toBe(id(2));
    expect(await resolveTopic(topics.api, id(40))).toBeNull();
  });

  it("asks about each topic of the history once, and uses what it already knows", async () => {
    const topics = fake();
    topics.history = [
      topicEntry(2),
      topicEntry(2, { address: `memora://topic/${id(2)}`, pinned: true })
    ];
    const cache = new Map<string, ResolvedTopic | null>();
    const places = await loadPlaces(topics.api, cache);
    expect(topics.calls.path).toHaveLength(1);
    expect(places.pinned).toHaveLength(1);
    await loadPlaces(topics.api, cache);
    expect(topics.calls.path).toHaveLength(1);
    expect(topics.calls.history).toHaveLength(2);
  });

  it("keeps an entry whose topic could not be read, and tries again next time", async () => {
    const topics = fake();
    topics.history = [topicEntry(2)];
    topics.failNext.path = "boom";
    const cache = new Map<string, ResolvedTopic | null>();
    const first = await loadPlaces(topics.api, cache);
    expect(first.recents[0]).toMatchObject({ title: "Stored 2", count: null });
    expect(cache.has(id(2))).toBe(false);
    const second = await loadPlaces(topics.api, cache);
    expect(second.recents[0]).toMatchObject({ title: "Memory", count: 1 });
  });
});
