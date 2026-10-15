import { changedPromptIdentity, defaultPromptPin, withPromptPin } from "./prompt-runtime.js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createHash } from "node:crypto";
import { defaultSourceRelationSettings, sourceDecisionPassesFloors } from "@app/domain";
import type { SourceRelationChunk, SourceRelationNote, PgPool } from "@app/db";
import { uuidAssignments } from "./__fixtures__/uuid-assignments.js";
import { runSourcePairVerdicts } from "./golden-source-pairs.js";
import {
  combineSourceRelationCoverage,
  matchSources,
  orderSourceRelationChunks,
  orientSymmetricNotes,
  parseSourceDecision,
  rankSourceCandidates,
  sourceDecisionPrompt,
  sourceRelationPromptVersion,
  sourceRelationWrites,
  type SourceRelationContext
} from "./source-relation-processing.js";

const mocks = vi.hoisted(() => ({
  repository: {} as Record<string, Mock<(...args: any[]) => any>>,
  selection: vi.fn(),
  taskDefaults: null as Record<string, unknown> | null
}));
vi.mock("@app/db", () => ({
  createSourceRelationRepository: () => mocks.repository,
  createAiConfigRepository: () => ({ getDefaultTask: mocks.selection })
}));
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
    const parsed = parse([item({ 0: "s2", 1: "s1", 2: "similar_to", 5: ["c2"], 6: ["c1"] })]);
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
    // A symmetric relation rejected the other way round is the same relation.
    expect(
      writes([item({ 2: "similar_to" })], {
        ...context,
        existing: [saved("rejected", "B", "A", "similar_to")]
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

  it("keeps note reuse and direct discovery in every shortlist prefix", () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      title: `Work ${i}`,
      textScore: 1 - i / 50,
      vectorScore: 0.8,
      graphScore: 0,
      noteScore: i < 20 ? 1 : 0
    }));
    const selected = rankSourceCandidates(candidates, 40).slice(0, 8);
    expect(selected.filter((candidate) => candidate.noteScore > 0)).toHaveLength(4);
    expect(selected.filter((candidate) => candidate.noteScore === 0)).toHaveLength(4);
  });
});

describe("source matching budget and recovery", () => {
  let states: Map<string, unknown>, decisions: Map<string, Record<string, unknown>>;
  beforeEach(() => {
    states = new Map();
    decisions = new Map();
    mocks.selection.mockReset().mockResolvedValue({
      profileId: "profile",
      providerConfigId: "provider",
      modelId: "model",
      runtime: "local",
      localModelId: null,
      revision: "r1",
      parameters: {},
      modelDefaultParameters: {}
    });
    mocks.repository = {
      roots: vi.fn().mockResolvedValue(["root-A"]),
      fingerprint: vi.fn(async (id: string) => id),
      candidates: vi
        .fn()
        .mockResolvedValue([
          { id: "root-B", textScore: 1, vectorScore: 0, graphScore: 0, noteScore: 1 }
        ]),
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
    settings = { ...defaultSourceRelationSettings, maxInputTokens: 200000 }
  ) =>
    matchSources({
      pool: {} as PgPool,
      ai: { runDefaultTask: ai },
      sourceIds: ["A"],
      runKey: key,
      settings,
      contentLanguage: "en"
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
  it("reports planned and completed pair counts, counting a repair only once", async () => {
    const onProgress = vi.fn();
    const ai = vi
      .fn()
      .mockResolvedValueOnce(execution("invalid"))
      .mockResolvedValue(execution({ relations: [] }));
    const result = await matchSources({
      pool: {} as PgPool,
      ai: { runDefaultTask: ai },
      sourceIds: ["A"],
      runKey: "progress",
      settings: { ...defaultSourceRelationSettings, maxInputTokens: 200000 },
      contentLanguage: "en",
      onProgress
    });
    expect(onProgress.mock.calls[0]).toEqual([0, { completed: 0, total: 1 }]);
    expect(onProgress.mock.calls.at(-1)).toEqual([1, { completed: 1, total: 1 }]);
    expect(result).toMatchObject({ completed: 1, total: 1 });
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it("keeps partial counts across resume instead of inventing completed analyses", async () => {
    mocks.repository.candidates!.mockResolvedValue(
      ["one", "two"].map((id) => ({
        id,
        textScore: 1,
        vectorScore: 0,
        graphScore: 0,
        noteScore: 0
      }))
    );
    const ai = vi.fn().mockResolvedValue({ ...execution({ relations: [] }), inputTokens: 2500 });
    const settings = { ...defaultSourceRelationSettings, maxInputTokens: 2000 };
    expect(await run(ai, "partial", settings)).toMatchObject({
      completed: 1,
      total: 2,
      partial: true
    });
    expect(await run(ai, "partial", settings)).toMatchObject({
      completed: 1,
      total: 2,
      partial: true
    });
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it("counts a reciprocal pair only once across a collective batch", async () => {
    mocks.repository.roots!.mockResolvedValue(["root-A", "root-B"]);
    mocks.repository.candidates!.mockImplementation(async (root: string) => [
      {
        id: root === "root-A" ? "root-B" : "root-A",
        textScore: 1,
        vectorScore: 0,
        graphScore: 0,
        noteScore: 1
      }
    ]);
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    expect(await run(ai)).toMatchObject({ completed: 1, total: 1, rootCount: 2 });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(await run(ai)).toMatchObject({ completed: 1, total: 1 });
  });
  it("judges a pair once: a note-backed relation saved from one side keeps the other side's key", async () => {
    // Saving a relation that cites a note relation removes it from both sides' prompts.
    const cited = new Set<string>();
    mocks.repository.pairNotes!.mockImplementation(async () => (cited.has(note.id) ? [] : [note]));
    mocks.repository.commitDecision!.mockImplementation(
      async (
        key: string,
        _a: string,
        _b: string,
        relations: Array<{ evidence: Array<{ note: { id: string } | null }> }>,
        metadata: Record<string, unknown>
      ) => {
        for (const relation of relations)
          for (const evidence of relation.evidence) if (evidence.note) cited.add(evidence.note.id);
        decisions.set(key, { ...metadata, persistedCount: relations.length });
        return relations.length;
      }
    );
    mocks.repository.roots!.mockResolvedValueOnce(["root-A"]).mockResolvedValueOnce(["root-B"]);
    mocks.repository.candidates!.mockImplementation(async (root: string) => [
      {
        id: root === "root-A" ? "root-B" : "root-A",
        textScore: 1,
        vectorScore: 0,
        graphScore: 0,
        noteScore: root === "root-A" ? 1 : 0
      }
    ]);
    const ai = vi.fn().mockResolvedValue(execution({ relations: [item()] }));
    expect((await run(ai, "first")).persistedCount).toBe(1);
    expect(cited.has(note.id)).toBe(true);
    expect(await run(ai, "second")).toMatchObject({ completed: 0, total: 0, persistedCount: 0 });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(mocks.repository.pairNoteFingerprints).toHaveBeenCalledWith("root-B", "root-A");
  });
  it("judges a pair again when a new note relation appears between the two roots", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    await run(ai);
    mocks.repository.pairNoteFingerprints!.mockResolvedValue([note.fingerprint, "new-note"]);
    await run(ai, "second");
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it("caches negative decisions across executions without more model calls", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    await run(ai);
    expect(await run(ai, "second")).toMatchObject({ completed: 0, total: 0 });
    expect(ai).toHaveBeenCalledTimes(1);
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
  it("finishes all six affordable analyses without estimating usage", async () => {
    mocks.repository.candidates!.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `candidate-${index}`,
        textScore: 1,
        vectorScore: 0,
        graphScore: 0,
        noteScore: 0
      }))
    );
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    expect(
      await run(ai, "six", { ...defaultSourceRelationSettings, maxInputTokens: 20000 })
    ).toMatchObject({ completed: 6, total: 6, inputTokens: 600, partial: false });
    expect(ai).toHaveBeenCalledTimes(6);
  });
  it("allows a call at the exact limit and blocks the next after actual overrun", async () => {
    mocks.repository.candidates!.mockResolvedValue(
      ["one", "two", "three"].map((id) => ({
        id,
        textScore: 1,
        vectorScore: 0,
        graphScore: 0,
        noteScore: 0
      }))
    );
    const ai = vi.fn().mockResolvedValue({ ...execution({ relations: [] }), inputTokens: 2000 });
    expect(
      await run(ai, "limit", { ...defaultSourceRelationSettings, maxInputTokens: 2000 })
    ).toMatchObject({ completed: 2, total: 3, inputTokens: 4000, partial: true });
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it("blocks a repair after the original response exceeds the real budget", async () => {
    const ai = vi.fn().mockResolvedValue({ ...execution("invalid"), inputTokens: 2500 });
    expect(
      await run(ai, "repair", { ...defaultSourceRelationSettings, maxInputTokens: 2000 })
    ).toMatchObject({ completed: 0, total: 1, inputTokens: 2500, partial: true });
    expect(ai).toHaveBeenCalledTimes(1);
  });
  describe("coverage in the stage checkpoint metadata", () => {
    const candidatesNamed = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `candidate-${index}`,
        title: `Work ${String(index).padStart(2, "0")}`,
        textScore: 1 - index / 100,
        vectorScore: 0,
        graphScore: 0,
        noteScore: 0
      }));
    const settingsWith = (overrides: Partial<typeof defaultSourceRelationSettings>) => ({
      ...defaultSourceRelationSettings,
      maxInputTokens: 200000,
      ...overrides
    });

    it("records the per-run pair cap as coverage, not as a partial run", async () => {
      mocks.repository.candidates!.mockResolvedValue(candidatesNamed(8));
      const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
      const result = await run(ai, "cap", settingsWith({ maxPairs: 3 }));
      expect(ai).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ partial: false, completed: 3, total: 3 });
      expect(result.coverage).toEqual({
        judgedPairs: 3,
        candidatePairs: 8,
        capReached: true,
        relationLimitReached: false,
        budgetExhausted: false
      });
      expect(states.get("cap:root-A")).toMatchObject({
        partial: false,
        finished: true,
        coverage: result.coverage
      });
    });

    it("reports a fully judged shortlist without any limit", async () => {
      mocks.repository.candidates!.mockResolvedValue(candidatesNamed(2));
      const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
      const result = await run(ai, "full", settingsWith({ maxPairs: 3 }));
      expect(result.coverage).toEqual({
        judgedPairs: 2,
        candidatePairs: 2,
        capReached: false,
        relationLimitReached: false,
        budgetExhausted: false
      });
    });

    it("records the relation limit apart from the cap", async () => {
      mocks.repository.candidates!.mockResolvedValue(candidatesNamed(4));
      const ai = vi.fn().mockResolvedValue(execution({ relations: [item()] }));
      const result = await run(ai, "limit", settingsWith({ maxRelations: 1, maxPairs: 4 }));
      expect(ai).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ partial: false, persistedCount: 1 });
      expect(result.coverage).toEqual({
        judgedPairs: 1,
        candidatePairs: 4,
        capReached: false,
        relationLimitReached: true,
        budgetExhausted: false
      });
    });

    it("records an exhausted input budget as the only partial reason", async () => {
      mocks.repository.candidates!.mockResolvedValue(candidatesNamed(3));
      const ai = vi.fn().mockResolvedValue({ ...execution({ relations: [] }), inputTokens: 2500 });
      const result = await run(ai, "budget", settingsWith({ maxInputTokens: 2000 }));
      expect(result.partial).toBe(true);
      expect(result.coverage).toEqual({
        judgedPairs: 1,
        candidatePairs: 3,
        capReached: false,
        relationLimitReached: false,
        budgetExhausted: true
      });
    });

    it("counts the candidates an earlier run already judged and advances with each run", async () => {
      mocks.repository.candidates!.mockResolvedValue(candidatesNamed(5));
      const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
      const settings = settingsWith({ maxPairs: 2 });
      const judged = async (key: string) => (await run(ai, key, settings)).coverage;
      expect(await judged("first")).toMatchObject({ judgedPairs: 2, capReached: true });
      expect(await judged("second")).toMatchObject({ judgedPairs: 4, capReached: true });
      expect(await judged("third")).toMatchObject({
        judgedPairs: 5,
        candidatePairs: 5,
        capReached: false
      });
      expect(ai).toHaveBeenCalledTimes(5);
    });

    it("counts already judged candidates that rank after the cap without judging more", async () => {
      const candidates = candidatesNamed(5);
      mocks.repository.candidates!.mockResolvedValue(candidates);
      const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
      const settings = settingsWith({ maxPairs: 2 });
      await run(ai, "before", settings);
      expect(ai).toHaveBeenCalledTimes(2);
      // The two judged works now rank last: the cap stops the plan before them, and they still count.
      mocks.repository.candidates!.mockResolvedValue(
        candidates.map((candidate, index) => ({ ...candidate, textScore: index / 10 + 0.1 }))
      );
      const after = await run(ai, "after", settings);
      expect(ai).toHaveBeenCalledTimes(4);
      expect(after.coverage).toEqual({
        judgedPairs: 4,
        candidatePairs: 5,
        capReached: true,
        relationLimitReached: false,
        budgetExhausted: false
      });
    });

    it("keeps the stored coverage when a finished run is resumed", async () => {
      mocks.repository.candidates!.mockResolvedValue(candidatesNamed(8));
      const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
      const first = await run(ai, "again", settingsWith({ maxPairs: 3 }));
      expect((await run(ai, "again", settingsWith({ maxPairs: 3 }))).coverage).toEqual(
        first.coverage
      );
      expect(ai).toHaveBeenCalledTimes(3);
    });

    it("does not count a candidate without evidence on both sides", async () => {
      mocks.repository.candidates!.mockResolvedValue(candidatesNamed(2));
      mocks.repository.pairChunks!.mockResolvedValueOnce([a]).mockResolvedValue([a, b]);
      const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
      const result = await run(ai, "thin", settingsWith({ maxPairs: 3 }));
      expect(result.coverage).toMatchObject({ judgedPairs: 1, candidatePairs: 1 });
    });

    it("counts a reciprocal pair as judged for both roots of a collective run", async () => {
      mocks.repository.roots!.mockResolvedValue(["root-A", "root-B"]);
      mocks.repository.candidates!.mockImplementation(async (root: string) => [
        {
          id: root === "root-A" ? "root-B" : "root-A",
          textScore: 1,
          vectorScore: 0,
          graphScore: 0,
          noteScore: 1
        }
      ]);
      const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
      const result = await run(ai, "collective");
      expect(ai).toHaveBeenCalledTimes(1);
      expect(result.coverage).toMatchObject({ judgedPairs: 2, candidatePairs: 2 });
    });

    it("adds up the roots of a run and leaves coverage unknown when any root predates it", () => {
      const part = {
        judgedPairs: 2,
        candidatePairs: 5,
        capReached: true,
        relationLimitReached: false,
        budgetExhausted: false
      };
      expect(
        combineSourceRelationCoverage([
          part,
          { ...part, judgedPairs: 1, candidatePairs: 1, capReached: false, budgetExhausted: true }
        ])
      ).toEqual({
        judgedPairs: 3,
        candidatePairs: 6,
        capReached: true,
        relationLimitReached: false,
        budgetExhausted: true
      });
      expect(combineSourceRelationCoverage([part, undefined])).toBeUndefined();
    });
  });
  it("recovers a committed decision before a checkpoint write without exceeding the proposal cap", async () => {
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
    expect(result.persistedCount).toBe(1);
    expect(result).toMatchObject({ completed: 1, total: 1 });
    expect((states.get("run:root-A") as { proposals: number }).proposals).toBe(1);
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
  it("excludes the current root before ranking, evidence retrieval and model execution", async () => {
    mocks.repository.candidates!.mockResolvedValue([
      { id: "root-A", textScore: 1, vectorScore: 1, graphScore: 1, noteScore: 1 }
    ]);
    const ai = vi.fn();
    await run(ai);
    expect(mocks.repository.pairNotes).not.toHaveBeenCalled();
    expect(mocks.repository.pairChunks).not.toHaveBeenCalled();
    expect(ai).not.toHaveBeenCalled();
  });
  it("preserves spent budgets and decisions when language serialization invalidates an old checkpoint", async () => {
    const settings = { ...defaultSourceRelationSettings, maxInputTokens: 200000 };
    const configuration = createHash("sha256")
      .update(
        JSON.stringify({
          version: "source-relations-v1",
          language: "en",
          settings,
          profile: "profile",
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
    states.set("run:root-A", {
      settings,
      configuration,
      pairs: ["done", "failed"],
      completed: ["done"],
      attempts: { done: 1, failed: 2 },
      inputTokens: 10000,
      proposals: 1,
      persistedCount: 1,
      partial: false,
      finished: false
    });
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    await expect(run(ai)).rejects.toThrow("errors.sourceRelations.configurationChanged");
    expect(ai).not.toHaveBeenCalled();
    expect(states.get("run:root-A")).toMatchObject({
      completed: ["done"],
      inputTokens: 10000,
      persistedCount: 1,
      proposals: 1,
      attempts: { failed: 2 }
    });
  });
  it("keeps its run fingerprint while the task adds nothing and notices a task default that changes the parameters", async () => {
    const settings = { ...defaultSourceRelationSettings, maxInputTokens: 200000 };
    const ai = vi.fn().mockResolvedValue(execution({ relations: [] }));
    await run(ai, "run", settings);
    // The reasoning-off default belongs to the note decision call only: source matching hashes
    // exactly the profile, model and parameters, as before the default existed.
    const prompts = changedPromptIdentity([
      "sources.decide",
      "sources.decide.repair",
      "sources.validation.default",
      "sources.validation.same_root"
    ]);
    const unchanged = createHash("sha256")
      .update(
        JSON.stringify({
          version: sourceRelationPromptVersion,
          ...(prompts ? { prompts } : {}),
          language: "en",
          settings,
          profile: "profile",
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
    expect((states.get("run:root-A") as { configuration: string }).configuration).toBe(unchanged);
    // A resumed run whose task now adds a default no longer matches its saved fingerprint.
    mocks.taskDefaults = { reasoningLevel: "off" };
    try {
      await expect(run(ai, "run", settings)).rejects.toThrow(
        "errors.sourceRelations.configurationChanged"
      );
    } finally {
      mocks.taskDefaults = null;
    }
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
    type: "similar_to",
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
    expect(prompt).toContain('"source":"s1","target":"s3","type":"similar_to"');
    expect(prompt).toContain('"evidence":["c1","c4"]');
  });

  it("reads a symmetric relation from the lower alias and writes it in that direction", () => {
    for (const [index, ids] of uuidAssignments(9).entries()) {
      const { context, ids: works } = worksFor(ids, index);
      for (const answer of [
        ["s1", "s3", "similar_to", 90, 90, ["c1"], ["c4"]],
        ["s3", "s1", "similar_to", 90, 90, ["c4"], ["c1"]]
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
          targetSourceItemId: works.paper
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
      relationType: "similar_to",
      sourceIdea: "Memory consolidates.",
      targetIdea: "Retrieval strengthens.",
      status
    });
    const answer = { relations: [["s1", "s3", "similar_to", 90, 90, ["c1"], ["c4"]]] };
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

  it("breaks candidate ties on the work title, never on the candidate ID", () => {
    for (const [first, second] of uuidAssignments(2).map((ids) => ids as [string, string])) {
      const signals = { textScore: 0.5, vectorScore: 0.5, graphScore: 0, noteScore: 0 };
      const candidates = [
        { id: first, title: "Zeta work", ...signals },
        { id: second, title: "Alpha work", ...signals }
      ];
      expect(rankSourceCandidates(candidates, 2).map((candidate) => candidate.title)).toEqual([
        "Alpha work",
        "Zeta work"
      ]);
    }
  });

  it("sends the model the same prompt for the same works under any UUID assignment", async () => {
    const states = new Map<string, unknown>();
    const decisions = new Map<string, Record<string, unknown>>();
    mocks.selection.mockReset().mockResolvedValue({
      profileId: "profile",
      providerConfigId: "provider",
      modelId: "model",
      runtime: "local",
      localModelId: null,
      revision: "r1",
      parameters: {},
      modelDefaultParameters: {}
    });
    const prompts: string[] = [];
    for (const [index, ids] of uuidAssignments(9).entries()) {
      const { context, ids: works } = worksFor(ids, index);
      mocks.repository = {
        roots: vi.fn().mockResolvedValue([works.learning]),
        fingerprint: vi.fn(async (id: string) => id),
        candidates: vi.fn().mockResolvedValue([
          {
            id: works.memory,
            title: "Memory paper",
            textScore: 1,
            vectorScore: 0,
            graphScore: 0,
            noteScore: 0
          }
        ]),
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
