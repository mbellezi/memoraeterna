import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@app/conversion";
import {
  AiCassette,
  AiModelRegistry,
  createAiScheduler,
  DecisionsDisabledError,
  DecisionsUnavailableError,
  decisionsLaneKey,
  resolveAiLaneRuntimeConfig,
  resolveDecisionsLimits,
  setAiAdapterDecorator
} from "@app/ai";
import {
  calibrate,
  frozenRelationCalibrations,
  RelationsConfigSchema,
  relationsConfig,
  renderRelationPairText,
  waitingForDeciderSkipReason,
  type RelationsConfig
} from "@app/domain";
import type { PgPool } from "@app/db";

import type { AiService } from "../ai-service.js";
import {
  DecisionsRuntime,
  type DecisionsDecideInput,
  type DecisionsResolution
} from "../ai-decisions.js";
import { decisionsScenarioNotes } from "./__fixtures__/decisions-scenario.js";
import { decisionsDesign, relationDecisionsInstruction } from "./decisions-identity.js";
import { StoredDecidedNoteSchema } from "./relation-link.js";
import {
  relationDecideInstruction,
  relationDecisionsOperation,
  RelationMatcher,
  type DecidedNote,
  type MatcherNoteVector
} from "./relation-matcher.js";

/**
 * The relation matcher with the Decisions API as its decider (F3 plan decision 30): the local
 * retrieval builds the candidate lists, Decisions scores them under its own calibration, and the
 * local ranker decides when it cannot. The repositories are mocks; `decideWithDecisions` is a fake
 * table of log-odds here (the adapter, the cassette and the lane have tests of their own).
 */

const mocks = vi.hoisted(() => ({
  notes: {
    findById: vi.fn(),
    findTextMatchingCandidates: vi.fn(),
    findVectorMatchingCandidates: vi.fn(),
    filterRetrievableCandidateIds: vi.fn(),
    scoreMatchingCandidates: vi.fn(),
    findManyByIds: vi.fn()
  },
  relations: { pairStatuses: vi.fn() },
  decisions: {
    findVerdicts: vi.fn(),
    findReverseVerdicts: vi.fn(),
    record: vi.fn(),
    findRankerScores: vi.fn(),
    recordRankerScores: vi.fn(),
    findDecidedPartners: vi.fn()
  },
  aiConfig: { getDefaultTask: vi.fn(), recordTaskRun: vi.fn() },
  graph: { findAtomicNoteCandidates: vi.fn() },
  localModels: { findById: vi.fn() },
  states: { read: vi.fn(), record: vi.fn() },
  settings: { get: vi.fn(), set: vi.fn() },
  debug: { record: vi.fn() }
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
  createSettingsRepository: () => mocks.settings,
  createSimilarityDebugRepository: () => mocks.debug
}));
vi.mock("@app/ai", async (original) => ({
  ...(await original<typeof import("@app/ai")>()),
  decideValidationForCatalogEntry: () => ({ runtimeBuild: "build-1" }),
  decideValidationParityFailed: () => false
}));

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
const note = (id: string, title: string): Note => {
  const value: Note = {
    id,
    title,
    ideaStatement: `Idea of ${title}`,
    bodyMarkdown: `Body of ${title}.`,
    status: "active",
    supersessionStatus: "current",
    createdFromSourceItemId: `source-${id}`,
    metadata: {}
  };
  registry.set(id, value);
  return value;
};
const titleOf = (text: string) => /^Title: (.*)$/mu.exec(text)![1]!;

const space = { model: "embed", provider: "local", runtime: "local", spaceKey: "space-1" };
const vectorOf = (): MatcherNoteVector => ({
  embedding: Array.from({ length: 256 }, () => 0.1),
  space
});

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
let routes: Record<string, unknown>;

/** Log-odds of the fake Decisions API by "query title>candidate title"; any other pair is unrelated. */
const decisionTable = new Map<string, number>();
/** A probability of 0.00 on the bake-off scale: what the Decisions API says of an unrelated pair. */
const unrelated = -16.118095550958316;
/** Log-odds of the fake local ranker by the same key; any other pair is -5. */
const rankerTable = new Map<string, number>();

const ai = {
  runDefaultTask: vi.fn(),
  rankPairs: vi.fn(),
  decideRouteStatus: vi.fn(),
  traceOperation: vi.fn(
    async (_operation: string, _context: unknown, run: () => Promise<unknown>) => await run()
  ),
  resolveDecisions: vi.fn<() => Promise<DecisionsResolution>>(),
  decideWithDecisions: vi.fn()
};

function matcher(config: RelationsConfig) {
  return new RelationMatcher({
    getPool: () => ({}) as PgPool,
    ai: ai as unknown as AiService,
    config
  });
}

async function run(noteIds: string[], config: RelationsConfig, signal?: AbortSignal) {
  const handed: DecidedNote[] = [];
  const result = await matcher(config).matchNotes({
    noteIds,
    vectors: new Map(noteIds.map((id) => [id, vectorOf()] as const)),
    signal,
    handOff: async (decided) => {
      handed.push(decided);
      return decided.pairs.length;
    }
  });
  return { result, handed };
}

const uncalibrated = RelationsConfigSchema.parse({});

/** T58's frozen Decisions entry (plan decision 30): apply from 2.228, suggest from 1.593. */
const frozenDecisions = frozenRelationCalibrations.find(
  (entry) => entry.identity.runtimeKind === "remote"
)!;

/**
 * The frozen Decisions bands under the identity the product derives: the shipped entry, which T58
 * re-froze on the product's own online requests (see "the shipped calibration").
 */
const refrozen = (() => {
  const { identity } = decisionsDesign({
    instruction: relationDecisionsInstruction(),
    config: RelationsConfigSchema.parse({})
  });
  return RelationsConfigSchema.parse({
    calibrations: [
      ...frozenRelationCalibrations.filter((entry) => entry.identity.runtimeKind !== "remote"),
      {
        ...frozenDecisions,
        identity,
        parity: { requestDesignSha256: identity.requestDesignSha256 }
      }
    ]
  });
})();

let source: Note, a: Note, b: Note, c: Note;
beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of [ai.runDefaultTask, ai.rankPairs, ai.decideRouteStatus]) mock.mockReset();
  ai.resolveDecisions.mockReset();
  ai.decideWithDecisions.mockReset();
  registry.clear();
  decisionTable.clear();
  rankerTable.clear();
  source = note("n-source", "Source");
  a = note("n-a", "Alpha");
  b = note("n-b", "Beta");
  c = note("n-c", "Gamma");
  mocks.notes.findById.mockImplementation(async (id: string) => registry.get(id) ?? null);
  mocks.notes.filterRetrievableCandidateIds.mockImplementation(
    async (input: { candidateIds: string[] }) =>
      new Set(input.candidateIds.filter((id) => registry.has(id)))
  );
  mocks.notes.scoreMatchingCandidates.mockImplementation(
    async ({ candidateIds }: { candidateIds: string[] }) =>
      candidateIds.flatMap((id) => {
        const found = registry.get(id);
        return found ? [{ note: found, textScore: 0.1, vectorScore: 0.5, hasVector: true }] : [];
      })
  );
  mocks.notes.findTextMatchingCandidates.mockResolvedValue([
    { note: a, textScore: 0.9, vectorScore: 0 }
  ]);
  mocks.notes.findVectorMatchingCandidates.mockResolvedValue(
    [
      [b, 0.6],
      [c, 0.55],
      [a, 0.99]
    ].map(([n, s]) => ({ note: n, textScore: 0, vectorScore: s }))
  );
  mocks.graph.findAtomicNoteCandidates.mockResolvedValue([]);
  mocks.relations.pairStatuses.mockResolvedValue(new Map());
  mocks.decisions.findRankerScores.mockResolvedValue(new Map());
  mocks.decisions.findDecidedPartners.mockResolvedValue(new Map());
  mocks.notes.findManyByIds.mockImplementation(async (ids: string[]) =>
    ids.flatMap((id) => (registry.has(id) ? [registry.get(id)!] : []))
  );
  mocks.states.read.mockResolvedValue(new Map());
  mocks.localModels.findById.mockResolvedValue({
    id: "ranker-model",
    catalogId: "mlx-qwen3-reranker-0.6b",
    metadata: {}
  });
  mocks.settings.get.mockResolvedValue(null);
  routes = { "class:decide": rankerRoute };
  mocks.aiConfig.getDefaultTask.mockImplementation(
    async (task: string, _profile: unknown, keys: string[] = [task]) =>
      keys.map((key) => routes[key]).find(Boolean) ?? null
  );
  ai.decideRouteStatus.mockResolvedValue("ready");
  ai.rankPairs.mockImplementation(
    async (input: { pairs: Array<{ query: string; document: string }> }) => {
      const logOdds = input.pairs.map(
        (pair) => rankerTable.get(`${titleOf(pair.query)}>${titleOf(pair.document)}`) ?? -5
      );
      return {
        logOdds,
        scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
        tokenCounts: logOdds.map(() => 300),
        truncated: logOdds.map(() => false),
        aiTaskRunIds: ["rank-1"],
        calls: 1,
        profileId: "ranker-profile",
        localModelId: "ranker-model",
        provider: "local",
        modelId: "Qwen3-Reranker-0.6B",
        runtime: "mlx",
        runtimeBuild: "build-1",
        parameters: { batchSize: 16 },
        uncalibrated: false,
        durationMs: 10,
        queueMs: 0
      };
    }
  );
  ai.resolveDecisions.mockResolvedValue({ use: "decisions" });
  ai.decideWithDecisions.mockImplementation(async (input: DecisionsDecideInput) => ({
    decisions: input.lists.map((list, listIndex) =>
      list.candidates.map((text, candidateIndex) => {
        const logOdds = decisionTable.get(`${titleOf(list.query)}>${titleOf(text)}`) ?? unrelated;
        return {
          probability: 1 / (1 + Math.exp(-logOdds)),
          logOdds,
          aiTaskRunId: `decisions-${listIndex}-${candidateIndex}`
        };
      })
    ),
    calls: input.lists.length * 2,
    inputTokens: 100,
    costUsd: 0.00001,
    replayed: 0
  }));
});

const decisionsKey = (config: RelationsConfig) =>
  decisionsDesign({ instruction: relationDecisionsInstruction(), config }).cacheKey;

describe("the Decisions decider scoring the retrieval's candidate lists", () => {
  /** Every call so far, in order. */
  const askedCalls = () =>
    ai.decideWithDecisions.mock.calls.map(
      ([input]) => input as DecisionsDecideInput & { sourceIds: string[] }
    );
  const queryTitles = (call: DecisionsDecideInput) => call.lists.map((list) => titleOf(list.query));

  it("asks the note against its candidates in one list, then each candidate that can still be accepted against the note", async () => {
    decisionTable.set("Source>Alpha", 3).set("Alpha>Source", 2);
    const { result, handed } = await run([source.id], uncalibrated);
    expect(ai.rankPairs).not.toHaveBeenCalled();
    const [forward, backward] = askedCalls();
    expect(ai.decideWithDecisions).toHaveBeenCalledTimes(2);
    for (const call of [forward!, backward!])
      expect(call).toMatchObject({
        operation: relationDecisionsOperation,
        instruction: relationDecisionsInstruction(),
        priority: "P2",
        stage: "atomic_note_matching"
      });
    expect(forward!.sourceIds.sort()).toEqual([
      "source-n-a",
      "source-n-b",
      "source-n-c",
      "source-n-source"
    ]);
    // The retrieval's candidates in content order, as one list of the note.
    const own = renderRelationPairText(source, 600);
    expect(forward!.lists).toEqual([
      {
        query: own,
        candidates: [a, b, c].map((candidate) => renderRelationPairText(candidate, 600))
      }
    ]);
    // Beta and Gamma scored p 0.00 from the note: no mean can reach the band, so neither is asked
    // about in the other direction. Alpha is.
    expect(backward!.lists).toEqual([{ query: renderRelationPairText(a, 600), candidates: [own] }]);
    // Each direction's log-odds is recorded under the Decisions cache key, not the ranker's.
    const key = decisionsKey(uncalibrated);
    expect(mocks.decisions.findRankerScores.mock.calls[0]![0].deciderKey).toBe(key);
    expect(
      mocks.decisions.recordRankerScores.mock.calls.map(([record]) => [
        record.deciderKey === key,
        record.loAtomicNoteId,
        record.loToHi,
        record.hiToLo,
        record.aiTaskRunId
      ])
    ).toEqual([
      // The note's direction to each candidate is stored as soon as its list is scored ...
      [true, "n-a", null, 3, "decisions-0-0"],
      [true, "n-b", null, unrelated, "decisions-0-1"],
      [true, "n-c", null, unrelated, "decisions-0-2"],
      // ... and Alpha's direction back to the note, with the run that scored it.
      [true, "n-a", 2, null, "decisions-0-0"]
    ]);
    expect(result).toMatchObject({ decided: 1, accepted: 1, decider: "decisions" });
    expect(result.decisionsFallback).toBeUndefined();
    expect(handed[0]!.decider).toEqual({
      kind: "decisions",
      mode: "ranker",
      deciderKey: key,
      calibration: "uncalibrated",
      profileId: null,
      modelId: "gpt-6-luna"
    });
    expect(mocks.states.record.mock.calls[0]![0]).toMatchObject({ deciderKey: key });
  });

  describe("the request that cannot change the outcome is not sent (a lossless filter)", () => {
    // A pair's score is the mean of its directions, each at most +16.12: a direction from the note
    // below 2 x edge - 16.12 leaves the mean under the edge whatever the answer is.
    it("holds back a candidate whose direction from the note cannot reach the uncalibrated pass", async () => {
      // The pass is 1.3249: -13.47 is the lowest direction that can still reach it.
      decisionTable.set("Source>Alpha", -13.5).set("Source>Beta", -13.4).set("Source>Gamma", 0);
      decisionTable.set("Beta>Source", 16.118).set("Gamma>Source", 3);
      const { handed } = await run([source.id], uncalibrated);
      const [, backward] = askedCalls();
      expect(queryTitles(backward!)).toEqual(["Beta", "Gamma"]);
      expect(handed[0]!.pairs.map((pair) => [pair.candidateId, pair.score])).toEqual([
        ["n-c", 1.5],
        ["n-b", (-13.4 + 16.118) / 2]
      ]);
    });

    it("uses the lowest edge of the frozen calibration: 1.593 asks for a direction from -12.93", async () => {
      decisionTable.set("Source>Alpha", -13).set("Source>Beta", -12.9).set("Source>Gamma", 0);
      decisionTable.set("Beta>Source", 16.118).set("Gamma>Source", 16.118);
      const { handed } = await run([source.id], refrozen);
      const [, backward] = askedCalls();
      // Alpha (-13) cannot reach 1.593 (mean 1.559 at best); Beta (-12.9) and Gamma can.
      expect(queryTitles(backward!)).toEqual(["Beta", "Gamma"]);
      expect(handed[0]!.decider.calibration).toBe("frozen");
    });

    it("asks every candidate when the pair's score is the max of its directions", async () => {
      await run([source.id], RelationsConfigSchema.parse({ decide: { rule: "max" } }));
      const [, backward] = askedCalls();
      expect(queryTitles(backward!)).toEqual(["Alpha", "Beta", "Gamma"]);
    });

    it("sends nothing more when no candidate can be accepted, and stores what it asked", async () => {
      const { result, handed } = await run([source.id], uncalibrated);
      expect(ai.decideWithDecisions).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ decided: 1, accepted: 0 });
      expect(handed).toEqual([]);
      expect(
        mocks.decisions.recordRankerScores.mock.calls.map(([record]) => [
          record.loAtomicNoteId,
          record.loToHi,
          record.hiToLo
        ])
      ).toEqual([
        ["n-a", null, unrelated],
        ["n-b", null, unrelated],
        ["n-c", null, unrelated]
      ]);
    });
  });

  describe("each queried note carries its decided neighbourhood, as the frozen design sends it", () => {
    const partnersOf = (...entries: Array<[string, string[]]>) =>
      mocks.decisions.findDecidedPartners.mockResolvedValue(new Map(entries));
    const titlesOf = (list: { candidates: readonly string[] }) => list.candidates.map(titleOf);

    it("adds the notes a candidate was decided against to its request, and reads only the new direction", async () => {
      note("n-x2", "Xi");
      note("n-x1", "Chi");
      partnersOf(["n-a", ["n-x2", "n-x1"]]);
      decisionTable.set("Source>Alpha", 3).set("Alpha>Source", 2);
      // The makeup's own scores are never read: an answer of 16 for Alpha > Chi changes nothing.
      decisionTable.set("Alpha>Chi", 16).set("Alpha>Xi", 16);
      const { handed } = await run([source.id], uncalibrated);
      expect(
        mocks.decisions.findDecidedPartners.mock.calls.map(([lookup]) => lookup.noteIds)
      ).toEqual([["n-source"], ["n-a"]]);
      expect(mocks.decisions.findDecidedPartners.mock.calls[0]![0].deciderKey).toBe(
        decisionsKey(uncalibrated)
      );
      const [forward, backward] = askedCalls();
      // Content order (titles), the note being queried about included.
      expect(titlesOf(backward!.lists[0]!)).toEqual(["Chi", "Source", "Xi"]);
      // The note's own list has no partner of its own yet: just its candidates.
      expect(titlesOf(forward!.lists[0]!)).toEqual(["Alpha", "Beta", "Gamma"]);
      // Only the three candidate pairs are stored, with the directions asked for.
      expect(
        mocks.decisions.recordRankerScores.mock.calls.map(([record]) => record.loAtomicNoteId)
      ).toEqual(["n-a", "n-b", "n-c", "n-a"]);
      expect(handed[0]!.pairs[0]).toMatchObject({ candidateId: "n-a", score: 2.5 });
      // The notes of the makeup took part in the call: they are among its sources.
      expect(backward!.sourceIds).toEqual(expect.arrayContaining(["source-n-x1", "source-n-x2"]));
    });

    it("fills a request up to its neighbourhood limit and leaves out what is not a current note", async () => {
      const partners = Array.from({ length: 25 }, (_, index) =>
        note(`n-p${String(index).padStart(2, "0")}`, `Partner ${String(index).padStart(2, "0")}`)
      );
      registry.get("n-p03")!.status = "rejected";
      partnersOf(["n-a", partners.map((partner) => partner.id)]);
      decisionTable.set("Source>Alpha", 3);
      await run([source.id], uncalibrated);
      const [, backward] = askedCalls();
      const alpha = backward!.lists[0]!;
      // The note itself and 11 partners fit (12): the first 11 current ones by content.
      expect(alpha.candidates).toHaveLength(12);
      expect(titlesOf(alpha)).toContain("Source");
      expect(titlesOf(alpha)).not.toContain("Partner 03");
      expect(titlesOf(alpha)).toContain("Partner 11");
      expect(titlesOf(alpha)).not.toContain("Partner 12");
    });

    it("never trims a list's own targets, and gives them no makeup", async () => {
      const many = Array.from({ length: 22 }, (_, index) =>
        note(`n-m${String(index).padStart(2, "0")}`, `Many ${String(index).padStart(2, "0")}`)
      );
      mocks.notes.findVectorMatchingCandidates.mockResolvedValue(
        many.map((candidate) => ({ note: candidate, textScore: 0, vectorScore: 0.5 }))
      );
      mocks.notes.findTextMatchingCandidates.mockResolvedValue([]);
      partnersOf(["n-source", ["n-a"]]);
      await run(
        [source.id],
        RelationsConfigSchema.parse({ retrieval: { fusedK: 25, vectorK: 50 } })
      );
      const [forward] = askedCalls();
      expect(forward!.lists[0]!.candidates).toHaveLength(22);
      expect(titlesOf(forward!.lists[0]!)).not.toContain("Alpha");
    });

    it("keeps the cached candidates in the note's own list as makeup when it asks for the rest", async () => {
      mocks.decisions.findRankerScores.mockResolvedValue(
        new Map([["n-a:n-source", { loToHi: 1, hiToLo: 2 }]])
      );
      decisionTable.set("Source>Beta", 3).set("Beta>Source", 3);
      await run([source.id], uncalibrated);
      const [forward, backward] = askedCalls();
      // Alpha is decided already, so only Beta and Gamma are asked about; Alpha stays in the request.
      expect(titlesOf(forward!.lists[0]!)).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(queryTitles(backward!)).toEqual(["Beta"]);
      expect(
        mocks.decisions.recordRankerScores.mock.calls.map(([record]) => record.loAtomicNoteId)
      ).toEqual(["n-b", "n-c", "n-b"]);
    });
  });

  it("stores each direction with the run that scored it, as soon as it is scored", async () => {
    let call = 0;
    ai.decideWithDecisions.mockImplementation(async (input: DecisionsDecideInput) => {
      call += 1;
      return {
        decisions: input.lists.map((list) =>
          list.candidates.map(() => ({ probability: 0.95, logOdds: 3, aiTaskRunId: `run-${call}` }))
        ),
        calls: 1,
        inputTokens: 1,
        costUsd: 0,
        replayed: 0
      };
    });
    await run([source.id], uncalibrated);
    // The note's list is call 1, the candidates' requests are call 2: a direction keeps its own run.
    expect(
      mocks.decisions.recordRankerScores.mock.calls.map(([record]) => [
        record.loAtomicNoteId,
        record.loToHi,
        record.hiToLo,
        record.aiTaskRunId
      ])
    ).toEqual([
      ["n-a", null, 3, "run-1"],
      ["n-b", null, 3, "run-1"],
      ["n-c", null, 3, "run-1"],
      ["n-a", 3, null, "run-2"],
      ["n-b", 3, null, "run-2"],
      ["n-c", 3, null, "run-2"]
    ]);
  });

  it("keeps the directions already paid for when a later request fails", async () => {
    decisionTable.set("Source>Alpha", 3);
    const forward = ai.decideWithDecisions.getMockImplementation()!;
    ai.decideWithDecisions
      .mockImplementationOnce(forward)
      .mockRejectedValue(new DecisionsUnavailableError("network"));
    rankerTable.set("Source>Alpha", 9).set("Alpha>Source", 9);
    const { result, handed } = await run([source.id], uncalibrated);
    // The reverse request failed: the ranker decided the note, but the note's directions that had
    // been scored were stored under the Decisions key first, so a retry does not pay for them again.
    expect(handed[0]!.decider).toMatchObject({ kind: "ranker", fallback: "network" });
    expect(result.decisionsFallback).toEqual({ notes: 1, reason: "network" });
    const key = decisionsKey(uncalibrated);
    expect(
      mocks.decisions.recordRankerScores.mock.calls
        .filter(([record]) => record.deciderKey === key)
        .map(([record]) => [record.loAtomicNoteId, record.hiToLo])
    ).toEqual([
      ["n-a", 3],
      ["n-b", unrelated],
      ["n-c", unrelated]
    ]);
  });

  it("sends no text of a note outside the re-match fence as the makeup of a request", async () => {
    note("n-x1", "Chi");
    note("n-x2", "Xi");
    mocks.decisions.findDecidedPartners.mockResolvedValue(new Map([["n-a", ["n-x1", "n-x2"]]]));
    mocks.notes.filterRetrievableCandidateIds.mockImplementation(
      async (input: { candidateIds: string[]; fence?: unknown }) =>
        new Set(
          input.candidateIds.filter((id) => registry.has(id) && !(input.fence && id === "n-x2"))
        )
    );
    decisionTable.set("Source>Alpha", 3).set("Alpha>Source", 2);
    await matcher(uncalibrated).matchNotes({
      noteIds: [source.id],
      vectors: new Map([[source.id, vectorOf()]]),
      fence: { rootSourceItemIds: ["root-1"] },
      handOff: async (decided) => decided.pairs.length
    });
    const [, backward] = askedCalls();
    // Chi is in view of the fence, Xi is not: only Chi's text goes to the provider.
    expect(backward!.lists[0]!.candidates.map(titleOf)).toEqual(["Chi", "Source"]);
    expect(JSON.stringify(askedCalls())).not.toContain("Xi");
  });

  it("only suggests while it has no frozen calibration: the mean of both directions from the pass", async () => {
    // Alpha: mean 2.75 (far above the pass), Beta: mean 1.3 (just under 1.3249), Gamma: mean 1.325.
    decisionTable.set("Source>Alpha", 3.5).set("Alpha>Source", 2);
    decisionTable.set("Source>Beta", 1.5).set("Beta>Source", 1.1);
    decisionTable.set("Source>Gamma", 1.65).set("Gamma>Source", 1);
    const { handed } = await run([source.id], uncalibrated);
    expect(
      handed[0]!.pairs.map((pair) => [pair.candidateId, pair.band, pair.score, pair.probability])
    ).toEqual([
      ["n-a", "suggest", 2.75, null],
      ["n-c", "suggest", 1.325, null]
    ]);
    // Never an automatic apply, whatever the score.
    decisionTable.set("Source>Alpha", 16).set("Alpha>Source", 16);
    const { handed: again } = await run([source.id], uncalibrated);
    expect(again[0]!.pairs.every((pair) => pair.band === "suggest")).toBe(true);
    expect(again[0]!.pairs[0]).toMatchObject({ calibration: "uncalibrated" });
  });

  it("applies in its own frozen apply band and suggests below it, with the calibrated probability", async () => {
    const config = refrozen;
    decisionTable.set("Source>Alpha", 3).set("Alpha>Source", 2.6);
    decisionTable.set("Source>Beta", 2).set("Beta>Source", 1.4);
    decisionTable.set("Source>Gamma", 1).set("Gamma>Source", 1);
    const { handed } = await run([source.id], config);
    const entry = frozenDecisions.kind === "isotonic" ? frozenDecisions : null!;
    expect(handed[0]!.decider).toMatchObject({ kind: "decisions", calibration: "frozen" });
    expect(
      handed[0]!.pairs.map((pair) => [pair.candidateId, pair.band, pair.score, pair.calibration])
    ).toEqual([
      ["n-a", "apply", 2.8, "frozen"],
      ["n-b", "suggest", 1.7, "frozen"]
    ]);
    expect(handed[0]!.pairs.map((pair) => pair.probability)).toEqual([
      calibrate(2.8, entry.blocks),
      calibrate(1.7, entry.blocks)
    ]);
  });

  it("names the requests it sends: the frozen entry's identity, request design included", async () => {
    const { identity, calibration } = decisionsDesign({
      instruction: relationDecisionsInstruction(),
      config: relationsConfig
    });
    // Spike A's mechanism instruction, the frozen contract, the OpenAI provider and the model are
    // the frozen ones, and so is the request design: T58 re-froze on the product's partial, online
    // requests (dd654932) after the bake-off's dense design (0e1ebd94) proved not to be the one sent.
    expect(identity).toMatchObject({
      contract: "relation-decide-decisions-v1",
      instructionSha256: "1fc9a2eee90e36636d344db2c7c2566974ac47e67bcbc43eeff250bfd78b0164",
      provider: "openai",
      model: "gpt-6-luna",
      runtimeKind: "remote"
    });
    const denseSha = "0e1ebd94857f256b1ea72cd5883c803c2b0db6d87277009b78c6679eaca4098c";
    expect(identity).toEqual(frozenDecisions.identity);
    expect((identity as { requestDesignSha256: string }).requestDesignSha256).not.toBe(denseSha);
    // So the shipped calibration applies to it.
    expect(calibration).toEqual(frozenDecisions);
    // The local ranker's instruction is another one: the catalog keeps the two apart.
    expect(sha256(relationDecideInstruction())).not.toBe(identity.instructionSha256);
  });

  it("the shipped calibration is the product's: it applies in its band, another neighbourhood only suggests", async () => {
    // Far above the frozen apply edge (2.228), under the shipped config: applied.
    decisionTable.set("Source>Alpha", 10).set("Alpha>Source", 10);
    const { handed } = await run([source.id], relationsConfig);
    expect(handed[0]!.decider).toMatchObject({ kind: "decisions", calibration: "frozen" });
    expect(handed[0]!.pairs).toHaveLength(1);
    expect(handed[0]!.pairs[0]).toMatchObject({
      candidateId: "n-a",
      band: "apply",
      calibration: "frozen"
    });
    // The derived identity finds the same entry.
    const { handed: refrozenHanded } = await run([source.id], refrozen);
    expect(refrozenHanded[0]!.pairs[0]).toMatchObject({ band: "apply", calibration: "frozen" });
    // Changing what a request carries is another identity: nothing is reused or applied.
    const narrower = new RelationMatcher({
      getPool: () => ({}) as PgPool,
      ai: ai as unknown as AiService,
      config: refrozen,
      decisionsLimits: resolveDecisionsLimits({ maxNeighbourhood: 6 })
    });
    const handedNarrow: DecidedNote[] = [];
    await narrower.matchNotes({
      noteIds: [source.id],
      vectors: new Map([[source.id, vectorOf()]]),
      handOff: async (decided) => {
        handedNarrow.push(decided);
        return decided.pairs.length;
      }
    });
    expect(handedNarrow[0]!.decider).toMatchObject({ calibration: "uncalibrated" });
    expect(handedNarrow[0]!.decider.deciderKey).not.toBe(handed[0]!.decider.deciderKey);
  });

  it("keeps the calibration to the identity it was frozen for: another design is uncalibrated", async () => {
    const identity = { ...frozenDecisions.identity, requestDesignSha256: "c".repeat(64) };
    const edited = RelationsConfigSchema.parse({
      calibrations: [
        {
          ...frozenDecisions,
          identity,
          parity: { requestDesignSha256: identity.requestDesignSha256 }
        }
      ]
    });
    decisionTable.set("Source>Alpha", 5).set("Alpha>Source", 5);
    const { handed } = await run([source.id], edited);
    expect(handed[0]!.decider.calibration).toBe("uncalibrated");
    expect(handed[0]!.pairs[0]).toMatchObject({ band: "suggest", probability: null });
  });

  it("reuses what the Decisions key stored and asks only for the directions it lacks", async () => {
    mocks.decisions.findRankerScores.mockResolvedValue(
      new Map([
        // Alpha: both directions stored. Beta: only the note's direction (n-b sorts before n-source).
        ["n-a:n-source", { loToHi: 1, hiToLo: 2 }],
        ["n-b:n-source", { loToHi: null, hiToLo: 4 }]
      ])
    );
    decisionTable.set("Beta>Source", 2);
    const { handed } = await run([source.id], uncalibrated);
    const [forward, backward] = askedCalls();
    // Gamma is the only candidate asked about from the note (Alpha and Beta stay in its list as
    // makeup), and Gamma scores p 0.00, so only Beta's other direction is asked, at its stored 4.
    expect(forward!.lists[0]!.candidates.map(titleOf)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(queryTitles(backward!)).toEqual(["Beta"]);
    expect(
      mocks.decisions.recordRankerScores.mock.calls.map(([record]) => [
        record.loAtomicNoteId,
        record.loToHi,
        record.hiToLo
      ])
    ).toEqual([
      ["n-c", null, unrelated],
      ["n-b", 2, null]
    ]);
    expect(
      handed[0]!.pairs.map((pair) => [pair.candidateId, pair.decisionSource, pair.score])
    ).toEqual([
      ["n-b", "model", 3],
      ["n-a", "cache", 1.5]
    ]);
  });

  it("asks for nothing when every direction is stored", async () => {
    mocks.decisions.findRankerScores.mockResolvedValue(
      new Map(
        ["n-a", "n-b", "n-c"].map((id) => [`${id}:n-source`, { loToHi: 3, hiToLo: 3 }] as const)
      )
    );
    const { handed } = await run([source.id], uncalibrated);
    expect(ai.decideWithDecisions).not.toHaveBeenCalled();
    expect(mocks.decisions.recordRankerScores).not.toHaveBeenCalled();
    expect(handed[0]!.pairs.every((pair) => pair.decisionSource === "cache")).toBe(true);
  });

  it("leaves a direction OpenAI refused undecided: it is not stored and the pair is not banded", async () => {
    ai.decideWithDecisions.mockImplementation(async (input: DecisionsDecideInput) => ({
      decisions: input.lists.map((list) =>
        list.candidates.map((text) =>
          titleOf(text) === "Alpha"
            ? { probability: null, logOdds: null, aiTaskRunId: "x" }
            : { probability: 0.99, logOdds: 4.6, aiTaskRunId: "y" }
        )
      ),
      calls: 1,
      inputTokens: 1,
      costUsd: 0,
      replayed: 0
    }));
    const { handed } = await run([source.id], uncalibrated);
    expect(handed[0]!.pairs.map((pair) => pair.candidateId)).toEqual(["n-b", "n-c"]);
    // Alpha has no direction from the note, so the other one is not asked either: nothing is stored.
    expect(
      mocks.decisions.recordRankerScores.mock.calls.map(([record]) => record.loAtomicNoteId)
    ).toEqual(["n-b", "n-c", "n-b", "n-c"]);
    expect(queryTitles(askedCalls()[1]!)).toEqual(["Beta", "Gamma"]);
  });

  it("hands on notes that the link job's checkpoint schema reads, whichever decider decided them", async () => {
    decisionTable.set("Source>Beta", 3).set("Beta>Source", 3);
    const { handed } = await run([source.id], uncalibrated);
    expect(StoredDecidedNoteSchema.parse(handed[0])).toMatchObject({
      decider: { kind: "decisions", profileId: null, modelId: "gpt-6-luna" }
    });
    ai.decideWithDecisions.mockRejectedValue(new DecisionsUnavailableError("network"));
    rankerTable.set("Source>Beta", 9).set("Beta>Source", 9);
    const { handed: fellBack } = await run([source.id], relationsConfig);
    expect(StoredDecidedNoteSchema.parse(fellBack[0])).toMatchObject({
      decider: { kind: "ranker", fallback: "network" }
    });
  });

  it("names a pair's subject only when its two directions differ by the typed margin, and checkpoints it (decision 31b)", async () => {
    // "Source>Alpha" is Alpha as the Document: Alpha (the lower note) scores 5 against 2.5 for
    // Source, so Alpha is the subject. Beta's directions are too close to name one.
    decisionTable.set("Source>Alpha", 5).set("Alpha>Source", 2.5);
    decisionTable.set("Source>Beta", 4).set("Beta>Source", 3.5);
    decisionTable.set("Source>Gamma", 2).set("Gamma>Source", 5);
    const { handed } = await run([source.id], uncalibrated);
    const subjects = new Map(handed[0]!.pairs.map((pair) => [pair.candidateId, pair]));
    expect(subjects.get("n-a")?.directionSubjectId).toBe("n-a");
    expect(subjects.get("n-b")?.directionSubjectId).toBeNull();
    // The Document with the higher score is the subject on either side of the pair.
    expect(subjects.get("n-c")?.directionSubjectId).toBe("n-source");
    // The checkpoint keeps it, and still reads a pair written before it existed.
    const stored = StoredDecidedNoteSchema.parse(handed[0]);
    expect(stored.pairs.find((pair) => pair.candidateId === "n-a")?.directionSubjectId).toBe("n-a");
    const before = { ...handed[0]!.pairs[0]! } as Record<string, unknown>;
    delete before.directionSubjectId;
    expect(() => StoredDecidedNoteSchema.parse({ ...handed[0], pairs: [before] })).not.toThrow();
    // The margin is typed configuration: 0.25 names Beta's too, 10 names none.
    const sharper = await run(
      [source.id],
      RelationsConfigSchema.parse({ decisions: { directionMarginLogOdds: 0.25 } })
    );
    expect(
      sharper.handed[0]!.pairs.find((pair) => pair.candidateId === "n-b")?.directionSubjectId
    ).toBe("n-b");
    const blunter = await run(
      [source.id],
      RelationsConfigSchema.parse({ decisions: { directionMarginLogOdds: 10 } })
    );
    expect(blunter.handed[0]!.pairs.map((pair) => pair.directionSubjectId)).toEqual([
      null,
      null,
      null
    ]);
  });

  it("keeps the checkpoint strict: a local decider has a profile, the Decisions API has none", async () => {
    decisionTable.set("Source>Beta", 3).set("Beta>Source", 3);
    const { handed } = await run([source.id], uncalibrated);
    const decisions = StoredDecidedNoteSchema.parse(handed[0]);
    const withDecider = (decider: Record<string, unknown>) => ({ ...decisions, decider });
    // The Decisions API with a profile row, or a ranker without one, is not a decided note.
    expect(
      StoredDecidedNoteSchema.safeParse(withDecider({ ...decisions.decider, profileId: "p-1" }))
        .success
    ).toBe(false);
    expect(
      StoredDecidedNoteSchema.safeParse(
        withDecider({ ...decisions.decider, kind: "ranker", profileId: null })
      ).success
    ).toBe(false);
    expect(
      StoredDecidedNoteSchema.safeParse(
        withDecider({ ...decisions.decider, kind: "generative", profileId: null })
      ).success
    ).toBe(false);
    // A row written before the Decisions decider existed (a ranker, no fallback) still reads.
    expect(
      StoredDecidedNoteSchema.safeParse(
        withDecider({
          kind: "ranker",
          mode: "ranker",
          deciderKey: "key",
          calibration: "frozen",
          profileId: "profile",
          modelId: "model"
        })
      ).success
    ).toBe(true);
    // A fallback reason belongs to a local decider only.
    expect(
      StoredDecidedNoteSchema.safeParse(withDecider({ ...decisions.decider, fallback: "network" }))
        .success
    ).toBe(false);
  });

  it("is the key the re-match harness clears, and is available with no ranker installed", async () => {
    routes = {};
    const decider = matcher(uncalibrated);
    expect(await decider.currentDeciderKey()).toBe(decisionsKey(uncalibrated));
    expect(await decider.deciderAvailable()).toBe(true);
    ai.resolveDecisions.mockResolvedValue({ use: "local", reason: null });
    expect(await decider.deciderAvailable()).toBe(false);
    expect(await decider.currentDeciderKey()).toBeNull();
  });

  it("places its calls on its own lane and its fallback's, peeked at: no fallback is recorded", async () => {
    // The Gardener status asks often: reading the decider records no Decisions fallback.
    const peekDecisions = vi.fn(async (): Promise<DecisionsResolution> => ({ use: "decisions" }));
    const reader = new RelationMatcher({
      getPool: () => ({}) as PgPool,
      ai: { ...ai, peekDecisions } as unknown as AiService,
      config: uncalibrated
    });
    const own = { lane: decisionsLaneKey(resolveDecisionsLimits()) };
    await expect(reader.deciderCalls()).resolves.toEqual([own, { lane: "local" }]);
    // No local decider to fall back to: its own lane alone.
    routes = {};
    await expect(reader.deciderCalls()).resolves.toEqual([own]);
    // Turned on but unable to decide (a refused key, the day's cap): the local ranker decides.
    routes = { "class:decide": rankerRoute };
    peekDecisions.mockResolvedValue({ use: "local", reason: "spend_cap" });
    await expect(reader.deciderCalls()).resolves.toEqual([{ lane: "local" }]);
    expect(ai.resolveDecisions).not.toHaveBeenCalled();
    expect(ai.decideWithDecisions).not.toHaveBeenCalled();
  });
});

describe("falling back to the local ranker", () => {
  const shipped = relationsConfig;
  const ranked = (title: string, forward: number, backward: number) => {
    rankerTable.set(`Source>${title}`, forward).set(`${title}>Source`, backward);
  };

  it.each([
    "no_key",
    "invalid_key",
    "spend_cap",
    "quota",
    "breaker_open",
    "network",
    "error"
  ] as const)(
    "when Decisions fails with %s: the ranker decides, suggestions only, and the summary says why",
    async (reason) => {
      ai.decideWithDecisions.mockRejectedValue(new DecisionsUnavailableError(reason));
      // Beta's mean is 9: the local ranker suggests it (decision 29), it never applies.
      ranked("Beta", 9, 9);
      const { result, handed } = await run([source.id], shipped);
      expect(ai.rankPairs).toHaveBeenCalledOnce();
      expect(handed[0]!.decider).toMatchObject({
        kind: "ranker",
        calibration: "frozen",
        fallback: reason
      });
      expect(handed[0]!.pairs.map((pair) => [pair.candidateId, pair.band])).toEqual([
        ["n-b", "suggest"]
      ]);
      // A local ranker's asymmetry carries no direction (decision 31b), whatever its scores say.
      expect(handed[0]!.pairs.map((pair) => pair.directionSubjectId)).toEqual([null]);
      expect(result.decisionsFallback).toEqual({ notes: 1, reason });
      // The scores were stored under the ranker's key, and the note's state under it too.
      const [mlx] = frozenRelationCalibrations;
      expect(mlx!.identity.instructionSha256).toBe(sha256(relationDecideInstruction()));
      expect(mocks.states.record.mock.calls[0]![0].deciderKey).not.toBe(decisionsKey(shipped));
    }
  );

  it("when Decisions cannot decide at the admission: the ranker decides and says why, with no Decisions call", async () => {
    ai.resolveDecisions.mockResolvedValue({ use: "local", reason: "spend_cap" });
    ranked("Beta", 9, 9);
    const { result, handed } = await run([source.id], shipped);
    expect(ai.decideWithDecisions).not.toHaveBeenCalled();
    expect(handed[0]!.decider).toMatchObject({ kind: "ranker", fallback: "spend_cap" });
    expect(result.decisionsFallback).toEqual({ notes: 1, reason: "spend_cap" });
  });

  it("when Decisions is off (or the setup is Local): the ranker decides and nothing says otherwise", async () => {
    ai.resolveDecisions.mockResolvedValue({ use: "local", reason: null });
    ranked("Beta", 9, 9);
    const { result, handed } = await run([source.id], shipped);
    expect(ai.decideWithDecisions).not.toHaveBeenCalled();
    expect(handed[0]!.decider).not.toHaveProperty("fallback");
    expect(result.decisionsFallback).toBeUndefined();
    // A matcher whose AI service knows no Decisions decider (an older harness) is the same.
    const plain = new RelationMatcher({
      getPool: () => ({}) as PgPool,
      ai: {
        ...ai,
        resolveDecisions: undefined,
        decideWithDecisions: undefined
      } as unknown as AiService,
      config: shipped
    });
    const handedPlain: DecidedNote[] = [];
    await plain.matchNotes({
      noteIds: [source.id],
      vectors: new Map([[source.id, vectorOf()]]),
      handOff: async (decided) => {
        handedPlain.push(decided);
        return 0;
      }
    });
    expect(handedPlain[0]!.decider.kind).toBe("ranker");
  });

  it("goes on with Decisions for the next note once a failure was only that note's", async () => {
    ai.decideWithDecisions
      .mockRejectedValueOnce(new DecisionsUnavailableError("network"))
      .mockImplementation(async (input: DecisionsDecideInput) => ({
        decisions: input.lists.map((list) =>
          list.candidates.map(() => ({ probability: 0.9, logOdds: 2.2, aiTaskRunId: "r" }))
        ),
        calls: 1,
        inputTokens: 1,
        costUsd: 0,
        replayed: 0
      }));
    ranked("Beta", 9, 9);
    const second = note("n-second", "Second");
    mocks.notes.findVectorMatchingCandidates.mockResolvedValue([
      { note: b, textScore: 0, vectorScore: 0.6 }
    ]);
    mocks.notes.findTextMatchingCandidates.mockResolvedValue([]);
    const { result, handed } = await run([source.id, second.id], shipped);
    expect(handed.map((decided) => decided.decider.kind)).toEqual(["ranker", "decisions"]);
    expect(result.decisionsFallback).toEqual({ notes: 1, reason: "network" });
  });

  it("fails the note visibly, for a job retry, when Decisions failed and no local decider exists", async () => {
    routes = {};
    ai.decideWithDecisions.mockRejectedValue(new DecisionsUnavailableError("network"));
    const failure = await run([source.id], shipped).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: "errors.matching.rerankingFailed" });
    expect((failure as Error).cause).toBeInstanceOf(DecisionsUnavailableError);
    expect(mocks.states.record).not.toHaveBeenCalled();
  });

  it("rethrows a cancellation and a failure that is not Decisions' own, with no fallback", async () => {
    const controller = new AbortController();
    ai.decideWithDecisions.mockImplementation(async () => {
      controller.abort(new Error("canceled"));
      throw new DecisionsUnavailableError("network");
    });
    await expect(run([source.id], shipped, controller.signal)).rejects.toBeDefined();
    expect(ai.rankPairs).not.toHaveBeenCalled();
    ai.decideWithDecisions.mockReset();
    ai.decideWithDecisions.mockRejectedValue(new Error("database is down"));
    await expect(run([source.id], shipped)).rejects.toThrow("database is down");
    expect(ai.rankPairs).not.toHaveBeenCalled();
  });

  it("falls back to the local ranker with no apply band: Decisions' own entry never leaks to it", async () => {
    // Even with a frozen Decisions entry that applies, the ranker that takes over only suggests.
    const config = shipped;
    ai.decideWithDecisions.mockRejectedValue(new DecisionsUnavailableError("quota"));
    ranked("Beta", 16, 16);
    const { handed } = await run([source.id], config);
    expect(handed[0]!.pairs.map((pair) => [pair.candidateId, pair.band])).toEqual([
      ["n-b", "suggest"]
    ]);
  });
});

describe("when the person turns Decisions off, or leaves the setup, during an admission", () => {
  const ranked = (title: string) => {
    rankerTable.set(`Source>${title}`, 9).set(`${title}>Source`, 9);
    rankerTable.set(`Second>${title}`, 9).set(`${title}>Second`, 9);
  };
  /** The first request of the admission is answered; every later one finds Decisions off. */
  const offAfterTheForwardRequest = () => {
    const answered = ai.decideWithDecisions.getMockImplementation()!;
    ai.decideWithDecisions
      .mockImplementationOnce(answered)
      .mockRejectedValue(new DecisionsDisabledError("off"));
  };
  /** A second note whose only candidate is Beta; the first keeps the default candidates. */
  const second = () => {
    const next = note("n-second", "Second");
    mocks.notes.findVectorMatchingCandidates.mockImplementation(async (input: { noteId: string }) =>
      (input.noteId === next.id
        ? [[b, 0.6]]
        : [
            [b, 0.6],
            [c, 0.55],
            [a, 0.99]
          ]
      ).map(([candidate, vectorScore]) => ({
        note: candidate,
        textScore: 0,
        vectorScore
      }))
    );
    mocks.notes.findTextMatchingCandidates.mockImplementation(async (input: { noteId: string }) =>
      input.noteId === next.id ? [] : [{ note: a, textScore: 0.9, vectorScore: 0 }]
    );
    return next;
  };

  it("decides this note and the rest of the admission with the local ranker, and records no failure", async () => {
    decisionTable.set("Source>Alpha", 3).set("Alpha>Source", 2);
    offAfterTheForwardRequest();
    ranked("Alpha");
    ranked("Beta");
    const next = second();
    const { result, handed } = await run([source.id, next.id], relationsConfig);
    // One request went out for the first note (its list); the reverse request was refused, and the
    // second note did not ask Decisions at all.
    expect(ai.decideWithDecisions).toHaveBeenCalledTimes(2);
    expect(handed.map((decided) => decided.decider.kind)).toEqual(["ranker", "ranker"]);
    // It was the person's choice, not a fallback: no reason in the summaries or the result.
    for (const decided of handed) expect(decided.decider).not.toHaveProperty("fallback");
    expect(result.decisionsFallback).toBeUndefined();
    expect(result).toMatchObject({ decided: 2 });
    expect(result.skipped).toBeUndefined();
    // The ranker's decisions, under the ranker's key; what Decisions scored before stays stored.
    expect(mocks.states.record.mock.calls.map(([record]) => record.deciderKey)).not.toContain(
      decisionsKey(relationsConfig)
    );
    expect(
      mocks.decisions.recordRankerScores.mock.calls.filter(
        ([record]) => record.deciderKey === decisionsKey(relationsConfig)
      ).length
    ).toBeGreaterThan(0);
  });

  it("waits for a decider when there is no local one, instead of failing the import", async () => {
    routes = {};
    decisionTable.set("Source>Alpha", 3);
    ai.decideWithDecisions.mockRejectedValue(new DecisionsDisabledError("preset"));
    const { result, handed } = await run([source.id], relationsConfig);
    expect(result.skipped).toBe(waitingForDeciderSkipReason);
    expect(result.decided).toBe(0);
    expect(handed).toEqual([]);
    expect(mocks.states.record).not.toHaveBeenCalled();
  });

  it("still rethrows a cancellation", async () => {
    const controller = new AbortController();
    ai.decideWithDecisions.mockImplementation(async () => {
      controller.abort(new Error("canceled"));
      throw new DecisionsDisabledError("off");
    });
    await expect(run([source.id], relationsConfig, controller.signal)).rejects.toBeDefined();
    expect(ai.rankPairs).not.toHaveBeenCalled();
  });
});

describe("with a replayed Decisions cassette (the real runtime, adapter and lane; no network)", () => {
  // Recorded once, live, on the benchmark's synthetic notes (`decisions-scenario.ts`): four requests,
  // 2,934 input tokens, US$ 0.0003. The source's two candidate orders differ, so its list is sent twice.
  const fixture = join(import.meta.dirname, "__fixtures__", "decisions-cassette");
  const settingsStore = new Map<string, unknown>();
  const scenario = decisionsScenarioNotes();
  let directory: string;
  let cassette: AiCassette;
  let runtime: DecisionsRuntime;
  const fetchSpy = vi.fn<typeof globalThis.fetch>();

  beforeEach(async () => {
    settingsStore.clear();
    settingsStore.set("ai.preset.v1", { mode: "hybrid", at: "now" });
    settingsStore.set("relations.decisions", { enabled: true });
    mocks.settings.get.mockImplementation(async (key: string) => settingsStore.get(key) ?? null);
    mocks.settings.set.mockImplementation(async (key: string, value: unknown) => {
      settingsStore.set(key, value);
      return { key, value };
    });
    mocks.aiConfig.recordTaskRun.mockImplementation(async () => "audit-row");
    // A copy: a replay writes the request of a miss next to its entries.
    directory = await mkdtemp(join(tmpdir(), "decisions-replay-"));
    await cp(fixture, directory, { recursive: true });
    cassette = new AiCassette({ mode: "replay", directory });
    setAiAdapterDecorator((adapter) => cassette.wrap(adapter));
    fetchSpy.mockReset();
    runtime = new DecisionsRuntime({
      getPool: () =>
        ({
          query: async (_sql: string, params: unknown[]) => ({
            rows: [{ value: settingsStore.get(String(params[0])) }],
            rowCount: 1
          })
        }) as unknown as PgPool,
      scheduler: createAiScheduler(resolveAiLaneRuntimeConfig({}, { environment: {} })),
      registry: new AiModelRegistry(),
      credentials: { save: vi.fn(), remove: vi.fn() },
      // No key is stored: a replay reads none.
      readSecret: async () => {
        throw new Error("errors.ai.missingCredential");
      },
      cassetteMode: "replay",
      fetch: fetchSpy
    });
    ai.resolveDecisions.mockImplementation(() => runtime.resolve());
    ai.decideWithDecisions.mockImplementation((input: DecisionsDecideInput, signal?: AbortSignal) =>
      runtime.decide(input, signal)
    );
    for (const entry of Object.values(scenario)) registry.set(entry.id, entry as Note);
    mocks.notes.findTextMatchingCandidates.mockResolvedValue([]);
    mocks.notes.findVectorMatchingCandidates.mockResolvedValue(
      [scenario.related, scenario.decoy].map((candidate) => ({
        note: candidate,
        textScore: 0,
        vectorScore: 0.6
      }))
    );
  });
  afterEach(async () => {
    setAiAdapterDecorator(null);
    await rm(directory, { recursive: true, force: true });
  });

  it("suggests the note that says the same thing and rejects the decoy that shares its words", async () => {
    const { result, handed } = await run([scenario.source.id], uncalibrated);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Two requests of the source's list (its two candidate orders) and the related note's other
    // direction; the decoy scored p 0.00 from the source, so its other direction was never asked.
    expect(cassette.stats()).toMatchObject({ served: 3, misses: 0, recorded: 0 });
    expect(ai.rankPairs).not.toHaveBeenCalled();
    expect(result).toMatchObject({ decided: 1, accepted: 1, decider: "decisions" });
    expect(handed[0]!.decider).toMatchObject({
      kind: "decisions",
      calibration: "uncalibrated",
      profileId: null,
      modelId: "gpt-6-luna"
    });
    // The related note: source -> it p 1.00 (+16.1), it -> source p 0.99 (+4.6); the mean is 10.36.
    expect(handed[0]!.pairs).toHaveLength(1);
    expect(handed[0]!.pairs[0]).toMatchObject({
      candidateId: "n-related",
      band: "suggest",
      probability: null,
      calibration: "uncalibrated",
      decisionSource: "model"
    });
    expect(handed[0]!.pairs[0]!.score).toBeCloseTo((16.118095551 + 4.59511985) / 2, 6);
    // The decoy scores -16.1 from the source and is stored with that one direction, not accepted.
    const stored = mocks.decisions.recordRankerScores.mock.calls.map(([record]) => record);
    const decoy = stored.find((record) => record.loAtomicNoteId === "n-decoy")!;
    expect(decoy.hiToLo).toBeCloseTo(-16.118095550958316, 9);
    expect(decoy.loToHi).toBeNull();
    expect(decoy.deciderKey).toBe(decisionsKey(uncalibrated));
    // The replay spent nothing and the audit says what was recorded.
    expect(await runtime.status()).toMatchObject({ spentTodayUsd: 0, requestsToday: 0 });
    expect(mocks.aiConfig.recordTaskRun).toHaveBeenCalledTimes(3);
    expect(mocks.aiConfig.recordTaskRun.mock.calls[0]![0]).toMatchObject({
      provider: "openai-decisions",
      lane: "remote:openai-decisions",
      workloadClass: "decide",
      costEstimate: 0,
      status: "succeeded"
    });
  });

  it("applies the related note by the decider's own frozen apply band, once a freeze names the product's design", async () => {
    const { handed } = await run([scenario.source.id], refrozen);
    expect(cassette.stats()).toMatchObject({ served: 3, misses: 0 });
    expect(handed[0]!.decider).toMatchObject({ kind: "decisions", calibration: "frozen" });
    // Mean 10.36 is past the frozen apply edge 2.228; the decoy (-16.1) is nowhere near suggest.
    const top =
      frozenDecisions.kind === "isotonic" ? frozenDecisions.blocks.at(-1)!.probability : null;
    expect(handed[0]!.pairs.map((pair) => [pair.candidateId, pair.band, pair.probability])).toEqual(
      [["n-related", "apply", top]]
    );
  });

  it("falls back to the local ranker when the cassette misses: a request it does not hold", async () => {
    // An edited note is another request: the replay misses, the decider is unavailable for it, and
    // the ranker (suggestions only, decision 29) decides, with the reason in the summary.
    const edited = registry.get("n-source")!;
    edited.ideaStatement = `${edited.ideaStatement} (edited)`;
    rankerTable.set(`${edited.title}>${scenario.related.title}`, 9);
    rankerTable.set(`${scenario.related.title}>${edited.title}`, 9);
    const { result, handed } = await run([edited.id], relationsConfig);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cassette.stats().misses).toBeGreaterThan(0);
    expect(handed[0]!.decider).toMatchObject({ kind: "ranker", fallback: "error" });
    expect(handed[0]!.pairs.map((pair) => [pair.candidateId, pair.band])).toEqual([
      ["n-related", "suggest"]
    ]);
    expect(result.decisionsFallback).toEqual({ notes: 1, reason: "error" });
  });
});
