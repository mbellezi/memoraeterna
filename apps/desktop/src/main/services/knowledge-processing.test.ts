import { describe, expect, it, vi } from "vitest";

import {
  calculateRelationScore,
  generateAtomicNoteCandidates,
  generateSummaryFromChunks,
  meetsRelationThreshold,
  parseAtomicNoteGenerationOutput,
  scoreMetadataOverlap
} from "./knowledge-processing.js";

describe("knowledge processing", () => {
  it("uses map-reduce for a source that exceeds the model input budget", async () => {
    const run = vi.fn(async (input: string) => ({
      output: input.includes("partial summaries") ? "Reduced summary" : "Partial summary",
      providerId: "test",
      modelId: "mock-model",
      runtime: "remote",
      profileId: "00000000-0000-4000-8000-000000000001",
      aiTaskRunId: "00000000-0000-4000-8000-000000000002"
    }));
    const result = await generateSummaryFromChunks([
      { id: "chunk-1", content: "A".repeat(80) },
      { id: "chunk-2", content: "B".repeat(80) }
    ], run, 100);

    expect(result).toMatchObject({ summary: "Reduced summary", mapReduce: true });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("parses structured notes and rejects invented evidence ids", () => {
    const output = JSON.stringify({
      notes: [{
        title: "Atomic idea",
        bodyMarkdown: "One idea with evidence.",
        ideaStatement: "Atomic notes stay traceable.",
        evidenceChunkIds: ["chunk-1"]
      }]
    });
    expect(parseAtomicNoteGenerationOutput(output, new Set(["chunk-1"])).notes).toHaveLength(1);
    expect(() => parseAtomicNoteGenerationOutput(output, new Set(["chunk-2"]))).toThrow(
      "atomic_note_unknown_evidence_chunk"
    );
  });

  it("generates structured atomic notes through a mock AI adapter", async () => {
    const result = await generateAtomicNoteCandidates(
      { title: "Source", language: "en" },
      [{ id: "chunk-1", content: "Evidence" }],
      async () => ({
        output: JSON.stringify({ notes: [{
          title: "Atomic idea",
          bodyMarkdown: "Evidence-backed body.",
          ideaStatement: "Evidence supports the note.",
          evidenceChunkIds: ["chunk-1"]
        }] }),
        providerId: "test",
        modelId: "mock-model",
        runtime: "remote",
        profileId: "profile-1",
        aiTaskRunId: "run-1"
      })
    );
    expect(result?.output.notes[0]?.evidenceChunkIds).toEqual(["chunk-1"]);
    expect(result?.execution.modelId).toBe("mock-model");
  });

  it("scores simple entity and metadata overlap", () => {
    expect(scoreMetadataOverlap(
      { entities: ["PostgreSQL", "pgvector"] },
      { entities: ["PostgreSQL"], tags: ["local-first"] }
    )).toBeCloseTo(1 / 3);
    expect(meetsRelationThreshold(0.71, 0.72)).toBe(false);
    expect(meetsRelationThreshold(0.72, 0.72)).toBe(true);
    expect(calculateRelationScore({
      vectorScore: 0.9,
      textScore: 0.6,
      metadataScore: 0.3,
      hasEmbedding: true,
      rerankScore: 0.8
    })).toBeCloseTo(0.752);
  });
});
