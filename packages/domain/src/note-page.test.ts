import { describe, expect, it } from "vitest";

import {
  NotePageInputSchema,
  NotePageRelationSchema,
  NotePageSchema,
  NoteRelationsInputSchema,
  isRealRelationExplanation,
  knownModel,
  noteAuthorship,
  notePageLimits,
  relationExplanation,
  type NotePage,
  type NotePageRelation
} from "./note-page.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-15T10:00:00.000Z";

const relation = (overrides: Partial<NotePageRelation> = {}): NotePageRelation => ({
  id: id(20),
  type: "supports",
  direction: "outgoing",
  decidedBy: "decider",
  explanation: null,
  other: {
    id: id(2),
    title: "Other",
    ideaStatement: "Spacing helps recall.",
    language: "en",
    status: "active",
    superseded: false,
    authorship: "ai",
    sourceItemId: id(3),
    sourceTitle: "Book",
    passage: {
      chunkId: id(4),
      sourceSpanId: null,
      chunkIndex: 0,
      excerpt: "Spacing",
      language: null
    }
  },
  ...overrides
});

const page = (overrides: Partial<NotePage> = {}): NotePage => ({
  note: {
    id: id(1),
    title: "Retrieval",
    ideaStatement: "Retrieval strengthens memory.",
    bodyMarkdown: "Retrieval strengthens memory.",
    language: "en",
    status: "active",
    superseded: false,
    ownership: "source",
    humanProtected: false,
    authorship: "ai",
    generationModel: "writer",
    homeSourceId: id(3),
    createdAt: at,
    updatedAt: at,
    reviewedAt: null,
    lastEditedAt: null
  },
  successors: [],
  evidence: { items: [], total: 0 },
  placement: {
    object: { kind: "note", id: id(1), title: "Retrieval" },
    primaryPath: [{ kind: "note", id: id(1), title: "Retrieval" }],
    alsoIn: [],
    citedBy: [],
    counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
  },
  relations: { items: [relation()], total: 1 },
  ...overrides
});

describe("notes.page contract", () => {
  it("bounds the inputs and defaults the relation page", () => {
    expect(NotePageInputSchema.parse({ noteId: id(1) })).toEqual({
      noteId: id(1),
      relationLimit: notePageLimits.relationPage
    });
    expect(() => NotePageInputSchema.parse({ noteId: "not-an-id" })).toThrow();
    expect(() =>
      NotePageInputSchema.parse({
        noteId: id(1),
        relationLimit: notePageLimits.relationPageMax + 1
      })
    ).toThrow();
    expect(() => NotePageInputSchema.parse({ noteId: id(1), extra: true })).toThrow();
    expect(NoteRelationsInputSchema.parse({ noteId: id(1), offset: 40 }).limit).toBe(20);
    expect(() => NoteRelationsInputSchema.parse({ noteId: id(1), offset: -1 })).toThrow();
  });

  it("parses a page and refuses unknown keys anywhere", () => {
    expect(NotePageSchema.parse(page())).toEqual(page());
    expect(() => NotePageSchema.parse({ ...page(), score: 1 })).toThrow();
    const withScore = { ...relation(), finalScore: 0.9 };
    expect(() => NotePageRelationSchema.parse(withScore)).toThrow();
    const leaking = page();
    (leaking.note as Record<string, unknown>).metadata = {};
    expect(() => NotePageSchema.parse(leaking)).toThrow();
  });

  it("accepts relation types later phases add and caps the lists", () => {
    for (const type of ["contradicts", "example_of", "same_as"])
      expect(NotePageRelationSchema.parse(relation({ type })).type).toBe(type);
    expect(() =>
      NotePageSchema.parse(
        page({
          relations: {
            items: Array(notePageLimits.relationPageMax + 1).fill(relation()),
            total: 51
          }
        })
      )
    ).toThrow();
    const long = relation();
    long.other.passage!.excerpt = "x".repeat(notePageLimits.excerptCharacters + 1);
    expect(() => NotePageRelationSchema.parse(long)).toThrow();
  });
});

describe("note authorship", () => {
  it("prefers an edit over an evolution, else the AI", () => {
    expect(noteAuthorship({ edited: true, evolution: true })).toBe("edited");
    expect(noteAuthorship({ edited: false, evolution: true })).toBe("evolution");
    expect(noteAuthorship({ edited: false, evolution: false })).toBe("ai");
  });
});

describe("relation explanation", () => {
  it("treats blanks and message keys as no explanation", () => {
    for (const text of [null, undefined, "", "   ", "knowledge.relations.explanations.hybrid"])
      expect(
        relationExplanation({ text, decisionSource: "model", matchingModel: "decider" })
      ).toBeNull();
    expect(isRealRelationExplanation("knowledge.relations.explanations.reranked")).toBe(false);
    expect(isRealRelationExplanation("Both describe recall.")).toBe(true);
  });

  it("names the writer only for a decision the model took in that call", () => {
    expect(
      relationExplanation({
        text: "Both describe recall.",
        decisionSource: "model",
        matchingModel: "m"
      })
    ).toEqual({ text: "Both describe recall.", writtenBy: "m" });
    expect(
      relationExplanation({
        text: "Both describe recall.",
        decisionSource: "cache",
        matchingModel: "m"
      })
    ).toEqual({ text: "Both describe recall.", writtenBy: null });
    expect(
      relationExplanation({
        text: "Both describe recall.",
        decisionSource: "model",
        matchingModel: ""
      })
    ).toEqual({ text: "Both describe recall.", writtenBy: null });
  });

  it("clips long stored text instead of failing the page", () => {
    const text = "a".repeat(notePageLimits.explanationCharacters + 10);
    expect(
      relationExplanation({ text, decisionSource: "model", matchingModel: "m" })?.text
    ).toHaveLength(notePageLimits.explanationCharacters);
  });

  it("maps a blank model name to unknown", () => {
    expect(knownModel("")).toBeNull();
    expect(knownModel(" ")).toBeNull();
    expect(knownModel(null)).toBeNull();
    expect(knownModel("decider")).toBe("decider");
  });
});
