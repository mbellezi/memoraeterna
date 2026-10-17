import { describe, expect, it } from "vitest";

import type { LabelItem } from "./bakeoff-sets.ts";
import {
  liveVerdicts,
  mergeVerdicts,
  orientPairs,
  planV9,
  readRecordedVerdicts,
  readReport
} from "./bakeoff-v9.ts";
import type { StoredNote } from "./note-texts.ts";

const row = (lo: string, hi: string, overrides: Record<string, string> = {}) => ({
  id: "x",
  lo_note: lo,
  hi_note: hi,
  decider_key: "e78e",
  lo_to_hi_score: "0.78",
  lo_to_hi_relation_type: "extends",
  hi_to_lo_score: "",
  hi_to_lo_relation_type: "",
  relation_type: "",
  accepted: "f",
  ...overrides
});

const item = (
  lo: string,
  hi: string,
  sets: string[],
  kind: "note" | "source" = "note"
): LabelItem => ({
  pairId: `${kind}:x:${lo}${hi}`,
  kind,
  library: "fixture",
  lo,
  hi,
  sets,
  pool: null,
  stratum: null,
  split: null,
  related: null
});

const note = (id: string): StoredNote => ({
  id,
  title: `Title ${id}`,
  idea: `Idea ${id}`,
  body: "Body."
});

describe("the recorded v9 verdicts", () => {
  it("are one verdict per judged direction, scaled 0-1 and kept as the contract's integer", () => {
    const verdicts = readRecordedVerdicts([
      row("a", "b"),
      row("c", "d", {
        lo_to_hi_score: "0.9",
        lo_to_hi_relation_type: "supports",
        hi_to_lo_score: "0.65",
        hi_to_lo_relation_type: "clarifies",
        accepted: "t"
      })
    ]);
    expect(
      verdicts.map((v) => [v.lo, v.hi, v.direction, v.scoreInt, v.relationType, v.accepted])
    ).toEqual([
      ["a", "b", "lo_to_hi", 78, "extends", false],
      ["c", "d", "lo_to_hi", 90, "supports", true],
      ["c", "d", "hi_to_lo", 65, "clarifies", true]
    ]);
    expect(verdicts[0]).toMatchObject({ origin: "recorded", score: 0.78, source: null });
  });

  it("refuse a score outside 0-1", () => {
    expect(() => readRecordedVerdicts([row("a", "b", { lo_to_hi_score: "78" })])).toThrow(
      'the score "78"'
    );
  });
});

describe("the live pairs", () => {
  it("are oriented so the note in the most pairs is the source of all of them", () => {
    const oriented = orientPairs([
      ["a", "b"],
      ["a", "c"],
      ["d", "a"],
      ["b", "e"]
    ]);
    // a is in three pairs, then b in the one left.
    expect(oriented).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["a", "d"],
      ["b", "e"]
    ]);
    expect(new Set(oriented.map(([source]) => source))).toEqual(new Set(["a", "b"]));
    expect(orientPairs([])).toEqual([]);
    // Ties go to the lower id, so the plan does not depend on the order of the pairs.
    expect(
      orientPairs([
        ["y", "x"],
        ["z", "w"]
      ])
    ).toEqual([
      ["w", "z"],
      ["x", "y"]
    ]);
  });

  it("leave out the pairs a recorded verdict covers, and carry the text of the notes of the rest", () => {
    const items = [
      item("a", "b", ["pool-A"]),
      item("a", "c", ["pool-A", "rv9-sample"]),
      item("b", "c", ["source-base"], "source"),
      item("d", "e", ["rv6"])
    ];
    const recorded = readRecordedVerdicts([row("b", "a")]);
    const plan = planV9(items, recorded, note);
    expect(plan.labelPairs).toBe(3);
    expect(plan.recordedPairs).toBe(1);
    expect(plan.live).toEqual([
      { source: "a", candidate: "c", label: "note:x:ac pool-A,rv9-sample" },
      { source: "d", candidate: "e", label: "note:x:de rv6" }
    ]);
    expect(Object.keys(plan.notes).sort()).toEqual(["a", "c", "d", "e"]);
    expect(plan.notes.a).toEqual({ title: "Title a", idea: "Idea a" });
    expect(() => planV9(items, recorded, () => undefined)).toThrow("No text for note");
  });
});

const report = (pairs: unknown[], contract = "atomic-note-matching-v9") => ({
  format: "memora-golden-note-pair-verdicts",
  version: 1,
  state: "finished",
  status: "completed",
  contract,
  pairsFile: { path: "p.json", sha256: "a".repeat(64), notes: 4, pairs: pairs.length, calls: 2 },
  cassette: { mode: "record", directory: "/c", served: 0, recorded: 2, misses: 0 },
  totals: { pairs: pairs.length, inputTokens: 1800, outputTokens: 120 },
  calls: [],
  pairs
});

describe("the knob's report", () => {
  const decided = {
    index: 0,
    source: "z",
    candidate: "a",
    label: null,
    status: "decided",
    score: 85,
    relationType: "extends",
    attempt: 0,
    aiTaskRunId: "run-1"
  };

  it("gives one live verdict per decided pair, lower id first, and none for the rest", () => {
    const verdicts = liveVerdicts(
      readReport(
        report([
          decided,
          {
            ...decided,
            source: "b",
            candidate: "c",
            status: "undecided",
            score: null,
            relationType: null
          },
          {
            ...decided,
            source: "d",
            candidate: "e",
            status: "skipped",
            score: null,
            relationType: null
          }
        ])
      )
    );
    expect(verdicts).toEqual([
      {
        lo: "a",
        hi: "z",
        direction: "call",
        score: 0.85,
        scoreInt: 85,
        relationType: "extends",
        origin: "live",
        accepted: null,
        source: "z",
        aiTaskRunId: "run-1"
      }
    ]);
  });

  it("must be finished and of the v9 contract", () => {
    expect(() => readReport({ ...report([decided]), state: "running" })).toThrow();
    expect(() => readReport(report([decided], "atomic-note-matching-v10"))).toThrow(
      "not atomic-note-matching-v9"
    );
  });
});

describe("the merged verdicts", () => {
  const items = [
    item("a", "b", ["pool-A"]),
    item("a", "c", ["pool-A"]),
    item("d", "e", ["rv6"]),
    item("f", "g", ["source-base"], "source")
  ];

  it("hold the recorded and the live verdicts and name the label pairs with none", () => {
    const recorded = readRecordedVerdicts([row("a", "b")]);
    const live = liveVerdicts(
      readReport(
        report([
          {
            source: "a",
            candidate: "c",
            status: "decided",
            score: 30,
            relationType: "supports",
            aiTaskRunId: null
          }
        ])
      )
    );
    const merged = mergeVerdicts(items, recorded, live);
    expect(merged.verdicts.map((v) => [v.lo, v.hi, v.origin])).toEqual([
      ["a", "b", "recorded"],
      ["a", "c", "live"]
    ]);
    expect(merged.missing).toEqual(["d|e"]);
    expect(merged.counts).toMatchObject({
      labelPairs: 3,
      labelPairsWithVerdict: 2,
      recordedVerdicts: 1,
      liveVerdicts: 1,
      recordedPairs: 1,
      livePairs: 1
    });
  });

  it("report every pair missing when nothing was judged live", () => {
    expect(mergeVerdicts(items, [], []).missing).toEqual(["a|b", "a|c", "d|e"]);
  });
});
