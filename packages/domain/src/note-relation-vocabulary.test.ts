import { describe, expect, it } from "vitest";

import {
  AtomicNoteRelationTypeSchema,
  directedNoteRelationTypes,
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
