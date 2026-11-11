import { describe, expect, it } from "vitest";

import {
  AskScopeSchema,
  QuestionAnswerInputSchema,
  QuestionCreateSchema,
  QuestionParagraphSchema,
  questionCitationKinds,
  questionScopeMaxSources
} from "./questions.js";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

describe("question scope", () => {
  it("takes the library, one topic or up to 50 chosen sources", () => {
    expect(AskScopeSchema.parse({ kind: "library" })).toEqual({ kind: "library" });
    expect(AskScopeSchema.parse({ kind: "topic", topicId: id })).toEqual({
      kind: "topic",
      topicId: id
    });
    expect(AskScopeSchema.parse({ kind: "sources", sourceIds: [id, other] }).kind).toBe("sources");
    const many = Array.from({ length: questionScopeMaxSources + 1 }, () => id);
    expect(AskScopeSchema.safeParse({ kind: "sources", sourceIds: many }).success).toBe(false);
    expect(AskScopeSchema.safeParse({ kind: "sources", sourceIds: [] }).success).toBe(false);
  });

  it("refuses a scope that names two things or an unknown kind", () => {
    expect(AskScopeSchema.safeParse({ kind: "topic", topicId: id, sourceIds: [id] }).success).toBe(
      false
    );
    expect(AskScopeSchema.safeParse({ kind: "topic", topicId: "not-a-uuid" }).success).toBe(false);
    expect(AskScopeSchema.safeParse({ kind: "entity", entityId: id }).success).toBe(false);
  });
});

describe("new question", () => {
  it("defaults to the library and plain text mode, and bounds the words", () => {
    const parsed = QuestionCreateSchema.parse({ text: "Why?", privacy: "offline_only" });
    expect(parsed).toMatchObject({ scope: { kind: "library" }, mode: "text", language: "und" });
    expect(QuestionCreateSchema.safeParse({ text: "", privacy: "offline_only" }).success).toBe(
      false
    );
    expect(
      QuestionCreateSchema.safeParse({ text: "x".repeat(2001), privacy: "offline_only" }).success
    ).toBe(false);
    expect(QuestionCreateSchema.safeParse({ text: "ok", privacy: "public" }).success).toBe(false);
  });
});

describe("stored answer", () => {
  const base = {
    paragraphs: [{ markdown: "Naps help.", citations: [1] }],
    citations: [{ ordinal: 1, kind: "note", targetId: id }],
    provenance: { model: "m", extra: "kept" },
    status: "complete",
    startedAt: new Date("2026-11-11T10:00:00Z")
  };

  it("cites notes, sources, topics and passages", () => {
    expect(questionCitationKinds).toEqual(["note", "source", "topic", "chunk"]);
    expect(QuestionAnswerInputSchema.parse(base).provenance).toMatchObject({ extra: "kept" });
  });

  it("refuses a paragraph that cites an ordinal the answer does not store", () => {
    const result = QuestionAnswerInputSchema.safeParse({
      ...base,
      paragraphs: [{ markdown: "Cites two.", citations: [1, 2] }]
    });
    expect(result.success).toBe(false);
  });

  it("refuses a repeated ordinal, an ordinal below 1 and an unknown anchor", () => {
    const twice = { ordinal: 1, kind: "note", targetId: other };
    expect(
      QuestionAnswerInputSchema.safeParse({ ...base, citations: [base.citations[0], twice] })
        .success
    ).toBe(false);
    expect(
      QuestionAnswerInputSchema.safeParse({
        ...base,
        citations: [{ ordinal: 0, kind: "note", targetId: id }]
      }).success
    ).toBe(false);
    expect(
      QuestionAnswerInputSchema.safeParse({
        ...base,
        citations: [{ ordinal: 1, kind: "note", targetId: id, anchor: { paragraph: id } }]
      }).success
    ).toBe(false);
    expect(
      QuestionAnswerInputSchema.safeParse({
        ...base,
        citations: [{ ordinal: 1, kind: "note", targetId: id, anchor: { passage: id } }]
      }).success
    ).toBe(true);
  });

  it("names each citation once per paragraph and never stores a running answer", () => {
    expect(QuestionParagraphSchema.safeParse({ markdown: "a", citations: [1, 1] }).success).toBe(
      false
    );
    expect(QuestionAnswerInputSchema.safeParse({ ...base, status: "running" }).success).toBe(false);
    expect(
      QuestionAnswerInputSchema.safeParse({ ...base, paragraphs: [], citations: [] }).success
    ).toBe(true);
  });
});
