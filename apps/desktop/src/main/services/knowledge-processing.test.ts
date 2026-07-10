import { describe, expect, it, vi } from "vitest";

import {
  buildAtomicNoteGenerationPrompt,
  buildKnowledgeGraphPrompt,
  calculateRelationScore,
  generateAtomicNoteCandidates,
  generateKnowledgeGraphFromAtomicNotes,
  generateSummaryFromChunks,
  meetsRelationThreshold,
  normalizeSummaryText,
  parseKnowledgeGraphOutput,
  parseAtomicNoteGenerationOutput,
  scoreMetadataOverlap
} from "./knowledge-processing.js";

describe("knowledge processing", () => {
  it("unwraps JSON summary responses while preserving plain text", () => {
    expect(normalizeSummaryText('{"summary":"Generated summary"}')).toBe("Generated summary");
    expect(normalizeSummaryText('```json\n{"summary":"Fenced summary"}\n```')).toBe("Fenced summary");
    expect(normalizeSummaryText("Plain summary")).toBe("Plain summary");
  });

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

  it("parses graph knowledge with traceable entities, claims, and relations", async () => {
    const output = {
      entities: [
        { key: "postgres", type: "Product", canonicalName: "PostgreSQL", aliases: [], confidence: 0.98, evidenceChunkIds: ["c1"] },
        { key: "vector", type: "Concept", canonicalName: "Vector search", aliases: [], confidence: 0.9, evidenceChunkIds: ["c1"] }
      ],
      claims: [{ text: "PostgreSQL supports vector search.", confidence: 0.9, evidenceChunkIds: ["c1"], relatedEntityKeys: ["postgres", "vector"] }],
      relations: [{ subjectEntityKey: "postgres", predicate: "supports", objectEntityKey: "vector", confidence: 0.88, evidenceChunkIds: ["c1"] }]
    };
    const resolved = {
      ...output,
      entities: output.entities.map((entity) => ({ ...entity, evidenceChunkIds: ["chunk-1"] })),
      claims: output.claims.map((claim) => ({ ...claim, evidenceChunkIds: ["chunk-1"] })),
      relations: output.relations.map((relation) => ({ ...relation, evidenceChunkIds: ["chunk-1"] }))
    };
    expect(parseKnowledgeGraphOutput(JSON.stringify(output), new Map([["c1", "chunk-1"]]))).toEqual(resolved);
    expect(parseKnowledgeGraphOutput(
      `<think>extract carefully</think>\n${JSON.stringify(output)}\nDone.`,
      new Map([["c1", "chunk-1"]])
    )).toEqual(resolved);
    expect(() => parseKnowledgeGraphOutput(JSON.stringify(output), new Map([["c2", "chunk-1"]]))).toThrow(
      "knowledge_graph_unknown_evidence_alias:c1"
    );
    const generated = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "en" },
      [{
        id: "note-1", title: "PostgreSQL", ideaStatement: "PostgreSQL supports vector search.",
        bodyMarkdown: "Vector search is supported.", evidenceChunkIds: ["chunk-1"]
      }],
      async () => ({
        output: JSON.stringify(output), providerId: "test", modelId: "mock", runtime: "remote",
        profileId: "profile-1", aiTaskRunId: "run-1"
      })
    );
    expect(generated?.batches[0]?.relations).toHaveLength(1);
  });

  it("regenerates a compact graph response after truncated JSON", async () => {
    const valid = JSON.stringify({
      entities: [{
        key: "e1", type: "Concept", canonicalName: "Local-first", aliases: [],
        confidence: 0.9, evidenceChunkIds: ["c1"]
      }],
      claims: [],
      relations: []
    });
    const run = vi.fn()
      .mockResolvedValueOnce({
        output: '{"entities":[{"key":"e1"', providerId: "test", modelId: "mock",
        runtime: "local", profileId: "profile-1", aiTaskRunId: "run-invalid"
      })
      .mockResolvedValueOnce({
        output: `<think>retry</think>\n${valid}`, providerId: "test", modelId: "mock",
        runtime: "local", profileId: "profile-1", aiTaskRunId: "run-repaired"
      });
    const result = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "en" },
      [{
        id: "note-1", title: "Local-first", ideaStatement: "Local-first evidence.",
        bodyMarkdown: "Local-first body.", evidenceChunkIds: ["chunk-1"]
      }],
      run
    );
    expect(result?.batches[0]?.entities[0]?.canonicalName).toBe("Local-first");
    expect(result?.executions[0]?.aiTaskRunId).toBe("run-repaired");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns a stable graph error code after two invalid responses", async () => {
    const run = vi.fn().mockResolvedValue({
      output: '{"entities":[', providerId: "test", modelId: "mock", runtime: "local",
      profileId: "profile-1", aiTaskRunId: "run-invalid"
    });
    await expect(generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "en" },
      [{
        id: "note-1", title: "Evidence", ideaStatement: "Evidence.",
        bodyMarkdown: "Body.", evidenceChunkIds: ["chunk-1"]
      }],
      run
    )).rejects.toThrow("knowledge_graph_output_invalid:invalid_json");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses atomic notes and short aliases without exposing source UUIDs to the model", () => {
    const prompt = buildKnowledgeGraphPrompt(
      { title: "Source", language: "en" },
      [{
        id: "note-1", title: "Atomic title", ideaStatement: "Atomic idea",
        bodyMarkdown: "Atomic body", evidenceChunkIds: ["00000000-0000-4000-8000-000000000001"]
      }]
    );
    expect(prompt).toContain("Atomic notes:");
    expect(prompt).toContain("evidence=c1");
    expect(prompt).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("resumes after completed graph batches instead of executing them again", async () => {
    const notes = [
      { id: "note-1", title: "One", ideaStatement: "A".repeat(60), bodyMarkdown: "Body", evidenceChunkIds: ["chunk-1"] },
      { id: "note-2", title: "Two", ideaStatement: "B".repeat(60), bodyMarkdown: "Body", evidenceChunkIds: ["chunk-2"] }
    ];
    const output = (alias: string) => JSON.stringify({
      entities: [{ key: "e1", type: "Concept", canonicalName: "Concept", aliases: [], confidence: 0.9, evidenceChunkIds: [alias] }],
      claims: [], relations: []
    });
    const firstRun = vi.fn()
      .mockResolvedValueOnce({ output: output("c1"), providerId: "test", modelId: "mock", runtime: "remote", profileId: "profile-1", aiTaskRunId: "run-1" })
      .mockResolvedValueOnce({ output: output("c1"), providerId: "test", modelId: "mock", runtime: "remote", profileId: "profile-1", aiTaskRunId: "run-2" });
    const first = await generateKnowledgeGraphFromAtomicNotes({ title: "Source", language: "en" }, notes, firstRun, 70);
    const resumedRun = vi.fn();
    const resumed = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "en" }, notes, resumedRun, 70,
      first ? { completedBatches: first.checkpoints } : {}
    );
    expect(firstRun).toHaveBeenCalledTimes(2);
    expect(resumedRun).not.toHaveBeenCalled();
    expect(resumed?.batches).toHaveLength(2);
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

  it("includes the strict JSON Schema in the atomic-note prompt", () => {
    const prompt = buildAtomicNoteGenerationPrompt(
      { title: "Source", language: "en" },
      [{ id: "chunk-1", content: "Evidence" }]
    );

    expect(prompt).toContain('"bodyMarkdown"');
    expect(prompt).toContain('"additionalProperties": false');
    expect(prompt).toContain("Do not use Markdown fences");
  });

  it("repairs one malformed local-model response and uses the repaired execution", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        output: `\`\`\`json
{"notes":[{"title":"Atomic idea","bodyDescriptor":"Wrong property","ideaStatement":"Evidence supports the note.","evidenceChunkIds":["chunk-1"]}]
\`\`\``,
        providerId: "local-mlx",
        modelId: "mock-model",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-invalid"
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ notes: [{
          title: "Atomic idea",
          bodyMarkdown: "Evidence-backed body.",
          ideaStatement: "Evidence supports the note.",
          language: "en",
          evidenceChunkIds: ["chunk-1"]
        }] }),
        providerId: "local-mlx",
        modelId: "mock-model",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-repaired"
      });

    const result = await generateAtomicNoteCandidates(
      { title: "Source", language: "en" },
      [{ id: "chunk-1", content: "Evidence" }],
      run
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain("Previous invalid output");
    expect(run.mock.calls[1]?.[0]).toContain('"bodyMarkdown"');
    expect(result?.output.notes[0]?.bodyMarkdown).toBe("Evidence-backed body.");
    expect(result?.execution.aiTaskRunId).toBe("run-repaired");
  });

  it("stops after one repair attempt when both outputs are invalid", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        output: "{invalid",
        providerId: "local-mlx",
        modelId: "mock-model",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-invalid-1"
      })
      .mockResolvedValueOnce({
        output: "{still-invalid",
        providerId: "local-mlx",
        modelId: "mock-model",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-invalid-2"
      });

    await expect(generateAtomicNoteCandidates(
      { title: "Source", language: "en" },
      [{ id: "chunk-1", content: "Evidence" }],
      run
    )).rejects.toBeInstanceOf(SyntaxError);
    expect(run).toHaveBeenCalledTimes(2);
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
    expect(calculateRelationScore({
      vectorScore: 0.9,
      textScore: 0.6,
      metadataScore: 0.3,
      graphScore: 0.8,
      hasEmbedding: true,
      rerankScore: 0.8
    })).toBeCloseTo(0.767);
  });
});
