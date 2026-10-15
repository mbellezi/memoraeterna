import { changedPromptIdentity, defaultPromptPin, withPromptPin } from "./prompt-runtime.js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createHash } from "node:crypto";
import { defaultSourceRelationSettings } from "@app/domain";
import type { SourceRelationChunk, SourceRelationNote, PgPool } from "@app/db";
import { uuidAssignments } from "./__fixtures__/uuid-assignments.js";
import {
  matchSources,
  orderSourceRelationChunks,
  orientSymmetricNotes,
  parseSourceRelations,
  rankSourceCandidates,
  sourceRelationPrompt,
  sourceRelationPromptVersion,
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
const proposal = () => ({
  source: "s1",
  target: "s2",
  type: "supports",
  sourceIdea: a.content,
  targetIdea: b.content,
  explanation: "The explanation connects mechanisms of retention.",
  importance: 0.9,
  confidence: 0.9,
  durable: true,
  grounded: true,
  sourceEvidence: ["c1"],
  targetEvidence: ["c2"],
  noteRelations: [],
  discovery: "source_analysis",
  existing: null
});
const parse = (relations: unknown[], ctx = context) =>
  parseSourceRelations({ relations }, ctx, defaultSourceRelationSettings, 4);

describe("source relation semantics", () => {
  it("resolves textual aliases to stable source-reference tags in semantic endpoint order", () => {
    const result = parse([
      {
        ...proposal(),
        source: "s2",
        target: "s1",
        sourceEvidence: ["c2"],
        targetEvidence: ["c1"],
        sourceIdea: "s2 gives evidence.",
        explanation: "s2 supports s1; s1 remains qualified."
      }
    ]);
    expect(result.relations[0]).toMatchObject({
      sourceItemId: "B",
      targetSourceItemId: "A",
      sourceIdea: '<source-ref id="B" /> gives evidence.',
      explanation:
        '<source-ref id="B" /> supports <source-ref id="A" />; <source-ref id="A" /> remains qualified.'
    });
    expect(() => parse([{ ...proposal(), explanation: "s30 supports s1." }])).toThrow();
    expect(() =>
      parse([{ ...proposal(), explanation: '<source-ref id="unknown" /> supports s1.' }])
    ).toThrow();
  });
  it("allows zero output and rejects event-only, ungrounded, weak and low-importance proposals", () => {
    expect(parse([]).relations).toEqual([]);
    for (const fields of [
      { durable: false },
      { grounded: false },
      { importance: 0.1 },
      { confidence: 0.1 },
      { type: "related" },
      { type: "mentions" }
    ]) {
      expect(parse([{ ...proposal(), ...fields }]).relations).toEqual([]);
    }
  });
  it("retains distinct ideas and types between the same sources", () => {
    const result = parse([
      proposal(),
      { ...proposal(), sourceIdea: "Feedback corrects retrieval errors." },
      { ...proposal(), type: "extends" }
    ]);
    expect(result.relations).toHaveLength(3);
  });
  it("consolidates the same connection from both routes without boosting confidence", () => {
    const result = parse([
      proposal(),
      { ...proposal(), discovery: "atomic_notes", noteRelations: ["n1"] }
    ]);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]?.evidence).toHaveLength(2);
    expect(result.relations[0]?.confidence).toBe(0.9);
  });
  it("requires evidence from the correct owners and known aliases on both sides", () => {
    for (const fields of [
      { sourceEvidence: ["c2"] },
      { targetEvidence: ["unknown"] },
      { source: "unknown" },
      { source: "s2", target: "s2" },
      { discovery: "atomic_notes" },
      { discovery: "atomic_notes", noteRelations: ["n9"] },
      { noteRelations: ["n1"] }
    ]) {
      expect(() => parse([{ ...proposal(), ...fields }])).toThrow();
    }
    expect(() =>
      parse([proposal()], { ...context, chunks: [a, { ...b, rootId: a.rootId }] })
    ).toThrow();
  });
  it("does not reverse directional note relationships or change their type", () => {
    expect(() =>
      parse([{ ...proposal(), discovery: "atomic_notes", noteRelations: ["n1"], type: "extends" }])
    ).toThrow();
    expect(() =>
      parse([
        {
          ...proposal(),
          discovery: "atomic_notes",
          noteRelations: ["n1"],
          source: "s2",
          target: "s1",
          sourceEvidence: ["c2"],
          targetEvidence: ["c1"]
        }
      ])
    ).toThrow();
  });
  it("preserves reviewed propositions and never resurrects rejected matches", () => {
    const existing = {
      id: "existing",
      sourceItemId: "A",
      targetSourceItemId: "B",
      relationType: "supports",
      sourceIdea: "Reviewed idea",
      targetIdea: b.content,
      status: "accepted"
    };
    const result = parse([{ ...proposal(), existing: "r1" }], { ...context, existing: [existing] });
    expect(result).toEqual({ proposals: 0, relations: [] });
    expect(
      parse([{ ...proposal(), existing: "r1" }], {
        ...context,
        existing: [{ ...existing, status: "rejected" }]
      }).relations
    ).toEqual([]);
    expect(() =>
      parse([{ ...proposal(), existing: "r2" }], { ...context, existing: [existing] })
    ).toThrow();
  });
  it("excludes exact saved connections without an alias but keeps new ideas between the same sources", () => {
    for (const status of ["pending_review", "accepted", "rejected"]) {
      const existing = {
        id: "existing",
        sourceItemId: "A",
        targetSourceItemId: "B",
        relationType: "supports",
        sourceIdea: a.content,
        targetIdea: b.content,
        status
      };
      const ctx = { ...context, existing: [existing] };
      const result = parse(
        [proposal(), { ...proposal(), sourceIdea: "A different mechanism." }],
        ctx
      );
      expect(result.proposals).toBe(1);
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0]?.sourceIdea).toBe("A different mechanism.");
      expect(sourceRelationPrompt(ctx, 4, false)).toContain(
        "EXCLUSION LIST, never candidates for ranking or enrichment"
      );
    }
  });
  it("enforces the remaining global allowance before persistence", () => {
    expect(() =>
      parseSourceRelations(
        { relations: [proposal(), proposal()] },
        context,
        defaultSourceRelationSettings,
        1
      )
    ).toThrow();
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
  it("uses compact aliases and explicitly treats summaries and old note links as hypotheses", () => {
    const prompt = sourceRelationPrompt(context, 4, false);
    expect(prompt).toContain("Summaries are navigation aids, NEVER evidence");
    expect(prompt).toContain("hypotheses, NOT proof");
    expect(prompt).toContain("Return ZERO to 4");
    expect(prompt).not.toContain("note-relation");
    expect(prompt).toContain("beyond a specific event");
  });
  it("exposes shared roots while retaining chapter endpoints and rejecting same-work relations", () => {
    const sibling = { ...a, id: "c", sourceItemId: "C", title: "Another chapter" };
    const ctx = { ...context, chunks: [a, b, sibling] };
    const prompt = sourceRelationPrompt(ctx, 4, false);
    expect(prompt).toContain('"key":"s1","root":"w1"');
    expect(prompt).toContain('"key":"s2","root":"w2"');
    expect(prompt).toContain('"key":"s3","root":"w1"');
    expect(prompt).toContain("DIFFERENT roots");
    expect(() => parse([{ ...proposal(), target: "s3", targetEvidence: ["c3"] }], ctx)).toThrow(
      "source_relation_same_root"
    );
    expect(parse([proposal()], ctx).relations).toHaveLength(1);
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
    for (const id of ["sources.match", "sources.repair", "sources.validation.same_root"]) {
      const entry = pin.entries.find((e) => e.id === id)!;
      entry.fields.body = "CATALOG:" + id + "\n" + entry.fields.body;
    }
    mocks.repository.pairChunks!.mockResolvedValue([a, { ...b, rootId: a.rootId }]);
    const ai = vi
      .fn()
      .mockResolvedValueOnce(execution({ relations: [proposal()] }))
      .mockResolvedValue(execution({ relations: [] }));
    await withPromptPin(pin, () => run(ai));
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[0]![1]).toContain("CATALOG:sources.match");
    expect(ai.mock.calls[1]![1]).toContain("CATALOG:sources.repair");
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
    const ai = vi.fn().mockResolvedValue(
      execution({
        relations: [{ ...proposal(), discovery: "atomic_notes", noteRelations: ["n1"] }]
      })
    );
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
  it("counts actual usage from the original call and its repair", async () => {
    const ai = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect((states.get("run:root-A") as { inputTokens: number }).inputTokens).toBe(0);
        return execution("invalid");
      })
      .mockResolvedValue(execution({ relations: [proposal()] }));
    const result = await run(ai);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(result.persistedCount).toBe(1);
    expect(result.inputTokens).toBe(200);
    expect(ai.mock.calls[0]?.[4]).toEqual({ maxOutputTokens: 3300 });
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
  it("recovers a committed decision before a checkpoint write without exceeding the proposal cap", async () => {
    const ai = vi.fn().mockResolvedValue(execution({ relations: [proposal()] }));
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
  it("explains same-root rejection in the bounded repair and accepts a negative decision", async () => {
    // Chunks are ordered by work, so the sibling chapter of root A follows A and precedes root B.
    mocks.repository.pairChunks!.mockResolvedValue([b, a, { ...a, id: "c", sourceItemId: "C" }]);
    const ai = vi
      .fn()
      .mockResolvedValueOnce(
        execution({ relations: [{ ...proposal(), target: "s2", targetEvidence: ["c2"] }] })
      )
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
      "sources.match",
      "sources.repair",
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
      sourceRelationPrompt(worksFor(ids, index).context, 4, false)
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
    expect(prompt).toContain('"key":"n1","source":"s1","target":"s3","type":"similar_to"');
  });

  it("reads a symmetric relation from the lower alias and writes it in that direction", () => {
    for (const [index, ids] of uuidAssignments(9).entries()) {
      const { context, ids: works } = worksFor(ids, index);
      const proposal = {
        source: "s1",
        target: "s3",
        type: "similar_to",
        sourceIdea: "Retrieval strengthens.",
        targetIdea: "Memory consolidates.",
        explanation: "Both describe how practice stabilizes memory.",
        importance: 0.9,
        confidence: 0.9,
        durable: true,
        grounded: true,
        sourceEvidence: ["c1"],
        targetEvidence: ["c4"],
        noteRelations: ["n1"],
        discovery: "atomic_notes",
        existing: null
      };
      const parsed = parseSourceRelations(
        { relations: [proposal] },
        context,
        defaultSourceRelationSettings,
        4
      );
      expect(parsed.relations[0]).toMatchObject({
        sourceItemId: works.retrieval,
        targetSourceItemId: works.paper
      });
      expect(parsed.relations[0]?.evidence[0]?.note?.sourceChunkId).toBe(works.c1);
      expect(() =>
        parseSourceRelations(
          {
            relations: [
              {
                ...proposal,
                source: "s3",
                target: "s1",
                sourceEvidence: ["c4"],
                targetEvidence: ["c1"]
              }
            ]
          },
          context,
          defaultSourceRelationSettings,
          4
        )
      ).toThrow("errors.sourceRelations.invalidOutput");
    }
  });

  it("treats a symmetric relation saved in the reverse direction as already known", () => {
    const { context, ids: works } = worksFor(uuidAssignments(9)[0]!);
    const saved = {
      id: "saved",
      sourceItemId: works.paper,
      targetSourceItemId: works.retrieval,
      relationType: "similar_to",
      sourceIdea: "Memory consolidates.",
      targetIdea: "Retrieval strengthens.",
      status: "accepted"
    };
    const result = parseSourceRelations(
      {
        relations: [
          {
            source: "s1",
            target: "s3",
            type: "similar_to",
            sourceIdea: "Retrieval strengthens.",
            targetIdea: "Memory consolidates.",
            explanation: "Both describe how practice stabilizes memory.",
            importance: 0.9,
            confidence: 0.9,
            durable: true,
            grounded: true,
            sourceEvidence: ["c1"],
            targetEvidence: ["c4"],
            noteRelations: [],
            discovery: "source_analysis",
            existing: null
          }
        ]
      },
      { ...context, existing: [saved] },
      defaultSourceRelationSettings,
      4
    );
    expect(result).toEqual({ proposals: 0, relations: [] });
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
  const prompt = sourceRelationPrompt(context, 4, false);
  expect(prompt).toContain("Merely distinguishing homonyms or unrelated senses");
  expect(prompt).toContain("must never be reinterpreted as an abstract definition");
});
