import { describe, expect, it, vi } from "vitest";

import {
  buildAtomicNoteGenerationPrompt,
  buildAggregateSummaryPrompt,
  buildBatchRerankPrompt,
  buildKnowledgeGraphPrompt,
  calculateAtomicNoteMatchingProgress,
  calculateRelationScore,
  fuseAtomicNoteCandidateRankings,
  generateAtomicNoteCandidates,
  generateKnowledgeGraphFromAtomicNotes,
  generateSummaryFromChunks,
  hasMinimumSummaryContent,
  limitKnowledgeGraphBatches,
  meetsRelationThreshold,
  normalizeSummaryText,
  parseKnowledgeGraphOutput,
  parseAtomicNoteGenerationOutput,
  parseBatchRerankOutput,
  scoreMetadataOverlap
} from "./knowledge-processing.js";

describe("knowledge processing", () => {
  it("builds and validates one complete atomic-note reranking batch", () => {
    const prompt = buildBatchRerankPrompt(
      { title: "Source", ideaStatement: "Source idea" },
      [
        { alias: "c1", title: "First", ideaStatement: "First idea" },
        { alias: "c2", title: "Second", ideaStatement: "Second idea" }
      ]
    );
    expect(prompt).toContain("source note -> candidate note");
    expect(prompt).toContain("[c1]");
    expect(prompt).not.toContain("explanation");

    const parsed = parseBatchRerankOutput(JSON.stringify({ results: [
      { candidateAlias: "c1", score: 0.9, relationType: "supports" },
      { candidateAlias: "c2", score: 0.2, relationType: "related" }
    ] }), new Set(["c1", "c2"]));
    expect(parsed.get("c1")).toMatchObject({ score: 0.9, relationType: "supports" });
    expect(() => parseBatchRerankOutput(JSON.stringify({ results: [
      { candidateAlias: "c1", score: 0.9, relationType: "supports" }
    ] }), new Set(["c1", "c2"]))).toThrow("atomic_note_rerank_incomplete_batch");
  });

  it("uses graph-only candidates in atomic-note RRF preselection", () => {
    const fused = fuseAtomicNoteCandidateRankings(
      [{ noteId: "text", score: 0.8 }, { noteId: "both", score: 0.7 }],
      [{ noteId: "both", score: 0.9 }],
      [{ noteId: "graph", score: 0.95 }],
      3
    );
    expect(fused.map((candidate) => candidate.noteId)).toContain("graph");
    expect(fused[0]?.noteId).toBe("both");
    expect(fused.find((candidate) => candidate.noteId === "graph")?.graphRank).toBe(1);
  });

  it("reserves space for graph-only discoveries when text and vector fill the limit", () => {
    const common = Array.from({ length: 30 }, (_, index) => ({
      noteId: `common-${index + 1}`,
      score: 1 - index / 100
    }));
    const fused = fuseAtomicNoteCandidateRankings(
      common,
      common,
      Array.from({ length: 5 }, (_, index) => ({ noteId: `graph-${index + 1}`, score: 0.9 - index / 10 })),
      30,
      5
    );
    expect(fused).toHaveLength(30);
    expect(fused.filter((candidate) => candidate.noteId.startsWith("graph-"))).toHaveLength(5);
  });

  it("advances atomic-note matching progress after each reranking candidate", () => {
    expect(calculateAtomicNoteMatchingProgress({
      noteIndex: 0,
      noteCount: 2,
      completedCandidates: 1,
      candidateCount: 4
    })).toBe(0.125);
    expect(calculateAtomicNoteMatchingProgress({
      noteIndex: 0,
      noteCount: 2,
      completedCandidates: 4,
      candidateCount: 4
    })).toBe(0.5);
    expect(calculateAtomicNoteMatchingProgress({
      noteIndex: 1,
      noteCount: 2,
      completedCandidates: 2,
      candidateCount: 2
    })).toBe(1);
  });

  it("unwraps JSON summary responses while preserving plain text", () => {
    expect(normalizeSummaryText('{"summary":"Generated summary"}')).toBe("Generated summary");
    expect(normalizeSummaryText('```json\n{"summary":"Fenced summary"}\n```')).toBe("Fenced summary");
    expect(normalizeSummaryText('```json\n{"resumo":"Resumo em português"}\n```')).toBe("Resumo em português");
    expect(normalizeSummaryText("Plain summary")).toBe("Plain summary");
    expect(normalizeSummaryText("<NO_SUMMARY>")).toBe("");
    expect(normalizeSummaryText('{"summary":"<NO_SUMMARY>"}')).toBe("");
  });

  it("skips summary generation below the substantive word-count heuristic", async () => {
    const run = vi.fn();
    const result = await generateSummaryFromChunks([
      { id: "title", content: "# A short isolated title" }
    ], run);

    expect(hasMinimumSummaryContent(["# A short isolated title"])).toBe(false);
    expect(result).toMatchObject({ summary: "", skippedReason: "too_short" });
    expect(run).not.toHaveBeenCalled();
  });

  it("allows the minimum summary word count to be disabled", async () => {
    const run = vi.fn(async (_prompt: string) => ({
      output: "Short summary.",
      providerId: "test",
      modelId: "mock-model",
      runtime: "remote",
      profileId: "profile-1",
      aiTaskRunId: "run-1"
    }));

    const result = await generateSummaryFromChunks(
      [{ id: "title", content: "Brief but intentional content." }],
      run,
      3_500,
      0
    );

    expect(result?.summary).toBe("Short summary.");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("builds aggregate summaries without requesting an output heading", () => {
    const prompt = buildAggregateSummaryPrompt(
      { kind: "book", title: "Source" },
      [{ title: "Chapter", summary: "Substantive summary." }]
    );

    expect(prompt).toContain('do not output "# Aggregate summary" or "# Resumo agregado"');
    expect(prompt).toContain("[Subpart 1: Chapter]");
    expect(prompt).not.toContain("\n## 1.");
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
      { id: "chunk-1", content: "alpha ".repeat(30) },
      { id: "chunk-2", content: "beta ".repeat(30) }
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
    expect(run.mock.calls[1]?.[0]).toContain("Previous invalid output");
    expect(run.mock.calls[1]?.[0]).toContain('{"entities":[{"key":"e1"');
    expect(run.mock.calls[1]?.[0]).toContain("not valid JSON");
  });

  it("tells the repair model to replace free-text relation endpoints with entity keys", async () => {
    const entity = {
      key: "e1", type: "Concept", canonicalName: "Imantação", aliases: [],
      confidence: 0.9, evidenceChunkIds: ["c1"]
    };
    const invalid = JSON.stringify({
      entities: [entity], claims: [],
      relations: [{
        subjectEntityKey: "e1", predicate: "involves", objectEntityKey: "co-presença",
        confidence: 0.9, evidenceChunkIds: ["c1"]
      }]
    });
    const valid = JSON.stringify({ entities: [entity], claims: [], relations: [] });
    const run = vi.fn()
      .mockResolvedValueOnce({
        output: invalid, providerId: "test", modelId: "mock", runtime: "local",
        profileId: "profile-1", aiTaskRunId: "run-invalid"
      })
      .mockResolvedValueOnce({
        output: valid, providerId: "test", modelId: "mock", runtime: "local",
        profileId: "profile-1", aiTaskRunId: "run-repaired"
      });

    const result = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "pt-BR" },
      [{
        id: "note-1", title: "Imantação", ideaStatement: "Imantação envolve co-presença.",
        bodyMarkdown: "A imantação é uma sintonia progressiva.", evidenceChunkIds: ["chunk-1"]
      }],
      run
    );

    expect(result?.batches[0]?.relations).toEqual([]);
    expect(result?.executions[0]?.aiTaskRunId).toBe("run-repaired");
    expect(run.mock.calls[1]?.[0]).toContain("relations.0: relation references an unknown entity key");
    expect(run.mock.calls[1]?.[0]).toContain("must exactly match an entities[].key");
    expect(run.mock.calls[1]?.[0]).toContain('"objectEntityKey":"co-presença"');
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
    expect(prompt).toContain('only allowed evidence aliases in this batch are: ["c1"]');
    expect(prompt).toContain("must exactly match an entities[].key");
    expect(prompt).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("puts the remaining source extraction limits in the prompt and enforces them", async () => {
    const inputs = [
      { id: "chunk-1", title: "One", ideaStatement: "", bodyMarkdown: "A".repeat(80), evidenceChunkIds: ["chunk-1"] },
      { id: "chunk-2", title: "Two", ideaStatement: "", bodyMarkdown: "B".repeat(80), evidenceChunkIds: ["chunk-2"] }
    ];
    const run = vi.fn(async (_prompt: string) => ({
      output: JSON.stringify({
        entities: [
          { key: "e1", type: "Concept", canonicalName: "Allowed", aliases: [], confidence: 0.9, evidenceChunkIds: ["c1"] },
          { key: "e2", type: "Concept", canonicalName: "Overflow", aliases: [], confidence: 0.8, evidenceChunkIds: ["c1"] }
        ],
        claims: [],
        relations: []
      }),
      providerId: "test", modelId: "mock", runtime: "remote", profileId: "profile-1", aiTaskRunId: "run-1"
    }));

    const generated = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Long source", language: "en" }, inputs, run, 100,
      { inputKind: "source_chunks", extractionLimits: { maxEntities: 1, maxRelations: 2 } }
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain("Source excerpts:");
    expect(run.mock.calls[0]?.[0]).toContain("at most 1 entities");
    expect(run.mock.calls[0]?.[0]).toContain("2 relations");
    expect(generated?.batches.flatMap((batch) => batch.entities).map((entity) => entity.canonicalName)).toEqual(["Allowed"]);
  });

  it("drops relations whose endpoints exceed the entity cap", () => {
    const [limited] = limitKnowledgeGraphBatches([{
      entities: [
        { key: "e1", type: "Concept", canonicalName: "One", aliases: [], confidence: 1, evidenceChunkIds: ["chunk-1"] },
        { key: "e2", type: "Concept", canonicalName: "Two", aliases: [], confidence: 1, evidenceChunkIds: ["chunk-1"] }
      ],
      claims: [],
      relations: [{ subjectEntityKey: "e1", predicate: "links", objectEntityKey: "e2", confidence: 1, evidenceChunkIds: ["chunk-1"] }]
    }], { maxEntities: 1, maxRelations: 10 });

    expect(limited?.entities).toHaveLength(1);
    expect(limited?.relations).toEqual([]);
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
    expect(prompt).toContain('never use "evidenceChunkId"');
    expect(prompt).toContain('"additionalProperties": false');
    expect(prompt).toContain("Do not use Markdown fences");
    expect(prompt).toContain("indexes or tables of contents");
    expect(prompt).toContain('return exactly {"notes":[]}');
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
    expect(run.mock.calls[1]?.[0]).toContain("Validation problems");
    expect(run.mock.calls[1]?.[0]).toContain('"bodyMarkdown"');
    expect(result?.output.notes[0]?.bodyMarkdown).toBe("Evidence-backed body.");
    expect(result?.execution.aiTaskRunId).toBe("run-repaired");
  });

  it("recovers when Gemma repairs corrupted JSON with singular evidenceChunkId", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        output: `{"notes":[{"title":"Canopus","body<image|><|channel>"bodyMarkdown":"Evidence",` +
          `"ideaStatement":"Canopus guides.","evidenceChunkIds":["chunk-1"]}]}`,
        providerId: "local-mlx",
        modelId: "gemma",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-corrupted"
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ notes: [{
          title: "Canopus",
          bodyMarkdown: "Canopus is associated with guidance.",
          ideaStatement: "Canopus guides.",
          language: "pt-BR",
          evidenceChunkId: ["chunk-1"]
        }] }),
        providerId: "local-mlx",
        modelId: "gemma",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-singular-key"
      });

    const result = await generateAtomicNoteCandidates(
      { title: "Sírius e Canopus", language: "pt-BR" },
      [{ id: "chunk-1", content: "Canopus is associated with guidance." }],
      run
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain("not valid JSON");
    expect(run.mock.calls[1]?.[0]).toContain('never use "evidenceChunkId"');
    expect(result?.output.notes[0]?.evidenceChunkIds).toEqual(["chunk-1"]);
    expect(result?.output.notes[0]).not.toHaveProperty("evidenceChunkId");
    expect(result?.execution.aiTaskRunId).toBe("run-singular-key");
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
