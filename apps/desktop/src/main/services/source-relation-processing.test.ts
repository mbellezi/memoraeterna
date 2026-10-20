import { changedPromptIdentity, defaultPromptPin, withPromptPin } from "./prompt-runtime.js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createHash } from "node:crypto";
import {
  defaultSourceRelationSettings,
  relationsConfig,
  sourceDecisionPassesFloors
} from "@app/domain";
import type { SourceRelationChunk, SourceRelationNote, PgPool } from "@app/db";
import { uuidAssignments } from "./__fixtures__/uuid-assignments.js";
import { runSourcePairVerdicts } from "./golden-source-pairs.js";
import { InFlightRegistry } from "./relations/in-flight-registry.js";
import {
  matchSources,
  orderSourceRelationChunks,
  orientSymmetricNotes,
  parseSourceDecision,
  promoteSourceRelations,
  sourceDecisionPrompt,
  sourceJudgeRequestSettings,
  sourceRelationPromptVersion,
  sourceRelationWrites,
  type MatchSourcesOptions,
  type SourceRelationContext
} from "./source-relation-processing.js";

const mocks = vi.hoisted(() => ({
  repository: {} as Record<string, Mock<(...args: any[]) => any>>,
  selection: vi.fn(),
  taskDefaults: null as Record<string, unknown> | null
}));
vi.mock("@app/db", async (original) => {
  const actual = await original<typeof import("@app/db")>();
  return {
    aiRouteKeys: actual.aiRouteKeys,
    createSourceRelationRepository: () => mocks.repository,
    createAiConfigRepository: () => ({ getDefaultTask: mocks.selection })
  };
});
// A test can stand in for a task that adds a default beneath the profile's parameters.
vi.mock("./ai-task-parameters.js", async (original) => {
  const actual = await original<typeof import("./ai-task-parameters.js")>();
  return {
    ...actual,
    aiTaskBehaviorDefaults: (...args: Parameters<typeof actual.aiTaskBehaviorDefaults>) =>
      mocks.taskDefaults ?? actual.aiTaskBehaviorDefaults(...args)
  };
});
const a: SourceRelationChunk = {
  id: "a",
  sourceItemId: "A",
  documentId: "ad",
  sourceSpanId: null,
  content: "Retrieval strengthens durable learning.",
  contentHash: "ah",
  title: "A",
  summary: "Retrieval mechanisms",
  rootId: "root-A",
  rootTitle: "Root A",
  chunkIndex: 0
};
const b: SourceRelationChunk = {
  ...a,
  id: "b",
  sourceItemId: "B",
  documentId: "bd",
  contentHash: "bh",
  title: "B",
  rootId: "root-B",
  rootTitle: "Root B"
};
const note: SourceRelationNote = {
  id: "note-relation",
  type: "supports",
  sourceNoteId: "an",
  targetNoteId: "bn",
  sourceChunkId: "a",
  targetChunkId: "b",
  sourceItemId: "A",
  targetSourceItemId: "B",
  sourceIdea: a.content,
  targetIdea: b.content,
  fingerprint: "n1"
};
const context: SourceRelationContext = { chunks: [a, b], notes: [note], existing: [] };
/** A v5 verdict item: [from, to, type, importance, confidence, [from chunks], [to chunks]]. */
const item = (overrides: Partial<Record<number, unknown>> = {}): unknown[] =>
  Object.assign(["s1", "s2", "supports", 90, 90, ["c1"], ["c2"]], overrides);
const floors = { minImportance: 0.85, minConfidence: 0.8, includeWeakTypes: false };
const parse = (relations: unknown[], ctx = context) => parseSourceDecision({ relations }, ctx, 0);
const writes = (relations: unknown[], ctx = context, allowance = 2, settings = floors) =>
  sourceRelationWrites(parse(relations, ctx).items, ctx, settings, allowance);

describe("source verdicts without prose", () => {
  it("resolves compact items to sources and their own chunks, with null prose and scores / 100", () => {
    const parsed = parse([item({ 0: "s2", 1: "s1", 5: ["c2"], 6: ["c1"] })]);
    expect(parsed).toMatchObject({ answered: true, invalid: 0, sameRoot: false });
    expect(parsed.items[0]).toMatchObject({
      sourceItemId: "B",
      targetSourceItemId: "A",
      importance: 90,
      confidence: 90,
      attempt: 0
    });
    const result = writes([item({ 0: "s2", 1: "s1", 3: 92, 4: 81, 5: ["c2"], 6: ["c1"] })]);
    expect(result.relations).toEqual([
      expect.objectContaining({
        existingId: null,
        sourceItemId: "B",
        targetSourceItemId: "A",
        relationType: "supports",
        sourceIdea: null,
        targetIdea: null,
        explanation: null,
        importance: 0.92,
        confidence: 0.81
      })
    ]);
    expect(result.relations[0]!.evidence).toEqual([{ source: b, target: a, note: null }]);
  });

  it("allows zero items and applies the floors and weak types to the raw scores", () => {
    expect(parse([])).toEqual({ answered: true, items: [], invalid: 0, sameRoot: false });
    expect(writes([item({ 3: 85, 4: 80 })]).relations).toHaveLength(1);
    for (const overrides of [{ 3: 84 }, { 4: 79 }, { 2: "related" }, { 2: "mentions" }]) {
      const result = writes([item(overrides)]);
      expect(result.relations).toEqual([]);
      expect(result.records[0]).toMatchObject({ outcome: "below_floors" });
    }
    expect(
      writes([item({ 2: "related" })], context, 2, { ...floors, includeWeakTypes: true }).relations
    ).toHaveLength(1);
    expect(
      sourceDecisionPassesFloors({ type: "supports", importance: 85, confidence: 80 }, floors)
    ).toBe(true);
  });

  it("writes the judge's contrasts as contradicts and drops similar_to as weak (D27, Q14)", () => {
    const contrasts = writes([item({ 2: "contrasts" })]);
    expect(contrasts.relations.map((relation) => relation.relationType)).toEqual(["contradicts"]);
    expect(contrasts.records[0]).toMatchObject({ type: "contrasts", outcome: "persisted" });
    const similar = writes([item({ 2: "similar_to" })]);
    expect(similar.relations).toEqual([]);
    // The raw verdict is stored as answered, so tuning can still count it at $0.
    expect(similar.records[0]).toMatchObject({ type: "similar_to", outcome: "weak_type" });
    expect(
      sourceRelationWrites(parse([item({ 2: "similar_to" })]).items, context, floors, 2, {
        keepSimilarTo: true
      }).relations.map((relation) => relation.relationType)
    ).toEqual(["similar_to"]);
  });

  it("keeps valid items and drops malformed ones one by one", () => {
    const parsed = parse([
      item(),
      [...item(), "A prose explanation."],
      item({ 3: 0.9 }),
      item({ 3: 101 }),
      item({ 1: "s9" }),
      item({ 1: "s1" }),
      item({ 5: ["c2"], 6: ["c1"] }),
      item({ 5: [] }),
      item({ 5: ["c1", "c1", "c1", "c1"] }),
      item({ 2: "same_as" }),
      { source: "s1", target: "s2" }
    ]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.invalid).toBe(10);
    expect(parsed.sameRoot).toBe(false);
  });

  it("reads output without the envelope as not answered", () => {
    for (const output of ["invalid", { results: [] }, { relations: "none" }, null])
      expect(parseSourceDecision(output, context, 0).answered).toBe(false);
    expect(
      parseSourceDecision(
        '```json\n{"relations":[["s1","s2","extends",90,90,["c1"],["c2"]]]}\n```',
        context,
        1
      ).items[0]
    ).toMatchObject({ type: "extends", attempt: 1 });
  });

  it("turns a symmetric item answered from the higher alias instead of refusing it", () => {
    const parsed = parse([item({ 0: "s2", 1: "s1", 2: "contrasts", 5: ["c2"], 6: ["c1"] })]);
    expect(parsed.invalid).toBe(0);
    expect(parsed.items[0]).toMatchObject({ sourceItemId: "A", targetSourceItemId: "B" });
    expect(parsed.items[0]!.sourceChunks).toEqual([a]);
  });

  it("flags items joining two chapters of the same work for the same-root feedback", () => {
    const sibling = { ...a, id: "c", sourceItemId: "C", title: "Another chapter" };
    const ctx = { ...context, chunks: [a, b, sibling] };
    const prompt = sourceDecisionPrompt(ctx, 2, false);
    expect(prompt).toContain('"key":"s1","root":"w1"');
    expect(prompt).toContain('"key":"s2","root":"w2"');
    expect(prompt).toContain('"key":"s3","root":"w1"');
    expect(prompt).toContain("DIFFERENT roots");
    const parsed = parse([item({ 1: "s3", 6: ["c3"] }), item()], ctx);
    expect(parsed).toMatchObject({ invalid: 1, sameRoot: true });
    expect(parsed.items).toHaveLength(1);
  });

  it("merges items of the same endpoints and type and keeps the allowance by importance", () => {
    const second = { ...b, id: "b2", chunkIndex: 1, contentHash: "b2h" };
    const ctx = { ...context, notes: [], chunks: [a, b, second] };
    const result = writes(
      [
        item({ 3: 88 }),
        item({ 3: 95, 4: 82, 6: ["c3"] }),
        item({ 2: "extends", 3: 90 }),
        item({ 0: "s2", 1: "s1", 2: "clarifies", 3: 86, 5: ["c2"], 6: ["c1"] })
      ],
      ctx
    );
    expect(
      result.relations.map((relation) => [relation.relationType, relation.importance])
    ).toEqual([
      ["supports", 0.95],
      ["extends", 0.9]
    ]);
    expect(result.relations[0]!.confidence).toBe(0.9);
    expect(result.relations[0]!.evidence.map((evidence) => evidence.target.id)).toEqual([
      "b",
      "b2"
    ]);
    expect(result.proposals).toBe(2);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "persisted",
      "persisted",
      "persisted",
      "over_allowance"
    ]);
  });

  it("never brings back a relation the owner rejected and does not count a saved one again", () => {
    const saved = (status: string, from = "A", to = "B", relationType = "supports") => ({
      id: `saved-${status}`,
      sourceItemId: from,
      targetSourceItemId: to,
      relationType,
      sourceIdea: "Older stored idea",
      targetIdea: "Older stored target",
      status
    });
    const rejected = writes([item()], { ...context, existing: [saved("rejected")] });
    expect(rejected).toMatchObject({ proposals: 0, relations: [] });
    expect(rejected.records[0]).toMatchObject({ outcome: "owner_rejected" });
    // A symmetric relation rejected the other way round, under its earlier name, is the same one.
    expect(
      writes([item({ 2: "contrasts" })], {
        ...context,
        existing: [saved("rejected", "B", "A", "contrasts")]
      }).relations
    ).toEqual([]);
    // Saved and not rejected: the evidence merges into it on persistence; it is no new proposal.
    for (const status of ["accepted", "pending_review"]) {
      const known = writes([item()], { ...context, existing: [saved(status)] });
      expect(known.proposals).toBe(0);
      expect(known.relations).toHaveLength(1);
    }
    // A different type between the same sources is a new relation.
    expect(
      writes([item({ 2: "extends" })], { ...context, existing: [saved("rejected")] }).proposals
    ).toBe(1);
  });

  it("treats a relation promoted between the two works as the same relation (D27)", () => {
    const promoted = (status: string) => ({
      id: `promoted-${status}`,
      sourceItemId: "root-A",
      targetSourceItemId: "root-B",
      relationType: "supports",
      sourceIdea: null,
      targetIdea: null,
      status,
      origin: "promoted" as const,
      sourceRootId: "root-A",
      targetRootId: "root-B"
    });
    const upgraded = writes([item()], { ...context, existing: [promoted("pending_review")] });
    expect(upgraded.proposals).toBe(0);
    expect(upgraded.relations).toHaveLength(1);
    expect(
      writes([item()], { ...context, existing: [promoted("rejected")] }).records[0]
    ).toMatchObject({ outcome: "owner_rejected" });
    // Read the other way, a directed promoted relation is another relation.
    expect(
      writes([item({ 0: "s2", 1: "s1", 5: ["c2"], 6: ["c1"] })], {
        ...context,
        existing: [promoted("rejected")]
      }).relations
    ).toHaveLength(1);
  });

  it("backs a relation with the note connection whose passages it cites", () => {
    const backed = writes([item()]);
    expect(backed.relations[0]!.evidence).toEqual([{ source: a, target: b, note }]);
    // Another type or direction than the note's is source analysis only.
    expect(writes([item({ 2: "extends" })]).relations[0]!.evidence).toEqual([
      { source: a, target: b, note: null }
    ]);
    expect(
      writes([item({ 0: "s2", 1: "s1", 5: ["c2"], 6: ["c1"] })]).relations[0]!.evidence[0]!.note
    ).toBeNull();
  });

  it("stores every item with its raw scores and resolved chunks", () => {
    expect(writes([item({ 3: 70, 4: 60 })]).records).toEqual([
      {
        from: "A",
        to: "B",
        type: "supports",
        importance: 70,
        confidence: 60,
        fromChunks: ["a"],
        toChunks: ["b"],
        attempt: 0,
        outcome: "below_floors"
      }
    ]);
  });

  it("asks for compact items, states durable and grounded as instructions and lists no saved relations", () => {
    const prompt = sourceDecisionPrompt(
      {
        ...context,
        existing: [
          {
            id: "saved",
            sourceItemId: "A",
            targetSourceItemId: "B",
            relationType: "supports",
            sourceIdea: "A saved idea that must not be listed",
            targetIdea: "Its target",
            status: "accepted"
          }
        ]
      } as SourceRelationContext,
      2,
      false
    );
    expect(prompt).toContain('{"relations":[["s1","s2","supports",90,85,["c1"],["c3"]]]}');
    expect(prompt).toContain("Return ZERO to 2 items");
    expect(prompt).toContain("integers from 0 to 100");
    expect(prompt).toContain("Write no ideas, explanations or other text");
    expect(prompt).toContain("durable relationship");
    expect(prompt).toContain("grounded in supplied original chunks on BOTH sides");
    expect(prompt).toContain("Summaries are navigation aids, NEVER evidence");
    expect(prompt).toContain("hypotheses, NOT proof");
    expect(prompt).toContain("beyond a specific event");
    expect(prompt).toContain(
      '"source":"s1","target":"s2","type":"supports","sourceIdea":"Retrieval strengthens durable learning.","targetIdea":"Retrieval strengthens durable learning.","evidence":["c1","c2"]'
    );
    for (const absent of [
      "EXCLUSION LIST",
      "A saved idea",
      'sourceIdea":"Specific',
      'durable":',
      'explanation":',
      "note-relation"
    ])
      expect(prompt).not.toContain(absent);
  });
});

const judgeRoute = {
  profileId: "profile",
  providerConfigId: "provider",
  modelId: "model",
  runtime: "local",
  localModelId: null,
  revision: "r1",
  parameters: {},
  modelDefaultParameters: {},
  requiredCapabilities: ["text-generation"]
};
const noPromotion = {
  promoted: 0,
  refreshed: 0,
  retired: 0,
  ownerRejected: 0,
  otherRootIds: [],
  runId: null
};
const plan = (roots: string[]) => ({
  pairs: roots.map((rootId, index) => ({
    rootId,
    reason: index === 0 ? "nearest" : "reverse",
    cosine: 0.8 - index / 10
  })),
  state: { nearestRootId: roots[0] ?? null, nearestCosine: roots.length ? 0.8 : null },
  reverse: [],
  matchSeq: 2,
  spaceKey: "256:space",
  candidates: roots.length
});

describe("source matching by design E (D27)", () => {
  let states: Map<string, unknown>, decisions: Map<string, Record<string, unknown>>;
  let order: string[];
  beforeEach(() => {
    states = new Map();
    decisions = new Map();
    order = [];
    mocks.selection.mockReset().mockResolvedValue(judgeRoute);
    mocks.repository = {
      roots: vi.fn().mockResolvedValue(["root-A"]),
      fingerprint: vi.fn(async (id: string) => id),
      promoteFromNotes: vi.fn(async () => {
        order.push("promote");
        return { ...noPromotion, promoted: 2, otherRootIds: ["root-B"] };
      }),
      discoveryVector: vi.fn().mockResolvedValue({
        dimensions: 256,
        strategy: "source-composite-centroid-v2:space",
        spaceKey: "256:space",
        model: "embedder",
        provider: "local",
        runtime: "local",
        embedding: "[1,0]"
      }),
      planDiscovery: vi.fn(async () => {
        order.push("discover");
        return plan(["root-B"]);
      }),
      previewDiscovery: vi.fn(async () => plan(["root-B"])),
      owedDiscoveryRoots: vi.fn().mockResolvedValue([]),
      pairNotes: vi.fn().mockResolvedValue([note]),
      pairNoteFingerprints: vi.fn().mockResolvedValue([note.fingerprint]),
      pairChunks: vi.fn().mockResolvedValue([a, b]),
      existing: vi.fn().mockResolvedValue([]),
      runState: vi.fn(async (key: string) => structuredClone(states.get(key) ?? null)),
      saveRun: vi.fn(async (key: string, _root: string, state: unknown) => {
        states.set(key, structuredClone(state));
      }),
      decision: vi.fn(async (key: string) => decisions.get(key) ?? null),
      commitDecision: vi.fn(
        async (
          key: string,
          _a: string,
          _b: string,
          relations: unknown[],
          metadata: Record<string, unknown>
        ) => {
          decisions.set(key, { ...metadata, persistedCount: relations.length });
          return relations.length;
        }
      )
    };
  });
  const run = (
    ai: Mock<(...args: any[]) => any>,
    key = "run",
    settings = { ...defaultSourceRelationSettings, maxInputTokens: 200000 },
    extra: Partial<MatchSourcesOptions> = {}
  ) =>
    matchSources({
      pool: {} as PgPool,
      ai: { runDefaultTask: ai },
      sourceIds: ["A"],
      runKey: key,
      settings,
      contentLanguage: "en",
      ...extra
    });
  const execution = (output: unknown) => ({
    output,
    profileId: "profile",
    modelId: "model",
    providerId: "provider",
    runtime: "local",
    aiTaskRunId: "execution",
    inputTokens: 100,
    outputTokens: 20
  });

  it("promotes with no call before discovery, then judges the nearest root once", async () => {
    const ai = vi.fn(async () => {
      order.push("judge");
      return execution({ relations: [item()] });
    });
    const result = await run(ai);
    expect(order).toEqual(["promote", "discover", "judge"]);
    expect(mocks.repository.promoteFromNotes).toHaveBeenCalledWith("root-A");
    expect(mocks.repository.planDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ rootId: "root-A", fingerprint: "root-A", neighbours: 1 })
    );
    expect(result).toMatchObject({
      promoted: 2,
      persistedCount: 1,
      completed: 1,
      total: 1,
      coverage: { judgedPairs: 1, candidatePairs: 1, budgetExhausted: false, promoted: 2 }
    });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("resolves the judge through op:source_relation_matching with class decide", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    await run(ai);
    expect(mocks.selection).toHaveBeenCalledWith("reranking", undefined, [
      "op:source_relation_matching",
      "class:decide",
      "reranking"
    ]);
    expect(ai.mock.calls[0]![2]).toMatchObject({
      operation: "source_relation_matching",
      workloadClass: "decide",
      priority: "P2"
    });
  });

  it("keeps promotion and fails visibly before planning when no generative judge is routed", async () => {
    for (const route of [null, { ...judgeRoute, requiredCapabilities: ["reranking"] }]) {
      mocks.selection.mockReset().mockResolvedValue(route);
      const ai = vi.fn();
      await expect(run(ai, `no-judge-${String(route)}`)).rejects.toThrow(
        "errors.ai.noCompatibleModel"
      );
      expect(ai).not.toHaveBeenCalled();
    }
    expect(mocks.repository.promoteFromNotes).toHaveBeenCalledTimes(2);
    // A plan would move its reverse neighbours' bars and leave them unjudged: none is stored.
    expect(mocks.repository.planDiscovery).not.toHaveBeenCalled();
    expect(mocks.repository.saveRun).not.toHaveBeenCalled();
    // With nothing to judge, no judge is needed.
    mocks.repository.previewDiscovery!.mockResolvedValue(plan([]));
    mocks.repository.planDiscovery!.mockResolvedValue(plan([]));
    await expect(run(vi.fn(), "nothing")).resolves.toMatchObject({ total: 0, completed: 0 });
    expect(mocks.repository.planDiscovery).toHaveBeenCalledTimes(1);
  });

  it("plans a deferred or vectorless discovery when the same run asks again", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    // A book root whose last record has not linked yet, then the call for that last record.
    expect(await run(ai, "book", undefined, { discovery: "defer" })).toMatchObject({
      discoveryDeferred: 1,
      total: 0
    });
    expect(await run(ai, "book")).toMatchObject({ discoveryDeferred: 0, completed: 1, total: 1 });
    // A root matched before its composite existed is discovered once it has one.
    mocks.repository.discoveryVector!.mockResolvedValueOnce(null);
    expect(await run(ai, "late")).toMatchObject({ discoveryWithoutVector: 1, total: 0 });
    expect(await run(ai, "late")).toMatchObject({ discoveryWithoutVector: 0, total: 1 });
    expect(mocks.repository.planDiscovery).toHaveBeenCalledTimes(2);
    // A planned discovery is kept: a deferring call on the same run changes nothing.
    expect(await run(ai, "late", undefined, { discovery: "defer" })).toMatchObject({
      discoveryDeferred: 0,
      completed: 1,
      total: 1
    });
    expect(mocks.repository.planDiscovery).toHaveBeenCalledTimes(2);
  });

  it("selects again the pairs earlier plans of the root left unjudged", async () => {
    mocks.repository.owedDiscoveryRoots!.mockResolvedValue(["root-X"]);
    await run(vi.fn().mockResolvedValue(execution({ relations: [] })), "later");
    expect(mocks.repository.owedDiscoveryRoots).toHaveBeenCalledWith("root-A", "later:root-A");
    expect(mocks.repository.planDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ owed: ["root-X"] })
    );
  });

  it("defers discovery on request and skips a root without a composite vector", async () => {
    const ai = vi.fn();
    expect(await run(ai, "deferred", undefined, { discovery: "defer" })).toMatchObject({
      discoveryDeferred: 1,
      total: 0,
      promoted: 2
    });
    mocks.repository.discoveryVector!.mockResolvedValue(null);
    expect(await run(ai, "no-vector")).toMatchObject({ discoveryWithoutVector: 1, total: 0 });
    expect(mocks.repository.planDiscovery).not.toHaveBeenCalled();
    expect(ai).not.toHaveBeenCalled();
  });

  it("judges exactly the planned pairs when a run resumes, and plans once", async () => {
    mocks.repository.planDiscovery!.mockResolvedValue(plan(["root-B", "root-C"]));
    const ai = vi
      .fn()
      .mockResolvedValueOnce(execution({ relations: [] }))
      .mockRejectedValueOnce(new Error("interrupted"))
      .mockResolvedValue(execution({ relations: [] }));
    await expect(run(ai, "resume")).rejects.toThrow("interrupted");
    const onProgress = vi.fn();
    expect(await run(ai, "resume", undefined, { onProgress })).toMatchObject({
      completed: 2,
      total: 2
    });
    expect(mocks.repository.planDiscovery).toHaveBeenCalledTimes(1);
    expect(ai).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls[0]).toEqual([0.5, { completed: 1, total: 2 }]);
    expect(onProgress.mock.calls.at(-1)).toEqual([1, { completed: 2, total: 2 }]);
  });

  it("judges mutual neighbours once in a run and once across runs", async () => {
    mocks.repository.roots!.mockResolvedValue(["root-A", "root-B"]);
    mocks.repository.planDiscovery!.mockImplementation(async ({ rootId }: { rootId: string }) =>
      plan([rootId === "root-A" ? "root-B" : "root-A"])
    );
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    expect(await run(ai)).toMatchObject({ completed: 2, total: 2, rootCount: 2 });
    expect(ai).toHaveBeenCalledTimes(1);
    await run(ai, "again");
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("makes two jobs that select the same pair at once pay for one call", async () => {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const ai = vi.fn(async () => {
      await answered;
      return execution({ relations: [] });
    });
    const first = run(ai, "job-1");
    const second = run(ai, "job-2");
    await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("judges under the in-flight registry it is given, by source-pair key (the link jobs', D24)", async () => {
    const registry = new InFlightRegistry();
    const claim = registry.claim.bind(registry);
    const claimed: string[] = [];
    vi.spyOn(registry, "claim").mockImplementation((keys) => {
      claimed.push(...keys);
      return claim(keys);
    });
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    await run(ai, "job-1", undefined, { registry });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(claimed).toEqual([expect.stringMatching(/^source-pair:[0-9a-f]{64}$/)]);
    expect(registry.size).toBe(0);
  });

  it("re-judges a pair for a new note relation or a new request shape, never for floors or budget", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    const settings = { ...defaultSourceRelationSettings, maxInputTokens: 200000 };
    await run(ai, "one", settings);
    await run(ai, "two", {
      ...settings,
      minImportance: 0.95,
      minConfidence: 0.95,
      maxInputTokens: 50000
    });
    expect(ai).toHaveBeenCalledTimes(1);
    await run(ai, "three", { ...settings, evidenceChunksPerSource: 5 });
    expect(ai).toHaveBeenCalledTimes(2);
    mocks.repository.pairNoteFingerprints!.mockResolvedValue([note.fingerprint, "typed-later"]);
    await run(ai, "four", settings);
    expect(ai).toHaveBeenCalledTimes(3);
  });

  it("writes the judge's contrasts as contradicts", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [item({ 2: "contrasts" })] }));
    await run(ai);
    const [, , , relations, metadata] = mocks.repository.commitDecision!.mock.calls[0]!;
    expect(relations).toEqual([expect.objectContaining({ relationType: "contradicts" })]);
    expect(metadata.items).toEqual([expect.objectContaining({ type: "contrasts" })]);
  });

  it("lists the spike's number of note relations as hypotheses", async () => {
    await run(vi.fn().mockResolvedValue(execution({ relations: [] })));
    expect(mocks.repository.pairNotes).toHaveBeenCalledWith("root-A", "root-B", 4);
  });

  it("drops a pair without evidence on both sides from the totals", async () => {
    mocks.repository.pairChunks!.mockResolvedValue([a]);
    const ai = vi.fn();
    expect(await run(ai)).toMatchObject({ completed: 0, total: 0 });
    expect(ai).not.toHaveBeenCalled();
  });

  it("sends the decider the request a golden source pair verdict sends, and persists nothing", async () => {
    const matcherAi = vi.fn().mockResolvedValue(execution({ relations: [item()] }));
    await run(matcherAi);
    const [, matcherInput, matcherContext, , matcherLimits] = matcherAi.mock.calls[0]!;
    // The whole repository is handed over (every write function included) and must stay untouched.
    for (const fn of Object.values(mocks.repository)) fn.mockClear();
    const verdictAi = vi.fn().mockResolvedValue(execution({ relations: [item()] }));
    const report = await runSourcePairVerdicts({
      mode: "verdict_only",
      file: {
        path: "/pairs.json",
        sha256: "0".repeat(64),
        pairs: [{ left: "Root A", right: "Root B" }]
      },
      manifest: { name: "test", sources: [] },
      roots: [
        { id: "root-A", title: "Root A", type: "StandaloneArticle" },
        { id: "root-B", title: "Root B", type: "StandaloneArticle" }
      ],
      reader: mocks.repository as never,
      ai: { runDefaultTask: verdictAi },
      settings: { ...defaultSourceRelationSettings, maxInputTokens: 200000 },
      contentLanguage: "en",
      cassette: null
    });
    const [task, input, callContext, signal, limits] = verdictAi.mock.calls[0]!;
    expect(task).toBe("reranking");
    expect(input).toBe(matcherInput);
    expect(limits).toEqual(matcherLimits);
    expect(signal).toBeUndefined();
    expect(callContext).toEqual({ ...matcherContext, origin: "golden_source_pairs" });
    expect(report.pairs[0]).toMatchObject({ status: "judged", verdict: "related" });
    for (const [name, fn] of Object.entries(mocks.repository))
      if (!["pairNotes", "pairChunks", "existing"].includes(name))
        expect(fn, name).not.toHaveBeenCalled();
  });

  it("real same-root recovery composes the exact active validation suffix", async () => {
    const pin = defaultPromptPin();
    for (const id of ["sources.decide", "sources.decide.repair", "sources.validation.same_root"]) {
      const entry = pin.entries.find((e) => e.id === id)!;
      entry.fields.body = "CATALOG:" + id + "\n" + entry.fields.body;
    }
    mocks.repository.pairChunks!.mockResolvedValue([a, { ...b, rootId: a.rootId }]);
    const ai = vi
      .fn()
      .mockResolvedValueOnce(execution({ relations: [item()] }))
      .mockResolvedValue(execution({ relations: [] }));
    await withPromptPin(pin, () => run(ai));
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[0]![1]).toContain("CATALOG:sources.decide");
    expect(ai.mock.calls[1]![1]).toContain("CATALOG:sources.decide.repair");
    expect(ai.mock.calls[1]![1]).toContain("CATALOG:sources.validation.same_root");
  });

  it("counts actual usage from the original call and its repair", async () => {
    const ai = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect((states.get("run:root-A") as { inputTokens: number }).inputTokens).toBe(0);
        return execution("invalid");
      })
      .mockResolvedValue(execution({ relations: [item()] }));
    const result = await run(ai);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(result.persistedCount).toBe(1);
    expect(result.inputTokens).toBe(200);
    expect(ai.mock.calls[0]?.[4]).toEqual({ maxOutputTokens: 1900 });
  });
  it("audits the second call after an invalid answer as a repair (D35)", async () => {
    const ai = vi
      .fn()
      .mockResolvedValueOnce(execution("invalid"))
      .mockResolvedValue(execution({ relations: [item()] }));
    await run(ai);
    expect(ai.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ attempt: 0, isRepair: false }),
      expect.objectContaining({ attempt: 1, isRepair: true, stage: "sourceMatching" })
    ]);
  });
  it.each([0, 100, 15000])("records actual input usage %s", async (inputTokens) => {
    const ai = vi.fn().mockResolvedValue({ ...execution({ relations: [] }), inputTokens });
    expect((await run(ai)).inputTokens).toBe(inputTokens);
    expect(states.get("run:root-A")).toMatchObject({ inputTokens });
  });
  it.each([undefined, null, NaN, -1, 1.5, Infinity])(
    "does not estimate unavailable or invalid usage: %s",
    async (inputTokens) => {
      const ai = vi.fn().mockResolvedValue({ ...execution({ relations: [] }), inputTokens });
      expect((await run(ai)).inputTokens).toBe(0);
    }
  );
  it("does not invent consumption for an interrupted call without usage", async () => {
    const ai = vi.fn().mockRejectedValue(new Error("interrupted"));
    await expect(run(ai)).rejects.toThrow("interrupted");
    expect((states.get("run:root-A") as { inputTokens: number }).inputTokens).toBe(0);
  });
  it("allows a call at the exact limit and blocks the next after actual overrun", async () => {
    mocks.repository.planDiscovery!.mockResolvedValue(plan(["one", "two", "three"]));
    const ai = vi.fn().mockResolvedValue({ ...execution({ relations: [] }), inputTokens: 2000 });
    expect(
      await run(ai, "limit", { ...defaultSourceRelationSettings, maxInputTokens: 2000 })
    ).toMatchObject({
      completed: 2,
      total: 3,
      inputTokens: 4000,
      partial: true,
      coverage: { judgedPairs: 2, candidatePairs: 3, budgetExhausted: true }
    });
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it("blocks a repair after the original response exceeds the real budget", async () => {
    const ai = vi.fn().mockResolvedValue({ ...execution("invalid"), inputTokens: 2500 });
    expect(
      await run(ai, "repair", { ...defaultSourceRelationSettings, maxInputTokens: 2000 })
    ).toMatchObject({ completed: 0, total: 1, inputTokens: 2500, partial: true });
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it("recovers a committed decision before a checkpoint write", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [item()] }));
    const original = mocks.repository.saveRun!;
    mocks.repository.saveRun = vi.fn(
      async (key: string, root: string, state: { completed: string[] }) => {
        if (state.completed.length) throw new Error("checkpoint interrupted");
        return original(key, root, state);
      }
    );
    await expect(run(ai)).rejects.toThrow("checkpoint interrupted");
    mocks.repository.saveRun = original;
    const result = await run(ai);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ persistedCount: 1, completed: 1, total: 1 });
  });
  it("does not silently degrade to generic links after invalid output", async () => {
    const ai = vi.fn().mockResolvedValue(execution("invalid"));
    await expect(run(ai)).rejects.toThrow("errors.sourceRelations.invalidOutput");
    expect(ai).toHaveBeenCalledTimes(2);
    expect(mocks.repository.commitDecision).not.toHaveBeenCalled();
  });
  it("keeps the valid items of the first answer when one repair cannot fix the rest", async () => {
    const ai = vi
      .fn()
      .mockResolvedValueOnce(execution({ relations: [item(), item({ 3: 0.9 })] }))
      .mockResolvedValueOnce(execution("invalid"));
    const result = await run(ai);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1]![1]).toContain("Use only supplied aliases");
    expect(result).toMatchObject({ persistedCount: 1, completed: 1 });
    const [, , , relations, metadata] = mocks.repository.commitDecision!.mock.calls[0]!;
    expect(relations).toHaveLength(1);
    expect(metadata).toMatchObject({ invalidItems: 1, aiTaskRunIds: ["execution", "execution"] });
  });
  it("asks no repair once the valid items fill the pair's two relations", async () => {
    const ai = vi
      .fn()
      .mockResolvedValue(
        execution({ relations: [item(), item({ 2: "extends" }), item({ 1: "s9" })] })
      );
    expect((await run(ai)).persistedCount).toBe(2);
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it("asks for at most two items and stores every returned item with its raw scores apart from the floors", async () => {
    const ai = vi
      .fn()
      .mockResolvedValue(
        execution({ relations: [item({ 3: 95 }), item({ 2: "extends", 3: 70, 4: 99 })] })
      );
    const settings = {
      ...defaultSourceRelationSettings,
      maxInputTokens: 200000,
      maxRelationsPerPair: 4,
      minImportance: 0.85,
      minConfidence: 0.8
    };
    await run(ai, "raw", settings);
    expect(ai.mock.calls[0]![1]).toContain("Return ZERO to 2 items");
    expect(ai.mock.calls[0]![2]).toMatchObject({
      operation: "source_relation_matching",
      promptVersion: "source-relations-v5"
    });
    const [, , , relations, metadata] = mocks.repository.commitDecision!.mock.calls[0]!;
    expect(relations).toEqual([expect.objectContaining({ relationType: "supports" })]);
    expect(metadata).toMatchObject({
      promptVersion: sourceRelationPromptVersion,
      proposals: 2,
      floors: { minImportance: 0.85, minConfidence: 0.8, includeWeakTypes: false },
      items: [
        {
          from: "A",
          to: "B",
          type: "supports",
          importance: 95,
          confidence: 90,
          fromChunks: ["a"],
          toChunks: ["b"],
          attempt: 0,
          outcome: "persisted"
        },
        expect.objectContaining({
          type: "extends",
          importance: 70,
          confidence: 99,
          outcome: "below_floors"
        })
      ]
    });
  });
  it("explains same-root rejection in the bounded repair and accepts a negative decision", async () => {
    // Chunks are ordered by work, so the sibling chapter of root A follows A and precedes root B.
    mocks.repository.pairChunks!.mockResolvedValue([b, a, { ...a, id: "c", sourceItemId: "C" }]);
    const ai = vi
      .fn()
      .mockResolvedValueOnce(execution({ relations: [item()] }))
      .mockResolvedValueOnce(execution({ relations: [] }));
    const result = await run(ai);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1]?.[1]).toContain(
      "Rejected: source and target belong to the SAME root/work"
    );
    expect(result.persistedCount).toBe(0);
    expect(mocks.repository.commitDecision!.mock.calls[0]?.[3]).toEqual([]);
  });
  it("stops visibly when the judge's route changes during a run, and starts over afterwards", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    mocks.selection
      .mockReset()
      .mockResolvedValueOnce(judgeRoute)
      .mockResolvedValue({ ...judgeRoute, modelId: "another-model" });
    await expect(run(ai)).rejects.toThrow("errors.sourceRelations.configurationChanged");
    expect(ai).not.toHaveBeenCalled();
    // The next run judges under the new judge (its pair keys carry it, so nothing is judged twice)
    // the pairs the first plan selected: planning again would lose the reverse neighbours.
    await expect(run(ai)).resolves.toMatchObject({ completed: 1 });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(mocks.repository.planDiscovery).toHaveBeenCalledTimes(1);
  });
  it("keys the judge on its identity, which a task default beneath the parameters changes", async () => {
    const settings = { ...defaultSourceRelationSettings, maxInputTokens: 200000 };
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    await run(ai, "run", settings);
    const prompts = changedPromptIdentity([
      "sources.decide",
      "sources.decide.repair",
      "sources.validation.default",
      "sources.validation.same_root"
    ]);
    const identity = createHash("sha256")
      .update(
        JSON.stringify({
          version: sourceRelationPromptVersion,
          ...(prompts ? { prompts } : {}),
          language: "en",
          request: sourceJudgeRequestSettings(settings, relationsConfig.sourceJudge),
          provider: "provider",
          model: "model",
          runtime: "local",
          localModel: null,
          revision: "r1",
          parameters: {},
          defaults: {}
        })
      )
      .digest("hex");
    expect((states.get("run:root-A") as { configuration: string }).configuration).toBe(identity);
    mocks.taskDefaults = { reasoningLevel: "off" };
    try {
      await run(ai, "default", settings);
      expect(ai).toHaveBeenCalledTimes(2);
    } finally {
      mocks.taskDefaults = null;
    }
  });
});

describe("re-promotion (R14)", () => {
  it("re-promotes every root of the sources it is given, with no call", async () => {
    mocks.repository = {
      roots: vi.fn().mockResolvedValue(["root-A", "root-B"]),
      promoteFromNotes: vi.fn(async (root: string) => ({
        ...noPromotion,
        promoted: root === "root-A" ? 1 : 0,
        retired: root === "root-A" ? 1 : 0
      }))
    };
    expect(await promoteSourceRelations({} as PgPool, ["A", "B", "A"])).toEqual({
      promoted: 1,
      refreshed: 0,
      retired: 1
    });
    expect(mocks.repository.roots).toHaveBeenCalledWith(["A", "B"]);
    expect(mocks.repository.promoteFromNotes).toHaveBeenCalledTimes(2);
  });
});

/**
 * The same two works under any UUID assignment: three sources of two roots, four chunks and one
 * symmetric note stored in the direction opposite to the prompt's content order. The database may
 * hand the chunks back in any order.
 */
const worksFor = (ids: string[], rotation = 0) => {
  const [learning, memory, retrieval, spacing, paper, c1, c2, c3, c4] = ids as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string
  ];
  const chunk = (
    id: string,
    sourceItemId: string,
    rootId: string,
    title: string,
    rootTitle: string,
    chunkIndex: number,
    content: string
  ): SourceRelationChunk => ({
    id,
    sourceItemId,
    rootId,
    title,
    rootTitle,
    chunkIndex,
    content,
    contentHash: `hash-${content}`,
    documentId: `document-${sourceItemId}`,
    sourceSpanId: null,
    summary: `Summary of ${title}`
  });
  const inContentOrder = [
    chunk(c1, retrieval, learning, "Retrieval", "Learning mechanisms", 0, "Retrieval strengthens."),
    chunk(c2, retrieval, learning, "Retrieval", "Learning mechanisms", 1, "Feedback corrects."),
    chunk(c3, spacing, learning, "Spacing", "Learning mechanisms", 0, "Spacing distributes."),
    chunk(c4, paper, memory, "Memory paper", "Memory paper", 0, "Memory consolidates.")
  ];
  const chunks = [...inContentOrder.slice(rotation), ...inContentOrder.slice(0, rotation)];
  const note: SourceRelationNote = {
    id: `note-relation-${ids[0]}`,
    type: "contrasts",
    sourceNoteId: `note-${c4}`,
    targetNoteId: `note-${c1}`,
    sourceChunkId: c4,
    targetChunkId: c1,
    sourceItemId: paper,
    targetSourceItemId: retrieval,
    sourceIdea: "Memory consolidates.",
    targetIdea: "Retrieval strengthens.",
    fingerprint: "note-fingerprint"
  };
  const existing = {
    id: `existing-${spacing}`,
    sourceItemId: retrieval,
    targetSourceItemId: paper,
    relationType: "supports",
    sourceIdea: "Old idea",
    targetIdea: "Older idea",
    status: "accepted"
  };
  const ordered = orderSourceRelationChunks(chunks);
  const sources = [...new Set(ordered.map((c) => c.sourceItemId))];
  const context: SourceRelationContext = {
    chunks: ordered,
    notes: orientSymmetricNotes([note], sources),
    existing: [existing]
  };
  return { context, ids: { retrieval, spacing, paper, learning, memory, c1, c4 } };
};

describe("source relation prompts do not depend on database IDs", () => {
  it("number sources, roots, chunks and notes by content under any UUID assignment", () => {
    const prompts = uuidAssignments(9).map((ids, index) =>
      sourceDecisionPrompt(worksFor(ids, index).context, 2, false)
    );
    expect(prompts.length).toBeGreaterThan(1);
    expect(new Set(prompts).size).toBe(1);
    const prompt = prompts[0]!;
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(prompt).toContain('"key":"s1","root":"w1","title":"Retrieval"');
    expect(prompt).toContain('"key":"s2","root":"w1","title":"Spacing"');
    expect(prompt).toContain('"key":"s3","root":"w2","title":"Memory paper"');
    expect(prompt.indexOf("Retrieval strengthens.")).toBeLessThan(
      prompt.indexOf("Feedback corrects.")
    );
    expect(prompt.indexOf("Feedback corrects.")).toBeLessThan(
      prompt.indexOf("Spacing distributes.")
    );
    expect(prompt.indexOf("Spacing distributes.")).toBeLessThan(
      prompt.indexOf("Memory consolidates.")
    );
    // The stored pair runs from the paper to the retrieval chapter; the prompt reads lower alias first.
    expect(prompt).toContain('"source":"s1","target":"s3","type":"contrasts"');
    expect(prompt).toContain('"evidence":["c1","c4"]');
  });

  it("reads a symmetric relation from the lower alias and writes it in that direction", () => {
    for (const [index, ids] of uuidAssignments(9).entries()) {
      const { context, ids: works } = worksFor(ids, index);
      for (const answer of [
        ["s1", "s3", "contrasts", 90, 90, ["c1"], ["c4"]],
        ["s3", "s1", "contrasts", 90, 90, ["c4"], ["c1"]]
      ]) {
        const parsed = parseSourceDecision({ relations: [answer] }, context, 0);
        const result = sourceRelationWrites(
          parsed.items,
          context,
          defaultSourceRelationSettings,
          2
        );
        expect(result.relations[0]).toMatchObject({
          sourceItemId: works.retrieval,
          targetSourceItemId: works.paper,
          relationType: "contradicts"
        });
        expect(result.relations[0]?.evidence[0]?.note?.sourceChunkId).toBe(works.c1);
      }
    }
  });

  it("treats a symmetric relation saved in the reverse direction as the same relation", () => {
    const { context, ids: works } = worksFor(uuidAssignments(9)[0]!);
    const saved = (status: string) => ({
      id: "saved",
      sourceItemId: works.paper,
      targetSourceItemId: works.retrieval,
      relationType: "contradicts",
      sourceIdea: null,
      targetIdea: null,
      status
    });
    const answer = { relations: [["s1", "s3", "contrasts", 90, 90, ["c1"], ["c4"]]] };
    const known = sourceRelationWrites(
      parseSourceDecision(answer, context, 0).items,
      { ...context, existing: [saved("accepted")] },
      defaultSourceRelationSettings,
      2
    );
    expect(known.proposals).toBe(0);
    expect(known.relations).toHaveLength(1);
    expect(
      sourceRelationWrites(
        parseSourceDecision(answer, context, 0).items,
        { ...context, existing: [saved("rejected")] },
        defaultSourceRelationSettings,
        2
      )
    ).toMatchObject({ proposals: 0, relations: [] });
  });

  it("sends the model the same prompt for the same works under any UUID assignment", async () => {
    const states = new Map<string, unknown>();
    const decisions = new Map<string, Record<string, unknown>>();
    mocks.selection.mockReset().mockResolvedValue(judgeRoute);
    const prompts: string[] = [];
    for (const [index, ids] of uuidAssignments(9).entries()) {
      const { context, ids: works } = worksFor(ids, index);
      mocks.repository = {
        roots: vi.fn().mockResolvedValue([works.learning]),
        fingerprint: vi.fn(async (id: string) => id),
        promoteFromNotes: vi.fn().mockResolvedValue(noPromotion),
        discoveryVector: vi.fn().mockResolvedValue({ spaceKey: "256:space" }),
        planDiscovery: vi.fn().mockResolvedValue(plan([works.memory])),
        owedDiscoveryRoots: vi.fn().mockResolvedValue([]),
        pairNotes: vi.fn().mockResolvedValue([]),
        pairNoteFingerprints: vi.fn().mockResolvedValue([]),
        // The database returns the chunks in whatever order it likes.
        pairChunks: vi.fn().mockResolvedValue([...context.chunks].reverse()),
        existing: vi.fn().mockResolvedValue([]),
        runState: vi.fn(async (key: string) => structuredClone(states.get(key) ?? null)),
        saveRun: vi.fn(async (key: string, _root: string, state: unknown) => {
          states.set(key, structuredClone(state));
        }),
        decision: vi.fn(async (key: string) => decisions.get(key) ?? null),
        commitDecision: vi.fn(async (key: string, _a: string, _b: string, relations: unknown[]) => {
          decisions.set(key, { persistedCount: relations.length });
          return relations.length;
        })
      };
      const ai = vi.fn().mockResolvedValue({
        output: { relations: [] },
        profileId: "profile",
        modelId: "model",
        providerId: "provider",
        runtime: "local",
        aiTaskRunId: "execution"
      });
      await matchSources({
        pool: {} as PgPool,
        ai: { runDefaultTask: ai },
        sourceIds: [works.learning],
        runKey: `determinism-${index}`,
        settings: { ...defaultSourceRelationSettings, maxInputTokens: 200000 },
        contentLanguage: "en"
      });
      prompts.push(ai.mock.calls[0]![1] as string);
    }
    expect(prompts).toHaveLength(4);
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).toContain('"key":"s1","root":"w1","title":"Retrieval"');
  });
});

it("forbids lexical disambiguation and proper-name reinterpretation as conceptual clarification", () => {
  const prompt = sourceDecisionPrompt(context, 2, false);
  expect(prompt).toContain("Merely distinguishing homonyms or unrelated senses");
  expect(prompt).toContain("must never be reinterpreted as an abstract definition");
});
