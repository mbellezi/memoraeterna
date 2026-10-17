/**
 * Shared data of the F3 measurement tests: the real fixture mapping (built from the committed
 * benchmark, as the build script does) and synthetic exports over it. Not a test file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { HeldOutAccess } from "./freeze-guard.ts";
import {
  evaluateMatching,
  type AiCallRow,
  type EvaluationInput,
  type MatchingEvaluation,
  type RelationRow
} from "./matching-evaluation.ts";
import {
  buildMatchingFixture,
  pairKey,
  parseMatchingFixture,
  type MatchingMapping
} from "./matching-fixture.ts";
import type { RelationsExport } from "./relations-export.ts";

const workspace = resolve(import.meta.dirname, "..", "..");
/**
 * Where the stored reports, cassettes and Spike A files live. The tests that reproduce published
 * numbers from them skip when they are absent; a worktree sets MEMORA_CACHE_ROOT to the main
 * checkout's `.cache` to run them.
 */
export const cacheRoot = process.env.MEMORA_CACHE_ROOT ?? resolve(workspace, ".cache");
const fixturePath = "scripts/fixtures/matching-benchmark.json";
const fixtureText = readFileSync(resolve(workspace, fixturePath), "utf8");

/** The real mapping: 60 roots, 26 + 28 expected and 25 + 35 forbidden root pairs. */
export const mapping: MatchingMapping = buildMatchingFixture(
  parseMatchingFixture(JSON.parse(fixtureText)),
  { path: fixturePath, text: fixtureText }
).mapping;

/** Held-out expected root pairs the stored `matching-v9a.json` note layer links (24 of 28). */
export const v9aHeldOutLinked = [
  "Q1/Q5", "Q2/Q5", "W1/W5", "F1/F5", "F2/F5", "F3/F5", "L1/L5", "L2/L5", "L3/L5", "A1/A5",
  "A2/A5", "A3/A5", "R1/R5", "R2/R5", "R3/R5", "M1/M5", "M2/M5", "P01/V01", "P02/V01",
  "P03/V01", "P06/V02", "P07/V02", "P08/V03", "P09/V03"
]; // prettier-ignore
/** The four it does not link. */
export const v9aHeldOutMissed = ["Q3/Q5", "W2/W5", "W3/W5", "M3/M5"];

/** Sample B (`matching-v9b.json`) links the same pairs but L2/L5: 23 of 28. */
export const v9bHeldOutLinked = v9aHeldOutLinked.filter((pair) => pair !== "L2/L5");
export const v9bHeldOutMissed = [...v9aHeldOutMissed, "L2/L5"].sort();

export const noteIdOf = (root: string): string => `note-${root}`;
export const sourceIdOf = (root: string): string => `src-${root}`;

/**
 * An export with one note per root (a book's note sits under its first chapter) and nothing else:
 * add candidates, decisions and relations to it.
 */
export function worldExport(): RelationsExport {
  const sources: RelationsExport["sources"] = [];
  const notes: RelationsExport["notes"] = [];
  for (const root of mapping.roots) {
    sources.push({ id: sourceIdOf(root.id), parentId: null, title: root.title });
    let holder = sourceIdOf(root.id);
    const chapter = root.records[0];
    if (chapter) {
      holder = `${sourceIdOf(root.id)}-${chapter.id}`;
      sources.push({ id: holder, parentId: sourceIdOf(root.id), title: chapter.title });
    }
    notes.push({ id: noteIdOf(root.id), sourceItemId: holder });
  }
  return {
    format: "memora-relations-export",
    version: 1,
    sources,
    notes,
    candidates: [],
    decisions: [],
    relations: [],
    context: { label: "test world", database: null, generatedAt: null }
  };
}

/** The two note ids of a root pair, in the order the pair is written. */
export const notesOfPair = (pair: string): [string, string] => {
  const [a, b] = pair.split("/") as [string, string];
  return [noteIdOf(a), noteIdOf(b)];
};

/** A relation row that passes the legacy blend: strong signals and a decider score of 0.9. */
export function strongRelation(pair: string): RelationsExport["relations"][number] {
  const [source, target] = notesOfPair(pair);
  return {
    sourceNoteId: source,
    targetNoteId: target,
    status: "pending_review",
    relationType: "supports",
    vectorScore: 0.8,
    textScore: 0.5,
    metadataScore: 0,
    graphScore: null,
    rerankScore: 0.9,
    finalScore: null,
    fusionScore: null,
    textRank: 1,
    vectorRank: 1,
    graphRank: null
  };
}

export const expectedHeldOut = (): string[] =>
  mapping.expectedRootPairs
    .filter((entry) => entry.partition === "holdout")
    .map((entry) => pairKey(...entry.pair));
export const forbiddenHeldOut = (): string[] =>
  mapping.forbiddenRootPairs
    .filter((entry) => entry.partition === "holdout")
    .map((entry) => pairKey(...entry.pair));

/** A valid freeze record and the access it opens. */
export const openAccess: HeldOutAccess = {
  open: true,
  frozen: {
    configHash: "sha256:0123456789abcdef",
    calibrationIdentity: "decide/test",
    parity: {},
    inputHashes: {},
    frozenAt: "2026-10-30T12:00:00Z"
  }
};
export const sealedAccess: HeldOutAccess = { open: false, reason: "no frozen.json" };

const rootsOf = (pair: string) => pair.split("/") as [string, string];

export interface SampleSpec {
  /** Held-out expected pairs shown by note relations (the first n of the 28). */
  shown: number;
  /** Of those, how many are only suggestions (shown, not applied). */
  suggested?: number;
  forbidden?: number;
  /** Held-out expected pairs linked by source relations (the first n). */
  sourceLinked?: number;
  /** Tuning expected pairs linked by source relations (the first n). */
  tuningSourceLinked?: number;
  sourceCalls?: number;
  sourceReplayed?: number;
  sourceSeconds?: number;
}

export const tuningExpected = mapping.expectedRootPairs
  .filter((entry) => entry.partition === "tuning")
  .map((entry) => entry.pair.slice().sort().join("/"));

export function evaluationOf(spec: SampleSpec): MatchingEvaluation {
  return evaluateMatching(inputOf(spec));
}

/** A library over the world's roots with the relations and source calls the spec describes. */
export function inputOf(spec: SampleSpec): EvaluationInput {
  const data = worldExport();
  const noteRelations: RelationRow[] = [];
  expectedHeldOut()
    .slice(0, spec.shown)
    .forEach((pair, index) => {
      const [a, b] = rootsOf(pair);
      noteRelations.push({
        sourceId: noteIdOf(a),
        targetId: noteIdOf(b),
        status: "pending_review",
        shown: true,
        applied: index >= (spec.suggested ?? 0)
      });
    });
  forbiddenHeldOut()
    .slice(0, spec.forbidden ?? 0)
    .forEach((pair) => {
      const [a, b] = rootsOf(pair);
      noteRelations.push({
        sourceId: noteIdOf(a),
        targetId: noteIdOf(b),
        status: "pending_review",
        shown: true,
        applied: true
      });
    });
  const sourceRelations: EvaluationInput["sourceRelations"] = [
    ...expectedHeldOut().slice(0, spec.sourceLinked ?? 0),
    ...tuningExpected.slice(0, spec.tuningSourceLinked ?? 0)
  ].map((pair, index) => {
    const [a, b] = rootsOf(pair);
    return {
      sourceId: sourceIdOf(a),
      targetId: sourceIdOf(b),
      status: "pending_review",
      origin: index % 2 === 0 ? "judged" : "promoted"
    };
  });
  const calls = spec.sourceCalls ?? 0;
  const aiCalls: AiCallRow[] = Array.from({ length: calls }, (_, index) => ({
    task: "reranking",
    status: "succeeded",
    durationMs: ((spec.sourceSeconds ?? 1) * 1000) / Math.max(1, calls / 10),
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: null,
    operation: "source_relation_matching",
    noteId: null,
    sourceItemId: sourceIdOf(mapping.roots[index % 10]!.id),
    promptVersion: "source-v5",
    replayed: index < (spec.sourceReplayed ?? 0),
    startedAt: "2026-10-30T12:00:00.000Z",
    finishedAt: "2026-10-30T12:00:02.000Z"
  }));
  return {
    mapping,
    sources: data.sources,
    notes: data.notes,
    noteRelations,
    sourceRelations,
    aiCalls,
    operations: [
      { task: "reranking", operation: "note_matching_reranking", calls: 60, replayed: 0 }
    ],
    chunks: 30
  };
}
