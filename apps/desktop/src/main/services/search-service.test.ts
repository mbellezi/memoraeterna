import { describe, expect, it } from "vitest";
import type { AtomicNoteSearchRecord, SearchEvidenceRecord } from "@app/db";

import { fuseRankings, fuseSearchRankings } from "./search-service.js";

describe("search ranking fusion", () => {
  it("keeps textual and vector ranks separate and favors candidates present in both lists", () => {
    const shared = candidate("00000000-0000-4000-8000-000000000001", 0.6, 0.8);
    const textOnly = candidate("00000000-0000-4000-8000-000000000002", 0.95, 0);
    const vectorOnly = candidate("00000000-0000-4000-8000-000000000003", 0, 0.98);
    const graphOnly = { ...candidate("00000000-0000-4000-8000-000000000004", 0, 0), graphScore: 0.9 };

    const fused = fuseSearchRankings([textOnly, shared], [vectorOnly, shared], [graphOnly, shared]);

    expect(fused[0]).toMatchObject({
      chunkId: shared.chunkId,
      textRank: 2,
      vectorRank: 2,
      graphRank: 2
    });
    expect(fused[0]?.fusionScore).toBeGreaterThan(fused[1]?.fusionScore ?? 0);
    expect(fused.find((item) => item.chunkId === textOnly.chunkId)).toMatchObject({
      textRank: 1,
      vectorRank: null,
      vectorScore: 0
    });
    expect(fused.find((item) => item.chunkId === vectorOnly.chunkId)).toMatchObject({
      textRank: null,
      vectorRank: 1,
      textScore: 0
    });
    expect(fused.find((item) => item.chunkId === graphOnly.chunkId)).toMatchObject({
      graphRank: 1,
      graphScore: 0.9
    });
  });

  it("fuses atomic-note rankings keyed by note id without a graph signal", () => {
    const shared = noteCandidate("00000000-0000-4000-8000-000000000101", 0.7, 0.85);
    const textOnly = noteCandidate("00000000-0000-4000-8000-000000000102", 0.9, 0);
    const vectorOnly = noteCandidate("00000000-0000-4000-8000-000000000103", 0, 0.95);

    const fused = fuseRankings(
      (candidate) => candidate.noteId,
      [textOnly, shared],
      [vectorOnly, shared]
    );

    expect(fused[0]).toMatchObject({ noteId: shared.noteId, textRank: 2, vectorRank: 2, graphRank: null });
    expect(fused[0]?.fusionScore).toBeGreaterThan(fused[1]?.fusionScore ?? 0);
    expect(fused.find((item) => item.noteId === textOnly.noteId)).toMatchObject({
      textRank: 1,
      vectorRank: null,
      vectorScore: 0
    });
    expect(fused.find((item) => item.noteId === vectorOnly.noteId)).toMatchObject({
      textRank: null,
      vectorRank: 1,
      textScore: 0
    });
    expect(fused.every((item) => item.fusionScore <= 1)).toBe(true);
  });
});

function noteCandidate(noteId: string, textScore: number, vectorScore: number): AtomicNoteSearchRecord {
  return {
    noteId,
    sourceItemId: "00000000-0000-4000-8000-000000000010",
    sourceTitle: "Source",
    sourceType: "PersonalNote",
    title: "Note title",
    ideaStatement: "Idea statement",
    excerpt: "Body markdown",
    status: "approved",
    textScore,
    vectorScore,
    graphScore: 0,
    finalScore: Math.max(textScore, vectorScore)
  };
}

function candidate(chunkId: string, textScore: number, vectorScore: number): SearchEvidenceRecord {
  return {
    sourceItemId: "00000000-0000-4000-8000-000000000010",
    sourceTitle: "Source",
    sourceType: "PersonalNote",
    documentId: "00000000-0000-4000-8000-000000000020",
    chunkId,
    sourceSpanId: null,
    excerpt: "Evidence",
    page: null,
    sourceBlockId: null,
    boundingBox: null,
    selector: null,
    textScore,
    vectorScore,
    graphScore: 0,
    finalScore: Math.max(textScore, vectorScore)
  };
}
