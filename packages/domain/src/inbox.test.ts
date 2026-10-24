import { describe, expect, it } from "vitest";

import { supportedLanguageCodes, translate, type MessageKey } from "@app/i18n";

import {
  InboxActInputSchema,
  InboxActResultSchema,
  InboxCountsSchema,
  InboxItemSchema,
  InboxListInputSchema,
  compareInboxPositions,
  emptyInboxCounts,
  inboxActions,
  inboxCursor,
  inboxErrorKeys,
  inboxItemKey,
  inboxKinds,
  inboxRiskRank,
  inboxTime,
  inboxVariants,
  inboxVerbs,
  parseInboxCursor
} from "./inbox.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const item = {
  kind: "duplicate",
  id: id(1),
  risk: "low",
  variant: "title",
  at: "2026-10-24T05:00:00.123456Z",
  params: { cosine: 0.98 },
  objects: [{ kind: "note", id: id(2), title: "Naps" }],
  changeSet: null,
  actions: ["dismiss"]
} as const;

describe("the inbox.* contracts", () => {
  it("lists the kinds of D29 in the order the Inbox shows them", () => {
    expect(inboxKinds).toEqual([
      "review",
      "quarantined",
      "contradiction",
      "withdrawn",
      "duplicate",
      "obsidian_conflict",
      "budget",
      "backlog"
    ]);
    expect(Object.keys(inboxVariants).sort()).toEqual([...inboxKinds].sort());
  });

  it("parses an item and refuses unknown fields, kinds and verbs", () => {
    expect(InboxItemSchema.parse(item)).toEqual(item);
    expect(() => InboxItemSchema.parse({ ...item, extra: true })).toThrow();
    expect(() => InboxItemSchema.parse({ ...item, kind: "other" })).toThrow();
    expect(() => InboxItemSchema.parse({ ...item, actions: ["undo"] })).toThrow();
    expect(() => InboxItemSchema.parse({ ...item, risk: "urgent" })).toThrow();
    expect(() =>
      InboxItemSchema.parse({ ...item, objects: [{ kind: "note", id: "x", title: "" }] })
    ).toThrow();
  });

  it("bounds a page and defaults it to the largest", () => {
    expect(InboxListInputSchema.parse({}).limit).toBe(50);
    expect(() => InboxListInputSchema.parse({ limit: 51 })).toThrow();
    expect(() => InboxListInputSchema.parse({ kinds: [] })).toThrow();
    expect(InboxListInputSchema.parse({ kinds: ["review"], risk: "high" })).toMatchObject({
      kinds: ["review"],
      risk: "high"
    });
  });

  it("counts every kind, a missing one is an error", () => {
    const counts = emptyInboxCounts();
    expect(InboxCountsSchema.parse(counts)).toEqual(counts);
    expect(Object.keys(counts.byKind)).toEqual([...inboxKinds]);
    const missing = Object.fromEntries(
      Object.entries(counts.byKind).filter(([kind]) => kind !== "review")
    );
    expect(() => InboxCountsSchema.parse({ ...counts, byKind: missing })).toThrow();
  });

  it("takes the offered verbs and undo, and answers in a closed set of states", () => {
    expect(inboxActions).toEqual([...inboxVerbs, "undo"]);
    for (const action of inboxActions)
      expect(InboxActInputSchema.parse({ kind: "review", id: "topic:x", action }).action).toBe(
        action
      );
    expect(() => InboxActInputSchema.parse({ kind: "review", id: "x", action: "merge" })).toThrow();
    for (const result of [
      { status: "done", undoable: true, queued: 3 },
      { status: "stale" },
      { status: "waiting" },
      { status: "gone" },
      { status: "unsupported" },
      { status: "blocked", blockers: [{ code: "later_change", changeSet: null }], more: 0 }
    ])
      expect(InboxActResultSchema.parse(result)).toEqual(result);
    expect(() =>
      InboxActResultSchema.parse({ status: "blocked", blockers: [], more: 0 })
    ).toThrow();
  });

  it("keys an item by kind and ID", () => {
    expect(inboxItemKey({ kind: "quarantined", id: "topic-overview|note:x" })).toBe(
      "quarantined:topic-overview|note:x"
    );
  });
});

describe("the order of the list", () => {
  it("ranks high before medium before low", () => {
    expect([inboxRiskRank("high"), inboxRiskRank("medium"), inboxRiskRank("low")]).toEqual([
      0, 1, 2
    ]);
  });

  it("orders by risk, then age, then key in code-unit order", () => {
    const at = "2026-10-24T05:00:00.000001Z";
    const later = "2026-10-24T05:00:00.000002Z";
    const positions = [
      { rank: 2, at, key: "a" },
      { rank: 1, at: later, key: "a" },
      { rank: 1, at, key: "b" },
      { rank: 1, at, key: "B" },
      { rank: 0, at: later, key: "z" }
    ];
    expect(
      positions
        .toSorted(compareInboxPositions)
        .map((p) => `${p.rank}${p.key}${p.at === at ? 1 : 2}`)
    ).toEqual(["0z2", "1B1", "1b1", "1a2", "2a1"]);
    expect(compareInboxPositions(positions[0]!, positions[0]!)).toBe(0);
  });

  it("round-trips a cursor and refuses what is not one", () => {
    const position = { rank: 1, at: "2026-10-24T05:00:00.123456Z", key: "quarantined:a|note:b" };
    expect(parseInboxCursor(inboxCursor(position))).toEqual(position);
    for (const bad of [
      "",
      "3|2026-10-24T05:00:00.123456Z|k",
      "1|yesterday|k",
      "1|2026-10-24T05:00:00Z|k",
      "1|2026-10-24T05:00:00.123456Z|"
    ])
      expect(parseInboxCursor(bad)).toBeNull();
  });

  it("writes a date the way the database writes a time, with microseconds", () => {
    expect(inboxTime(new Date("2026-10-24T05:00:00.123Z"))).toBe("2026-10-24T05:00:00.123000Z");
    expect(inboxTime(new Date(0))).toBe("1970-01-01T00:00:00.000000Z");
  });
});

describe("the inbox.* failures", () => {
  it("are worded in every language", () => {
    for (const locale of supportedLanguageCodes)
      for (const key of inboxErrorKeys)
        expect(translate(locale, key as MessageKey), `${locale} ${key}`).not.toBe(key);
  });
});
