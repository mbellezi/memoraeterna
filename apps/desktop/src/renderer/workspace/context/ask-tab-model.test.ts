import { describe, expect, it } from "vitest";
import type { ObjectLocateResult } from "@app/domain";

import type { LibrarySourceProgress } from "../../../shared/ipc-library";
import type { QuestionListItemView } from "../../../shared/ipc-questions";
import {
  askTabState,
  askTarget,
  earlierLimit,
  earlierQuestions,
  indexedLine,
  primaryTopic,
  sameScope
} from "./ask-tab-model";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const topic = (n: number, title: string) => ({ kind: "topic" as const, id: uuid(n), title });

const located = (primaryPath: ObjectLocateResult["primaryPath"]): ObjectLocateResult => ({
  object: { kind: "note", id: uuid(9), title: "A note" },
  primaryPath: [...primaryPath, { kind: "note", id: uuid(9), title: "A note" }],
  alsoIn: [],
  citedBy: [],
  counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
});

describe("the topic a note asks", () => {
  it("is the deepest topic above it, without the untitled root", () => {
    expect(primaryTopic(located([topic(1, ""), topic(2, "Science"), topic(3, "Biology")]))).toEqual(
      {
        id: uuid(3),
        title: "Biology"
      }
    );
  });

  it("is null for a note with no place, or no read", () => {
    expect(primaryTopic(located([topic(1, "")]))).toBeNull();
    expect(primaryTopic(located([]))).toBeNull();
    expect(primaryTopic(null)).toBeNull();
  });
});

describe("what each kind of object asks (D14: library, topic, sources)", () => {
  it("asks a topic for itself and a source for itself", () => {
    expect(askTarget("topic", uuid(4), undefined)).toEqual({
      variant: "topic",
      scope: { kind: "topic", topicId: uuid(4) },
      topicTitle: null
    });
    expect(askTarget("source", uuid(5), undefined)).toEqual({
      variant: "source",
      scope: { kind: "sources", sourceIds: [uuid(5)] },
      topicTitle: null
    });
  });

  it("asks a note for the topic it is in, and waits while it does not know where that is", () => {
    expect(askTarget("note", uuid(6), undefined)).toBeNull();
    expect(askTarget("note", uuid(6), { id: uuid(3), title: "Biology" })).toEqual({
      variant: "note",
      scope: { kind: "topic", topicId: uuid(3) },
      topicTitle: "Biology"
    });
  });

  it("widens a note with no place to the library and says so (its own words)", () => {
    expect(askTarget("note", uuid(6), null)).toEqual({
      variant: "noteUnplaced",
      scope: { kind: "library" },
      topicTitle: null
    });
  });

  it("asks the library for an entity and for a question", () => {
    expect(askTarget("entity", uuid(7), undefined)?.scope).toEqual({ kind: "library" });
    expect(askTarget("entity", uuid(7), undefined)?.variant).toBe("entity");
    expect(askTarget("question", uuid(8), undefined)?.scope).toEqual({ kind: "library" });
    expect(askTarget("question", uuid(8), undefined)?.variant).toBe("library");
  });
});

describe("scopes and the questions asked before", () => {
  const item = (n: number, scope: QuestionListItemView["scope"]): QuestionListItemView => ({
    id: uuid(100 + n),
    text: `Question ${n}`,
    language: "en",
    scope,
    status: "complete",
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
    answerCount: 1
  });

  it("compares scopes by what they ask (sources as sets)", () => {
    expect(sameScope({ kind: "library" }, { kind: "library" })).toBe(true);
    expect(sameScope({ kind: "library" }, { kind: "topic", topicId: uuid(1) })).toBe(false);
    expect(
      sameScope({ kind: "topic", topicId: uuid(1) }, { kind: "topic", topicId: uuid(1) })
    ).toBe(true);
    expect(
      sameScope({ kind: "topic", topicId: uuid(1) }, { kind: "topic", topicId: uuid(2) })
    ).toBe(false);
    expect(
      sameScope(
        { kind: "sources", sourceIds: [uuid(1), uuid(2)] },
        { kind: "sources", sourceIds: [uuid(2), uuid(1)] }
      )
    ).toBe(true);
    expect(
      sameScope(
        { kind: "sources", sourceIds: [uuid(1)] },
        { kind: "sources", sourceIds: [uuid(1), uuid(2)] }
      )
    ).toBe(false);
    expect(
      sameScope({ kind: "sources", sourceIds: [uuid(1)] }, { kind: "topic", topicId: uuid(1) })
    ).toBe(false);
  });

  it("lists only the questions of this scope, newest first as read, at most five", () => {
    const here = { kind: "topic" as const, topicId: uuid(1) };
    const items = [
      item(1, here),
      item(2, { kind: "library" }),
      item(3, here),
      ...Array.from({ length: 8 }, (_, n) => item(10 + n, here))
    ];
    const listed = earlierQuestions(items, here);
    expect(listed).toHaveLength(earlierLimit);
    expect(listed.map((entry) => entry.id).slice(0, 2)).toEqual([uuid(101), uuid(103)]);
    expect(earlierQuestions(items, { kind: "topic", topicId: uuid(99) })).toEqual([]);
  });
});

describe("the milestone line of a source", () => {
  const progress = (
    chunks: { state: "pending" | "running" | "done"; indexed: number },
    notes: { state: "pending" | "running" | "done" | "notApplicable" },
    run: "running" | "succeeded" | null
  ): LibrarySourceProgress => ({
    run: run
      ? { status: run, stage: "atomicNotes", startedAt: null, completedAt: null, failedStage: null }
      : null,
    needsYou: null,
    paused: false,
    steps: {
      read: { state: "done", pages: 10 },
      chunks,
      notes: { ...notes, soFar: 0, estimate: null },
      placed: { state: "pending", count: 0 },
      summary: { state: "pending" },
      relations: { state: "pending" }
    },
    sections: []
  });

  it("says the passages are indexed and that the notes are still arriving", () => {
    expect(
      indexedLine(progress({ state: "done", indexed: 142 }, { state: "running" }, "running"))
    ).toEqual({ kind: "indexed", count: 142, arriving: true });
  });

  it("says only that they are indexed once the notes are done or the source was stored without notes", () => {
    expect(
      indexedLine(progress({ state: "done", indexed: 210 }, { state: "done" }, "succeeded"))
    ).toEqual({ kind: "indexed", count: 210, arriving: false });
    expect(
      indexedLine(progress({ state: "done", indexed: 40 }, { state: "notApplicable" }, null))
    ).toEqual({ kind: "indexed", count: 40, arriving: false });
  });

  it("says the passages are still being indexed while they are, and nothing for an idle source with none", () => {
    expect(
      indexedLine(progress({ state: "running", indexed: 0 }, { state: "pending" }, "running"))
    ).toEqual({ kind: "indexing" });
    expect(
      indexedLine(progress({ state: "pending", indexed: 0 }, { state: "pending" }, null))
    ).toBeNull();
    expect(indexedLine(null)).toBeNull();
  });
});

describe("the tab's state: one failure at a time", () => {
  const base = { scope: "ready", sendFailed: false, earlier: "ready", earlierCount: 0 } as const;

  it("is loading while the scope or the earlier questions are read", () => {
    expect(askTabState({ ...base, scope: "loading" })).toBe("loading");
    expect(askTabState({ ...base, earlier: "loading" })).toBe("loading");
  });

  it("is empty with no earlier question and success with some", () => {
    expect(askTabState(base)).toBe("empty");
    expect(askTabState({ ...base, earlierCount: 2 })).toBe("success");
  });

  it("is an error for a scope it cannot write, a send that failed or a list that did not load", () => {
    expect(askTabState({ ...base, scope: "error" })).toBe("error");
    expect(askTabState({ ...base, sendFailed: true })).toBe("error");
    expect(askTabState({ ...base, earlier: "error" })).toBe("error");
    // The scope outranks everything: no field, no list.
    expect(askTabState({ ...base, scope: "error", earlier: "loading" })).toBe("error");
    expect(askTabState({ ...base, scope: "loading", earlier: "error" })).toBe("loading");
  });
});
