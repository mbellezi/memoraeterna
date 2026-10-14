import { describe, expect, it } from "vitest";
import {
  AtomicNoteMatchingSettingsSchema,
  AtomicNoteRelationTypeSchema,
  type AtomicNoteMatchingSettings,
  type AtomicNoteRelationType
} from "@app/domain";

import {
  atomicNoteDecisionContentHash,
  atomicNoteDeciderKey,
  canQualifyAtomicNoteRelation,
  selectAtomicNoteRelations,
  type AtomicNoteRelationSelectionCandidate
} from "./knowledge-processing.js";

/** Small deterministic PRNG (mulberry32) so a failing case can be replayed from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const relationTypes = AtomicNoteRelationTypeSchema.options;

function randomCase(seed: number) {
  const next = random(seed);
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  // Coarse values make ties and exact threshold hits frequent, the edge where a gate could slip.
  const score = () => pick([0, 0.05, 0.25, 1 / 3, 0.4, 0.5, 0.6, 0.65, 0.75, 0.9, 1, next()]);
  const weight = () => pick([0, 0.1, 0.3, 0.55, 1, next()]);
  const settings: AtomicNoteMatchingSettings = AtomicNoteMatchingSettingsSchema.parse({
    withEmbeddingAndGraph: { vector: weight(), text: weight(), graph: weight(), metadata: 0.1 },
    withEmbedding: { vector: weight(), text: weight(), metadata: 0.15 },
    withGraph: { text: weight(), graph: weight(), metadata: 0.15 },
    textAndMetadata: { text: weight(), metadata: 0.3 },
    rerankerWeight: pick([0, 0.2, 0.4, 0.6, 1, next()]),
    minRerankScore: pick([0, 0.5, 0.65, 0.9, 1, next()]),
    requireReranking: next() < 0.7,
    includeWeakTypes: next() < 0.3,
    maxRelationsPerNote: pick([1, 2, 3, 10])
  });
  const threshold = pick([0, 0.3, 0.5, 0.6, 0.75, 0.9, 1, next()]);
  const hasEmbedding = next() < 0.7;
  const candidates = Array.from({ length: 1 + Math.floor(next() * 20) }, (_, index) => ({
    noteId: `note-${index}`,
    contentKey: `content-${Math.floor(next() * 5)}`,
    scores: {
      vectorScore: score(),
      textScore: score(),
      metadataScore: score(),
      graphScore: next() < 0.4 ? score() : null
    },
    verdict: { score: score(), relationType: pick(relationTypes) as AtomicNoteRelationType }
  }));
  return { settings, threshold, hasEmbedding, candidates };
}

const accepted = (selection: ReadonlyArray<{ candidate: { noteId: string }; accepted: boolean }>) =>
  selection.filter((item) => item.accepted).map((item) => item.candidate.noteId);

describe("lossless feasibility gate", () => {
  it("accepts exactly the relations of the ungated pipeline for random scores and settings", () => {
    let dropped = 0;
    let total = 0;
    for (let seed = 1; seed <= 3000; seed += 1) {
      const { settings, threshold, hasEmbedding, candidates } = randomCase(seed);
      const options = { hasEmbedding, threshold, settings };
      // Ungated: every candidate is decided.
      const ungated = selectAtomicNoteRelations(
        candidates.map((candidate): AtomicNoteRelationSelectionCandidate => ({
          ...candidate,
          decision: candidate.verdict
        })),
        options
      );
      // Gated: a candidate that cannot qualify is never sent to the decider.
      const gated = selectAtomicNoteRelations(
        candidates.map((candidate): AtomicNoteRelationSelectionCandidate => {
          const feasible = canQualifyAtomicNoteRelation({ ...options, scores: candidate.scores });
          total += 1;
          if (!feasible) dropped += 1;
          return { ...candidate, decision: feasible ? candidate.verdict : null };
        }),
        options
      );
      expect(accepted(gated), `seed ${seed}`).toEqual(accepted(ungated));
    }
    // The property is not vacuous: the gate really drops candidates in these cases.
    expect(dropped).toBeGreaterThan(total / 10);
  });

  it("drops only candidates that a perfect decider score cannot lift to the threshold", () => {
    const settings = AtomicNoteMatchingSettingsSchema.parse({ rerankerWeight: 0.4 });
    const scores = (text: number) => ({
      vectorScore: 0,
      textScore: text,
      metadataScore: 0,
      graphScore: null
    });
    // Without an embedding: base = 0.7 * text; best final = 0.6 * base + 0.4.
    const feasible = (text: number) =>
      canQualifyAtomicNoteRelation({
        scores: scores(text),
        hasEmbedding: false,
        threshold: 0.6,
        settings
      });
    expect(feasible(1)).toBe(true);
    expect(feasible(0.5)).toBe(true); // best 0.61
    expect(feasible(0.45)).toBe(false); // best 0.589
    expect(feasible(0)).toBe(false);
  });

  it("orders accepted relations by final score, then content, and applies the per-note limit", () => {
    const settings = AtomicNoteMatchingSettingsSchema.parse({ maxRelationsPerNote: 2 });
    const candidate = (noteId: string, contentKey: string, score: number) => ({
      noteId,
      contentKey,
      scores: { vectorScore: 1, textScore: 1, metadataScore: 1, graphScore: null },
      decision: { score, relationType: "supports" as const }
    });
    const selection = selectAtomicNoteRelations(
      [
        candidate("z", "Beta", 0.9),
        candidate("y", "Alpha", 0.9),
        candidate("x", "Gamma", 1),
        candidate("w", "Delta", 0.2)
      ],
      { hasEmbedding: true, threshold: 0.6, settings }
    );
    expect(selection.map((item) => item.candidate.noteId)).toEqual(["x", "y", "z", "w"]);
    expect(selection.map((item) => [item.qualifies, item.accepted])).toEqual([
      [true, true],
      [true, true],
      [true, false],
      [false, false]
    ]);
  });
});

describe("relation decision identity", () => {
  const route = {
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

  it("ignores output budgets and parameter order, never the model, prompt or reasoning", () => {
    const key = atomicNoteDeciderKey(route);
    expect(
      atomicNoteDeciderKey({
        ...route,
        parameters: { temperature: 0, reasoningLevel: "off", maxTokens: 512 }
      })
    ).toBe(key);
    for (const changed of [
      { ...route, modelId: "gpt-5.6-terra" },
      { ...route, baseUrl: "http://127.0.0.1:8080" },
      { ...route, revision: "abc" },
      { ...route, promptFingerprint: "prompt-b" },
      { ...route, parameters: { ...route.parameters, reasoningLevel: "low" } }
    ])
      expect(atomicNoteDeciderKey(changed)).not.toBe(key);
  });

  it("hashes only the content the decider sees", () => {
    const note = { title: "Retrieval", ideaStatement: "Retrieval improves recall." };
    const hash = atomicNoteDecisionContentHash(note);
    expect(
      atomicNoteDecisionContentHash({ ...note, bodyMarkdown: "Other body" } as typeof note)
    ).toBe(hash);
    expect(atomicNoteDecisionContentHash({ ...note, title: "Recall" })).not.toBe(hash);
    expect(atomicNoteDecisionContentHash({ ...note, ideaStatement: "Changed." })).not.toBe(hash);
    // The separator keeps "ab" + "c" apart from "a" + "bc".
    expect(atomicNoteDecisionContentHash({ title: "ab", ideaStatement: "c" })).not.toBe(
      atomicNoteDecisionContentHash({ title: "a", ideaStatement: "bc" })
    );
  });
});
