import { describe, expect, it } from "vitest";

import {
  AtomicNoteRelationTypeSchema,
  automaticNoteRelationDirection,
  deciderRelationDirection,
  directedNoteRelationTypes,
  isDirectedNoteRelationType,
  isSymmetricNoteRelationType,
  noteRelationPair,
  NoteRelationReadTypeSchema,
  noteRelationSubject,
  NoteRelationTypingSchema,
  noteRelationWriteTypes,
  NoteRelationWriteTypeSchema,
  symmetricNoteRelationTypes
} from "./knowledge.js";
import { directedRelationTypes } from "./relation-explanation.js";

const lo = "00000000-0000-4000-8000-000000000001";
const hi = "00000000-0000-4000-8000-000000000002";

describe("the relations v2 vocabulary (D10)", () => {
  it("writes seven types, five directed and two symmetric; none is the typer's veto", () => {
    expect(noteRelationWriteTypes).toEqual([
      "supports",
      "contradicts",
      "extends",
      "depends_on",
      "example_of",
      "clarifies",
      "same_as"
    ]);
    expect([...directedNoteRelationTypes, ...symmetricNoteRelationTypes].sort()).toEqual(
      [...noteRelationWriteTypes].sort()
    );
    expect(directedRelationTypes).toBe(directedNoteRelationTypes);
    expect(NoteRelationTypingSchema.parse("none")).toBe("none");
    expect(NoteRelationWriteTypeSchema.safeParse("none").success).toBe(false);
    expect(NoteRelationWriteTypeSchema.safeParse("contrasts").success).toBe(false);
  });

  it("reads the write types and every legacy value, and never maps similar_to to same_as", () => {
    for (const type of [...noteRelationWriteTypes, ...AtomicNoteRelationTypeSchema.options])
      expect(NoteRelationReadTypeSchema.parse(type)).toBe(type);
    expect(NoteRelationReadTypeSchema.options).toHaveLength(11);
    expect(isSymmetricNoteRelationType("similar_to")).toBe(true);
    expect(isSymmetricNoteRelationType("same_as")).toBe(true);
    expect(isSymmetricNoteRelationType("contrasts")).toBe(true);
    expect(isSymmetricNoteRelationType(null)).toBe(true);
    for (const type of ["supports", "mentions", "related", "example_of"])
      expect(isSymmetricNoteRelationType(type)).toBe(false);
  });
});

describe("the stored pair (D8)", () => {
  it("sorts the endpoints and keeps the decided direction of a directed type", () => {
    expect(noteRelationPair(lo, hi, "supports")).toEqual({ lo, hi, direction: "lo_to_hi" });
    expect(noteRelationPair(hi, lo, "supports")).toEqual({ lo, hi, direction: "hi_to_lo" });
    // A legacy type the generative matcher still writes keeps its judged direction.
    expect(noteRelationPair(hi, lo, "related")).toEqual({ lo, hi, direction: "hi_to_lo" });
  });

  it("reads a symmetric or untyped relation both ways", () => {
    for (const type of ["contradicts", "same_as", "contrasts", "similar_to", null])
      expect(noteRelationPair(hi, lo, type)).toEqual({ lo, hi, direction: "symmetric" });
  });

  it("sorts as PostgreSQL does, case-insensitively, and refuses a self pair", () => {
    expect(noteRelationPair(hi.toUpperCase(), lo, "extends")).toEqual({
      lo,
      hi,
      direction: "hi_to_lo"
    });
    expect(() => noteRelationPair(lo, lo.toUpperCase(), "supports")).toThrow("two different");
  });

  it("names the subject of a directed pair only", () => {
    const pair = { sourceAtomicNoteId: lo, targetAtomicNoteId: hi };
    expect(noteRelationSubject({ ...pair, direction: "lo_to_hi" })).toBe(lo);
    expect(noteRelationSubject({ ...pair, direction: "hi_to_lo" })).toBe(hi);
    expect(noteRelationSubject({ ...pair, direction: "symmetric" })).toBeNull();
    expect(noteRelationSubject({ ...pair, direction: "unknown" })).toBeNull();
  });
});

describe("the direction of an automatic relation (plan decision 31b)", () => {
  it("knows which types read in one direction", () => {
    for (const type of directedNoteRelationTypes)
      expect(isDirectedNoteRelationType(type)).toBe(true);
    for (const type of [...symmetricNoteRelationTypes, "related", "contrasts", "mentions", null])
      expect(isDirectedNoteRelationType(type)).toBe(false);
  });

  it("names the Document with the higher score as the subject, only past the margin", () => {
    // `loToHi` is the score with the lower note as the query and the higher note as the Document.
    expect(deciderRelationDirection(2.5, 0.5, 1)).toBe("hi_to_lo");
    expect(deciderRelationDirection(0.5, 2.5, 1)).toBe("lo_to_hi");
    // A difference of exactly the margin names a direction; less does not.
    expect(deciderRelationDirection(1.5, 0.5, 1)).toBe("hi_to_lo");
    expect(deciderRelationDirection(1.4, 0.5, 1)).toBeNull();
    // A tie names none, even at a margin of zero; a non-finite score names none.
    expect(deciderRelationDirection(1, 1, 0)).toBeNull();
    expect(deciderRelationDirection(Infinity, 0, 1)).toBeNull();
    expect(deciderRelationDirection(Number.NaN, 0, 1)).toBeNull();
    // A zero margin takes any difference.
    expect(deciderRelationDirection(0.1, 0, 0)).toBe("hi_to_lo");
  });

  it("stores the typer's guess as a guess, and the decider's direction as the decider's", () => {
    expect(automaticNoteRelationDirection({ relationType: "extends", typed: "lo_to_hi" })).toEqual({
      direction: "lo_to_hi",
      directionSource: "typer"
    });
    expect(
      automaticNoteRelationDirection({ relationType: "extends", typed: "lo_to_hi", decider: null })
    ).toEqual({ direction: "lo_to_hi", directionSource: "typer" });
    // The decider's direction wins over the guess, also when they disagree.
    expect(
      automaticNoteRelationDirection({
        relationType: "supports",
        typed: "lo_to_hi",
        decider: "hi_to_lo"
      })
    ).toEqual({ direction: "hi_to_lo", directionSource: "decider" });
    // A relation that reads both ways has no direction and no source, whatever was guessed.
    expect(
      automaticNoteRelationDirection({
        relationType: "same_as",
        typed: "symmetric",
        decider: "hi_to_lo"
      })
    ).toEqual({ direction: "symmetric", directionSource: null });
    expect(automaticNoteRelationDirection({ relationType: null, typed: "symmetric" })).toEqual({
      direction: "symmetric",
      directionSource: null
    });
  });
});
