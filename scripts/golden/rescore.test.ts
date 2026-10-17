import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PairScores, RelationsExport } from "./relations-export.ts";
import {
  compareWithStoredReport,
  legacyBlendScore,
  legacyBlendSettings,
  parseRescoreRule,
  rescore,
  rescoreEvaluation,
  runRescore
} from "./rescore.ts";
import {
  mapping,
  notesOfPair,
  strongRelation,
  v9aHeldOutLinked,
  v9aHeldOutMissed,
  v9bHeldOutLinked,
  v9bHeldOutMissed,
  worldExport
} from "./test-world.ts";

const blend = (
  input: Partial<Parameters<typeof legacyBlendScore>[0]>,
  renormalize = false
): number =>
  legacyBlendScore(
    {
      vector: 0.8,
      text: 0.5,
      metadata: 0,
      graph: null,
      hasEmbedding: true,
      rerank: 0.9,
      ...input
    },
    legacyBlendSettings,
    renormalize
  );

describe("the legacy blend (frozen copy of the v9 arithmetic)", () => {
  it("reproduces a stored v9 relation's final score", () => {
    // A relation of the V9-A end state: vector 0.8535, text 0.4419, graph 0.6145, metadata 0, decider 0.95.
    expect(
      blend({
        vector: 0.8534770607948303,
        text: 0.44186047,
        graph: 0.6145402512951073,
        metadata: 0,
        rerank: 0.95
      })
    ).toBeCloseTo(0.7504627070700172, 12);
  });

  it("selects the weight set by the signals that exist", () => {
    // Embedding without graph: (0.55 v + 0.3 t + 0.15 m) * 0.6 + 0.4 r.
    expect(blend({})).toBeCloseTo((0.55 * 0.8 + 0.3 * 0.5) * 0.6 + 0.9 * 0.4, 12);
    // No embedding, no graph: text and metadata only (0.7, 0.3).
    expect(blend({ hasEmbedding: false, vector: null })).toBeCloseTo(
      0.5 * 0.7 * 0.6 + 0.9 * 0.4,
      12
    );
    // No decider score: the base score alone.
    expect(blend({ rerank: null })).toBeCloseTo(0.55 * 0.8 + 0.3 * 0.5, 12);
  });

  it("renormalizes the weights when the metadata signal is dropped", () => {
    const withZero = blend({ vector: 0.6, text: 0.4, rerank: 0.8 });
    const dropped = blend({ vector: 0.6, text: 0.4, rerank: 0.8 }, true);
    expect(withZero).toBeCloseTo((0.55 * 0.6 + 0.3 * 0.4) * 0.6 + 0.8 * 0.4, 12);
    expect(dropped).toBeCloseTo(((0.55 * 0.6 + 0.3 * 0.4) / 0.85) * 0.6 + 0.8 * 0.4, 12);
    expect(withZero).toBeLessThan(0.6);
    expect(dropped).toBeGreaterThan(0.6);
  });
});

describe("rescore rules", () => {
  it("parses rules and demands scores for a ranker rule", () => {
    expect(parseRescoreRule("legacy-blend")).toMatchObject({
      kind: "legacy-blend",
      renormalizeMetadata: false
    });
    expect(parseRescoreRule("legacy-blend-renormalized")).toMatchObject({
      renormalizeMetadata: true
    });
    expect(parseRescoreRule("decider-only:0.7")).toEqual({
      kind: "decider-only",
      threshold: 0.7,
      includeWeakTypes: false
    });
    expect(() => parseRescoreRule("ranker:max:3.3125")).toThrow("needs --scores");
    expect(() => parseRescoreRule("blend")).toThrow("Unknown rule");
  });

  it("applies the cap, the weak-type exclusion and the validation floor like the pipeline did", () => {
    const data = worldExport();
    data.notes = Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, sourceItemId: "s" }));
    // n0 judged 12 candidates that qualify, each a little stronger than the previous.
    data.candidates = Array.from({ length: 12 }, (_, i) => ({
      sourceNoteId: "n0",
      targetNoteId: `n${i + 1}`,
      finalRank: i + 1,
      textRank: i + 1,
      vectorRank: i + 1,
      graphRank: null,
      textScore: 0.5,
      vectorScore: 0.8,
      metadataScore: 0,
      graphScore: null,
      fusionScore: null,
      rerankScore: 0.7 + i * 0.02,
      finalScore: null,
      passedThreshold: null
    }));
    data.decisions = data.candidates.map((c) => ({
      loNoteId: "n0",
      hiNoteId: c.targetNoteId,
      deciderKey: "k",
      loToHiScore: c.rerankScore,
      hiToLoScore: null,
      loToHiType: c.targetNoteId === "n12" ? "mentions" : "supports",
      hiToLoType: null,
      accepted: true
    }));
    const result = rescore(data, parseRescoreRule("legacy-blend"));
    // 12 candidates; the strongest (n12) is a weak type and leaves; the cap keeps 10 of the 11 left.
    expect(result.acceptedNotePairs).toHaveLength(10);
    expect(result.acceptedNotePairs.map(([, b]) => b)).not.toContain("n12");
    expect(result.acceptedNotePairs.map(([, b]) => b)).not.toContain("n1"); // the weakest of the 11
    // A score under the 0.65 floor never qualifies, whatever the blend says.
    data.candidates[11]!.rerankScore = 0.6;
    data.decisions[11]!.loToHiScore = 0.6;
    data.decisions[11]!.loToHiType = "supports";
    const lowered = rescore(data, parseRescoreRule("legacy-blend"));
    expect(lowered.acceptedNotePairs.map(([, b]) => b)).not.toContain("n12");
  });

  it("answers a direction with the verdict of the reverse direction", () => {
    const data = worldExport();
    const [lo, hi] = notesOfPair("A1/A5");
    data.candidates = [
      {
        sourceNoteId: lo,
        targetNoteId: hi,
        finalRank: 3,
        textRank: 2,
        vectorRank: 1,
        graphRank: null,
        textScore: 0.5,
        vectorScore: 0.8,
        metadataScore: 0,
        graphScore: null,
        fusionScore: null,
        rerankScore: null,
        finalScore: null,
        passedThreshold: null
      }
    ];
    // Only hi -> lo was judged, as the generative decider judges an unordered pair once.
    data.decisions = [
      {
        loNoteId: lo,
        hiNoteId: hi,
        deciderKey: "k",
        loToHiScore: null,
        hiToLoScore: 0.9,
        loToHiType: null,
        hiToLoType: "extends",
        accepted: true
      }
    ];
    const result = rescore(data, parseRescoreRule("legacy-blend"));
    expect(result.acceptedNotePairs).toEqual([[lo, hi]]);
    expect(result.blendCheck).toEqual({ compared: 0, maxAbsoluteDifference: null });
  });

  it("keeps a pair the metadata weight rejected when the weight is renormalized away", () => {
    const data = worldExport();
    const [lo, hi] = notesOfPair("A1/A5");
    data.relations = [
      { ...strongRelation("A1/A5"), vectorScore: 0.6, textScore: 0.4, rerankScore: 0.8 }
    ];
    data.decisions = [];
    expect(rescore(data, parseRescoreRule("legacy-blend")).acceptedNotePairs).toEqual([]);
    expect(rescore(data, parseRescoreRule("legacy-blend-renormalized")).acceptedNotePairs).toEqual([
      [lo, hi]
    ]);
  });

  it("accepts on the decider score alone, without weak types, as a lower bound", () => {
    const data = worldExport();
    const [a, b] = notesOfPair("A1/A5");
    const [c, d] = notesOfPair("F1/F5");
    const [e, f] = notesOfPair("L1/L5");
    data.decisions = [
      { loNoteId: a, hiNoteId: b, deciderKey: "k", loToHiScore: 0.7, hiToLoScore: null, loToHiType: "supports", hiToLoType: null, accepted: true },
      { loNoteId: c, hiNoteId: d, deciderKey: "k", loToHiScore: 0.6, hiToLoScore: 0.8, loToHiType: "supports", hiToLoType: "extends", accepted: true },
      { loNoteId: e, hiNoteId: f, deciderKey: "k", loToHiScore: 0.9, hiToLoScore: null, loToHiType: "related", hiToLoType: null, accepted: false }
    ]; // prettier-ignore
    const at = (t: number) =>
      rescore(data, parseRescoreRule(`decider-only:${t}`)).acceptedNotePairs;
    expect(at(0.65)).toEqual([
      [a, b],
      [c, d]
    ]);
    expect(at(0.8)).toEqual([[c, d]]);
    expect(at(0.95)).toEqual([]);
  });

  it("warns when several deciders judged the pairs and narrows to one on request", () => {
    const data = worldExport();
    const [a, b] = notesOfPair("A1/A5");
    data.decisions = [
      {
        loNoteId: a,
        hiNoteId: b,
        deciderKey: "old-decider-1",
        loToHiScore: 0.9,
        hiToLoScore: null,
        loToHiType: "supports",
        hiToLoType: null,
        accepted: true
      },
      {
        loNoteId: a,
        hiNoteId: b,
        deciderKey: "new-decider-2",
        loToHiScore: 0.2,
        hiToLoScore: null,
        loToHiType: "supports",
        hiToLoType: null,
        accepted: false
      }
    ];
    const rule = parseRescoreRule("decider-only:0.65");
    const mixed = rescore(data, rule);
    expect(mixed.warnings[0]).toContain("decisions of 2 deciders are mixed");
    expect(mixed.acceptedNotePairs).toEqual([[a, b]]); // either decider's score counts
    const old = rescore(data, rule, { deciderKey: "old" });
    expect(old.warnings).toEqual([]);
    expect(old.acceptedNotePairs).toEqual([[a, b]]);
    expect(rescore(data, rule, { deciderKey: "new" }).acceptedNotePairs).toEqual([]);
  });

  it("accepts on a ranker's aggregated log-odds", () => {
    const scores: PairScores = {
      format: "memora-relations-pair-scores",
      version: 1,
      decider: "test",
      scale: "log-odds",
      scores: [
        { query: "a", doc: "b", logOdds: 4 },
        { query: "b", doc: "a", logOdds: 1 },
        { query: "c", doc: "d", logOdds: 2 },
        { query: "d", doc: "c", logOdds: 2 }
      ]
    };
    const data = worldExport();
    const max = rescore(data, parseRescoreRule("ranker:max:3.3125", scores));
    expect(max.acceptedNotePairs).toEqual([["a", "b"]]);
    const mean = rescore(data, parseRescoreRule("ranker:mean:2", scores));
    expect(mean.acceptedNotePairs).toEqual([
      ["a", "b"],
      ["c", "d"]
    ]);
  });
});

describe("the note layer of a re-score against the fixture", () => {
  const data = (linked = v9aHeldOutLinked, missed = v9aHeldOutMissed): RelationsExport => {
    const world = worldExport();
    // The held-out expected pairs a v9 sample links pass the blend; the ones it misses were judged
    // 0.6, under the 0.65 floor the blend demands but over a decider-only threshold of 0.55.
    world.relations = [
      ...linked.map((pair) => strongRelation(pair)),
      ...missed.map((pair) => ({ ...strongRelation(pair), rerankScore: 0.6 }))
    ];
    world.decisions = world.relations.map((relation) => ({
      loNoteId: relation.sourceNoteId,
      hiNoteId: relation.targetNoteId,
      deciderKey: "k",
      loToHiScore: relation.rerankScore,
      hiToLoScore: null,
      loToHiType: "supports",
      hiToLoType: null,
      accepted: relation.rerankScore! >= 0.65
    }));
    return world;
  };

  it("reproduces the stored sample A held-out note layer (24 of 28, 0 of 35) with the v9 blend", () => {
    const { result, evaluation } = rescoreEvaluation(
      data(),
      mapping,
      parseRescoreRule("legacy-blend")
    );
    expect(result.acceptedNotePairs).toHaveLength(24);
    const layer = evaluation.partitions.holdout.layers.notes;
    expect(layer.expected).toMatchObject({ hit: 24, total: 28, evaluable: 28 });
    expect([...layer.expected.hitPairs].sort()).toEqual([...v9aHeldOutLinked].sort());
    expect([...layer.expected.missPairs].sort()).toEqual([...v9aHeldOutMissed].sort());
    expect(layer.forbidden).toMatchObject({ hit: 0, total: 35 });
    expect(result.blendCheck?.compared).toBe(0); // the test rows carry no stored final score
  });

  it("reproduces the stored sample B held-out note layer (23 of 28)", () => {
    const { result, evaluation } = rescoreEvaluation(
      data(v9bHeldOutLinked, v9bHeldOutMissed),
      mapping,
      parseRescoreRule("legacy-blend")
    );
    expect(result.acceptedNotePairs).toHaveLength(23);
    const layer = evaluation.partitions.holdout.layers.notes;
    expect(layer.expected).toMatchObject({ hit: 23, total: 28 });
    expect(layer.expected.missPairs).toContain("L2/L5");
    expect(layer.forbidden.hit).toBe(0);
  });

  it("finds the four missed pairs again when the blend leaves acceptance (decider only, a lower bound)", () => {
    const { evaluation } = rescoreEvaluation(
      data(),
      mapping,
      parseRescoreRule("decider-only:0.55")
    );
    expect(evaluation.partitions.holdout.layers.notes.expected.hit).toBe(28);
  });

  it("compares with a stored report by pair set and never lists the pairs", () => {
    const { evaluation } = rescoreEvaluation(data(), mapping, parseRescoreRule("legacy-blend"));
    const stored = (hits: string[]) => ({
      format: "memora-golden-matching-evaluation",
      partitions: {
        tuning: { layers: { notes: { expected: { hitPairs: [] }, forbidden: { hitPairs: [] } } } },
        holdout: {
          layers: { notes: { expected: { hitPairs: hits }, forbidden: { hitPairs: [] } } }
        }
      }
    });
    const same = compareWithStoredReport(evaluation, stored(v9aHeldOutLinked));
    expect(same.holdout).toEqual({
      same: true,
      differing: 0,
      reproduces: { expected: 24, forbidden: 0 }
    });
    const differs = compareWithStoredReport(evaluation, stored(v9aHeldOutLinked.slice(1)));
    expect(differs.holdout).toEqual({ same: false, differing: 1, reproduces: null });
  });
});

describe("the rescore command and the freeze guard", () => {
  let directory = "";
  let exportFile = "";
  let mappingFile = "";
  let parityFile = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-rescore-"));
    const world = worldExport();
    world.relations = v9aHeldOutLinked.map((pair) => strongRelation(pair));
    exportFile = join(directory, "export.json");
    mappingFile = join(directory, "mapping.json");
    parityFile = join(directory, "stored.json");
    await writeFile(exportFile, JSON.stringify(world));
    await writeFile(mappingFile, JSON.stringify(mapping));
    await writeFile(
      parityFile,
      JSON.stringify({
        format: "memora-golden-matching-evaluation",
        partitions: {
          tuning: {
            layers: { notes: { expected: { hitPairs: [] }, forbidden: { hitPairs: [] } } }
          },
          holdout: {
            layers: {
              notes: { expected: { hitPairs: v9aHeldOutLinked }, forbidden: { hitPairs: [] } }
            }
          }
        }
      })
    );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const argv = (...extra: string[]) => [
    "--export",
    exportFile,
    "--rule",
    "legacy-blend",
    "--mapping",
    mappingFile,
    ...extra
  ];

  it("seals the held-out pairs without a freeze record, in the report and in the JSON", async () => {
    const json = join(directory, "sealed.json");
    const markdown = await runRescore(argv("--json", json, "--parity", parityFile), {
      open: false,
      reason: "no frozen.json"
    });
    expect(markdown).toContain("| held-out | sealed | sealed | sealed |");
    expect(markdown).toContain("held-out sealed until the freeze");
    // The parity line says the pairs are the same and gives the stored report's published figure only.
    expect(markdown).toContain(
      "held-out same pairs (the stored report links 24 expected and 0 forbidden)"
    );
    for (const pair of v9aHeldOutLinked) expect(markdown).not.toContain(pair);
    const stored = await readFile(json, "utf8");
    for (const pair of v9aHeldOutLinked) expect(stored).not.toContain(`"${pair}"`);
    expect(JSON.parse(stored).acceptedNotePairs).toBeUndefined();
    expect(JSON.parse(stored).evaluation.partitions.holdout.sealed).toBe(true);
  });

  it("prints the held-out result once the freeze record is open", async () => {
    const markdown = await runRescore(argv(), {
      open: true,
      frozen: {
        configHash: "sha256:0123456789abcdef",
        calibrationIdentity: "x",
        parity: {},
        inputHashes: {},
        frozenAt: "2026-10-30T12:00:00Z"
      }
    });
    expect(markdown).toContain("| held-out | 24/28 | 0/35 |");
    expect(markdown).toContain("Held-out: expected not linked: Q3/Q5, W2/W5, W3/W5, M3/M5");
  });

  it("asks for an export and a rule", async () => {
    await expect(runRescore([])).rejects.toThrow("--export and --rule are required");
    await expect(
      runRescore(["--export", join(directory, "none.json"), "--rule", "legacy-blend"])
    ).rejects.toThrow("Cannot read the relations export");
    expect(await runRescore(["--help"])).toContain("Usage:");
  });
});
