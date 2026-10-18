import { describe, expect, it } from "vitest";

import {
  NotePageEvidenceSchema,
  NotePageInputSchema,
  NotePageRelationSchema,
  NotePageSchema,
  NoteRelationsInputSchema,
  RelationReviewInputSchema,
  RelationReviewResultSchema,
  clipCharacters,
  isRealRelationExplanation,
  knownModel,
  noteAuthorship,
  noteRelationCalibration,
  notePageLimits,
  relationBandWord,
  relationExplanation,
  withinCharacters,
  type NotePage,
  type NotePageRelation
} from "./note-page.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-15T10:00:00.000Z";

const relation = (overrides: Partial<NotePageRelation> = {}): NotePageRelation => ({
  id: id(20),
  type: "supports",
  direction: "outgoing",
  directionSource: null,
  state: "applied",
  band: null,
  calibration: null,
  probability: null,
  vetoSource: null,
  decidedBy: { model: "decider", kind: null },
  typedBy: null,
  explainedBy: null,
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
  withdrawn: { items: [], total: 0 },
  earlierVersions: { items: [], total: 0 },
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
    // The main list unless a group is named; an unknown group is refused.
    expect(NoteRelationsInputSchema.parse({ noteId: id(1), offset: 0 }).group).toBe("shown");
    expect(
      NoteRelationsInputSchema.parse({ noteId: id(1), offset: 0, group: "withdrawn" }).group
    ).toBe("withdrawn");
    expect(() =>
      NoteRelationsInputSchema.parse({ noteId: id(1), offset: 0, group: "hidden" })
    ).toThrow();
  });

  it("keeps the calibrated probability in the contract, bounded, and refuses a legacy score", () => {
    expect(NotePageRelationSchema.parse(relation({ probability: 0.8 })).probability).toBe(0.8);
    expect(NotePageRelationSchema.safeParse(relation({ probability: 1.2 })).success).toBe(false);
    expect(NotePageRelationSchema.safeParse({ ...relation(), finalScore: 0.4 }).success).toBe(
      false
    );
  });

  it("describes who decided, typed and explained a relation, and where each ran", () => {
    const parsed = NotePageRelationSchema.parse(
      relation({
        decidedBy: { model: "ranker", kind: "local" },
        typedBy: { model: "typer", kind: "remote" },
        explainedBy: { model: "writer", kind: null }
      })
    );
    expect(parsed.typedBy).toEqual({ model: "typer", kind: "remote" });
    expect(parsed.explainedBy?.kind).toBeNull();
    expect(
      NotePageRelationSchema.safeParse(
        relation({ decidedBy: { model: "m", kind: "cloud" } as never })
      ).success
    ).toBe(false);
    expect(
      NotePageRelationSchema.safeParse(relation({ decidedBy: { model: "", kind: null } })).success
    ).toBe(false);
  });

  it("lists the withdrawn and the earlier-version relations beside the shown ones", () => {
    const withdrawn = relation({ state: "withdrawn", vetoSource: "explainer" });
    const full = page({
      withdrawn: { items: [withdrawn], total: 21 },
      earlierVersions: { items: [], total: 3 }
    });
    expect(NotePageSchema.parse(full).withdrawn.total).toBe(21);
    const missing = { ...page() } as Record<string, unknown>;
    delete missing.withdrawn;
    expect(NotePageSchema.safeParse(missing).success).toBe(false);
    expect(() =>
      NotePageSchema.parse(
        page({ earlierVersions: { items: Array(51).fill(relation()), total: 51 } })
      )
    ).toThrow();
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

describe("excerpt bounds count characters, as SQL cuts them", () => {
  const emoji = "\u{1F600}";
  const withPassage = (excerpt: string): NotePageRelation => {
    const value = relation();
    value.other.passage!.excerpt = excerpt;
    return value;
  };

  it("accepts an excerpt of exactly the bound in code points although it has more UTF-16 units", () => {
    // `left(content, 600)` returns 600 code points: 601 UTF-16 units with one emoji.
    const excerpt = emoji + "a".repeat(notePageLimits.excerptCharacters - 1);
    expect(excerpt.length).toBe(notePageLimits.excerptCharacters + 1);
    expect(NotePageRelationSchema.parse(withPassage(excerpt)).other.passage?.excerpt).toBe(excerpt);
    const allEmoji = emoji.repeat(notePageLimits.excerptCharacters);
    expect(NotePageRelationSchema.safeParse(withPassage(allEmoji)).success).toBe(true);
  });

  it("still refuses an excerpt of more characters than the bound", () => {
    const excerpt = emoji + "a".repeat(notePageLimits.excerptCharacters);
    expect(NotePageRelationSchema.safeParse(withPassage(excerpt)).success).toBe(false);
    expect(
      NotePageRelationSchema.safeParse(
        withPassage(emoji.repeat(notePageLimits.excerptCharacters + 1))
      ).success
    ).toBe(false);
  });

  it("applies the same unit to evidence excerpts and explanations", () => {
    const evidence = {
      chunkId: id(4),
      sourceItemId: id(5),
      documentId: null,
      sourceSpanId: null,
      sourceTitle: "Chapter",
      workTitle: null,
      chunkIndex: 0,
      range: null,
      page: null,
      language: null,
      primary: true,
      current: true,
      sourceAvailable: true
    };
    const bound = notePageLimits.evidenceExcerptCharacters;
    expect(
      NotePageEvidenceSchema.safeParse({ ...evidence, excerpt: emoji.repeat(bound) }).success
    ).toBe(true);
    expect(
      NotePageEvidenceSchema.safeParse({ ...evidence, excerpt: emoji.repeat(bound + 1) }).success
    ).toBe(false);
    const stored = relation({
      explanation: { text: emoji.repeat(notePageLimits.explanationCharacters), writtenBy: "m" }
    });
    expect(NotePageRelationSchema.safeParse(stored).success).toBe(true);
    const empty = relation({ explanation: { text: "", writtenBy: "m" } });
    expect(NotePageRelationSchema.safeParse(empty).success).toBe(false);
  });

  it("counts and clips characters without splitting a surrogate pair", () => {
    expect(withinCharacters(emoji.repeat(3), 3)).toBe(true);
    expect(withinCharacters(emoji.repeat(4), 3)).toBe(false);
    expect(clipCharacters("abc", 5)).toBe("abc");
    expect(clipCharacters(emoji.repeat(4), 3)).toBe(emoji.repeat(3));
    expect(clipCharacters(`ab${emoji}cd`, 3)).toBe(`ab${emoji}`);
  });

  it("lists a note whose home source was deleted, without a source", () => {
    const orphan = relation();
    orphan.other.sourceItemId = null;
    orphan.other.sourceTitle = "";
    expect(NotePageRelationSchema.parse(orphan).other.sourceItemId).toBeNull();
    expect(
      NotePageSchema.parse(page({ relations: { items: [orphan], total: 1 } })).relations.items
    ).toHaveLength(1);
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
    // The clipped text still passes the contract, even when it is made of emoji.
    const emoji = relationExplanation({
      text: "\u{1F600}".repeat(notePageLimits.explanationCharacters + 10),
      decisionSource: "model",
      matchingModel: "m"
    });
    expect(Array.from(emoji!.text)).toHaveLength(notePageLimits.explanationCharacters);
    expect(NotePageRelationSchema.safeParse(relation({ explanation: emoji })).success).toBe(true);
  });

  it("maps a blank model name to unknown", () => {
    expect(knownModel("")).toBeNull();
    expect(knownModel(" ")).toBeNull();
    expect(knownModel(null)).toBeNull();
    expect(knownModel("decider")).toBe("decider");
  });
});

describe("band words (D42)", () => {
  const word = (
    band: "apply" | "suggest" | null,
    calibration: "frozen" | "provisional" | "uncalibrated" | null,
    state?: NotePageRelation["state"]
  ) => relationBandWord({ band, calibration, state });

  it("says strong for the apply band and possible for the suggest band", () => {
    expect(word("apply", "frozen")).toBe("strong");
    expect(word("apply", "provisional")).toBe("strong");
    expect(word("suggest", "frozen")).toBe("possible");
    expect(word("suggest", "provisional", "suggested")).toBe("possible");
    expect(word("apply", null, "applied")).toBe("strong");
  });

  it("says not calibrated for a decider without a calibration, which only suggests", () => {
    expect(word("suggest", "uncalibrated", "suggested")).toBe("uncalibrated");
    expect(word("apply", "uncalibrated")).toBe("uncalibrated");
  });

  it("says nothing for a legacy row, a kept relation or a withdrawn one", () => {
    expect(word(null, null)).toBeNull();
    expect(word(null, null, "applied")).toBeNull();
    expect(word("apply", "frozen", "kept")).toBeNull();
    expect(word("suggest", "uncalibrated", "withdrawn")).toBeNull();
  });

  it("never assumes an apply band exists: a library of suggestions has only two words", () => {
    const words = new Set(
      (["frozen", "provisional", "uncalibrated", null] as const).map((calibration) =>
        word("suggest", calibration, "suggested")
      )
    );
    expect([...words].sort()).toEqual(["possible", "uncalibrated"]);
  });

  it("reads the calibration a row recorded, and none from anything else", () => {
    expect(noteRelationCalibration({ calibration: "frozen" })).toBe("frozen");
    expect(noteRelationCalibration({ calibration: "uncalibrated", score: 1 })).toBe("uncalibrated");
    expect(noteRelationCalibration({ calibration: "other" })).toBeNull();
    expect(noteRelationCalibration({})).toBeNull();
    expect(noteRelationCalibration(null)).toBeNull();
    expect(noteRelationCalibration([])).toBeNull();
    expect(noteRelationCalibration("frozen")).toBeNull();
  });
});

describe("relations.review contract (D15)", () => {
  it("takes a relation and a verdict, nothing else", () => {
    expect(RelationReviewInputSchema.parse({ relationId: id(20), verdict: "keep" })).toEqual({
      relationId: id(20),
      verdict: "keep"
    });
    // A Keep may carry the owner's direction: the subject note, or null for none (decision 31b).
    expect(
      RelationReviewInputSchema.parse({
        relationId: id(20),
        verdict: "keep",
        subjectNoteId: id(21)
      }).subjectNoteId
    ).toBe(id(21));
    expect(
      RelationReviewInputSchema.parse({ relationId: id(20), verdict: "keep", subjectNoteId: null })
        .subjectNoteId
    ).toBeNull();
    expect(
      RelationReviewInputSchema.safeParse({
        relationId: id(20),
        verdict: "keep",
        subjectNoteId: "x"
      }).success
    ).toBe(false);
    expect(
      RelationReviewInputSchema.safeParse({ relationId: id(20), verdict: "maybe" }).success
    ).toBe(false);
    expect(
      RelationReviewInputSchema.safeParse({ relationId: "x", verdict: "remove" }).success
    ).toBe(false);
    expect(
      RelationReviewInputSchema.safeParse({ relationId: id(20), verdict: "keep", note: "x" })
        .success
    ).toBe(false);
  });

  it("answers the verdict that stands and whether this call wrote it", () => {
    expect(
      RelationReviewResultSchema.parse({ relationId: id(20), outcome: "kept", changed: false })
    ).toEqual({ relationId: id(20), outcome: "kept", changed: false });
    expect(
      RelationReviewResultSchema.safeParse({
        relationId: id(20),
        outcome: "rejected",
        changed: true
      }).success
    ).toBe(false);
  });
});
