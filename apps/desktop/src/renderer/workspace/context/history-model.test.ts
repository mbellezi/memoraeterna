import { describe, expect, it } from "vitest";
import type { ChangeSetSummary } from "@app/domain";

import {
  historyRow,
  historyState,
  historyUndoFailure,
  historyUndoKey,
  historyUndoOutcome,
  historyWho
} from "./history-model";

const change = (fields: Partial<ChangeSetSummary> = {}): ChangeSetSummary => ({
  kind: "topic",
  id: "00000000-0000-4000-8000-000000000001",
  titleKey: "topics.changeSets.place",
  titleParams: { items: 3 },
  risk: "low",
  status: "applied",
  origin: "place",
  subjectId: null,
  jobId: null,
  at: "2026-11-11T10:00:00.000Z",
  undoneAt: null,
  undo: "available",
  ...fields
});

describe("who made a change", () => {
  it("reads the person's own edits and undos as you, everything else as the Gardener", () => {
    expect(historyWho({ origin: "human" })).toBe("you");
    expect(historyWho({ origin: "undo" })).toBe("you");
    for (const origin of ["place", "rebalance", "naming", "build", "match", "link", "patch"])
      expect(historyWho({ origin })).toBe("gardener");
  });
});

describe("a row of the thread", () => {
  it("offers Desfazer for an applied change the store can undo, with a solid node", () => {
    expect(historyRow(change())).toEqual({
      node: "done",
      note: null,
      undo: "offered",
      refusal: null
    });
  });

  it("shows Desfazer as under way while it runs", () => {
    expect(historyRow(change(), { status: "pending" }).undo).toBe("running");
  });

  it("says a later change depends on a blocked one, and offers nothing", () => {
    expect(historyRow(change({ undo: "blocked" }))).toEqual({
      node: "done",
      note: "blocked",
      undo: null,
      refusal: null
    });
  });

  it("offers nothing for a change the store cannot undo (a build, an undo)", () => {
    expect(historyRow(change({ undo: "unavailable", origin: "build" }))).toMatchObject({
      node: "done",
      note: null,
      undo: null
    });
  });

  it("shows what waits, what was undone and what was dismissed as a hollow node, with no Desfazer", () => {
    for (const [status, note] of [
      ["pending_review", "waiting"],
      ["undone", "undone"],
      ["dismissed", "dismissed"]
    ] as const)
      expect(historyRow(change({ status, undo: "available" }))).toEqual({
        node: "hollow",
        note,
        undo: null,
        refusal: null
      });
  });

  it("marks a row undone here at once, before the read comes back", () => {
    expect(historyRow(change(), { status: "undone" })).toMatchObject({
      node: "hollow",
      note: "undone",
      undo: null
    });
  });

  it("keeps Desfazer and names the store's reason after a refusal or a failure, never both reasons", () => {
    const refused = historyRow(change(), {
      status: "blocked",
      messageKey: "changes.blockers.later_change"
    });
    expect(refused).toEqual({
      node: "done",
      note: null,
      undo: "offered",
      refusal: "changes.blockers.later_change"
    });
    const blockedAndRefused = historyRow(change({ undo: "blocked" }), {
      status: "failed",
      messageKey: "activity.done.undoFailed"
    });
    expect(blockedAndRefused.note).toBeNull();
    expect(blockedAndRefused.refusal).toBe("activity.done.undoFailed");
  });
});

describe("what a Desfazer leaves", () => {
  it("is undone, or the first blocker's own words, or the plain failure", () => {
    expect(historyUndoOutcome({ status: "undone", kind: "topic", id: change().id })).toEqual({
      status: "undone"
    });
    expect(
      historyUndoOutcome({
        status: "blocked",
        blockers: [
          { code: "later_change", changeSet: null },
          { code: "conflict", changeSet: null }
        ],
        more: 0
      })
    ).toEqual({ status: "blocked", messageKey: "changes.blockers.later_change" });
    expect(historyUndoFailure(new Error("boom"))).toEqual({
      status: "failed",
      messageKey: "activity.done.undoFailed"
    });
    expect(historyUndoFailure(new Error("changes.errors.notFound"))).toEqual({
      status: "failed",
      messageKey: "changes.errors.notFound"
    });
  });

  it("keys a row by its store and ID", () => {
    expect(historyUndoKey({ kind: "relation", id: "abc" })).toBe("relation:abc");
  });
});

describe("the tab's state", () => {
  it("is loading, error, empty or success from its read", () => {
    expect(historyState({ status: "loading" })).toBe("loading");
    expect(historyState({ status: "error" })).toBe("error");
    expect(historyState({ status: "ready", items: [] })).toBe("empty");
    expect(historyState({ status: "ready", items: [change()] })).toBe("success");
  });
});
