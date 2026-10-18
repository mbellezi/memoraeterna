import { describe, expect, it } from "vitest";
import type { NotePage, NotePageRelation } from "@app/domain";

import { withoutWithdrawn } from "./NotePage";
import { fixtureId, notePage, relationItem } from "./note-page-fixtures";
import {
  bandWordKey,
  cardContent,
  focusAfterRemoval,
  groupOf,
  keepShownRelations,
  listOf,
  locateRelation,
  offersReview,
  provenanceLines,
  relationStateKey,
  withReviewed,
  withWithdrawn,
  withWrittenExplanation
} from "./note-page-model";

// The pure parts of the relation review (F3 D15, D42, R29): what the page does with a verdict, a
// relation the writer withdrew and a refresh, and where focus goes when a row leaves its list.
const row = (n: number, overrides: Partial<NotePageRelation> = {}) =>
  relationItem({ id: fixtureId(n), ...overrides });
const pageWith = (parts: {
  shown?: NotePageRelation[];
  withdrawn?: NotePageRelation[];
  earlier?: NotePageRelation[];
  totals?: [number, number, number];
}): NotePage => {
  const shown = parts.shown ?? [];
  const withdrawn = parts.withdrawn ?? [];
  const earlier = parts.earlier ?? [];
  const [a, b, c] = parts.totals ?? [shown.length, withdrawn.length, earlier.length];
  return notePage({
    relations: { items: shown, total: a },
    withdrawn: { items: withdrawn, total: b },
    earlierVersions: { items: earlier, total: c }
  });
};

describe("band word and state of a relation", () => {
  it("keys a word only for an automatic relation with a band, whatever the calibration", () => {
    const word = (overrides: Partial<NotePageRelation>) => bandWordKey(row(60, overrides));
    expect(word({ band: "apply", calibration: "frozen" })).toBe("notePage.band.strong");
    expect(word({ band: "suggest", calibration: "provisional" })).toBe("notePage.band.possible");
    expect(word({ band: "suggest", calibration: "uncalibrated" })).toBe(
      "notePage.band.uncalibrated"
    );
    expect(word({})).toBeNull();
    expect(word({ state: "kept", band: "apply", calibration: "frozen" })).toBeNull();
    expect(word({ state: "withdrawn", band: "suggest", calibration: "frozen" })).toBeNull();
  });

  it("keys a state chip for suggested, kept and withdrawn, none for applied", () => {
    expect(relationStateKey("applied")).toBeNull();
    expect(relationStateKey("suggested")).toBe("notePage.state.suggested");
    expect(relationStateKey("kept")).toBe("notePage.state.kept");
    expect(relationStateKey("withdrawn")).toBe("notePage.state.withdrawn");
  });

  it("offers Keep and Remove on a suggested or withdrawn relation, and on one the writer just withdrew", () => {
    expect(offersReview({ state: "suggested" }, null)).toBe(true);
    expect(offersReview({ state: "withdrawn" }, undefined)).toBe(true);
    expect(offersReview({ state: "applied" }, { status: "vetoed" })).toBe(true);
    expect(offersReview({ state: "applied" }, { status: "writing" })).toBe(false);
    expect(offersReview({ state: "applied" }, null)).toBe(false);
    expect(offersReview({ state: "kept" }, { status: "unexplained" })).toBe(false);
  });
});

describe("the three actors of a relation", () => {
  it("lists the known steps in the order they happen", () => {
    const decided = { model: "ranker", kind: "local" as const };
    const typed = { model: "typer", kind: "remote" as const };
    const explained = { model: "writer", kind: null };
    expect(provenanceLines({ decidedBy: decided, typedBy: typed, explainedBy: explained })).toEqual(
      [
        { role: "decided", actor: decided },
        { role: "typed", actor: typed },
        { role: "explained", actor: explained }
      ]
    );
    expect(provenanceLines({ decidedBy: null, typedBy: null, explainedBy: explained })).toEqual([
      { role: "explained", actor: explained }
    ]);
    expect(provenanceLines({ decidedBy: null, typedBy: null, explainedBy: null })).toEqual([]);
    expect(cardContent(row(60, { typedBy: typed }), null).provenance.map((l) => l.role)).toEqual([
      "decided",
      "typed"
    ]);
  });
});

describe("lists of relations on the page", () => {
  it("names the field of each group and finds the list a relation is in", () => {
    expect(listOf("shown")).toBe("relations");
    expect(listOf("withdrawn")).toBe("withdrawn");
    expect(listOf("earlier")).toBe("earlierVersions");
    expect(groupOf("earlierVersions")).toBe("earlier");
    const page = pageWith({ shown: [row(60), row(62)], withdrawn: [row(64)], earlier: [row(66)] });
    expect(locateRelation(page, fixtureId(62))).toEqual({
      list: "relations",
      ids: [fixtureId(60), fixtureId(62)]
    });
    expect(locateRelation(page, fixtureId(64))?.list).toBe("withdrawn");
    expect(locateRelation(page, fixtureId(66))?.list).toBe("earlierVersions");
    expect(locateRelation(page, fixtureId(99))).toBeNull();
  });

  it("keeps the rows of every list shown past the first page when the page is read again", () => {
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => row(1000 + from + index));
    const shown = pageWith({ shown: rows(0, 30), withdrawn: rows(100, 130), totals: [30, 40, 0] });
    const refreshed = pageWith({
      shown: rows(0, 20),
      withdrawn: rows(100, 120),
      totals: [30, 40, 0]
    });
    const kept = keepShownRelations(shown, refreshed);
    expect(kept.relations.items).toHaveLength(30);
    expect(kept.withdrawn.items).toHaveLength(30);
    // The refreshed totals win, and a list that was not extended is the refreshed one.
    expect(kept.withdrawn.total).toBe(40);
    expect(kept.earlierVersions).toBe(refreshed.earlierVersions);
    // A relation reviewed meanwhile (not in the refreshed first page, dropped by the caller) leaves.
    const dropped = keepShownRelations(shown, refreshed, new Set([rows(0, 30)[25]!.id]));
    expect(dropped.relations.items).toHaveLength(29);
  });
});

describe("where focus goes when a row leaves its list", () => {
  const ids = ["a", "b", "c"];

  it("goes to the row that takes its place, else the one before it", () => {
    expect(focusAfterRemoval(ids, "a")).toBe("b");
    expect(focusAfterRemoval(ids, "b")).toBe("c");
    expect(focusAfterRemoval(ids, "c")).toBe("b");
    expect(focusAfterRemoval(["a"], "a")).toBeNull();
    expect(focusAfterRemoval(ids, "missing")).toBeNull();
    expect(focusAfterRemoval([], "a")).toBeNull();
  });
});

describe("the owner's verdict on a relation (I-R2, I-R3)", () => {
  const suggested = (n: number) => row(n, { state: "suggested", band: "suggest" });

  it("removes a removed relation from its list and takes it out of the total once", () => {
    const page = pageWith({ shown: [suggested(60), row(62)], totals: [5, 0, 0] });
    const next = withReviewed(page, fixtureId(60), "removed");
    expect(next.relations).toEqual({ items: [row(62)], total: 4 });
    expect(withReviewed(next, fixtureId(60), "removed")).toBe(next);
    const last = withReviewed(
      pageWith({ shown: [row(60)], totals: [1, 0, 0] }),
      fixtureId(60),
      "removed"
    );
    expect(last.relations).toEqual({ items: [], total: 0 });
  });

  it("marks a kept suggestion in place and moves a kept withdrawn relation to the shown list", () => {
    const page = pageWith({
      shown: [suggested(60), row(62)],
      withdrawn: [row(64, { state: "withdrawn", vetoSource: "typer" })],
      totals: [2, 3, 0]
    });
    const keptInPlace = withReviewed(page, fixtureId(60), "kept");
    expect(keptInPlace.relations.items.map((item) => [item.id, item.state])).toEqual([
      [fixtureId(60), "kept"],
      [fixtureId(62), "applied"]
    ]);
    expect(keptInPlace.relations.total).toBe(2);
    const moved = withReviewed(page, fixtureId(64), "kept");
    expect(moved.withdrawn).toEqual({ items: [], total: 2 });
    expect(moved.relations.items.at(-1)).toMatchObject({
      id: fixtureId(64),
      state: "kept",
      vetoSource: null
    });
    expect(moved.relations.total).toBe(3);
  });

  it("leaves a page without the relation as it is, and an earlier-version list too", () => {
    const page = pageWith({ shown: [row(60)] });
    expect(withReviewed(page, fixtureId(99), "kept")).toBe(page);
    const earlier = pageWith({ earlier: [row(66)] });
    expect(withReviewed(earlier, fixtureId(66), "removed").earlierVersions.total).toBe(0);
  });
});

describe("a relation the writer withdrew (T59, T60)", () => {
  it("moves out of the shown list into the withdrawn one when its card closes", () => {
    const page = pageWith({ shown: [row(60), row(62)], totals: [5, 0, 0] });
    const next = withWithdrawn(page, new Set([fixtureId(60)]));
    expect(next.relations).toEqual({ items: [row(62)], total: 4 });
    expect(next.withdrawn.total).toBe(1);
    expect(next.withdrawn.items[0]).toMatchObject({
      id: fixtureId(60),
      state: "withdrawn",
      vetoSource: "explainer"
    });
    // Applied again it changes nothing: the row is gone, so nothing is counted twice.
    expect(withWithdrawn(next, new Set([fixtureId(60)]))).toBe(next);
  });

  it("counts the withdrawn row without listing it when the list was not fully loaded", () => {
    const page = pageWith({
      shown: [row(60)],
      withdrawn: [row(70, { state: "withdrawn" })],
      totals: [1, 25, 0]
    });
    const next = withWithdrawn(page, new Set([fixtureId(60)]));
    expect(next.withdrawn.total).toBe(26);
    expect(next.withdrawn.items).toHaveLength(1);
  });

  it("goes through the page's own rule: the open card keeps its row", () => {
    const load = { status: "ready" as const, page: pageWith({ shown: [row(60), row(62)] }) };
    const withdrawn = new Set([fixtureId(60)]);
    expect(withoutWithdrawn(load, withdrawn, fixtureId(60))).toBe(load);
    const hidden = withoutWithdrawn(load, withdrawn, null);
    expect(hidden.status === "ready" && hidden.page.withdrawn.total).toBe(1);
  });
});

describe("an explanation just written", () => {
  it("is on the relation wherever it is listed, with the model that wrote it", () => {
    const page = pageWith({ shown: [row(60)], withdrawn: [row(62, { state: "withdrawn" })] });
    const next = withWrittenExplanation(page, fixtureId(62), { text: "Why.", writtenBy: "writer" });
    expect(next.withdrawn.items[0]).toMatchObject({
      explanation: { text: "Why.", writtenBy: "writer" },
      explainedBy: { model: "writer", kind: null }
    });
    expect(next.relations).toBe(page.relations);
    expect(withWrittenExplanation(page, fixtureId(99), { text: "x", writtenBy: "w" })).toBe(page);
  });
});
