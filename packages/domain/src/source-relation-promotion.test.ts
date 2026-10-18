import { describe, expect, it } from "vitest";

import {
  planPromotedSourceRelations,
  type PromotionNoteRelation
} from "./source-relation-promotion.js";

const titles: Record<string, string> = { R: "Retrieval", X: "Feedback", Y: "Spacing" };
const compareRoots = (a: string, b: string) =>
  titles[a]! < titles[b]! ? -1 : titles[a]! > titles[b]! ? 1 : 0;
let next = 0;
const relation = (
  type: string | null,
  subjectRootId: string,
  objectRootId: string,
  overrides: Partial<PromotionNoteRelation> = {}
): PromotionNoteRelation => ({
  id: `n${++next}`,
  type,
  subjectRootId,
  objectRootId,
  probability: 0.9,
  contentKey: `idea ${next}`,
  directed: true,
  ...overrides
});
const plan = (relations: PromotionNoteRelation[]) =>
  planPromotedSourceRelations({ rootId: "R", relations, compareRoots });

describe("promotion of typed shown note relations (D27, decision 29)", () => {
  it("gives one relation per other root with the majority type and its supporting relations", () => {
    const a = relation("supports", "R", "X", { contentKey: "a" }),
      b = relation("supports", "R", "X", { contentKey: "b" }),
      c = relation("extends", "R", "X");
    expect(plan([a, b, c])).toEqual([
      {
        sourceRootId: "R",
        targetRootId: "X",
        type: "supports",
        symmetric: false,
        noteRelationIds: [a.id, b.id]
      }
    ]);
  });

  it("breaks a type tie by summed probability, then by content order", () => {
    const strong = relation("extends", "R", "X", { probability: 0.99 });
    const weak = relation("supports", "R", "X", { probability: 0.7 });
    expect(plan([weak, strong])[0]!.type).toBe("extends");
    const first = relation("depends_on", "R", "X", { probability: 0.8, contentKey: "a" });
    const second = relation("clarifies", "R", "X", { probability: 0.8, contentKey: "b" });
    expect(plan([second, first])[0]!.type).toBe("depends_on");
  });

  it("reads a directed type in its note direction and keeps both directions with their own majority", () => {
    const forward = [relation("supports", "R", "X"), relation("supports", "R", "X")];
    const backward = relation("supports", "X", "R");
    expect(
      plan([...forward, backward]).map((item) => [item.sourceRootId, item.targetRootId])
    ).toEqual([
      ["R", "X"],
      ["X", "R"]
    ]);
    // The reverse direction reads mostly as another type: only the forward one is promoted.
    const others = [relation("extends", "X", "R"), relation("extends", "X", "R")];
    expect(plan([...forward, backward, ...others])).toEqual([
      expect.objectContaining({ sourceRootId: "R", targetRootId: "X", type: "supports" })
    ]);
  });

  it("keeps the direction holding most of the type when no direction has its own majority", () => {
    // supports leads overall (5), yet extends leads R -> X and depends_on leads X -> R.
    const relations = [
      ...Array.from({ length: 3 }, () => relation("supports", "R", "X")),
      ...Array.from({ length: 4 }, () => relation("extends", "R", "X")),
      ...Array.from({ length: 2 }, () => relation("supports", "X", "R")),
      ...Array.from({ length: 3 }, () => relation("depends_on", "X", "R"))
    ];
    expect(plan(relations)).toEqual([
      expect.objectContaining({ sourceRootId: "R", targetRootId: "X", type: "supports" })
    ]);
  });

  it("orders a symmetric relation's roots by content and counts every supporting relation", () => {
    const relations = [
      relation("same_as", "R", "X", { contentKey: "a" }),
      relation("same_as", "X", "R", { contentKey: "b" })
    ];
    expect(plan(relations)).toEqual([
      {
        sourceRootId: "X",
        targetRootId: "R",
        type: "same_as",
        symmetric: true,
        noteRelationIds: relations.map((item) => item.id)
      }
    ]);
    // The legacy contrasts is promoted as contradicts.
    expect(plan([relation("contrasts", "R", "Y")])[0]!.type).toBe("contradicts");
  });

  it("reads a directed type with no given direction as one relation that reads both ways (decision 31b)", () => {
    const relations = [
      relation("extends", "R", "X", { directed: false, contentKey: "a" }),
      relation("extends", "X", "R", { directed: false, contentKey: "b" })
    ];
    // The roots follow content order (Feedback before Retrieval), whatever the notes' endpoint order.
    expect(plan(relations)).toEqual([
      {
        sourceRootId: "X",
        targetRootId: "R",
        type: "extends",
        symmetric: true,
        noteRelationIds: relations.map((item) => item.id)
      }
    ]);
  });

  it("takes a direction only from the notes that have one, yet counts the linked ones of its type as support", () => {
    const given = relation("extends", "R", "X", { contentKey: "a" });
    const unread = [
      relation("extends", "X", "R", { directed: false, contentKey: "b" }),
      relation("extends", "X", "R", { directed: false, contentKey: "c" })
    ];
    expect(plan([...unread, given])).toEqual([
      {
        sourceRootId: "R",
        targetRootId: "X",
        type: "extends",
        symmetric: false,
        noteRelationIds: [given.id, ...unread.map((item) => item.id)]
      }
    ]);
    // The type still wins by every relation: two undirected ones outvote one directed one of another type.
    const other = relation("supports", "R", "X");
    expect(plan([...unread, other])[0]).toEqual(
      expect.objectContaining({ type: "extends", symmetric: true })
    );
  });

  it("keeps the linked notes' support when one directed note arrives, and the direction choice is the directed notes' alone", () => {
    const linked = Array.from({ length: 3 }, (_, index) =>
      relation("extends", index % 2 ? "R" : "X", index % 2 ? "X" : "R", {
        directed: false,
        contentKey: `l${index}`
      })
    );
    const given = relation("extends", "X", "R", { contentKey: "z" });
    // The three linked notes outvote nothing about the direction: Feedback (X) reads as the subject.
    expect(plan([...linked, given])).toEqual([
      {
        sourceRootId: "X",
        targetRootId: "R",
        type: "extends",
        symmetric: false,
        noteRelationIds: [...linked.map((item) => item.id), given.id]
      }
    ]);
    // Both directions given: each is supported by its own notes and by the linked ones.
    const reverse = relation("extends", "R", "X", { contentKey: "y" });
    const both = plan([...linked, given, reverse]);
    expect(both.map((item) => [item.sourceRootId, item.targetRootId])).toEqual([
      ["R", "X"],
      ["X", "R"]
    ]);
    expect(both.every((item) => item.noteRelationIds.length === 4)).toBe(true);
    // Linked notes of another type add nothing to the winner's support.
    const stray = relation("supports", "R", "X", { directed: false });
    expect(plan([...linked, given, stray])[0]!.noteRelationIds).not.toContain(stray.id);
  });

  it("promotes nothing from untyped, weak or same-root relations, or relations of other roots", () => {
    expect(
      plan([
        relation(null, "R", "X"),
        relation("similar_to", "R", "X"),
        relation("related", "R", "X"),
        relation("supports", "R", "R"),
        relation("supports", "X", "Y")
      ])
    ).toEqual([]);
  });

  it("gives every other root its own relation, in content order of the roots", () => {
    expect(
      plan([relation("supports", "R", "Y"), relation("extends", "X", "R")]).map((item) => item.type)
    ).toEqual(["extends", "supports"]);
  });

  it("is a function of the relations, not of their order", () => {
    const relations = [
      relation("supports", "R", "X"),
      relation("extends", "R", "X"),
      relation("supports", "X", "R"),
      relation("contradicts", "R", "Y")
    ];
    expect(plan(relations.toReversed())).toEqual(plan(relations));
  });
});
