import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@app/conversion";
import { findLocalModelCatalogEntry, rankerCatalogArtifactSha256, rankPairsLimits } from "@app/ai";
import {
  calibrate,
  frozenRelationCalibrations,
  provisionalRelationCalibrations,
  RelationsConfigSchema,
  relationsConfig,
  renderRelationPairText,
  type RelationsConfig
} from "@app/domain";
import type { PgPool } from "@app/db";

import { uuidAssignments } from "../__fixtures__/uuid-assignments.js";
import type { AiService } from "../ai-service.js";
import { atomicNoteDeciderKey, atomicNoteDecisionContentHash } from "../knowledge-processing.js";
import {
  deriveDeciderMode,
  mapGenerativeRelationType,
  rankerCalibrationIdentity,
  rankerDeciderCacheKey,
  relationDecideInstruction,
  relationDecideOperation,
  RelationMatcher,
  type DecidedNote,
  type MatcherNoteVector,
  type RankerModelIdentity
} from "./relation-matcher.js";

const mocks = vi.hoisted(() => ({
  notes: {
    findById: vi.fn(),
    listBySourceItem: vi.fn(),
    findTextMatchingCandidates: vi.fn(),
    findVectorMatchingCandidates: vi.fn(),
    filterRetrievableCandidateIds: vi.fn(),
    scoreMatchingCandidates: vi.fn()
  },
  relations: { pairStatuses: vi.fn(), upsertDecided: vi.fn() },
  decisions: {
    findVerdicts: vi.fn(),
    findReverseVerdicts: vi.fn(),
    record: vi.fn(),
    findRankerScores: vi.fn(),
    recordRankerScores: vi.fn()
  },
  aiConfig: { getDefaultTask: vi.fn() },
  graph: { findAtomicNoteCandidates: vi.fn() },
  localModels: { findById: vi.fn() },
  states: { read: vi.fn(), record: vi.fn() },
  runs: { start: vi.fn(), finish: vi.fn() },
  settings: { get: vi.fn() },
  debug: { record: vi.fn() },
  validation: { runtimeBuild: "build-1" as string | null, parityFailed: false }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAtomicNoteRepository: () => mocks.notes,
  createAtomicNoteRelationRepository: () => mocks.relations,
  createRelationDecisionRepository: () => mocks.decisions,
  createAiConfigRepository: () => mocks.aiConfig,
  createKnowledgeGraphRepository: () => mocks.graph,
  createLocalModelRepository: () => mocks.localModels,
  createNoteMatchStateRepository: () => mocks.states,
  createRelationMatchRunRepository: () => mocks.runs,
  createSettingsRepository: () => mocks.settings,
  createSimilarityDebugRepository: () => mocks.debug
}));
vi.mock("@app/ai", async (original) => ({
  ...(await original<typeof import("@app/ai")>()),
  decideValidationForCatalogEntry: () =>
    mocks.validation.runtimeBuild ? { runtimeBuild: mocks.validation.runtimeBuild } : null,
  decideValidationParityFailed: () => mocks.validation.parityFailed
}));

// --- fixtures -------------------------------------------------------------------------------------

interface Note {
  id: string;
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
  status: string;
  supersessionStatus: string;
  createdFromSourceItemId: string;
  metadata: Record<string, unknown>;
}
const registry = new Map<string, Note>();
const note = (id: string, title = id, extra: Partial<Note> = {}): Note => {
  const value: Note = {
    id,
    title,
    ideaStatement: `Idea of ${title}`,
    bodyMarkdown: `Body of ${title}.`,
    status: "active",
    supersessionStatus: "current",
    createdFromSourceItemId: `source-${id}`,
    metadata: {},
    ...extra
  };
  registry.set(id, value);
  return value;
};
const space = { model: "embed", provider: "local", runtime: "local", spaceKey: "space-1" };
const vectorOf = (): MatcherNoteVector => ({
  embedding: Array.from({ length: 256 }, () => 0.1),
  space
});
const listEntry = (candidate: Note, score: number, kind: "text" | "vector") => ({
  note: candidate,
  textScore: kind === "text" ? score : 0,
  vectorScore: kind === "vector" ? score : 0
});
/** Sets the source note's three candidate lists (cosines for the vector list). */
function lists(input: {
  text?: Array<[Note, number]>;
  vector?: Array<[Note, number]>;
  graph?: Array<[Note, number]>;
}) {
  mocks.notes.findTextMatchingCandidates.mockResolvedValue(
    (input.text ?? []).map(([n, s]) => listEntry(n, s, "text"))
  );
  mocks.notes.findVectorMatchingCandidates.mockResolvedValue(
    (input.vector ?? []).map(([n, s]) => listEntry(n, s, "vector"))
  );
  const graph = (input.graph ?? []).map(([n, s]) => ({
    noteId: n.id,
    graphScore: s,
    pathType: "shared_entity",
    contentKey: `${n.title}\0${n.ideaStatement}`
  }));
  mocks.graph.findAtomicNoteCandidates.mockImplementation(async (_id: string, limit: number) =>
    graph.slice(0, limit)
  );
}

const rankerRoute = {
  routeKey: "class:decide",
  profileId: "ranker-profile",
  provider: "local",
  baseUrl: null,
  modelId: "Qwen3-Reranker-0.6B",
  runtime: "mlx",
  localModelId: "ranker-model",
  repository: "Qwen/Qwen3-Reranker-0.6B",
  revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
  quantization: "bf16",
  requiredCapabilities: ["reranking", "offline"],
  parameters: {},
  modelDefaultParameters: {}
};
const writerRoute = {
  routeKey: "reranking",
  profileId: "writer-profile",
  provider: "openai-codex",
  baseUrl: null,
  modelId: "writer",
  runtime: "remote",
  localModelId: null,
  repository: null,
  revision: null,
  quantization: null,
  requiredCapabilities: ["text-generation", "structured-output"],
  parameters: {},
  modelDefaultParameters: {}
};
let routes: Record<string, unknown>;

/** Scores of the fake ranker by "query title>document title"; any other pair scores -5. */
const rankerScores = new Map<string, number>();
const titleOf = (text: string) => /^Title: (.*)$/mu.exec(text)![1]!;
const rankResult = (logOdds: number[], overrides: Record<string, unknown> = {}) => ({
  logOdds,
  scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
  tokenCounts: logOdds.map(() => 300),
  truncated: logOdds.map(() => false),
  aiTaskRunIds: Array.from({ length: Math.ceil(logOdds.length / 32) }, (_, i) => `rank-${i + 1}`),
  calls: Math.ceil(logOdds.length / 32),
  profileId: "ranker-profile",
  localModelId: "ranker-model",
  provider: "local",
  modelId: "Qwen3-Reranker-0.6B",
  runtime: "mlx",
  runtimeBuild: "build-1",
  parameters: { batchSize: 16 },
  uncalibrated: false,
  durationMs: 100,
  queueMs: 0,
  ...overrides
});
const ai = {
  runDefaultTask: vi.fn(),
  rankPairs: vi.fn(),
  decideRouteStatus: vi.fn(),
  traceOperation: vi.fn(
    async (_operation: string, _context: unknown, run: () => Promise<unknown>) => await run()
  )
};
const generativeCalls = () => ai.runDefaultTask.mock.calls.filter(([task]) => task === "reranking");
const verdicts = (...items: Array<[number, number, string]>) => ({
  output: { results: items },
  profileId: "writer-profile",
  modelId: "writer",
  providerId: "openai-codex",
  runtime: "remote",
  aiTaskRunId: `gen-${ai.runDefaultTask.mock.calls.length}`
});

/**
 * Spike A's provisional rule (max of both directions at 400 characters, applied from 3.3125 log-odds)
 * under the shipped instruction: the band, cache and fallback mechanics most tests read. The shipped
 * defaults (T58's frozen calibrations: mean, 600, suggest only) have tests of their own.
 */
const provisionalConfig = RelationsConfigSchema.parse({
  decide: { bodyCharacters: 400, rule: "max" },
  calibrations: provisionalRelationCalibrations.map((entry) => ({
    ...entry,
    identity: { ...entry.identity, instructionSha256: sha256(relationDecideInstruction()) }
  }))
});
/** No calibration at Spike A's 400 characters and max: every decider uncalibrated. */
const uncalibratedConfig = RelationsConfigSchema.parse({
  decide: { bodyCharacters: 400, rule: "max" }
});

function matcher(config: RelationsConfig = provisionalConfig, debug = false) {
  return new RelationMatcher({
    getPool: () => ({}) as PgPool,
    ai: ai as unknown as AiService,
    config,
    isDebugEnabled: async () => debug
  });
}

/** Runs the matcher on the given notes and collects the hand-offs and checkpoints. */
async function run(
  noteIds: string[],
  options: { config?: RelationsConfig; withVector?: boolean } = {}
) {
  const handed: DecidedNote[] = [];
  const completed: Array<[string, number]> = [];
  const vectors = new Map(
    options.withVector === false ? [] : noteIds.map((id) => [id, vectorOf()] as const)
  );
  const result = await matcher(options.config).matchNotes({
    noteIds,
    vectors,
    onNoteCompleted: (id, persisted) => void completed.push([id, persisted]),
    handOff: async (decided) => {
      handed.push(decided);
      return decided.pairs.length;
    }
  });
  return { result, handed, completed };
}

const mlxModel: RankerModelIdentity = {
  provider: "local",
  model: "mlx-qwen3-reranker-0.6b",
  runtimeKind: "mlx",
  repository: "Qwen/Qwen3-Reranker-0.6B",
  revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
  quantization: "bf16",
  artifactSha256: "174f5d43f89c73d2b8935f36af5f6a80a9fb31267d05ba7172393e978f6a3a01"
};

let source: Note, a: Note, b: Note, c: Note;
beforeEach(() => {
  vi.clearAllMocks();
  // Queued one-off answers never leak from one test into the next.
  for (const mock of [ai.runDefaultTask, ai.rankPairs, ai.decideRouteStatus]) mock.mockReset();
  registry.clear();
  rankerScores.clear();
  mocks.validation.runtimeBuild = "build-1";
  mocks.validation.parityFailed = false;
  source = note("n-source", "Source");
  a = note("n-a", "Alpha");
  b = note("n-b", "Beta");
  c = note("n-c", "Gamma");
  mocks.notes.findById.mockImplementation(async (id: string) => registry.get(id) ?? null);
  // The SQL of the graph list's exclusions: current notes, inside the fence (roots only here).
  mocks.notes.filterRetrievableCandidateIds.mockImplementation(
    async (input: { candidateIds: string[]; fence?: { rootSourceItemIds: string[] } }) =>
      new Set(
        input.candidateIds.filter((id) => {
          const found = registry.get(id);
          return (
            found !== undefined &&
            found.status !== "rejected" &&
            found.status !== "archived" &&
            found.supersessionStatus === "current" &&
            (!input.fence || input.fence.rootSourceItemIds.includes(found.createdFromSourceItemId))
          );
        })
      )
  );
  mocks.notes.scoreMatchingCandidates.mockImplementation(
    async ({ candidateIds }: { candidateIds: string[] }) =>
      candidateIds.flatMap((id) => {
        const found = registry.get(id);
        return found ? [{ note: found, textScore: 0.1, vectorScore: 0.5, hasVector: true }] : [];
      })
  );
  lists({
    text: [[a, 0.9]],
    vector: [
      [b, 0.6],
      [c, 0.55],
      [a, 0.99]
    ]
  });
  mocks.relations.pairStatuses.mockResolvedValue(new Map());
  mocks.decisions.findVerdicts.mockResolvedValue(new Map());
  mocks.decisions.findReverseVerdicts.mockResolvedValue(new Map());
  mocks.decisions.findRankerScores.mockResolvedValue(new Map());
  mocks.states.read.mockResolvedValue(new Map());
  mocks.localModels.findById.mockResolvedValue({
    id: "ranker-model",
    catalogId: "mlx-qwen3-reranker-0.6b",
    metadata: {}
  });
  mocks.settings.get.mockResolvedValue(null);
  routes = { "class:decide": rankerRoute, reranking: writerRoute };
  mocks.aiConfig.getDefaultTask.mockImplementation(
    async (task: string, _profile: unknown, keys: string[] = [task]) =>
      keys.map((key) => routes[key]).find(Boolean) ?? null
  );
  ai.decideRouteStatus.mockResolvedValue("ready");
  ai.rankPairs.mockImplementation(
    async (input: { pairs: Array<{ query: string; document: string }> }) =>
      rankResult(
        input.pairs.map(
          (pair) => rankerScores.get(`${titleOf(pair.query)}>${titleOf(pair.document)}`) ?? -5
        )
      )
  );
  ai.runDefaultTask.mockResolvedValue(verdicts());
});

// --- tests ----------------------------------------------------------------------------------------

describe("the decider mode of a profile with no preset", () => {
  it("is ranker with a validated ranker, the pre-F3 generative decider otherwise, else ranker", () => {
    expect(deriveDeciderMode({ validatedRanker: true, generativeRerankingRoute: true })).toBe(
      "ranker"
    );
    expect(deriveDeciderMode({ validatedRanker: true, generativeRerankingRoute: false })).toBe(
      "ranker"
    );
    // E6: no ranker on purpose, a local writer on `reranking`.
    expect(deriveDeciderMode({ validatedRanker: false, generativeRerankingRoute: true })).toBe(
      "ranker-else-generative"
    );
    expect(deriveDeciderMode({ validatedRanker: false, generativeRerankingRoute: false })).toBe(
      "ranker"
    );
    // A ranker that re-validates stays the decider: matching waits for it.
    expect(
      deriveDeciderMode({
        validatedRanker: false,
        rankerValidating: true,
        generativeRerankingRoute: true
      })
    ).toBe("ranker");
  });
});

describe("the ranker decider", () => {
  it("scores both directions of every candidate in one rankPairs input and accepts by the band alone", async () => {
    // Alpha is the most similar by text and vector but the ranker rejects it (max 2); Beta, barely
    // similar, is applied (max 3.5 >= 3.3125); Gamma stays just below (max 3.31).
    rankerScores.set("Source>Alpha", 1).set("Alpha>Source", 2);
    rankerScores.set("Source>Beta", 3.5).set("Beta>Source", -1);
    rankerScores.set("Source>Gamma", 3.3).set("Gamma>Source", 3.31);
    const { result, handed, completed } = await run([source.id]);
    expect(ai.rankPairs).toHaveBeenCalledOnce();
    const [input] = ai.rankPairs.mock.calls[0]!;
    expect(input).toMatchObject({
      operation: relationDecideOperation,
      instruction: relationDecideInstruction(),
      helperBatchSize: 16
    });
    // Content order, the note's direction first: both directions of a pair side by side.
    expect(
      input.pairs.map((pair: { query: string; document: string }) =>
        [titleOf(pair.query), titleOf(pair.document)].join(">")
      )
    ).toEqual([
      "Source>Alpha",
      "Alpha>Source",
      "Source>Beta",
      "Beta>Source",
      "Source>Gamma",
      "Gamma>Source"
    ]);
    expect(input.pairs[0].query).toBe(renderRelationPairText(source, 400));
    expect(generativeCalls()).toHaveLength(0);
    // Raw log-odds per direction, keyed by the canonical pair (here every candidate sorts first).
    expect(
      mocks.decisions.recordRankerScores.mock.calls.map(([record]) => [
        record.loAtomicNoteId,
        record.hiAtomicNoteId,
        record.loToHi,
        record.hiToLo,
        record.aiTaskRunId
      ])
    ).toEqual([
      ["n-a", "n-source", 2, 1, "rank-1"],
      ["n-b", "n-source", -1, 3.5, "rank-1"],
      ["n-c", "n-source", 3.31, 3.3, "rank-1"]
    ]);
    expect(handed).toHaveLength(1);
    expect(handed[0]!.decider).toMatchObject({ kind: "ranker", calibration: "provisional" });
    expect(handed[0]!.pairs).toEqual([
      expect.objectContaining({
        candidateId: "n-b",
        band: "apply",
        probability: null,
        score: 3.5,
        calibration: "provisional",
        relationType: null,
        subjectId: null,
        decisionSource: "model"
      })
    ]);
    expect(result).toMatchObject({ persistedCount: 1, decided: 1, accepted: 1, decider: "ranker" });
    expect(completed).toEqual([["n-source", 1]]);
    // Decisions and the match state are committed before the hand-off.
    expect(mocks.states.record).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "n-source", spaceKey: "space-1" })
    );
    expect(mocks.decisions.recordRankerScores.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.states.record.mock.invocationCallOrder[0]!
    );
  });

  it("only suggests while it is uncalibrated: no calibration, a failed parity check, or an uncalibrated call", async () => {
    rankerScores.set("Source>Beta", 9);
    const bands = async (options: { config?: RelationsConfig } = {}) => {
      const { handed } = await run([source.id], options);
      // A note with nothing accepted hands nothing on.
      return (handed[0]?.pairs ?? []).map((pair) => [
        pair.candidateId,
        pair.band,
        pair.calibration
      ]);
    };
    expect(await bands({ config: uncalibratedConfig })).toEqual([
      ["n-b", "suggest", "uncalibrated"]
    ]);
    mocks.validation.parityFailed = true;
    expect(await bands()).toEqual([["n-b", "suggest", "uncalibrated"]]);
    mocks.validation.parityFailed = false;
    ai.rankPairs.mockResolvedValueOnce(rankResult([-5, -5, 9, -5, -5, -5], { uncalibrated: true }));
    expect(await bands()).toEqual([["n-b", "suggest", "uncalibrated"]]);
    // Below the uncalibrated pass nothing is suggested either.
    rankerScores.set("Source>Beta", 3);
    expect(await bands({ config: uncalibratedConfig })).toEqual([]);
  });

  it("gives a frozen calibration's probability and both bands", async () => {
    const identity = rankerCalibrationIdentity({
      instructionSha256: sha256(relationDecideInstruction()),
      config: provisionalConfig,
      model: mlxModel
    });
    const config = RelationsConfigSchema.parse({
      decide: { bodyCharacters: 400, rule: "max" },
      calibrations: [
        {
          kind: "isotonic",
          identity,
          blocks: [
            { fromScore: 0, probability: 0.05 },
            { fromScore: 2, probability: 0.85 },
            { fromScore: 4, probability: 0.97 }
          ],
          applyFrom: 4,
          suggestFrom: 2,
          basis: "test",
          labelSetHash: "a".repeat(64),
          freezeHash: "b".repeat(64),
          fittedAt: "2026-10-20T10:00:00.000Z",
          parity: { referenceHash: "c".repeat(64), scores: [1] }
        }
      ]
    });
    rankerScores.set("Alpha>Source", 4.5).set("Source>Beta", 2.5);
    const { handed } = await run([source.id], { config });
    expect(handed[0]!.decider.calibration).toBe("frozen");
    expect(handed[0]!.pairs.map((pair) => [pair.candidateId, pair.band, pair.probability])).toEqual(
      [
        ["n-a", "apply", 0.97],
        ["n-b", "suggest", 0.85]
      ]
    );
  });

  it("suggests by the shipped frozen calibration: the mean of both directions from 0.125, never applied", async () => {
    // Alpha: mean 0.125 (suggested); Beta: mean 9 (suggested, not applied); Gamma: mean 0.0625.
    rankerScores.set("Source>Alpha", 2).set("Alpha>Source", -1.75);
    rankerScores.set("Source>Beta", 9).set("Beta>Source", 9);
    rankerScores.set("Source>Gamma", 0.125).set("Gamma>Source", 0);
    const { handed } = await run([source.id], { config: relationsConfig });
    const [input] = ai.rankPairs.mock.calls[0]!;
    expect(input.pairs[0].query).toBe(renderRelationPairText(source, 600));
    expect(handed[0]!.decider.calibration).toBe("frozen");
    const [mlx] = frozenRelationCalibrations;
    const blocks = mlx!.kind === "isotonic" ? mlx!.blocks : [];
    expect(
      handed[0]!.pairs.map((pair) => [pair.candidateId, pair.band, pair.score, pair.probability])
    ).toEqual([
      ["n-b", "suggest", 9, calibrate(9, blocks)],
      ["n-a", "suggest", 0.125, calibrate(0.125, blocks)]
    ]);
  });

  it("keeps its calibration across a runtime-build or helper-batch change, under another cache key", async () => {
    rankerScores.set("Source>Beta", 9);
    const keys: string[] = [];
    for (const [build, batch] of [
      ["build-1", 16],
      ["build-2", 16],
      ["build-1", 1]
    ] as const) {
      mocks.validation.runtimeBuild = build;
      const config = RelationsConfigSchema.parse({
        calibrations: provisionalConfig.calibrations,
        decide: { bodyCharacters: 400, rule: "max", helperBatchSize: batch }
      });
      const { handed } = await run([source.id], { config });
      expect(handed[0]!.pairs[0]).toMatchObject({ band: "apply", calibration: "provisional" });
      keys.push(mocks.decisions.findRankerScores.mock.calls.at(-1)![0].deciderKey);
    }
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(
      rankerDeciderCacheKey({
        instructionSha256: sha256(relationDecideInstruction()),
        template: "relation-pair-text-v1",
        bodyCharacters: 400,
        model: mlxModel,
        runtimeBuild: "build-1",
        parameters: { batchSize: 16 }
      })
    );
  });

  it("reuses stored scores under the cache key and both rendered-input hashes with no rank call (I-R5)", async () => {
    const hash = (n: Note) => sha256(renderRelationPairText(n, 400));
    mocks.decisions.findRankerScores.mockResolvedValue(
      new Map([
        ["n-a:n-source", { loToHi: 0, hiToLo: 0 }],
        ["n-b:n-source", { loToHi: 4, hiToLo: 0 }],
        ["n-c:n-source", { loToHi: 0, hiToLo: 0 }]
      ])
    );
    const { handed } = await run([source.id]);
    expect(ai.rankPairs).not.toHaveBeenCalled();
    expect(mocks.decisions.recordRankerScores).not.toHaveBeenCalled();
    expect(mocks.decisions.findRankerScores.mock.calls[0]![0].pairs).toEqual(
      [a, b, c].map((candidate) => ({
        loAtomicNoteId: candidate.id,
        hiAtomicNoteId: "n-source",
        loInputHash: hash(candidate),
        hiInputHash: hash(source)
      }))
    );
    expect(handed[0]!.pairs).toEqual([
      expect.objectContaining({ candidateId: "n-b", band: "apply", decisionSource: "cache" })
    ]);
    // A body edit changes the rendered input, so the hash no longer matches what was stored.
    expect(hash({ ...b, bodyMarkdown: "Another body." })).not.toBe(hash(b));
  });

  it("scores only the direction a stored pair is missing", async () => {
    mocks.decisions.findRankerScores.mockResolvedValue(
      new Map([
        ["n-a:n-source", { loToHi: 0, hiToLo: 0 }],
        ["n-b:n-source", { loToHi: null, hiToLo: 1 }],
        ["n-c:n-source", { loToHi: 0, hiToLo: 0 }]
      ])
    );
    rankerScores.set("Beta>Source", 5);
    const { handed } = await run([source.id]);
    expect(
      ai.rankPairs.mock.calls[0]![0].pairs.map((pair: { query: string; document: string }) =>
        [titleOf(pair.query), titleOf(pair.document)].join(">")
      )
    ).toEqual(["Beta>Source"]);
    expect(mocks.decisions.recordRankerScores).toHaveBeenCalledWith(
      expect.objectContaining({ loAtomicNoteId: "n-b", loToHi: 5, hiToLo: null })
    );
    expect(handed[0]!.pairs[0]).toMatchObject({ candidateId: "n-b", score: 5 });
  });

  it("fails visibly, before the checkpoint, when the ranker call fails", async () => {
    const cause = new Error("errors.localModels.runtimeFailed");
    ai.rankPairs.mockRejectedValue(cause);
    const handOff = vi.fn();
    const onNoteCompleted = vi.fn();
    const failure = await matcher()
      .matchNotes({
        noteIds: [source.id],
        vectors: new Map([[source.id, vectorOf()]]),
        onNoteCompleted,
        handOff
      })
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("errors.matching.rerankingFailed");
    // The cause keeps a transient failure retryable by the job supervisor.
    expect((failure as Error).cause).toBe(cause);
    expect(handOff).not.toHaveBeenCalled();
    expect(onNoteCompleted).not.toHaveBeenCalled();
    expect(mocks.states.record).not.toHaveBeenCalled();
  });

  it("waits, in mode ranker, for a ranker that goes into validation during the run", async () => {
    mocks.settings.get.mockResolvedValue("ranker");
    ai.rankPairs.mockRejectedValue(new Error("errors.localModels.rankerNotValidated"));
    const { result, handed, completed } = await run([source.id]);
    expect(result.skipped).toBe("waiting_for_decider");
    expect(handed).toEqual([]);
    expect(completed).toEqual([]);
  });

  it("builds the same rankPairs input for the same notes under any UUID assignment", async () => {
    const inputs: string[] = [];
    for (const ids of uuidAssignments(4)) {
      registry.clear();
      const [s, x, y, z] = ids as [string, string, string, string];
      const subject = note(s, "Source");
      const alpha = note(x, "Alpha");
      const beta = note(y, "Beta");
      const gamma = note(z, "Gamma");
      // Equal ranks across lists: only content can order the candidates.
      lists({
        text: [
          [beta, 0.5],
          [alpha, 0.5]
        ],
        vector: [
          [alpha, 0.5],
          [beta, 0.5]
        ],
        graph: [[gamma, 0.4]]
      });
      ai.rankPairs.mockClear();
      await run([subject.id]);
      inputs.push(JSON.stringify(ai.rankPairs.mock.calls[0]![0].pairs));
    }
    expect(new Set(inputs).size).toBe(1);
  });

  it("decides K = 10 fused candidates plus the reverse guard's earlier notes", async () => {
    // 24 vector candidates v01 (closest) .. v24; no text or graph signal.
    const vectorNotes = Array.from({ length: 24 }, (_, index) =>
      note(`n-v${String(index + 1).padStart(2, "0")}`, `V${String(index + 1).padStart(2, "0")}`)
    );
    const cosine = (index: number) => 0.9 - index * 0.01;
    lists({ vector: vectorNotes.map((n, index) => [n, cosine(index)] as [Note, number]) });
    // Earlier decided notes: v12 (k-th cosine 0.7, reached by 0.79), v15 (k-th 0.8, not reached by
    // 0.76), v18 (decided with fewer than K candidates: any later note completes it), v22 (outside the
    // guard's top 20) and v13 (not decided).
    mocks.states.read.mockImplementation(async (ids: string[]) => {
      const states = new Map([
        ["n-v12", { kthCosine: 0.7 }],
        ["n-v15", { kthCosine: 0.8 }],
        ["n-v18", { kthCosine: null }],
        ["n-v22", { kthCosine: 0.1 }]
      ]);
      expect(ids).toHaveLength(20);
      return new Map([...states].filter(([id]) => ids.includes(id)));
    });
    await run([source.id]);
    const titles = [
      ...new Set(
        ai.rankPairs.mock.calls[0]![0].pairs.map((pair: { document: string }) =>
          titleOf(pair.document)
        )
      )
    ].filter((title) => title !== "Source");
    expect(titles).toEqual([
      "V01",
      "V02",
      "V03",
      "V04",
      "V05",
      "V06",
      "V07",
      "V08",
      "V09",
      "V10",
      "V12",
      "V18"
    ]);
    // The note's own k-th vector cosine opens the guard to later notes.
    expect(mocks.states.record).toHaveBeenCalledWith({
      noteId: "n-source",
      deciderKey: expect.any(String),
      spaceKey: "space-1",
      kthCosine: cosine(9)
    });
  });

  it("leaves out pairs a person decided, pairs already related, and notes that are not current", async () => {
    note("n-a", "Alpha", { status: "archived" });
    mocks.relations.pairStatuses.mockResolvedValue(new Map([["n-b", "rejected"]]));
    await run([source.id]);
    expect(
      [
        ...new Set(
          ai.rankPairs.mock.calls[0]![0].pairs.map((pair: { document: string }) =>
            titleOf(pair.document)
          )
        )
      ].filter((title) => title !== "Source")
    ).toEqual(["Gamma"]);
    // A note that is not current is not decided at all, and still checkpointed.
    note("n-source", "Source", { supersessionStatus: "superseded" });
    ai.rankPairs.mockClear();
    const { completed } = await run([source.id]);
    expect(ai.rankPairs).not.toHaveBeenCalled();
    expect(completed).toEqual([["n-source", 0]]);
  });

  it("splits like the AI service and ships T58's frozen calibrations of the catalog rankers", () => {
    expect(relationsConfig.decide.rankPairsPerCall).toEqual(rankPairsLimits.perCall);
    expect(relationsConfig.decide.helperBatchSize).toBe(rankPairsLimits.helperBatchSize);
    const instructionSha256 = sha256(relationDecideInstruction());
    const identities = ["mlx-qwen3-reranker-0.6b", "gguf-qwen3-reranker-0.6b-q8-0"].map((id) => {
      const entry = findLocalModelCatalogEntry(id)!;
      return rankerCalibrationIdentity({
        instructionSha256,
        config: relationsConfig,
        model: {
          provider: "local",
          model: entry.id,
          runtimeKind: entry.runtime === "mlx" ? "mlx" : "gguf",
          repository: entry.repository,
          revision: entry.revision,
          quantization: entry.quantization,
          artifactSha256: rankerCatalogArtifactSha256(entry)
        }
      });
    });
    expect(
      frozenRelationCalibrations
        .filter((entry) => entry.identity.runtimeKind !== "remote")
        .map((entry) => entry.identity)
    ).toEqual(identities);
    // The shipped instruction is the F3 bake-off's `relation`, which the frozen maps are fitted under.
    expect(relationDecideInstruction()).toBe(
      "Judge whether the Document states an idea with a substantive conceptual relationship to the " +
        "Query note: it supports, contradicts, extends, depends on, exemplifies or clarifies it. " +
        "Sharing a topic alone is not enough."
    );
    expect(instructionSha256).toBe(
      "991ad3a617c4ca6cabab1cb8d45a5806b1e258ef0e5e80a7380d750a09b89c5b"
    );
  });

  it("matches the current notes of one source, with the fence hiding the roots not yet released", async () => {
    const hidden = note("n-h", "Hidden");
    lists({ vector: [[b, 0.6]], graph: [[hidden, 0.9]] });
    mocks.notes.listBySourceItem.mockResolvedValue([
      source,
      note("n-old", "Old", { supersessionStatus: "superseded" })
    ]);
    const result = await matcher().matchSource("source-n-source", {
      vectors: new Map([[source.id, vectorOf()]]),
      fence: { rootSourceItemIds: ["source-n-b"] },
      handOff: async () => 0
    });
    expect(result.decided).toBe(1);
    // Every signal is fenced in SQL: the text and vector queries, and the graph list's notes.
    for (const query of [
      mocks.notes.findTextMatchingCandidates,
      mocks.notes.findVectorMatchingCandidates,
      mocks.notes.filterRetrievableCandidateIds
    ])
      expect(query.mock.calls[0]![0].fence).toEqual({ rootSourceItemIds: ["source-n-b"] });
    const documents = ai.rankPairs.mock.calls[0]![0].pairs.map((pair: { document: string }) =>
      titleOf(pair.document)
    );
    expect(documents).toEqual(["Beta", "Source"]);
  });

  /** The candidates the ranker saw for the source note, by title. */
  const decidedTitles = () =>
    ai.rankPairs.mock.calls
      .flatMap(([input]) => input.pairs as Array<{ query: string; document: string }>)
      .filter((pair) => titleOf(pair.query) === "Source")
      .map((pair) => titleOf(pair.document))
      .sort();
  const tenVectorNotes = (sourceItemId: string) =>
    Array.from({ length: 10 }, (_, index) => {
      const title = `v${String(index + 1).padStart(2, "0")}`;
      return note(`n-${title}`, title, { createdFromSourceItemId: sourceItemId });
    });

  it("fences the graph list before fusion, deep enough that hidden roots take none of the K slots", async () => {
    const visible = tenVectorNotes("root-released");
    // Eight graph-only notes of a root not yet released lead the graph list; a released one is 9th.
    const hidden = Array.from({ length: 8 }, (_, index) =>
      note(`n-h${index}`, `h${index}`, { createdFromSourceItemId: "root-hidden" })
    );
    const deep = note("n-g", "g", { createdFromSourceItemId: "root-released" });
    lists({
      vector: visible.map((n, index) => [n, 0.9 - index * 0.01] as [Note, number]),
      graph: [...hidden, deep].map((n, index) => [n, 0.9 - index * 0.05] as [Note, number])
    });
    await matcher().matchNotes({
      noteIds: [source.id],
      vectors: new Map([[source.id, vectorOf()]]),
      fence: { rootSourceItemIds: ["root-released"] },
      handOff: async () => 0
    });
    // K = 10 visible candidates: the released graph note (kept by the graph-only reserve) and the
    // nine closest vectors. Hidden notes took no slot.
    expect(decidedTitles()).toEqual([...visible.slice(0, 9).map((n) => n.title), "g"].sort());
    // Gate 0's arrival lists: the graph list is read 40 deep, fenced in SQL, then cut to graphK.
    expect(mocks.graph.findAtomicNoteCandidates).toHaveBeenCalledWith(source.id, 40);
    expect(mocks.notes.filterRetrievableCandidateIds).toHaveBeenCalledWith({
      candidateIds: [...hidden, deep].map((n) => n.id),
      fence: { rootSourceItemIds: ["root-released"] }
    });
  });

  it("keeps archived and superseded graph notes out of the K slots without a fence", async () => {
    const visible = tenVectorNotes("root-released");
    const excluded = [
      note("n-x1", "x1", { status: "archived" }),
      note("n-x2", "x2", { supersessionStatus: "superseded" }),
      note("n-x3", "x3", { status: "archived" })
    ];
    lists({
      vector: visible.map((n, index) => [n, 0.9 - index * 0.01] as [Note, number]),
      graph: excluded.map((n, index) => [n, 0.9 - index * 0.05] as [Note, number])
    });
    await run([source.id]);
    expect(decidedTitles()).toEqual(visible.map((n) => n.title));
    expect(mocks.notes.filterRetrievableCandidateIds).toHaveBeenCalledWith({
      candidateIds: excluded.map((n) => n.id)
    });
  });
});

describe("decider modes", () => {
  it("skips with no call in mode ranker while no ranker is validated, and the run goes on", async () => {
    mocks.settings.get.mockResolvedValue("ranker");
    ai.decideRouteStatus.mockResolvedValue("not_validated");
    const { result, handed, completed } = await run([source.id]);
    expect(result).toMatchObject({ skipped: "waiting_for_decider", decided: 0, decider: null });
    expect(ai.rankPairs).not.toHaveBeenCalled();
    expect(ai.runDefaultTask).not.toHaveBeenCalled();
    expect(mocks.notes.findTextMatchingCandidates).not.toHaveBeenCalled();
    expect(handed).toEqual([]);
    expect(completed).toEqual([]);
  });

  it("names the key it decides under before it decides, the one the hand-off carries", async () => {
    // The re-match harness clears the decisions of this key (F3 T52b).
    rankerScores.set("Source>Beta", 9);
    const key = await matcher().currentDeciderKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    // No call is made to find it.
    expect(ai.rankPairs).not.toHaveBeenCalled();
    const ranker = await run([source.id]);
    expect(ranker.handed[0]!.decider.deciderKey).toBe(key);

    mocks.settings.get.mockResolvedValue("generative");
    routes["op:note_matching_reranking"] = writerRoute;
    ai.runDefaultTask.mockResolvedValue(
      verdicts([1, 90, "supports"], [2, 10, "related"], [3, 10, "related"])
    );
    const generativeKey = await matcher().currentDeciderKey();
    expect(generativeKey).not.toBeNull();
    expect(generativeKey).not.toBe(key);
    expect((await run([source.id])).handed[0]!.decider.deciderKey).toBe(generativeKey);
  });

  it("names no key while mode ranker waits for a validated ranker", async () => {
    mocks.settings.get.mockResolvedValue("ranker");
    ai.decideRouteStatus.mockResolvedValue("not_validated");
    await expect(matcher().currentDeciderKey()).resolves.toBeNull();
  });

  it("matches a profile with only a generative reranking route (E6) with the generative decider", async () => {
    routes = { reranking: writerRoute };
    ai.runDefaultTask.mockResolvedValue(
      verdicts([1, 90, "supports"], [2, 10, "related"], [3, 10, "related"])
    );
    const { result, handed } = await run([source.id]);
    expect(ai.decideRouteStatus).not.toHaveBeenCalled();
    expect(ai.rankPairs).not.toHaveBeenCalled();
    expect(result).toMatchObject({ decider: "generative", accepted: 1 });
    expect(handed[0]!.decider).toMatchObject({
      kind: "generative",
      mode: "ranker-else-generative"
    });
  });

  it("waits for a re-validating ranker in a derived profile instead of switching deciders", async () => {
    ai.decideRouteStatus.mockResolvedValue("not_validated");
    const { result } = await run([source.id]);
    expect(result.skipped).toBe("waiting_for_decider");
    expect(ai.runDefaultTask).not.toHaveBeenCalled();
  });

  it("uses the generative decider in Cloud (ranker-else-generative) until a ranker validates", async () => {
    mocks.settings.get.mockResolvedValue("ranker-else-generative");
    // The presets write the generative-decide op: routes (D16), ahead of `class:decide`.
    routes["op:note_matching_reranking"] = writerRoute;
    ai.decideRouteStatus.mockResolvedValue("missing");
    ai.runDefaultTask.mockResolvedValue(verdicts([1, 10, "related"]));
    expect((await run([source.id])).result.decider).toBe("generative");
    ai.decideRouteStatus.mockResolvedValue("ready");
    expect((await run([source.id])).result.decider).toBe("ranker");
  });

  it("skips a derived profile with neither a ranker nor a generative reranking route", async () => {
    routes = {};
    const { result } = await run([source.id]);
    expect(result.skipped).toBe("waiting_for_decider");
  });

  it("decides generatively in mode generative even with a validated ranker", async () => {
    mocks.settings.get.mockResolvedValue("generative");
    routes["op:note_matching_reranking"] = writerRoute;
    ai.runDefaultTask.mockResolvedValue(verdicts([1, 10, "related"]));
    expect((await run([source.id])).result.decider).toBe("generative");
    expect(ai.rankPairs).not.toHaveBeenCalled();
  });

  it("reads the routes after the legacy mapping wrote the generative-decide op: routes", async () => {
    // No preset, a ranker route whose model is missing, and the pre-F3 writer on `reranking`: the
    // derived mode keeps that writer (Q17), found through the op: route the mapping writes first.
    ai.decideRouteStatus.mockResolvedValue("missing");
    const ensureLegacyRouteMapping = vi.fn(async () => {
      routes["op:note_matching_reranking"] = writerRoute;
    });
    ai.runDefaultTask.mockResolvedValue(
      verdicts([1, 10, "related"], [2, 10, "related"], [3, 10, "related"])
    );
    const result = await new RelationMatcher({
      getPool: () => ({}) as PgPool,
      ai: { ...ai, ensureLegacyRouteMapping } as unknown as AiService
    }).matchNotes({
      noteIds: [source.id],
      vectors: new Map([[source.id, vectorOf()]]),
      handOff: async (decided) => decided.pairs.length
    });
    expect(ensureLegacyRouteMapping).toHaveBeenCalledOnce();
    expect(result.decider).toBe("generative");
    expect(ai.rankPairs).not.toHaveBeenCalled();
  });

  it("never sends the generative contract to a ranker: a decide route that resolves to one fails visibly", async () => {
    mocks.settings.get.mockResolvedValue("generative");
    routes = { "class:decide": rankerRoute };
    await expect(run([source.id])).rejects.toThrow("errors.ai.noCompatibleModel");
    expect(ai.runDefaultTask).not.toHaveBeenCalled();
  });

  it("states class decide on the generative call, which resolves its op: route first", async () => {
    routes = { reranking: writerRoute };
    ai.runDefaultTask.mockResolvedValue(
      verdicts([1, 10, "related"], [2, 10, "related"], [3, 10, "related"])
    );
    await run([source.id]);
    expect(generativeCalls()[0]![2]).toMatchObject({
      operation: "note_matching_reranking",
      workloadClass: "decide",
      attempt: 0
    });
    expect(mocks.aiConfig.getDefaultTask).toHaveBeenCalledWith("reranking", undefined, [
      "op:note_matching_reranking",
      "class:decide",
      "reranking"
    ]);
  });
});

describe("the generative decider", () => {
  beforeEach(() => {
    routes = { reranking: writerRoute };
  });

  it("suggests a verdict at the uncalibrated pass with its mapped type and judged direction", async () => {
    // Content order: Alpha [1], Beta [2], Gamma [3]. No blend: Alpha's similarity does not help it.
    ai.runDefaultTask.mockResolvedValue(
      verdicts([1, 60, "supports"], [2, 70, "contrasts"], [3, 95, "similar_to"])
    );
    const { handed } = await run([source.id]);
    expect(
      handed[0]!.pairs.map((pair) => [
        pair.candidateId,
        pair.band,
        pair.relationType,
        pair.subjectId
      ])
    ).toEqual([
      ["n-c", "suggest", null, "n-source"],
      ["n-b", "suggest", "contradicts", "n-source"]
    ]);
    expect(handed[0]!.pairs[0]).toMatchObject({
      probability: null,
      calibration: "uncalibrated",
      score: 0.95
    });
    // Raw verdicts are recorded per judged direction, with the title-and-idea hashes.
    expect(
      mocks.decisions.record.mock.calls.map(([record]) => [record.targetAtomicNoteId, record.score])
    ).toEqual([
      ["n-a", 0.6],
      ["n-b", 0.7],
      ["n-c", 0.95]
    ]);
    expect(mocks.decisions.record.mock.calls[0]![0]).toMatchObject({
      sourceAtomicNoteId: "n-source",
      sourceContentHash: atomicNoteDecisionContentHash(source)
    });
  });

  it("answers a direction from the reverse verdict, which keeps candidate -> note as its subject", async () => {
    mocks.decisions.findReverseVerdicts.mockResolvedValue(
      new Map([["n-c", { score: 0.9, relationType: "supports" }]])
    );
    ai.runDefaultTask.mockResolvedValue(verdicts([1, 10, "related"], [2, 10, "related"]));
    const { handed } = await run([source.id]);
    const prompt = generativeCalls()[0]![1] as string;
    expect(prompt).not.toContain("Title: Gamma");
    expect(handed[0]!.pairs).toEqual([
      expect.objectContaining({
        candidateId: "n-c",
        relationType: "supports",
        subjectId: "n-c",
        decisionSource: "reverse_cache"
      })
    ]);
    // A reused verdict is not a judgment of this direction: no row is written for it.
    expect(mocks.decisions.record.mock.calls.map(([record]) => record.targetAtomicNoteId)).toEqual([
      "n-a",
      "n-b"
    ]);
  });

  it("keeps valid items and asks once again only for the missing ones", async () => {
    ai.runDefaultTask
      .mockResolvedValueOnce(verdicts([1, 10, "related"], [3, 95, "extends"]))
      .mockResolvedValueOnce(verdicts([2, 70, "supports"]));
    const { handed } = await run([source.id]);
    const [first, repair] = generativeCalls();
    expect(repair![1]).toContain("[2]\nTitle: Beta");
    expect(repair![1]).not.toContain("Title: Alpha");
    expect(first![2]).toMatchObject({ operation: "note_matching_reranking", attempt: 0 });
    expect(repair![2]).toMatchObject({ operation: "note_matching_reranking_repair", attempt: 1 });
    expect(handed[0]!.pairs.map((pair) => pair.candidateId)).toEqual(["n-c", "n-b"]);
  });

  it("fails visibly, before the checkpoint, when a required decision stays incomplete after its repair", async () => {
    const cause = new Error("provider_timeout");
    ai.runDefaultTask
      .mockResolvedValueOnce(verdicts([1, 10, "related"]))
      .mockRejectedValueOnce(cause);
    const onNoteCompleted = vi.fn();
    const failure = await matcher()
      .matchNotes({
        noteIds: [source.id],
        vectors: new Map([[source.id, vectorOf()]]),
        onNoteCompleted,
        handOff: vi.fn()
      })
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("errors.matching.rerankingFailed");
    expect((failure as Error).cause).toBe(cause);
    expect(onNoteCompleted).not.toHaveBeenCalled();
    expect(mocks.decisions.record).not.toHaveBeenCalled();
  });

  it("builds the same prompt for the same notes under any UUID assignment", async () => {
    const prompts: string[] = [];
    for (const ids of uuidAssignments(4)) {
      registry.clear();
      const [s, x, y, z] = ids as [string, string, string, string];
      const subject = note(s, "Source");
      const alpha = note(x, "Alpha");
      const beta = note(y, "Beta");
      const gamma = note(z, "Gamma");
      lists({
        text: [
          [beta, 0.5],
          [alpha, 0.5]
        ],
        vector: [
          [alpha, 0.5],
          [beta, 0.5]
        ],
        graph: [[gamma, 0.4]]
      });
      ai.runDefaultTask.mockClear();
      ai.runDefaultTask.mockResolvedValue(
        verdicts([1, 10, "related"], [2, 10, "related"], [3, 10, "related"])
      );
      await run([subject.id], { withVector: false });
      prompts.push(generativeCalls()[0]![1] as string);
    }
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]!.indexOf("[1]\nTitle: Alpha")).toBeGreaterThan(-1);
    expect(prompts[0]!.indexOf("[3]\nTitle: Gamma")).toBeGreaterThan(prompts[0]!.indexOf("[2]"));
  });

  it("maps v9 types into the write vocabulary, leaving the rest to the typer", () => {
    expect(mapGenerativeRelationType("contrasts")).toBe("contradicts");
    expect(mapGenerativeRelationType("depends_on")).toBe("depends_on");
    expect(mapGenerativeRelationType("similar_to")).toBeNull();
    expect(mapGenerativeRelationType("related")).toBeNull();
    expect(mapGenerativeRelationType("mentions")).toBeNull();
  });
});

describe("decider identities", () => {
  const generative = {
    provider: "openai-codex",
    baseUrl: null,
    modelId: "gpt-5.6-luna",
    runtime: "remote",
    repository: null,
    revision: null,
    quantization: null,
    parameters: { reasoningLevel: "off", temperature: 0, maxTokens: 4096, contextWindow: 128000 },
    promptFingerprint: "prompt-a"
  };

  it("keys the generative decider by model, prompt and reasoning, never by output budgets", () => {
    const key = atomicNoteDeciderKey(generative);
    expect(
      atomicNoteDeciderKey({
        ...generative,
        parameters: { temperature: 0, reasoningLevel: "off", maxTokens: 512 }
      })
    ).toBe(key);
    for (const changed of [
      { ...generative, modelId: "gpt-5.6-terra" },
      { ...generative, baseUrl: "http://127.0.0.1:8080" },
      { ...generative, revision: "abc" },
      { ...generative, promptFingerprint: "prompt-b" },
      { ...generative, parameters: { ...generative.parameters, reasoningLevel: "low" } }
    ])
      expect(atomicNoteDeciderKey(changed)).not.toBe(key);
  });

  it("hashes only the title and idea the generative decider sees", () => {
    const shown = { title: "Retrieval", ideaStatement: "Retrieval improves recall." };
    const hash = atomicNoteDecisionContentHash(shown);
    expect(
      atomicNoteDecisionContentHash({ ...shown, bodyMarkdown: "Other body" } as typeof shown)
    ).toBe(hash);
    expect(atomicNoteDecisionContentHash({ ...shown, title: "Recall" })).not.toBe(hash);
    // The separator keeps "ab" + "c" apart from "a" + "bc".
    expect(atomicNoteDecisionContentHash({ title: "ab", ideaStatement: "c" })).not.toBe(
      atomicNoteDecisionContentHash({ title: "a", ideaStatement: "bc" })
    );
  });

  it("keys the ranker by instruction, template, model, runtime build and helper batch (D13)", () => {
    const base = {
      instructionSha256: "a".repeat(64),
      template: "relation-pair-text-v1",
      bodyCharacters: 400,
      model: mlxModel,
      runtimeBuild: "build-1",
      parameters: { batchSize: 16 }
    };
    const key = rankerDeciderCacheKey(base);
    for (const changed of [
      { ...base, instructionSha256: "b".repeat(64) },
      { ...base, bodyCharacters: 600 },
      { ...base, model: { ...mlxModel, revision: "other" } },
      { ...base, model: { ...mlxModel, artifactSha256: "c".repeat(64) } },
      { ...base, runtimeBuild: "build-2" },
      { ...base, parameters: { batchSize: 1 } },
      { ...base, parameters: {} }
    ])
      expect(rankerDeciderCacheKey(changed)).not.toBe(key);
    // The calibration identity has neither the runtime build nor the batch size.
    expect(
      rankerCalibrationIdentity({
        instructionSha256: base.instructionSha256,
        config: relationsConfig,
        model: mlxModel
      })
    ).toEqual({
      contract: "relation-decide-v1",
      instructionSha256: base.instructionSha256,
      template: "relation-pair-text-v1",
      bodyCharacters: 600,
      rule: "mean",
      ...mlxModel
    });
  });
});
