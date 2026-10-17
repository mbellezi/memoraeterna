import { describe, expect, it } from "vitest";

import {
  checkExitCode,
  defaultEvaluationOptions,
  evaluateMatching,
  renderEvaluationMarkdown,
  sealHeldOut,
  summarizeCalls,
  type AiCallRow,
  type EvaluationInput,
  type RelationRow
} from "./matching-evaluation.ts";
import type { MatchingMapping } from "./matching-fixture.ts";

const root = (
  id: string,
  partition: "tuning" | "holdout",
  extra: Partial<MatchingMapping["roots"][number]> = {}
): MatchingMapping["roots"][number] => ({
  id,
  manifestKey: `mf-${id.toLowerCase()}`,
  title: `Title ${id}`,
  partition,
  family: "f",
  kind: "document",
  nonconceptual: false,
  records: [],
  ...extra
});

/** A small fixture: a book A1 with two chapters, and tuning and held-out roots around it. */
const mapping: MatchingMapping = {
  format: "memora-golden-matching-mapping",
  version: 1,
  fixture: { path: "x.json", version: "matching-benchmark-v1", sha256: "a".repeat(64) },
  manifest: { name: "golden-matching-fixture", path: "m.json" },
  roots: [
    root("A1", "tuning", {
      kind: "container",
      records: [
        { id: "A1a", manifestKey: "mf-a1a", title: "Chapter a" },
        { id: "A1b", manifestKey: "mf-a1b", title: "Chapter b" }
      ]
    }),
    root("B1", "tuning"),
    root("F1", "tuning"),
    root("C1", "holdout"),
    root("D1", "holdout", { nonconceptual: true }),
    root("E1", "holdout")
  ],
  expectedRootPairs: [
    { pair: ["A1", "B1"], partition: "tuning", rationale: "r" },
    { pair: ["A1", "C1"], partition: "holdout", rationale: "r" },
    { pair: ["B1", "C1"], partition: "holdout", rationale: "r" },
    { pair: ["C1", "E1"], partition: "holdout", rationale: "r" }
  ],
  forbiddenRootPairs: [
    { pair: ["B1", "F1"], partition: "tuning", rationale: "r" },
    { pair: ["A1", "D1"], partition: "holdout", rationale: "r" },
    { pair: ["C1", "F1"], partition: "holdout", rationale: "r" }
  ],
  ambiguousRootPairs: [{ pair: ["A1", "F1"], reason: "r" }],
  subsets: { tuning: [], holdout: [] }
};

const sources = [
  { id: "s-a1", parentId: null, title: "Title A1" },
  { id: "s-a1a", parentId: "s-a1", title: "Chapter a" },
  { id: "s-a1b", parentId: "s-a1", title: "Chapter b" },
  { id: "s-b1", parentId: null, title: "Title B1" },
  { id: "s-f1", parentId: null, title: "Title F1" },
  { id: "s-c1", parentId: null, title: "Title C1" },
  { id: "s-d1", parentId: null, title: "Title D1" },
  { id: "s-e1", parentId: null, title: "Title E1" }
];
const notes = [
  { id: "n1", sourceItemId: "s-a1a" },
  { id: "n2", sourceItemId: "s-a1b" },
  { id: "n3", sourceItemId: "s-b1" },
  { id: "n4", sourceItemId: "s-c1" },
  { id: "n5", sourceItemId: "s-c1" },
  { id: "n6", sourceItemId: "s-d1" },
  { id: "n7", sourceItemId: "s-e1" },
  { id: "n8", sourceItemId: "s-f1" }
];
const relation = (sourceId: string, targetId: string, status = "pending_review"): RelationRow => ({
  sourceId,
  targetId,
  status
});

const call = (overrides: Partial<AiCallRow> = {}): AiCallRow => ({
  task: "reranking",
  status: "succeeded",
  durationMs: 1000,
  inputTokens: 100,
  outputTokens: 50,
  reasoningTokens: 10,
  operation: "note_matching_reranking",
  noteId: "n1",
  sourceItemId: null,
  promptVersion: "atomic-note-matching-v6",
  replayed: false,
  ...overrides
});

const library = (overrides: Partial<EvaluationInput> = {}): EvaluationInput => ({
  mapping,
  sources,
  notes,
  noteRelations: [
    relation("n1", "n4", "accepted"), // chapter a of A1 with C1: expected, held-out
    relation("n3", "n4"), // B1 with C1: expected, held-out
    relation("n2", "n7", "rejected"), // rejected: never a link
    relation("n4", "n7", "rejected"), // C1 with E1 is rejected: expected pair missed
    relation("n1", "n2", "accepted"), // inside the book A1: not a pair
    relation("n6", "n3"), // D1 (nonconceptual) with B1: unlabelled bridge
    relation("n4", "n8"), // C1 with F1: forbidden, held-out
    relation("n1", "ghost", "accepted") // a note outside the library: ignored
  ],
  sourceRelations: [
    relation("s-c1", "s-e1"), // C1 with E1 through sources
    relation("s-a1", "s-b1", "accepted"), // A1 with B1: expected, tuning
    relation("s-a1b", "s-f1") // A1 with F1: ambiguous
  ],
  aiCalls: [call()],
  ...overrides
});

describe("evaluateMatching: root pairs", () => {
  const result = evaluateMatching(library());

  it("finds every root of the fixture by title and rolls chapters up to their book", () => {
    expect(result.resolution.roots).toEqual({ total: 6, resolved: 6, missing: [], ambiguous: [] });
    expect(result.resolution.warnings).toEqual([]);
    expect(result.resolution.notes).toBe(8);
  });

  it("scores expected and forbidden pairs of the held-out partition on note relations", () => {
    const layer = result.partitions.holdout.layers.notes;
    expect(layer.expected).toMatchObject({
      total: 3,
      evaluable: 3,
      hit: 2,
      hitPairs: ["A1/C1", "B1/C1"],
      missPairs: ["C1/E1"]
    });
    expect(layer.forbidden).toMatchObject({ total: 2, evaluable: 2, hit: 1, hitPairs: ["C1/F1"] });
    expect(layer.nonconceptualPairs).toBe(1);
    expect(layer.unlabelledPairs).toBe(1);
    expect(layer.relations).toBe(4);
  });

  it("keeps the tuning partition apart and counts the ambiguous pair on its own", () => {
    const layer = result.partitions.tuning.layers.sources;
    expect(layer.expected).toMatchObject({ total: 1, hit: 1, hitPairs: ["A1/B1"] });
    expect(layer.ambiguousPairs).toEqual(["A1/F1"]);
    expect(layer.unlabelledPairs).toBe(0);
    expect(result.partitions.tuning.layers.notes.expected.hit).toBe(0);
  });

  it("combines the layers for the either-layer score", () => {
    const either = result.partitions.holdout.layers.either;
    expect(either.expected.hit).toBe(3);
    expect(either.expected.missPairs).toEqual([]);
    expect(either.relations).toBe(5);
  });

  it("counts a rejected relation only when the statuses ask for it", () => {
    const withRejected = evaluateMatching(library(), {
      ...defaultEvaluationOptions,
      statuses: ["accepted", "pending_review", "rejected"]
    });
    expect(withRejected.partitions.holdout.layers.notes.expected.hit).toBe(3);
  });

  it("ignores relations of notes that are not part of the library", () => {
    const without = evaluateMatching(library({ notes: notes.filter((note) => note.id !== "n4") }));
    expect(without.partitions.holdout.layers.notes.expected.hit).toBe(0);
  });

  it("reports notes of sources outside the fixture", () => {
    const outside = evaluateMatching(
      library({
        sources: [...sources, { id: "s-x", parentId: null, title: "Unrelated" }],
        notes: [...notes, { id: "n9", sourceItemId: "s-x" }]
      })
    );
    expect(outside.resolution.notesOutsideFixture).toBe(1);
    expect(outside.resolution.warnings).toContain(
      "1 notes belong to sources outside the fixture (not scored)"
    );
  });
});

describe("evaluateMatching: finding the roots", () => {
  it("does not score pairs whose roots are missing and leaves the exit undecided", () => {
    const partial = evaluateMatching(
      library({ sources: sources.filter((source) => !["s-e1", "s-f1"].includes(source.id)) })
    );
    expect(partial.resolution.roots.missing).toEqual(["F1", "E1"]);
    const layer = partial.partitions.holdout.layers.notes;
    expect(layer.expected).toMatchObject({ total: 3, evaluable: 2 });
    expect(layer.expected.missPairs).toEqual([]);
    expect(layer.forbidden).toMatchObject({ total: 2, evaluable: 1 });
    expect(partial.exit.expected.pass).toBeNull();
    expect(partial.exit.pass).toBeNull();
    expect(partial.resolution.warnings).toContain("roots not in the library: F1, E1");
  });

  it("refuses to guess between two library roots with the same title", () => {
    const twice = evaluateMatching(
      library({ sources: [...sources, { id: "s-b1-copy", parentId: null, title: "Title B1" }] })
    );
    expect(twice.resolution.roots.ambiguous).toEqual(["B1"]);
    expect(twice.resolution.roots.resolved).toBe(5);
    expect(twice.partitions.holdout.layers.notes.expected.hit).toBe(1);
  });

  it("uses explicit ids when the library was built by the benchmark controller", () => {
    const renamed = sources.map((source) =>
      source.id === "s-b1" ? { ...source, title: "Renamed" } : source
    );
    const byId = evaluateMatching(
      library({
        sources: renamed,
        ids: { A1: "s-a1", B1: "s-b1", F1: "s-f1", C1: "s-c1", D1: "s-d1", E1: "s-e1" }
      })
    );
    expect(byId.resolution.roots.resolved).toBe(6);
    expect(byId.resolution.warnings).toEqual([
      "B1: the library's title differs from the fixture's"
    ]);
    expect(byId.partitions.holdout.layers.notes.expected.hitPairs).toEqual(["A1/C1", "B1/C1"]);
    const byTitle = evaluateMatching(library({ sources: renamed }));
    expect(byTitle.resolution.roots.missing).toEqual(["B1"]);
  });

  it("warns when the chapters of a book differ from the fixture", () => {
    const result = evaluateMatching(
      library({ sources: sources.filter((source) => source.id !== "s-a1b") })
    );
    expect(result.resolution.warnings).toContain(
      "A1: the chapters in the library differ from the fixture's"
    );
  });

  it("survives a parent cycle without hanging", () => {
    const cyclic = evaluateMatching(
      library({
        sources: [
          ...sources.filter((source) => source.id !== "s-b1"),
          { id: "s-b1", parentId: "s-x", title: "Title B1" },
          { id: "s-x", parentId: "s-b1", title: "Cycle" }
        ]
      })
    );
    expect(cyclic.resolution.roots.missing).toEqual(["B1"]);
  });
});

describe("evaluateMatching: cost of the reranking task", () => {
  const calls: AiCallRow[] = [
    call({
      noteId: "n1",
      durationMs: 2000,
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 8
    }),
    call({
      noteId: "n3",
      durationMs: 4000,
      inputTokens: 300,
      outputTokens: 60,
      reasoningTokens: null
    }),
    call({
      noteId: "n4",
      durationMs: 6000,
      inputTokens: 200,
      outputTokens: null,
      reasoningTokens: null
    }),
    call({ noteId: "n5", durationMs: 8000, status: "failed", inputTokens: null }),
    call({
      operation: "source_relation_matching",
      noteId: null,
      sourceItemId: "s-a1a",
      durationMs: 3000
    }),
    call({
      operation: "source_relation_matching",
      noteId: null,
      sourceItemId: "s-c1",
      durationMs: 5000
    }),
    call({
      operation: "source_relation_matching",
      noteId: null,
      sourceItemId: "s-c1",
      durationMs: 1000
    }),
    call({ operation: "another_operation", noteId: null, durationMs: 700 }),
    call({ task: "summarization", noteId: "n1", durationMs: 99_000 })
  ];
  const cost = evaluateMatching(library({ aiCalls: calls })).cost;

  it("counts calls and seconds per note of the whole library, failed calls included", () => {
    expect(cost.noteMatching.notes).toBe(8);
    expect(cost.noteMatching.group.calls).toBe(4);
    expect(cost.noteMatching.group.failed).toBe(1);
    expect(cost.noteMatching.callsPerNote).toBe(0.5);
    expect(cost.noteMatching.secondsPerNote).toBe(20 / 8);
    expect(cost.noteMatching.group.seconds).toMatchObject({ sum: 20, measured: 4, p50: 5 });
  });

  it("averages tokens only over the calls that reported them", () => {
    const group = cost.noteMatching.group;
    expect(group.inputTokens).toEqual({ sum: 600, reported: 3, perCall: 200 });
    expect(group.outputTokens).toEqual({ sum: 150, reported: 3, perCall: 50 });
    expect(group.reasoningTokens).toEqual({ sum: 18, reported: 2, perCall: 9 });
  });

  it("splits the notes and calls by partition of the note's root", () => {
    expect(cost.noteMatching.perPartition.tuning).toMatchObject({
      notes: 4,
      calls: 2,
      secondsPerNote: 1.5
    });
    expect(cost.noteMatching.perPartition.holdout).toMatchObject({
      notes: 4,
      calls: 2,
      callsPerNote: 0.5,
      secondsPerNote: 3.5,
      inputTokensPerCall: 200
    });
    expect(cost.noteMatching.unattributedCalls).toBe(0);
    expect(cost.noteMatching.promptVersions).toEqual({ "atomic-note-matching-v6": 4 });
  });

  it("counts source matching per matched root and leaves other operations apart", () => {
    expect(cost.sourceMatching.group.calls).toBe(3);
    expect(cost.sourceMatching.roots).toBe(2);
    expect(cost.sourceMatching.callsPerRoot).toBe(1.5);
    expect(cost.sourceMatching.secondsPerRoot).toBe(4.5);
    expect(cost.unclassified.calls).toBe(1);
  });

  it("does not pretend to know the cost when the calls have no monitoring record", () => {
    const result = evaluateMatching(
      library({ aiCalls: calls.map((c) => ({ ...c, operation: null })) })
    );
    expect(result.cost.noteMatching.secondsPerNote).toBeNull();
    expect(result.exit.secondsPerNote).toMatchObject({ value: null, pass: null });
    expect(result.resolution.warnings.join("\n")).toContain("have no monitoring record");
  });

  it("does not pretend a library without calls of the task is free", () => {
    const none = evaluateMatching(library({ aiCalls: [call({ task: "summarization" })] }));
    expect(none.cost.noteMatching.secondsPerNote).toBeNull();
    expect(none.resolution.warnings.join("\n")).toContain("no reranking calls");
  });

  it("does not judge time from calls replayed out of a cassette", () => {
    const result = evaluateMatching(
      library({
        aiCalls: [call({ durationMs: 5, replayed: true }), call({ noteId: "n3", replayed: true })]
      })
    );
    expect(result.cost.noteMatching.group.replayed).toBe(2);
    expect(result.exit.secondsPerNote.pass).toBeNull();
    expect(result.exit.secondsPerNote.note).toContain("replayed");
  });

  it("summarizes unknown durations and tokens as unknown", () => {
    const group = summarizeCalls([
      call({ durationMs: null, inputTokens: null, outputTokens: null })
    ]);
    expect(group.seconds).toEqual({ sum: 0, measured: 0, p50: null, p95: null });
    expect(group.inputTokens.perCall).toBeNull();
  });
});

describe("evaluateMatching: the F1a exit criterion", () => {
  const good = (): EvaluationInput =>
    library({
      noteRelations: [relation("n1", "n4"), relation("n3", "n4"), relation("n4", "n7")],
      aiCalls: [call({ durationMs: 8000 })]
    });

  it("passes with enough expected pairs, no forbidden pair and a third of the v6 time", () => {
    const result = evaluateMatching(good(), { ...defaultEvaluationOptions, minExpected: 3 });
    expect(result.exit.expected).toMatchObject({ found: 3, total: 3, pass: true });
    expect(result.exit.forbidden).toMatchObject({ accepted: 0, pass: true });
    expect(result.exit.secondsPerNote).toMatchObject({ value: 1, limit: 10.4 / 3, pass: true });
    expect(result.exit.pass).toBe(true);
  });

  it("fails on a forbidden pair, too few expected pairs or too slow a pass", () => {
    const forbidden = evaluateMatching(library({ aiCalls: [] }));
    expect(forbidden.exit.forbidden).toMatchObject({ accepted: 1, pass: false });
    expect(forbidden.exit.pass).toBe(false);

    const few = evaluateMatching(good(), { ...defaultEvaluationOptions, minExpected: 4 });
    expect(few.exit.expected.pass).toBe(false);

    const slow = evaluateMatching(
      { ...good(), aiCalls: [call({ durationMs: 40_000 })] },
      { ...defaultEvaluationOptions, minExpected: 3 }
    );
    expect(slow.exit.secondsPerNote).toMatchObject({ value: 5, pass: false });
    expect(slow.exit.pass).toBe(false);
  });
});

describe("checkExitCode", () => {
  it("tells a pass from a failure and from an undecided exit criterion", () => {
    expect([true, false, null].map(checkExitCode)).toEqual([0, 1, 2]);
  });
});

describe("renderEvaluationMarkdown", () => {
  it("prints the exit table, the pairs not linked and unknown values as unknown", () => {
    const evaluation = evaluateMatching(library({ aiCalls: [] }));
    const text = renderEvaluationMarkdown(evaluation, {
      label: "unit",
      database: "127.0.0.1:1/db",
      fixtureSha256: "f".repeat(64)
    });
    expect(text).toContain("# Matching-quality evaluation: unit");
    expect(text).toContain("fixture sha256 ffffffffffff");
    expect(text).toContain("| Expected root pairs linked | 2/3 | at least 27/3 | FAIL |");
    expect(text).toContain("| Seconds per note (note-matching calls) | unknown |");
    expect(text).toContain("Note relations: expected not linked: C1/E1; forbidden linked: C1/F1");
    expect(text).toContain("## Warnings");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is deterministic and never prints a connection string", () => {
    const evaluation = evaluateMatching(library());
    expect(renderEvaluationMarkdown(evaluation)).toBe(renderEvaluationMarkdown(evaluation));
    expect(JSON.stringify(evaluation)).not.toMatch(/postgres(ql)?:\/\//u);
  });
});

describe("evaluateMatching: shown and applied relations (F3 gate)", () => {
  // A1 with C1 is applied, B1 with C1 only suggested, C1 with F1 withdrawn, C1 with E1 kept by the owner.
  const flagged = () =>
    library({
      noteRelations: [
        { ...relation("n1", "n4"), shown: true, applied: true },
        { ...relation("n3", "n4"), shown: true, applied: false },
        { ...relation("n4", "n8"), shown: false, applied: false },
        { ...relation("n4", "n7", "rejected"), shown: true, applied: false }
      ]
    });

  it("counts the clause's verdicts instead of the status and keeps applied-only beside them", () => {
    const result = evaluateMatching(flagged());
    const shown = result.partitions.holdout.layers.notes;
    const applied = result.partitions.holdout.layers.notesApplied;
    expect(shown.expected).toMatchObject({ hit: 3, hitPairs: ["A1/C1", "B1/C1", "C1/E1"] });
    expect(shown.forbidden.hit).toBe(0);
    expect(applied.expected).toMatchObject({ hit: 1, hitPairs: ["A1/C1"] });
    expect(result.partitions.holdout.layers.either.expected.hit).toBe(3);
  });

  it("reads a library without verdicts by status, shown and applied alike", () => {
    const legacy = evaluateMatching(library());
    const layers = legacy.partitions.holdout.layers;
    expect(layers.notesApplied.expected.hitPairs).toEqual(layers.notes.expected.hitPairs);
  });
});

describe("sealHeldOut (decision D3)", () => {
  it("empties the held-out result, keeps tuning and costs, and leaves the exit undecided", () => {
    const evaluation = evaluateMatching(library());
    const sealed = sealHeldOut(evaluation, "no frozen.json");
    const layer = sealed.partitions.holdout.layers.notes;
    expect(sealed.partitions.holdout.sealed).toBe(true);
    expect(layer.expected).toMatchObject({ total: 3, hit: 0, hitPairs: [], missPairs: [] });
    expect(layer.forbidden.hitPairs).toEqual([]);
    expect(sealed.partitions.tuning).toEqual(evaluation.partitions.tuning);
    expect(sealed.cost).toEqual(evaluation.cost);
    expect(sealed.exit.pass).toBeNull();
    expect(sealed.exit.expected.pass).toBeNull();
    expect(sealed.resolution.warnings.at(-1)).toBe(
      "held-out sealed until the freeze (decision D3): no frozen.json"
    );
    // The serialized report holds none of the held-out pair names.
    const json = JSON.stringify(sealed);
    for (const pair of ["A1/C1", "B1/C1", "C1/E1", "C1/F1"]) expect(json).not.toContain(pair);
  });

  it("prints a sealed partition as sealed, in the exit table and in the partition section", () => {
    const text = renderEvaluationMarkdown(
      sealHeldOut(evaluateMatching(library()), "no frozen.json")
    );
    expect(text).toContain("| Expected root pairs linked | sealed | at least 27/3 | not decided |");
    expect(text).toContain("Result sealed until the freeze (decision D3).");
    expect(text).not.toContain("C1/F1");
  });
});

describe("evaluateMatching: source report and calls per chapter", () => {
  const sourceCall = (sourceItemId: string, extra: Partial<AiCallRow> = {}): AiCallRow =>
    call({
      operation: "source_relation_matching",
      noteId: null,
      sourceItemId,
      promptVersion: "source-v5",
      startedAt: "2026-10-30T12:00:00.000Z",
      finishedAt: "2026-10-30T12:00:04.000Z",
      ...extra
    });

  it("reports replayed source calls, AI seconds, wall seconds, calls per source and relation origins", () => {
    const result = evaluateMatching(
      library({
        sourceRelations: [
          { ...relation("s-a1", "s-b1", "accepted"), origin: "judged" },
          { ...relation("s-c1", "s-e1"), origin: "promoted" },
          { ...relation("s-a1b", "s-f1"), origin: "promoted" },
          { ...relation("s-d1", "s-b1", "rejected"), origin: "promoted" },
          relation("s-e1", "s-f1")
        ],
        aiCalls: [
          sourceCall("s-c1", { durationMs: 2000, replayed: true }),
          sourceCall("s-c1", { durationMs: 3000, finishedAt: "2026-10-30T12:00:09.000Z" }),
          sourceCall("s-a1b", { durationMs: 1000 })
        ]
      })
    );
    const sources = result.cost.sourceMatching;
    expect(sources.roots).toBe(2);
    expect(sources.group).toMatchObject({ calls: 3, replayed: 1 });
    expect(sources.callsPerRoot).toBe(1.5);
    expect(sources.secondsPerRoot).toBe(3);
    // C1: 12:00:00 to 12:00:09; A1: 12:00:00 to 12:00:04.
    expect(sources.wallSecondsPerRoot).toBe(6.5);
    expect(sources.relationsByOrigin).toEqual({ promoted: 2, judged: 1, unknown: 1 });
    const text = renderEvaluationMarkdown(result);
    expect(text).toContain("| Source matching, per root | 2 roots | 3 | 1 | 1.50 | 3.00 |");
    expect(text).toContain(
      "Source matching: 3.00 AI-call seconds and 6.50 wall seconds per source, 1.50 calls per source, 1 of 3 calls replayed from a cassette; source relations promoted 2, judged 1, origin unknown 1."
    );
  });

  it("counts every root design E matched as a source, with or without a judge call (S1)", () => {
    const result = evaluateMatching(
      library({
        aiCalls: [sourceCall("s-c1", { durationMs: 4500 })],
        // A chapter rolls up to its book; a root outside the library is ignored.
        matchedRoots: ["s-c1", "s-a1b", "s-f1", "not-in-the-library"]
      })
    );
    expect(result.cost.sourceMatching).toMatchObject({
      roots: 3,
      callsPerRoot: 1 / 3,
      secondsPerRoot: 1.5
    });
  });

  it("leaves wall seconds unknown without call timestamps", () => {
    const result = evaluateMatching(
      library({
        aiCalls: [
          call({ operation: "source_relation_matching", noteId: null, sourceItemId: "s-c1" })
        ]
      })
    );
    expect(result.cost.sourceMatching.wallSecondsPerRoot).toBeNull();
  });

  it("derives generative calls per 30-chunk chapter from the operations and the chunk count", () => {
    const result = evaluateMatching(
      library({
        chunks: 60,
        operations: [
          {
            task: "knowledge-graph-generation",
            operation: "graph_atomic_notes",
            calls: 90,
            replayed: 0
          },
          { task: "reranking", operation: "note_matching_reranking", calls: 30, replayed: 10 },
          { task: "embedding", operation: "note_embedding", calls: 500, replayed: 0 }
        ]
      })
    );
    expect(result.cost.callsPerChapter?.generative).toEqual({
      calls: 120,
      perChunk: 2,
      perChapter: 60
    });
    expect(renderEvaluationMarkdown(result)).toContain(
      "120 generative calls over 60 chunks: 2.00 per chunk, 60.0 per 30-chunk chapter"
    );
    expect(evaluateMatching(library()).cost.callsPerChapter).toBeNull();
  });
});
