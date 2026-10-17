import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicNoteMatchingSettingsSchema } from "@app/domain";
import { KnowledgeService } from "./knowledge-service.js";
import { atomicNoteDecisionContentHash } from "./knowledge-processing.js";
import type { AiService } from "./ai-service.js";
import type { PgPool } from "@app/db";
import type { DecidedNote } from "./relations/relation-matcher.js";

// KnowledgeService.matchAtomicNotes delegates to the relations v2 matcher (F3 T51); the matcher's
// own behaviour is tested in `relations/relation-matcher.test.ts`. These tests cover what the
// service adds: the notes' vectors, the hand-off of accepted pairs (persisted later by the link
// job, F3 D21, T52) and the checkpoints, with the generative decider of a profile with no ranker.
const mocks = vi.hoisted(() => ({
  notes: {
    findById: vi.fn(),
    findTextMatchingCandidates: vi.fn(),
    findVectorMatchingCandidates: vi.fn(),
    scoreMatchingCandidates: vi.fn()
  },
  relations: { pairStatuses: vi.fn(), upsertDecided: vi.fn() },
  decisions: { findVerdicts: vi.fn(), findReverseVerdicts: vi.fn(), record: vi.fn() },
  aiConfig: { getDefaultTask: vi.fn() },
  graph: { findAtomicNoteCandidates: vi.fn() },
  embedding: { upsert: vi.fn(), findCurrentNoteVectors: vi.fn() },
  states: { read: vi.fn(), record: vi.fn() },
  runs: { start: vi.fn(), finish: vi.fn() },
  settings: { get: vi.fn() },
  run: vi.fn()
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAtomicNoteRepository: () => mocks.notes,
  createAtomicNoteRelationRepository: () => mocks.relations,
  createRelationDecisionRepository: () => mocks.decisions,
  createAiConfigRepository: () => mocks.aiConfig,
  createKnowledgeGraphRepository: () => mocks.graph,
  createEmbeddingRepository: () => mocks.embedding,
  createNoteMatchStateRepository: () => mocks.states,
  createRelationMatchRunRepository: () => mocks.runs,
  createSettingsRepository: () => mocks.settings
}));
const note = (id: string) => ({
  id,
  title: id,
  ideaStatement: `Idea ${id}`,
  bodyMarkdown: `Body ${id}`,
  metadata: {},
  createdFromSourceItemId: `source-${id}`,
  status: "pending_review",
  supersessionStatus: "current"
});
const execution = (output: unknown, aiTaskRunId = "run") => ({
  output,
  profileId: "profile",
  modelId: "model",
  providerId: "provider",
  runtime: "remote",
  aiTaskRunId
});
const route = (parameters: Record<string, unknown> = {}) => ({
  profileId: "profile",
  provider: "provider",
  baseUrl: null,
  modelId: "model",
  runtime: "remote",
  repository: null,
  revision: null,
  quantization: null,
  localModelId: null,
  requiredCapabilities: ["text-generation", "structured-output"],
  parameters,
  modelDefaultParameters: {}
});
/** One item of the decide-only contract: the candidate's number, a score 0-100 and the type. */
const result = (alias: number, score: number, relationType: string) => [alias, score, relationType];
function service(settings: unknown = {}) {
  return new KnowledgeService({
    getPool: () => ({}) as PgPool,
    aiService: {
      runDefaultTask: mocks.run,
      rankPairs: vi.fn(),
      decideRouteStatus: vi.fn()
    } as unknown as AiService,
    userDataPath: "/tmp/test",
    getStorageSettings: async () => ({}) as never,
    getUploadedFilesBasePath: async () => null,
    getAtomicNoteMatchingSettings: async () => AtomicNoteMatchingSettingsSchema.parse(settings),
    relationThreshold: 0.6
  });
}
const rerankCalls = () => mocks.run.mock.calls.filter(([task]) => task === "reranking");
const respond = (...outputs: unknown[]) => {
  const queue = [...outputs];
  mocks.run.mockImplementation(async (task) =>
    task === "embedding"
      ? execution(Array.from({ length: 256 }, () => 0.1))
      : execution(queue.shift(), `run-${outputs.length - queue.length}`)
  );
};
const defaultVerdicts = {
  results: [result(1, 10, "supports"), result(2, 70, "supports"), result(3, 95, "extends")]
};
beforeEach(() => {
  vi.resetAllMocks();
  const candidates = ["a", "b", "c"].map((id) => ({
    note: note(id),
    textScore: 1,
    vectorScore: 1,
    hasVector: true
  }));
  mocks.notes.findById.mockImplementation(async (id: string) => note(id));
  mocks.notes.findTextMatchingCandidates.mockResolvedValue(candidates);
  mocks.notes.findVectorMatchingCandidates.mockResolvedValue(candidates);
  mocks.notes.scoreMatchingCandidates.mockResolvedValue(candidates);
  mocks.graph.findAtomicNoteCandidates.mockResolvedValue([]);
  mocks.relations.pairStatuses.mockResolvedValue(new Map());
  mocks.relations.upsertDecided.mockResolvedValue({ change: "created" });
  mocks.decisions.findVerdicts.mockResolvedValue(new Map());
  mocks.decisions.findReverseVerdicts.mockResolvedValue(new Map());
  mocks.embedding.findCurrentNoteVectors.mockResolvedValue(new Map());
  mocks.states.read.mockResolvedValue(new Map());
  mocks.runs.start.mockResolvedValue({ id: "match-run" });
  mocks.settings.get.mockResolvedValue(null);
  // A profile with no preset and a generative `reranking` route only: the derived mode is
  // ranker-else-generative, and with no ranker the generative decider decides.
  mocks.aiConfig.getDefaultTask.mockImplementation(async (task: string) =>
    task === "reranking" ? route() : null
  );
  respond(defaultVerdicts);
});

describe("atomic note matching through the relations v2 matcher", () => {
  it("hands each decided note's accepted pairs on before its checkpoint, persisting none", async () => {
    const completed: Array<[string, number]> = [];
    const handedOn: DecidedNote[] = [];
    const order: string[] = [];
    mocks.decisions.record.mockImplementation(async () => void order.push("record"));
    const matched = await service().matchAtomicNotes(
      ["source"],
      undefined,
      undefined,
      { sourceItemId: "source-source" },
      {
        onNoteDecided: (decided) => {
          order.push("handOff");
          handedOn.push(decided);
        },
        onNoteCompleted: (noteId, persisted) => {
          order.push("checkpoint");
          completed.push([noteId, persisted]);
        }
      }
    );
    // The decider's verdict alone decides: 0.70 and 0.95 pass, 0.10 does not (no blend).
    expect(matched).toMatchObject({
      persistedCount: 0,
      decided: 1,
      accepted: 2,
      decider: "generative"
    });
    expect(handedOn).toHaveLength(1);
    expect(
      handedOn[0]!.pairs.map((pair) => [
        pair.candidateId,
        pair.relationType,
        pair.band,
        pair.score,
        pair.subjectId
      ])
    ).toEqual([
      ["c", "extends", "suggest", 0.95, "source"],
      ["b", "supports", "suggest", 0.7, "source"]
    ]);
    expect(handedOn[0]!.decider).toMatchObject({ kind: "generative", profileId: "profile" });
    // No relation row and no match run before the link job commits (D21).
    expect(mocks.relations.upsertDecided).not.toHaveBeenCalled();
    expect(mocks.runs.start).not.toHaveBeenCalled();
    // Raw verdicts are recorded before the hand-off, and the checkpoint follows it.
    const records = mocks.decisions.record.mock.calls.map(([record]) => record);
    expect(records.map((r) => [r.targetAtomicNoteId, r.score, r.relationType])).toEqual([
      ["a", 0.1, "supports"],
      ["b", 0.7, "supports"],
      ["c", 0.95, "extends"]
    ]);
    expect(records[0]).toMatchObject({
      sourceAtomicNoteId: "source",
      sourceContentHash: atomicNoteDecisionContentHash(note("source")),
      aiTaskRunId: "run-1"
    });
    expect(order).toEqual(["record", "record", "record", "handOff", "checkpoint"]);
    expect(completed).toEqual([["source", 0]]);
  });

  it("closes the run as failed and checkpoints nothing when the required decider fails", async () => {
    respond("not json", { results: [] });
    const completed: string[] = [];
    const failure = await service()
      .matchAtomicNotes(
        ["source"],
        undefined,
        undefined,
        {},
        {
          onNoteCompleted: (noteId) => void completed.push(noteId)
        }
      )
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("errors.matching.rerankingFailed");
    expect(rerankCalls()).toHaveLength(2);
    expect(mocks.relations.upsertDecided).not.toHaveBeenCalled();
    expect(mocks.decisions.record).not.toHaveBeenCalled();
    expect(completed).toEqual([]);
    // Nothing was handed on, so no run was opened.
    expect(mocks.runs.start).not.toHaveBeenCalled();
  });

  it("makes no call and checkpoints nothing in mode ranker without a validated ranker", async () => {
    mocks.settings.get.mockResolvedValue("ranker");
    const completed: string[] = [];
    const matched = await service().matchAtomicNotes(
      ["source"],
      undefined,
      undefined,
      {},
      {
        onNoteCompleted: (noteId) => void completed.push(noteId)
      }
    );
    expect(matched).toMatchObject({ skipped: "waiting_for_decider", persistedCount: 0 });
    expect(rerankCalls()).toHaveLength(0);
    expect(completed).toEqual([]);
  });

  it("keeps the prompt and the decider key independent of the settings that no longer decide", async () => {
    const prompts: string[] = [];
    const keys: string[] = [];
    for (const settings of [{ minRerankScore: 0.4 }, { minRerankScore: 0.9, rerankerWeight: 1 }]) {
      mocks.run.mockClear();
      mocks.decisions.findVerdicts.mockClear();
      respond(defaultVerdicts);
      await service(settings).matchAtomicNotes(["source"]);
      prompts.push(rerankCalls()[0]![1] as string);
      keys.push(mocks.decisions.findVerdicts.mock.calls[0]![0].deciderKey);
    }
    expect(new Set(prompts).size).toBe(1);
    expect(new Set(keys).size).toBe(1);
    expect(prompts[0]).toContain("The score is an integer from 0 to 100");
    // The output budget still applies to the generative call.
    mocks.run.mockClear();
    respond(defaultVerdicts);
    await service({ maxRerankOutputTokens: 1024 }).matchAtomicNotes(["source"]);
    expect(rerankCalls()[0]![4]).toEqual({ maxOutputTokens: 1024 });
  });

  it("runs the decision with reasoning off by default and identifies the decider by that", async () => {
    const decide = async (parameters: Record<string, unknown>) => {
      mocks.aiConfig.getDefaultTask.mockImplementation(async (task: string) =>
        task === "reranking" ? route(parameters) : null
      );
      mocks.run.mockClear();
      mocks.decisions.findVerdicts.mockClear();
      respond(defaultVerdicts);
      await service().matchAtomicNotes(["source"]);
      expect(rerankCalls()[0]![2]).toMatchObject({ operation: "note_matching_reranking" });
      return mocks.decisions.findVerdicts.mock.calls[0]![0].deciderKey as string;
    };
    const byDefault = await decide({});
    // The default is part of the effective parameters, so spelling it out changes nothing...
    expect(await decide({ reasoningLevel: "off" })).toBe(byDefault);
    // ...and asking for more reasoning is another decider.
    expect(await decide({ reasoningLevel: "high" })).not.toBe(byDefault);
  });

  it("records no verdict when the reranking route changes during the call", async () => {
    let calls = 0;
    mocks.aiConfig.getDefaultTask.mockImplementation(async (task: string, _profile, keys) => {
      if (task !== "reranking") return null;
      // The decider resolved after the call (with the op: and class keys) is another model.
      if (Array.isArray(keys) && keys.length > 1) calls += 1;
      return calls > 1 ? { ...route(), modelId: "other" } : route();
    });
    await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(1);
    expect(mocks.decisions.record).not.toHaveBeenCalled();
  });
});

describe("note embeddings in matching", () => {
  const vector = (seed = 0.1) => Array.from({ length: 256 }, () => seed);
  const storedVector = (embedding = vector(0.2)) => ({
    embedding,
    model: "stored-model",
    provider: "stored-provider",
    runtime: "local",
    strategy: "native-v2:stored-space"
  });
  const embeddingCalls = () => mocks.run.mock.calls.filter(([task]) => task === "embedding");
  const embeddedNoteIds = () =>
    embeddingCalls().map(([, , context]) => (context as { atomicNoteId: string }).atomicNoteId);

  it("embeds every note of the batch that has no vector before the first retrieval, one call each", async () => {
    respond(defaultVerdicts, defaultVerdicts, defaultVerdicts);
    await service().matchAtomicNotes(["n1", "n2", "n3"]);
    expect(embeddedNoteIds()).toEqual(["n1", "n2", "n3"]);
    expect(
      embeddingCalls().every(
        ([, , context]) =>
          (context as { operation: string }).operation === "note_matching_embedding"
      )
    ).toBe(true);
    // One lookup for the whole batch, and all the embedding is done before any note is retrieved:
    // no note is matched while a later note of the batch is still without a vector.
    expect(mocks.embedding.findCurrentNoteVectors).toHaveBeenCalledOnce();
    const lastEmbedding = Math.max(
      ...mocks.run.mock.calls.flatMap(([task], index) =>
        task === "embedding" ? [mocks.run.mock.invocationCallOrder[index]!] : []
      )
    );
    expect(lastEmbedding).toBeLessThan(
      mocks.notes.findTextMatchingCandidates.mock.invocationCallOrder[0]!
    );
    expect(mocks.embedding.upsert).toHaveBeenCalledTimes(3);
    // Every decided note records its match state in the space of its vector (D19).
    expect(mocks.states.record).toHaveBeenCalledTimes(3);
  });

  it("reuses the stored vector of a note instead of embedding it again, and retrieves in its space", async () => {
    mocks.embedding.findCurrentNoteVectors.mockResolvedValue(
      new Map([["source", { targetId: "source", ...storedVector() }]])
    );
    await service().matchAtomicNotes(["source"]);
    expect(embeddingCalls()).toHaveLength(0);
    expect(mocks.embedding.upsert).not.toHaveBeenCalled();
    const space = {
      embedding: vector(0.2),
      embeddingModel: "stored-model",
      embeddingSpaceKey: "stored-space",
      embeddingProvider: "stored-provider",
      embeddingRuntime: "local"
    };
    expect(mocks.notes.findVectorMatchingCandidates).toHaveBeenCalledWith(
      expect.objectContaining(space)
    );
    expect(mocks.notes.scoreMatchingCandidates).toHaveBeenCalledWith(
      expect.objectContaining(space)
    );
    expect(mocks.states.record).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "source", spaceKey: "stored-space" })
    );
  });

  it("embeds no note that is discarded, archived or superseded", async () => {
    mocks.notes.findById.mockImplementation(async (id: string) =>
      id === "gone" ? { ...note(id), supersessionStatus: "superseded" } : note(id)
    );
    await service().matchAtomicNotes(["gone", "kept"]);
    expect(embeddedNoteIds()).toEqual(["kept"]);
  });
});

describe("one decision per unordered pair with a generative decider", () => {
  it("judges a pair of one batch once: the second note reuses the first one's verdict", async () => {
    type Verdict = { score: number; relationType: string };
    const judged = new Map<string, Verdict>();
    // Each note finds the other one.
    const other = (id: string) => (id === "s1" ? "s2" : "s1");
    const candidateOf = ({ noteId }: { noteId: string }) => [
      { note: note(other(noteId)), textScore: 1, vectorScore: 1, hasVector: true }
    ];
    mocks.notes.findTextMatchingCandidates.mockImplementation(async (input) => candidateOf(input));
    mocks.notes.findVectorMatchingCandidates.mockImplementation(async (input) =>
      candidateOf(input)
    );
    mocks.notes.scoreMatchingCandidates.mockImplementation(async (input) => candidateOf(input));
    mocks.decisions.record.mockImplementation(
      async (r: { sourceAtomicNoteId: string; targetAtomicNoteId: string } & Verdict) => {
        judged.set(`${r.sourceAtomicNoteId}>${r.targetAtomicNoteId}`, {
          score: r.score,
          relationType: r.relationType
        });
      }
    );
    // The verdict judged from the other note answers this direction too (no relation exists yet:
    // the link job persists the pair after both notes are decided).
    mocks.decisions.findReverseVerdicts.mockImplementation(
      async (input: { sourceAtomicNoteId: string; targets: Array<{ atomicNoteId: string }> }) =>
        new Map(
          input.targets.flatMap(({ atomicNoteId }) => {
            const verdict = judged.get(`${atomicNoteId}>${input.sourceAtomicNoteId}`);
            return verdict ? [[atomicNoteId, verdict] as const] : [];
          })
        )
    );
    respond({ results: [result(1, 90, "supports")] });
    const handedOn: DecidedNote[] = [];
    const matched = await service().matchAtomicNotes(
      ["s1", "s2"],
      undefined,
      undefined,
      {},
      {
        onNoteDecided: (decided) => void handedOn.push(decided)
      }
    );
    expect(rerankCalls()).toHaveLength(1);
    expect(matched.persistedCount).toBe(0);
    expect([...judged.keys()]).toEqual(["s1>s2"]);
    // Both notes hand the pair on; the reused verdict keeps its judged subject (s1), and the link
    // job persists the pair once.
    expect(
      handedOn.map((decided) => [
        decided.noteId,
        decided.pairs[0]!.decisionSource,
        decided.pairs[0]!.subjectId
      ])
    ).toEqual([
      ["s1", "model", "s1"],
      ["s2", "reverse_cache", "s1"]
    ]);
    expect(mocks.relations.upsertDecided).not.toHaveBeenCalled();
  });
});
