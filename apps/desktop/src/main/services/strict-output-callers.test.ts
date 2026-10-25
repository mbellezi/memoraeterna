import { describe, expect, it, vi } from "vitest";
import { aiCassetteRequestKey, type AiModelDescriptor, type AiTaskRequest } from "@app/ai";
import {
  AtomicNoteGenerationOutputSchema,
  LanguageCodes,
  analyzeStrictJsonSchema,
  grammarSchemaForContract,
  outputSchemaForContract,
  toGrammarJsonSchema,
  type AiOutputContract
} from "@app/domain";

import { routedOutputSchema } from "./ai-service.js";
import {
  ConsultationService,
  consultationOutputContract,
  consultationPrompt,
  parseConsultationAnswer
} from "./consultation-service.js";
import { consultationSnapshot } from "./consultation-fixture.js";
import {
  generateAtomicNoteCandidates,
  type KnowledgeAiExecution,
  type KnowledgeAiRunner
} from "./knowledge-processing.js";
import { sourceJudgeOutputContract } from "./source-relation-processing.js";
import { topicNamingOutputContract } from "./topic-tree/topic-prompts.js";

/**
 * Strict output for the callers gate S saw repairing at schema none (owner, 10-25): the Ask, the
 * source judge (both modes), topic naming and atomic notes state their answer in strict terms, so a
 * remote runtime is sent a strict schema; a local runtime keeps what it was sent before (the
 * contract's own grammar for naming and notes, none for the Ask and the judge); the extraction pin
 * asks notes as recorded; the parsers stay the final validator and read a strict null as absent.
 */

const execution = (output: unknown, runId: string): KnowledgeAiExecution => ({
  output,
  providerId: "openai-codex",
  modelId: "writer",
  runtime: "remote",
  profileId: "profile-1",
  aiTaskRunId: runId
});
const chunks = [
  { id: "chunk-1", content: "Spaced review slows forgetting." },
  { id: "chunk-2", content: "Sleep consolidates memory." }
];
const strictNote = (title: string, language: string | null) => ({
  title,
  bodyMarkdown: `Body of ${title}.`,
  ideaStatement: `${title} holds one idea.`,
  language,
  evidenceChunkIds: ["chunk-1"]
});

/** The notes contract a caller states, read from the runner's first call. */
async function statedNotesContract(pinned: boolean) {
  const run = vi.fn<KnowledgeAiRunner>(async () =>
    execution(JSON.stringify({ notes: [strictNote("Memory", "en")] }), "run-0")
  );
  await generateAtomicNoteCandidates({ title: "Source", language: "en" }, chunks, run, { pinned });
  return { contract: run.mock.calls[0]![1].outputContract!, prompt: run.mock.calls[0]![0] };
}

describe("the strict schema each caller sends a remote runtime", () => {
  it("the Ask: `change` nullable and required, `contextIds` required, no refinement", () => {
    expect(analyzeStrictJsonSchema(consultationOutputContract.strictContract!).issues).toEqual([]);
    expect(outputSchemaForContract(consultationOutputContract)).toEqual({
      name: "consultation_answer",
      strict: true,
      schema: {
        type: "object",
        properties: {
          change: {
            anyOf: [
              {
                type: "object",
                properties: {
                  meaningful: { type: "boolean" },
                  explanation: { maxItems: 6, type: "array", items: { type: "string" } }
                },
                required: ["meaningful", "explanation"],
                additionalProperties: false
              },
              { type: "null" }
            ]
          },
          paragraphs: {
            minItems: 1,
            maxItems: 6,
            type: "array",
            items: {
              type: "object",
              properties: {
                markdown: { type: "string" },
                citations: { minItems: 1, maxItems: 12, type: "array", items: { type: "string" } },
                contextIds: { maxItems: 20, type: "array", items: { type: "string" } }
              },
              required: ["markdown", "citations", "contextIds"],
              additionalProperties: false
            }
          },
          gaps: { maxItems: 8, type: "array", items: { type: "string" } }
        },
        required: ["change", "paragraphs", "gaps"],
        additionalProperties: false
      }
    });
  });

  it("the source judge: an item is a list of seven aliases, scores or chunk lists", () => {
    expect(analyzeStrictJsonSchema(sourceJudgeOutputContract.strictContract!).issues).toEqual([]);
    expect(outputSchemaForContract(sourceJudgeOutputContract)).toEqual({
      name: "source_judge",
      strict: true,
      schema: {
        type: "object",
        properties: {
          relations: {
            type: "array",
            items: {
              minItems: 7,
              maxItems: 7,
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  { type: "integer", minimum: 0, maximum: 100 },
                  { minItems: 1, maxItems: 3, type: "array", items: { type: "string" } }
                ]
              }
            }
          }
        },
        required: ["relations"],
        additionalProperties: false
      }
    });
  });

  it("topic naming: `aliases` required", () => {
    expect(analyzeStrictJsonSchema(topicNamingOutputContract.strictContract!).issues).toEqual([]);
    expect(outputSchemaForContract(topicNamingOutputContract)).toEqual({
      name: "topic_naming",
      strict: true,
      schema: {
        type: "object",
        properties: {
          topics: {
            type: "array",
            items: {
              type: "object",
              properties: {
                alias: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                aliases: { type: "array", items: { type: "string" } },
                language: { type: "string" }
              },
              required: ["alias", "title", "description", "aliases", "language"],
              additionalProperties: false
            }
          }
        },
        required: ["topics"],
        additionalProperties: false
      }
    });
  });

  it("atomic notes: `language` nullable and required on the product path, nothing when pinned", async () => {
    const product = await statedNotesContract(false);
    expect(analyzeStrictJsonSchema(product.contract.strictContract!).issues).toEqual([]);
    expect(outputSchemaForContract(product.contract)).toEqual({
      name: "atomic_notes",
      strict: true,
      schema: {
        type: "object",
        properties: {
          notes: {
            maxItems: 50,
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                bodyMarkdown: { type: "string" },
                ideaStatement: { type: "string" },
                language: {
                  anyOf: [{ type: "string", enum: [...LanguageCodes] }, { type: "null" }]
                },
                evidenceChunkIds: { minItems: 1, type: "array", items: { type: "string" } }
              },
              required: ["title", "bodyMarkdown", "ideaStatement", "language", "evidenceChunkIds"],
              additionalProperties: false
            }
          }
        },
        required: ["notes"],
        additionalProperties: false
      }
    });
    // The extraction pin asks as it was recorded (F3 D5): no schema for a remote runtime.
    const pinned = await statedNotesContract(true);
    expect(outputSchemaForContract(pinned.contract)).toBeNull();
    expect(pinned.prompt).toBe(product.prompt);
  });
});

describe("what a local runtime is sent stays as it was", () => {
  const mlx = {
    outputSchemaFor: (contract: AiOutputContract) => grammarSchemaForContract(contract)
  };

  it("naming and notes keep their contract's own grammar, whatever their strict terms", async () => {
    expect(grammarSchemaForContract(topicNamingOutputContract)).toEqual(
      toGrammarJsonSchema(topicNamingOutputContract.contract, "topic_naming")
    );
    const grammar = toGrammarJsonSchema(AtomicNoteGenerationOutputSchema, "atomic_notes");
    for (const pinned of [false, true])
      expect(
        routedOutputSchema({
          contract: (await statedNotesContract(pinned)).contract,
          taskType: "atomic-note-generation",
          local: true,
          adapter: mlx
        })
      ).toEqual(grammar);
  });

  it("the Ask and the judge send a local runtime no grammar, as before; a remote one their strict schema", () => {
    for (const contract of [consultationOutputContract, sourceJudgeOutputContract]) {
      expect(grammarSchemaForContract(contract)).toBeNull();
      expect(
        routedOutputSchema({ contract, taskType: "reranking", local: true, adapter: mlx })
      ).toBeUndefined();
      expect(
        routedOutputSchema({ contract, taskType: "reranking", local: false, adapter: mlx })
      ).toEqual(outputSchemaForContract(contract));
    }
  });
});

describe("the parsers read a strict answer and stay the final validator", () => {
  const snapshot = consultationSnapshot();

  it("the Ask reads `change: null` as no change and keeps a stated change", () => {
    const paragraph = { markdown: "Practice helps [e1].", citations: ["e1"], contextIds: [] };
    const read = parseConsultationAnswer(
      JSON.stringify({ change: null, paragraphs: [paragraph], gaps: [] }),
      snapshot
    );
    expect(read).toEqual({ paragraphs: [paragraph], gaps: [] });
    expect(read).not.toHaveProperty("change");
    const change = { meaningful: true, explanation: ["A new study."] };
    expect(
      parseConsultationAnswer({ change, paragraphs: [paragraph], gaps: [] }, snapshot).change
    ).toEqual(change);
    // The prompt-level answer reads as before, and the parser still checks what strict cannot say.
    expect(
      parseConsultationAnswer(
        { paragraphs: [{ markdown: "Yes [e1].", citations: ["e1"] }], gaps: [] },
        snapshot
      )
    ).toEqual({
      paragraphs: [{ markdown: "Yes [e1].", citations: ["e1"], contextIds: [] }],
      gaps: []
    });
    expect(() =>
      parseConsultationAnswer(
        { change: null, paragraphs: [{ ...paragraph, citations: ["e1", "e1"] }], gaps: [] },
        snapshot
      )
    ).toThrow();
    expect(() =>
      parseConsultationAnswer(
        { change: null, paragraphs: [paragraph], gaps: [] },
        { ...snapshot, consultationIntent: "investigation" }
      )
    ).toThrow("consultation.errors.invalid");
  });

  it("the Ask states its contract and is answered in one call when the answer is strict", async () => {
    const answer = {
      change: null,
      paragraphs: [{ markdown: "Practice helps [e1].", citations: ["e1"], contextIds: [] }],
      gaps: []
    };
    const runOrganizationTask = vi.fn(async () => ({
      output: JSON.stringify(answer),
      aiTaskRunId: "run-0",
      inputTokens: 10,
      outputTokens: 5,
      costEstimate: 0
    }));
    const service = new ConsultationService({
      getPool: () => null,
      ai: {
        pinOrganizationProfile: vi.fn(),
        runOrganizationTask,
        runConsultationEmbedding: vi.fn(async () => null)
      } as never,
      contentLanguage: async () => "en"
    });
    const question = "Does retrieval practice help?";
    const result = await service.generate(snapshot, question, new AbortController().signal);
    expect(runOrganizationTask).toHaveBeenCalledTimes(1);
    const [, prompt, context] = runOrganizationTask.mock.calls[0] as unknown as [
      unknown,
      string,
      Record<string, unknown>
    ];
    // The prompt is the builder's own, byte for byte; only the contract is new in the context.
    expect(prompt).toBe(consultationPrompt(snapshot, question));
    expect(context.outputContract).toBe(consultationOutputContract);
    expect(context).toMatchObject({ operation: "wiki-consultation", isRepair: false });
    expect(result.answer).toEqual({ paragraphs: answer.paragraphs, gaps: [] });
  });

  it("notes read `language: null` as absent on the product path; the pinned path repairs it, as before", async () => {
    const answers = (...outputs: unknown[]) => {
      const run = vi.fn();
      outputs.forEach((output, index) =>
        run.mockResolvedValueOnce(execution(JSON.stringify(output), `run-${index}`))
      );
      return run;
    };
    const strict = { notes: [strictNote("Memory", null), strictNote("Sleep", "en")] };
    const product = answers(strict);
    const read = await generateAtomicNoteCandidates(
      { title: "S", language: "en" },
      chunks,
      product
    );
    expect(product).toHaveBeenCalledTimes(1);
    expect(read?.output.notes[0]).not.toHaveProperty("language");
    expect(read?.output.notes[1]).toMatchObject({ title: "Sleep", language: "en" });
    const pinned = answers(strict, { notes: [strictNote("Memory", "en")] });
    await generateAtomicNoteCandidates({ title: "S", language: "en" }, chunks, pinned, {
      pinned: true
    });
    expect(pinned).toHaveBeenCalledTimes(2);
    // A language outside the contract is still a note to repair.
    const other = answers({ notes: [strictNote("Memory", "de")] }, { notes: [] });
    await generateAtomicNoteCandidates({ title: "S", language: "en" }, chunks, other);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("naming: every strict answer is one the contract reads, and an empty list of aliases is none", () => {
    const item = { alias: "T1", title: "Memory", description: "Notes on memory.", language: "en" };
    const strict = topicNamingOutputContract.strictContract!;
    for (const aliases of [[], ["Remembering"]]) {
      const answer = { topics: [{ ...item, aliases }] };
      expect(strict.safeParse(answer).success).toBe(true);
      expect(topicNamingOutputContract.contract.safeParse(answer).success).toBe(true);
    }
    // The prompt-level answer that leaves `aliases` out is the contract's, never the strict terms'.
    expect(topicNamingOutputContract.contract.safeParse({ topics: [item] }).success).toBe(true);
    expect(strict.safeParse({ topics: [item] }).success).toBe(false);
  });

  it("the judge: the prompt's own item is strict, and an item strict refuses was never valid", () => {
    const strict = sourceJudgeOutputContract.strictContract!;
    const item = ["s1", "s2", "supports", 90, 85, ["c1"], ["c3"]];
    for (const answer of [{ relations: [item] }, { relations: [] }]) {
      expect(strict.safeParse(answer).success).toBe(true);
      expect(sourceJudgeOutputContract.contract.safeParse(answer).success).toBe(true);
    }
    for (const bad of [
      item.slice(0, 6),
      [...item, "more"],
      ["s1", "s2", "supports", 0.9, 85, ["c1"], ["c3"]],
      ["s1", "s2", "supports", 101, 85, ["c1"], ["c3"]],
      ["s1", "s2", "supports", 90, 85, [], ["c3"]]
    ]) {
      expect(strict.safeParse({ relations: [bad] }).success).toBe(false);
      expect(sourceJudgeOutputContract.contract.safeParse({ relations: [bad] }).success).toBe(
        false
      );
    }
  });
});

describe("recorded cassettes keep serving", () => {
  it("the cassette key ignores each strict schema a request now carries", async () => {
    const descriptor = {
      providerId: "openai-codex",
      modelId: "writer",
      runtime: "remote",
      capabilities: ["structured-output"],
      requirements: {}
    } as unknown as AiModelDescriptor;
    const request = {
      taskType: "structured-output",
      input: "Answer from the evidence.",
      modelId: "writer",
      parameters: { maxTokens: 2048 },
      metadata: { applicationInstruction: "" }
    } as unknown as AiTaskRequest;
    const plain = aiCassetteRequestKey(descriptor, request).key;
    const contracts = [
      consultationOutputContract,
      sourceJudgeOutputContract,
      topicNamingOutputContract,
      (await statedNotesContract(false)).contract
    ];
    for (const contract of contracts)
      expect(
        aiCassetteRequestKey(descriptor, {
          ...request,
          outputSchema: outputSchemaForContract(contract)!
        }).key
      ).toBe(plain);
  });
});
