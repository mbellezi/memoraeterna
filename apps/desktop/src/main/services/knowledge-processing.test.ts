import { describe, expect, it, vi } from "vitest";
import { defaultAtomicNoteMatchingSettings } from "@app/domain";

import {
  knowledgeGraphPromptVersion,
  buildKnowledgeGraphRepairPrompt,
  summaryConcepts,
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
  parseKnowledgeGraphBatchCheckpoints,
  parseKnowledgeGraphOutput,
  parseAtomicNoteGenerationOutput,
  mergeBatchRerankRepair,
  parseBatchRerankOutput,
  qualifiesAtomicNoteRelation,
  resolveAtomicNoteReferences,
  scoreMetadataOverlap
} from "./knowledge-processing.js";

describe("knowledge processing", () => {
  it("resolves only the evaluated note pair in prose references", () => {
    const source = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(
      resolveAtomicNoteReferences("c12 supports s1; s1 needs that evidence.", source, "c12", target)
    ).toBe(
      `<note-ref id="${target}" /> supports <note-ref id="${source}" />; <note-ref id="${source}" /> needs that evidence.`
    );
    expect(resolveAtomicNoteReferences("Independent prose.", source, "c12", target)).toBe(
      "Independent prose."
    );
    for (const text of ["c1 supports s1", "s2 supports c12", '<note-ref id="invented" />']) {
      expect(() => resolveAtomicNoteReferences(text, source, "c12", target)).toThrow(
        "atomic_note_rerank_invalid_reference"
      );
    }
  });
  it("resolves summary concept aliases to source chunks and drops unsupported evidence", () => {
    expect(
      summaryConcepts(
        {
          summary: "Summary",
          concepts: [
            { idea: "Concept with scope", evidenceChunkIds: ["c2"] },
            { idea: "Invented evidence", evidenceChunkIds: ["unknown"] }
          ]
        },
        [{ id: "one" }, { id: "two" }]
      )
    ).toEqual([{ idea: "Concept with scope", evidenceChunkIds: ["two"] }]);
    expect(summaryConcepts("Legacy summary", [{ id: "one" }])).toEqual([]);
  });
  it("builds the decide-only prompt and keeps every valid item of a partial batch", () => {
    const prompt = buildBatchRerankPrompt({ title: "Source", ideaStatement: "Source idea" }, [
      { alias: 1, title: "First", ideaStatement: "First idea" },
      { alias: 2, title: "Second", ideaStatement: "Second idea" }
    ]);
    expect(prompt).toContain("source note -> candidate note");
    expect(prompt).toContain("[1]\nTitle: First\nMain idea: First idea");
    expect(prompt).toContain("[2]\nTitle: Second");
    expect(prompt).toContain("Source note: Source\nSource idea");
    expect(prompt).toContain('{"results":[[1,0,"related"],[2,85,"extends"]]}');
    expect(prompt).toContain("The score is an integer from 0 to 100");
    expect(prompt).toContain("Write no explanations or other text");
    // No member of the contract holds prose, and nothing asks for any.
    expect(prompt).not.toContain("candidateAlias");
    expect(prompt).not.toContain("explanation:");
    expect(prompt).not.toContain("Add explanation");
    expect(prompt).not.toMatch(/%[a-z_]+%/);

    const parsed = parseBatchRerankOutput(
      JSON.stringify({
        results: [
          [1, 90, "supports"],
          [2, 20, "related"]
        ]
      }),
      [1, 2, 3]
    );
    expect(parsed.decisions.get(1)).toEqual({ alias: 1, score: 0.9, relationType: "supports" });
    expect(parsed.decisions.get(2)).toEqual({ alias: 2, score: 0.2, relationType: "related" });
    expect(parsed.retry).toEqual([3]);
  });

  it("stores the integer score as hundredths, exactly at the calibration thresholds", () => {
    // Every integer score 0-100 maps to the same number as its two-decimal spelling.
    for (const score of Array.from({ length: 101 }, (_, index) => index)) {
      const single = parseBatchRerankOutput({ results: [[1, score, "supports"]] }, [1]);
      expect(single.decisions.get(1)?.score).toBe(Number((score / 100).toFixed(2)));
    }
    const aliases = Array.from({ length: 100 }, (_, index) => index + 1);
    const parsed = parseBatchRerankOutput(
      { results: aliases.map((alias) => [alias, alias - 1, "supports"]) },
      aliases
    );
    expect(parsed.retry).toEqual([]);
    // 65 meets a 0.65 decider minimum exactly; 64 does not.
    expect(parsed.decisions.get(66)?.score).toBe(0.65);
    const accepts = (score: number) =>
      qualifiesAtomicNoteRelation({
        finalScore: 0.9,
        threshold: 0.6,
        rerankScore: score,
        relationType: "supports",
        settings: { ...defaultAtomicNoteMatchingSettings, minRerankScore: 0.65 }
      });
    expect(accepts(parsed.decisions.get(66)!.score)).toBe(true);
    expect(accepts(parsed.decisions.get(65)!.score)).toBe(false);
  });

  it("asks again only for missing, malformed, duplicated or unknown-shaped items", () => {
    const parsed = parseBatchRerankOutput(
      {
        results: [
          [4, 10, "related"],
          // A decimal or out-of-range score is malformed.
          [1, 0.9, "supports"],
          [6, 101, "supports"],
          [7, -1, "related"],
          // A number answered twice is ambiguous: neither answer is trusted.
          [2, 10, "related"],
          [2, 30, "related"],
          [3, 10, "unknown_type"],
          // Prose is not part of the contract, not even as an extra member.
          [8, 90, "supports", "Because 8 supports the source."],
          // Short items, the keyed v8 shape and string numbers do not identify a valid answer.
          [9, 90],
          { candidateAlias: "c10", score: 0.9, relationType: "supports" },
          ["11", 90, "supports"],
          // A number that was not asked is ignored.
          [99, 90, "supports"],
          "not an item"
        ]
      },
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    );
    expect([...parsed.decisions.keys()]).toEqual([4]);
    expect(parsed.decisions.get(4)).toEqual({ alias: 4, score: 0.1, relationType: "related" });
    expect(parsed.retry).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11]);
    for (const output of ["not json", { items: [] }, { results: "none" }, null])
      expect(parseBatchRerankOutput(output, [1, 2])).toEqual({
        decisions: new Map(),
        retry: [1, 2]
      });
    // A fenced or prefixed JSON answer is still read.
    expect(
      parseBatchRerankOutput('```json\n{"results":[[1,70,"extends"]]}\n```', [1]).decisions.get(1)
    ).toEqual({ alias: 1, score: 0.7, relationType: "extends" });
  });

  it("completes the first answer with one repair of only the numbers asked again", () => {
    const initial = parseBatchRerankOutput(
      {
        results: [
          [1, 10, "related"],
          [2, 0.9, "extends"]
        ]
      },
      [1, 2, 3]
    );
    expect(initial.retry).toEqual([2, 3]);
    const repaired = parseBatchRerankOutput(
      {
        results: [
          // An answer for a number that was already decided is not asked for and is ignored.
          [1, 90, "supports"],
          [2, 80, "extends"],
          [3, 30, "related"]
        ]
      },
      initial.retry
    );
    expect(repaired.retry).toEqual([]);
    const merged = mergeBatchRerankRepair(initial, repaired);
    expect([...merged.keys()].sort()).toEqual([1, 2, 3]);
    expect(merged.get(1)).toMatchObject({ score: 0.1, relationType: "related" });
    expect(merged.get(2)).toEqual({ alias: 2, score: 0.8, relationType: "extends" });
    expect(merged.get(3)).toMatchObject({ score: 0.3 });
  });

  it("uses graph-only candidates in atomic-note RRF preselection", () => {
    const fused = fuseAtomicNoteCandidateRankings(
      [
        { noteId: "text", score: 0.8 },
        { noteId: "both", score: 0.7 }
      ],
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
      Array.from({ length: 5 }, (_, index) => ({
        noteId: `graph-${index + 1}`,
        score: 0.9 - index / 10
      })),
      30,
      5
    );
    expect(fused).toHaveLength(30);
    expect(fused.filter((candidate) => candidate.noteId.startsWith("graph-"))).toHaveLength(5);
  });

  it("advances atomic-note matching progress after each reranking candidate", () => {
    expect(
      calculateAtomicNoteMatchingProgress({
        noteIndex: 0,
        noteCount: 2,
        completedCandidates: 1,
        candidateCount: 4
      })
    ).toBe(0.125);
    expect(
      calculateAtomicNoteMatchingProgress({
        noteIndex: 0,
        noteCount: 2,
        completedCandidates: 4,
        candidateCount: 4
      })
    ).toBe(0.5);
    expect(
      calculateAtomicNoteMatchingProgress({
        noteIndex: 1,
        noteCount: 2,
        completedCandidates: 2,
        candidateCount: 2
      })
    ).toBe(1);
  });

  it("unwraps JSON summary responses while preserving plain text", () => {
    expect(normalizeSummaryText('{"summary":"Generated summary"}')).toBe("Generated summary");
    expect(normalizeSummaryText('```json\n{"summary":"Fenced summary"}\n```')).toBe(
      "Fenced summary"
    );
    expect(normalizeSummaryText('```json\n{"resumo":"Resumo em português"}\n```')).toBe(
      "Resumo em português"
    );
    expect(normalizeSummaryText("Plain summary")).toBe("Plain summary");
    expect(normalizeSummaryText("<NO_SUMMARY>")).toBe("");
    expect(normalizeSummaryText('{"summary":"<NO_SUMMARY>"}')).toBe("");
  });

  it("skips summary generation below the substantive word-count heuristic", async () => {
    const run = vi.fn();
    const result = await generateSummaryFromChunks(
      [{ id: "title", content: "# A short isolated title" }],
      run
    );

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
    const prompt = buildAggregateSummaryPrompt({ kind: "book", title: "Source" }, [
      { title: "Chapter", summary: "Substantive summary." }
    ]);

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
    const result = await generateSummaryFromChunks(
      [
        { id: "chunk-1", content: "alpha ".repeat(30) },
        { id: "chunk-2", content: "beta ".repeat(30) }
      ],
      run,
      100
    );

    expect(result).toMatchObject({ summary: "Reduced summary", mapReduce: true });
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        operation: "summary_map",
        batchIndex: 0,
        attempt: 0,
        chunkIds: ["chunk-1"]
      })
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ operation: "summary_map", batchIndex: 1, chunkIds: ["chunk-2"] })
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      expect.objectContaining({ operation: "summary_reduce", chunkIds: ["chunk-1", "chunk-2"] })
    );
  });

  it("parses graph knowledge with traceable entities and relations", async () => {
    const output = {
      entities: [
        {
          key: "postgres",
          type: "Product",
          canonicalName: "PostgreSQL",
          identityDescription: "A concept defined in the supplied evidence.",
          aliases: [],
          confidence: 0.98,
          evidenceChunkIds: ["c1"]
        },
        {
          key: "vector",
          type: "Concept",
          canonicalName: "Vector search",
          identityDescription: "A concept defined in the supplied evidence.",
          aliases: [],
          confidence: 0.9,
          evidenceChunkIds: ["c1"]
        }
      ],
      relations: [
        {
          subjectEntityKey: "postgres",
          predicate: "supports",
          displayLabel: "supports",
          definition: "The subject supports the object.",
          objectEntityKey: "vector",
          confidence: 0.88,
          evidenceChunkIds: ["c1"]
        }
      ]
    };
    const resolved = {
      ...output,
      entities: output.entities.map((entity) => ({ ...entity, evidenceChunkIds: ["chunk-1"] })),
      relations: output.relations.map((relation) => ({
        ...relation,
        evidenceChunkIds: ["chunk-1"]
      }))
    };
    expect(parseKnowledgeGraphOutput(JSON.stringify(output), new Map([["c1", "chunk-1"]]))).toEqual(
      resolved
    );
    expect(
      parseKnowledgeGraphOutput(
        `<think>extract carefully</think>\n${JSON.stringify(output)}\nDone.`,
        new Map([["c1", "chunk-1"]])
      )
    ).toEqual(resolved);
    expect(() =>
      parseKnowledgeGraphOutput(JSON.stringify(output), new Map([["c2", "chunk-1"]]))
    ).toThrow("knowledge_graph_unknown_evidence_alias:c1");
    const generated = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "en" },
      [
        {
          id: "note-1",
          title: "PostgreSQL",
          ideaStatement: "PostgreSQL supports vector search.",
          bodyMarkdown: "Vector search is supported.",
          evidenceChunkIds: ["chunk-1"]
        }
      ],
      async () => ({
        output: JSON.stringify(output),
        providerId: "test",
        modelId: "mock",
        runtime: "remote",
        profileId: "profile-1",
        aiTaskRunId: "run-1"
      })
    );
    expect(generated?.batches[0]?.relations).toHaveLength(1);
  });

  describe("knowledge graph without claims", () => {
    const entity = (key: string) => ({
      key,
      type: "Concept",
      canonicalName: key,
      identityDescription: "A concept defined in the supplied evidence.",
      aliases: [],
      confidence: 0.9,
      evidenceChunkIds: ["c1"]
    });
    const relation = {
      subjectEntityKey: "a",
      predicate: "supports",
      displayLabel: "supports",
      definition: "The subject supports the object.",
      objectEntityKey: "b",
      confidence: 0.8,
      evidenceChunkIds: ["c1"]
    };
    const aliases = new Map([["c1", "chunk-1"]]);

    it("asks for entities and relations only, in every prompt and contract", () => {
      expect(knowledgeGraphPromptVersion).toBe("knowledge-graph-v8");
      const notes = [
        {
          id: "n",
          title: "Note",
          ideaStatement: "Idea",
          bodyMarkdown: "Body",
          evidenceChunkIds: ["chunk-1"]
        }
      ];
      const source = { title: "Source", language: "en" };
      for (const kind of ["atomic_notes", "source_chunks", "catalog_metadata"] as const) {
        const prompts = [
          buildKnowledgeGraphPrompt(source, notes, aliases, kind),
          buildKnowledgeGraphRepairPrompt(source, notes, aliases, "{", new Error("x"), kind)
        ];
        for (const prompt of prompts) {
          expect(prompt).not.toMatch(/claim/i);
          expect(prompt).not.toContain("relatedEntityKeys");
          expect(prompt).toContain('"entities"');
          expect(prompt).toContain('"relations"');
        }
      }
    });

    it("accepts a response without claims and ignores claims a model still returns", () => {
      const entities = [entity("a"), entity("b")];
      const expected = {
        entities: entities.map((item) => ({ ...item, evidenceChunkIds: ["chunk-1"] })),
        relations: [{ ...relation, evidenceChunkIds: ["chunk-1"] }]
      };
      const without = parseKnowledgeGraphOutput({ entities, relations: [relation] }, aliases);
      expect(without).toEqual(expected);
      expect(without).not.toHaveProperty("claims");
      // Whatever shape the claims have, whatever they cite, they cannot fail the response.
      for (const claims of [
        [{ text: "A verifiable statement.", confidence: 1, evidenceChunkIds: ["c1"] }],
        [{ text: "Cites an unknown alias.", confidence: 1, evidenceChunkIds: ["c9"] }],
        [{ text: "Unknown entity.", relatedEntityKeys: ["missing"] }],
        "not even a list"
      ]) {
        const parsed = parseKnowledgeGraphOutput(
          JSON.stringify({ entities, claims, relations: [relation] }),
          aliases
        );
        expect(parsed).toEqual(expected);
        expect(parsed).not.toHaveProperty("claims");
      }
    });

    it("still validates the entities and relations around ignored claims", () => {
      expect(() =>
        parseKnowledgeGraphOutput(
          { entities: [entity("a")], claims: [], relations: [relation] },
          aliases
        )
      ).toThrow();
    });

    it("never carries claims into the generated batches or their limits", async () => {
      const output = {
        entities: [entity("a"), entity("b")],
        claims: [{ text: "Ignored.", confidence: 1, evidenceChunkIds: ["c1"] }],
        relations: [relation]
      };
      const generated = await generateKnowledgeGraphFromAtomicNotes(
        { title: "Source", language: "en" },
        [
          {
            id: "n",
            title: "Note",
            ideaStatement: "Idea",
            bodyMarkdown: "Body",
            evidenceChunkIds: ["chunk-1"]
          }
        ],
        async () => ({
          output: JSON.stringify(output),
          providerId: "test",
          modelId: "mock",
          runtime: "remote",
          profileId: "profile-1",
          aiTaskRunId: "run-1"
        }),
        12_000,
        { extractionLimits: { maxEntities: 1, maxRelations: 5 } }
      );
      const batch = generated?.batches[0];
      expect(Object.keys(batch ?? {}).sort()).toEqual(["entities", "relations"]);
      expect(batch?.entities).toHaveLength(1);
      expect(
        JSON.stringify(generated?.checkpoints),
        "checkpoints persist entities and relations only"
      ).not.toContain("claims");
    });

    it("reads a checkpoint saved before claims were dropped", () => {
      const saved = [
        {
          batchKey: "source:abc",
          batch: { entities: [entity("a")], claims: [{ text: "Old." }], relations: [] },
          execution: {
            providerId: "p",
            modelId: "m",
            runtime: "remote",
            profileId: "profile",
            aiTaskRunId: "run"
          }
        }
      ];
      const parsed = parseKnowledgeGraphBatchCheckpoints(saved);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.batch).not.toHaveProperty("claims");
    });
  });

  it("regenerates a compact graph response after truncated JSON", async () => {
    const valid = JSON.stringify({
      entities: [
        {
          key: "e1",
          type: "Concept",
          canonicalName: "Local-first",
          identityDescription: "A concept defined in the supplied evidence.",
          aliases: [],
          confidence: 0.9,
          evidenceChunkIds: ["c1"]
        }
      ],
      claims: [],
      relations: []
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        output: '{"entities":[{"key":"e1"',
        providerId: "test",
        modelId: "mock",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-invalid"
      })
      .mockResolvedValueOnce({
        output: `<think>retry</think>\n${valid}`,
        providerId: "test",
        modelId: "mock",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-repaired"
      });
    const result = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "en" },
      [
        {
          id: "note-1",
          title: "Local-first",
          ideaStatement: "Local-first evidence.",
          bodyMarkdown: "Local-first body.",
          evidenceChunkIds: ["chunk-1"]
        }
      ],
      run
    );
    expect(result?.batches[0]?.entities[0]?.canonicalName).toBe("Local-first");
    expect(result?.executions[0]?.aiTaskRunId).toBe("run-repaired");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain("Previous invalid output");
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      operation: "graph_atomic_notes",
      batchIndex: 0,
      attempt: 0,
      chunkIds: ["chunk-1"]
    });
    expect(run.mock.calls[1]?.[1]).toMatchObject({
      operation: "graph_atomic_notes_repair",
      batchIndex: 0,
      attempt: 1,
      chunkIds: ["chunk-1"]
    });
    expect(run.mock.calls[1]?.[0]).toContain('{"entities":[{"key":"e1"');
    expect(run.mock.calls[1]?.[0]).toContain("not valid JSON");
  });

  it("tells the repair model to replace free-text relation endpoints with entity keys", async () => {
    const entity = {
      key: "e1",
      type: "Concept",
      canonicalName: "Imantação",
      identityDescription: "A concept defined in the supplied evidence.",
      aliases: [],
      confidence: 0.9,
      evidenceChunkIds: ["c1"]
    };
    const invalid = JSON.stringify({
      entities: [entity],
      claims: [],
      relations: [
        {
          subjectEntityKey: "e1",
          predicate: "involves",
          displayLabel: "involves",
          definition: "The subject supports the object.",
          objectEntityKey: "co-presença",
          confidence: 0.9,
          evidenceChunkIds: ["c1"]
        }
      ]
    });
    const valid = JSON.stringify({ entities: [entity], claims: [], relations: [] });
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        output: invalid,
        providerId: "test",
        modelId: "mock",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-invalid"
      })
      .mockResolvedValueOnce({
        output: valid,
        providerId: "test",
        modelId: "mock",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-repaired"
      });

    const result = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "pt-BR" },
      [
        {
          id: "note-1",
          title: "Imantação",
          ideaStatement: "Imantação envolve co-presença.",
          bodyMarkdown: "A imantação é uma sintonia progressiva.",
          evidenceChunkIds: ["chunk-1"]
        }
      ],
      run
    );

    expect(result?.batches[0]?.relations).toEqual([]);
    expect(result?.executions[0]?.aiTaskRunId).toBe("run-repaired");
    expect(run.mock.calls[1]?.[0]).toContain(
      "relations.0: relation references an unknown entity key"
    );
    expect(run.mock.calls[1]?.[0]).toContain("must exactly match an entities[].key");
    expect(run.mock.calls[1]?.[0]).toContain('"objectEntityKey":"co-presença"');
  });

  it("returns a stable graph error code after two invalid responses", async () => {
    const run = vi.fn().mockResolvedValue({
      output: '{"entities":[',
      providerId: "test",
      modelId: "mock",
      runtime: "local",
      profileId: "profile-1",
      aiTaskRunId: "run-invalid"
    });
    await expect(
      generateKnowledgeGraphFromAtomicNotes(
        { title: "Source", language: "en" },
        [
          {
            id: "note-1",
            title: "Evidence",
            ideaStatement: "Evidence.",
            bodyMarkdown: "Body.",
            evidenceChunkIds: ["chunk-1"]
          }
        ],
        run
      )
    ).rejects.toThrow("knowledge_graph_output_invalid:invalid_json");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses atomic notes and short aliases without exposing source UUIDs to the model", () => {
    const prompt = buildKnowledgeGraphPrompt({ title: "Source", language: "en" }, [
      {
        id: "note-1",
        title: "Atomic title",
        ideaStatement: "Atomic idea",
        bodyMarkdown: "Atomic body",
        evidenceChunkIds: ["00000000-0000-4000-8000-000000000001"]
      }
    ]);
    expect(prompt).toContain("Atomic notes:");
    expect(prompt).toContain("evidence=c1");
    expect(prompt).toContain('only allowed evidence aliases in this batch are: ["c1"]');
    expect(prompt).toContain("must exactly match an entities[].key");
    expect(prompt).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("puts the remaining source extraction limits in the prompt and enforces them", async () => {
    const inputs = [
      {
        id: "chunk-1",
        title: "One",
        ideaStatement: "",
        bodyMarkdown: "A".repeat(80),
        evidenceChunkIds: ["chunk-1"]
      },
      {
        id: "chunk-2",
        title: "Two",
        ideaStatement: "",
        bodyMarkdown: "B".repeat(80),
        evidenceChunkIds: ["chunk-2"]
      }
    ];
    const run = vi.fn(async (_prompt: string) => ({
      output: JSON.stringify({
        entities: [
          {
            key: "e1",
            type: "Concept",
            canonicalName: "Allowed",
            identityDescription: "A concept defined in the supplied evidence.",
            aliases: [],
            confidence: 0.9,
            evidenceChunkIds: ["c1"]
          },
          {
            key: "e2",
            type: "Concept",
            canonicalName: "Overflow",
            identityDescription: "A concept defined in the supplied evidence.",
            aliases: [],
            confidence: 0.8,
            evidenceChunkIds: ["c1"]
          }
        ],
        claims: [],
        relations: []
      }),
      providerId: "test",
      modelId: "mock",
      runtime: "remote",
      profileId: "profile-1",
      aiTaskRunId: "run-1"
    }));

    const generated = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Long source", language: "en" },
      inputs,
      run,
      100,
      { inputKind: "source_chunks", extractionLimits: { maxEntities: 1, maxRelations: 2 } }
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain("Source excerpts:");
    expect(run.mock.calls[0]?.[0]).toContain("at most 1 entities");
    expect(run.mock.calls[0]?.[0]).toContain("2 relations");
    expect(
      generated?.batches.flatMap((batch) => batch.entities).map((entity) => entity.canonicalName)
    ).toEqual(["Allowed"]);
  });

  it("drops relations whose endpoints exceed the entity cap", () => {
    const [limited] = limitKnowledgeGraphBatches(
      [
        {
          entities: [
            {
              key: "e1",
              type: "Concept",
              canonicalName: "One",
              identityDescription: "A concept defined in the supplied evidence.",
              aliases: [],
              confidence: 1,
              evidenceChunkIds: ["chunk-1"]
            },
            {
              key: "e2",
              type: "Concept",
              canonicalName: "Two",
              identityDescription: "A concept defined in the supplied evidence.",
              aliases: [],
              confidence: 1,
              evidenceChunkIds: ["chunk-1"]
            }
          ],
          relations: [
            {
              subjectEntityKey: "e1",
              predicate: "links",
              displayLabel: "links",
              definition: "The subject supports the object.",
              objectEntityKey: "e2",
              confidence: 1,
              evidenceChunkIds: ["chunk-1"]
            }
          ]
        }
      ],
      { maxEntities: 1, maxRelations: 10 }
    );

    expect(limited?.entities).toHaveLength(1);
    expect(limited?.relations).toEqual([]);
  });

  it("resumes after completed graph batches instead of executing them again", async () => {
    const notes = [
      {
        id: "note-1",
        title: "One",
        ideaStatement: "A".repeat(60),
        bodyMarkdown: "Body",
        evidenceChunkIds: ["chunk-1"]
      },
      {
        id: "note-2",
        title: "Two",
        ideaStatement: "B".repeat(60),
        bodyMarkdown: "Body",
        evidenceChunkIds: ["chunk-2"]
      }
    ];
    const output = (alias: string) =>
      JSON.stringify({
        entities: [
          {
            key: "e1",
            type: "Concept",
            canonicalName: "Concept",
            identityDescription: "A concept defined in the supplied evidence.",
            aliases: [],
            confidence: 0.9,
            evidenceChunkIds: [alias]
          }
        ],
        claims: [],
        relations: []
      });
    const firstRun = vi
      .fn()
      .mockResolvedValueOnce({
        output: output("c1"),
        providerId: "test",
        modelId: "mock",
        runtime: "remote",
        profileId: "profile-1",
        aiTaskRunId: "run-1"
      })
      .mockResolvedValueOnce({
        output: output("c1"),
        providerId: "test",
        modelId: "mock",
        runtime: "remote",
        profileId: "profile-1",
        aiTaskRunId: "run-2"
      });
    const first = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "en" },
      notes,
      firstRun,
      70
    );
    const resumedRun = vi.fn();
    const resumed = await generateKnowledgeGraphFromAtomicNotes(
      { title: "Source", language: "en" },
      notes,
      resumedRun,
      70,
      first ? { completedBatches: first.checkpoints } : {}
    );
    expect(firstRun).toHaveBeenCalledTimes(2);
    expect(resumedRun).not.toHaveBeenCalled();
    expect(resumed?.batches).toHaveLength(2);
  });

  it("parses structured notes and rejects invented evidence ids", () => {
    const output = JSON.stringify({
      notes: [
        {
          title: "Atomic idea",
          bodyMarkdown: "One idea with evidence.",
          ideaStatement: "Atomic notes stay traceable.",
          evidenceChunkIds: ["chunk-1"]
        }
      ]
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
        output: JSON.stringify({
          notes: [
            {
              title: "Atomic idea",
              bodyMarkdown: "Evidence-backed body.",
              ideaStatement: "Evidence supports the note.",
              evidenceChunkIds: ["chunk-1"]
            }
          ]
        }),
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
    const prompt = buildAtomicNoteGenerationPrompt({ title: "Source", language: "en" }, [
      { id: "chunk-1", content: "Evidence" }
    ]);

    expect(prompt).toContain('"bodyMarkdown"');
    expect(prompt).toContain('never use "evidenceChunkId"');
    expect(prompt).toContain('"additionalProperties": false');
    expect(prompt).toContain("Do not use Markdown fences");
    expect(prompt).toContain("indexes or tables of contents");
    expect(prompt).toContain('return exactly {"notes":[]}');
  });

  it("repairs one malformed local-model response and uses the repaired execution", async () => {
    const run = vi
      .fn()
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
        output: JSON.stringify({
          notes: [
            {
              title: "Atomic idea",
              bodyMarkdown: "Evidence-backed body.",
              ideaStatement: "Evidence supports the note.",
              language: "en",
              evidenceChunkIds: ["chunk-1"]
            }
          ]
        }),
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
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        output:
          `{"notes":[{"title":"Canopus","body<image|><|channel>"bodyMarkdown":"Evidence",` +
          `"ideaStatement":"Canopus guides.","evidenceChunkIds":["chunk-1"]}]}`,
        providerId: "local-mlx",
        modelId: "gemma",
        runtime: "local",
        profileId: "profile-1",
        aiTaskRunId: "run-corrupted"
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          notes: [
            {
              title: "Canopus",
              bodyMarkdown: "Canopus is associated with guidance.",
              ideaStatement: "Canopus guides.",
              language: "pt-BR",
              evidenceChunkId: ["chunk-1"]
            }
          ]
        }),
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
    const run = vi
      .fn()
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

    await expect(
      generateAtomicNoteCandidates(
        { title: "Source", language: "en" },
        [{ id: "chunk-1", content: "Evidence" }],
        run
      )
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("scores simple entity and metadata overlap", () => {
    expect(
      scoreMetadataOverlap(
        { entities: ["PostgreSQL", "pgvector"] },
        { entities: ["PostgreSQL"], tags: ["local-first"] }
      )
    ).toBeCloseTo(1 / 3);
    expect(meetsRelationThreshold(0.71, 0.72)).toBe(false);
    expect(meetsRelationThreshold(0.72, 0.72)).toBe(true);
    expect(
      calculateRelationScore({
        vectorScore: 0.9,
        textScore: 0.6,
        metadataScore: 0.3,
        hasEmbedding: true,
        rerankScore: 0.8
      })
    ).toBeCloseTo(0.752);
    expect(
      calculateRelationScore({
        vectorScore: 0.9,
        textScore: 0.6,
        metadataScore: 0.3,
        graphScore: 0.8,
        hasEmbedding: true,
        rerankScore: 0.8
      })
    ).toBeCloseTo(0.767);
  });
});

it("requires a display phrase and English identifier syntax for new relations", () => {
  const chunkId = "00000000-0000-4000-8000-000000000001";
  const output = {
    entities: ["e1", "e2"].map((key) => ({
      key,
      type: "Concept",
      canonicalName: key,
      identityDescription: "A concept defined in the supplied evidence.",
      confidence: 0.9,
      evidenceChunkIds: [chunkId]
    })),
    claims: [],
    relations: [
      {
        subjectEntityKey: "e1",
        objectEntityKey: "e2",
        predicate: "used_to_accuse",
        displayLabel: "Foi usado para acusar",
        definition: "The subject was used to accuse the object.",
        confidence: 0.9,
        evidenceChunkIds: [chunkId]
      }
    ]
  };
  expect(parseKnowledgeGraphOutput(output).relations[0]).toMatchObject({
    predicate: "used_to_accuse",
    displayLabel: "Foi usado para acusar",
    definition: "The subject was used to accuse the object."
  });
  expect(() =>
    parseKnowledgeGraphOutput({
      ...output,
      relations: [{ ...output.relations[0], displayLabel: undefined }]
    })
  ).toThrow();
  expect(() =>
    parseKnowledgeGraphOutput({
      ...output,
      relations: [{ ...output.relations[0], predicate: "Foi usado para acusar" }]
    })
  ).toThrow();
  expect(buildKnowledgeGraphPrompt({ title: "Evidence", language: "pt-BR" }, [])).toContain(
    "preserving the full meaning, direction, negation and modality"
  );
});

it("regenerates cached graph batches when the content language changes", async () => {
  const notes = [
    {
      id: "note-1",
      title: "Evidence",
      ideaStatement: "A substantive idea",
      bodyMarkdown: "Some substantive evidence",
      evidenceChunkIds: ["00000000-0000-4000-8000-000000000001"]
    }
  ];
  const run = vi.fn().mockResolvedValue({
    output: { entities: [], claims: [], relations: [] },
    providerId: "test",
    modelId: "test",
    runtime: "remote",
    profileId: "test",
    aiTaskRunId: "test"
  });
  const first = await generateKnowledgeGraphFromAtomicNotes(
    { title: "Evidence", language: "en" },
    notes,
    run,
    12_000,
    { contentLanguage: "en" }
  );
  run.mockClear();
  await generateKnowledgeGraphFromAtomicNotes(
    { title: "Evidence", language: "en" },
    notes,
    run,
    12_000,
    { contentLanguage: "pt-BR", completedBatches: first!.checkpoints }
  );
  expect(run).toHaveBeenCalledOnce();
});

describe("advanced note matching calibration", () => {
  it("normalizes custom weights and applies the configured AI share", async () => {
    const { AtomicNoteMatchingSettingsSchema } = await import("@app/domain");
    const settings = AtomicNoteMatchingSettingsSchema.parse({
      textAndMetadata: { text: 0.2, metadata: 0.2 },
      rerankerWeight: 0.8
    });
    expect(
      calculateRelationScore({
        textScore: 1,
        metadataScore: 0,
        vectorScore: 0,
        hasEmbedding: false,
        settings
      })
    ).toBeCloseTo(0.5);
    expect(
      calculateRelationScore({
        textScore: 1,
        metadataScore: 0,
        vectorScore: 0,
        hasEmbedding: false,
        rerankScore: 1,
        settings
      })
    ).toBeCloseTo(0.9);
  });
  it("never compensates an AI rejection with a high base score", async () => {
    const { AtomicNoteMatchingSettingsSchema } = await import("@app/domain");
    const { qualifiesAtomicNoteRelation } = await import("./knowledge-processing.js");
    const settings = AtomicNoteMatchingSettingsSchema.parse({});
    const input = { finalScore: 0.99, threshold: 0.6, relationType: "supports", settings };
    expect(qualifiesAtomicNoteRelation({ ...input, rerankScore: 0.3 })).toBe(false);
    expect(qualifiesAtomicNoteRelation({ ...input, rerankScore: null })).toBe(false);
    expect(qualifiesAtomicNoteRelation({ ...input, rerankScore: 0.9 })).toBe(true);
    expect(
      qualifiesAtomicNoteRelation({ ...input, rerankScore: 0.9, relationType: "related" })
    ).toBe(false);
    expect(
      qualifiesAtomicNoteRelation({
        ...input,
        rerankScore: 0,
        settings: { ...settings, minRerankScore: 0 }
      })
    ).toBe(false);
  });
  it("supports increased candidate batches and configurable graph reservation", () => {
    const results = Array.from({ length: 45 }, (_, i) => [i + 1, 80, "supports"]);
    expect(
      parseBatchRerankOutput(
        { results },
        results.map((r) => r[0] as number)
      ).decisions.size
    ).toBe(45);
    const ranked = [{ noteId: "text", score: 1 }];
    expect(
      fuseAtomicNoteCandidateRankings(ranked, ranked, [{ noteId: "graph", score: 1 }], 1, 0, 10)[0]
        ?.noteId
    ).toBe("text");
    expect(
      fuseAtomicNoteCandidateRankings(ranked, ranked, [{ noteId: "graph", score: 1 }], 1, 1, 10)[0]
        ?.noteId
    ).toBe("graph");
  });
});

it("defines relation semantics and rejects homonym-only clarification in note reranking", () => {
  const prompt = buildBatchRerankPrompt({ title: "A", ideaStatement: "A" }, []);
  expect(prompt).toContain("Merely distinguishing homonyms or unrelated senses");
  expect(prompt).toContain("must receive score 0.");
  expect(prompt).toContain("incompatible positions on the same question");
});
