import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  exportPairs,
  keptByExport,
  keptByRankerRule,
  lossReport,
  readSpikeDataset,
  readSpikeScores,
  renderLossMarkdown,
  runReverseOnly,
  spikeReverseOnly,
  wilsonInterval,
  type ReversePair
} from "./reverse-only.ts";
import { notePairKey, type PairScores, type RelationsExport } from "./relations-export.ts";
import { cacheRoot } from "./test-world.ts";

const pair = (a: string, b: string, sameRoot = false): ReversePair => ({ a, b, sameRoot });

describe("wilsonInterval", () => {
  it("matches the textbook interval", () => {
    const [low, high] = wilsonInterval(50, 100);
    expect(low).toBeCloseTo(0.4038, 3);
    expect(high).toBeCloseTo(0.5962, 3);
    expect(wilsonInterval(0, 10)[0]).toBe(0);
    expect(wilsonInterval(10, 10)[1]).toBe(1);
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});

describe("lossReport: literal and adjudicated loss", () => {
  // Ten pairs: four same-root. The pipeline keeps all but p3, p4 (same root) and p9, p10 (across).
  const pairs = [
    pair("a1", "b1"),
    pair("a2", "b2"),
    pair("a3", "b3", true),
    pair("a4", "b4", true),
    pair("a5", "b5"),
    pair("a6", "b6"),
    pair("a7", "b7", true),
    pair("a8", "b8", true),
    pair("a9", "b9"),
    pair("a10", "b10")
  ];
  const lost = new Set(["a3", "a4", "a9", "a10"]);
  const kept = (p: ReversePair) => !lost.has(p.a);

  it("counts every pair of the set and splits same-root pairs", () => {
    const report = lossReport("R_x", pairs, kept);
    expect(report.literal).toMatchObject({ total: 10, kept: 6, lost: 4, loss: 0.4 });
    expect(report.literal.sameRoot).toMatchObject({ total: 4, lost: 2, loss: 0.5 });
    expect(report.literal.crossRoot).toMatchObject({ total: 6, lost: 2 });
    expect(report.adjudicated).toBeNull();
  });

  it("counts only the pairs the panel rates related in the adjudicated loss", () => {
    // p3 (same root) and p9 are lost and unrelated; p4 and p10 are lost and related.
    const related = new Map<string, boolean>(
      pairs.map((p) => [notePairKey(p.a, p.b), !["a3", "a9", "a8"].includes(p.a)])
    );
    const report = lossReport("R_x", pairs, kept, related);
    expect(report.adjudicated).toMatchObject({
      related: 7,
      lostRelated: 2,
      keptRelated: 5,
      notRelated: 3,
      unlabelledKept: 0,
      unlabelledLost: 0,
      estimate: null
    });
    expect(report.adjudicated!.loss).toBeCloseTo(2 / 7, 6);
    expect(report.adjudicated!.sameRoot).toMatchObject({ related: 2, lostRelated: 1 });
    expect(report.adjudicated!.crossRoot).toMatchObject({ related: 5, lostRelated: 1 });
  });

  it("estimates the loss from the labelled kept sample and flags a bar inside the interval (R10)", () => {
    // 137-pair style set: 10 lost and related, 127 kept of which 50 labelled, 30 of those related.
    const many: ReversePair[] = [];
    for (let i = 0; i < 10; i += 1) many.push(pair(`lost${i}`, `x${i}`));
    for (let i = 0; i < 127; i += 1) many.push(pair(`kept${i}`, `y${i}`));
    const isKept = (p: ReversePair) => p.a.startsWith("kept");
    const labels = new Map<string, boolean>();
    for (let i = 0; i < 10; i += 1) labels.set(notePairKey(`lost${i}`, `x${i}`), true);
    for (let i = 0; i < 50; i += 1) labels.set(notePairKey(`kept${i}`, `y${i}`), i < 30);
    const report = lossReport("R_v9", many, isKept, labels);
    const adjudicated = report.adjudicated!;
    expect(adjudicated.unlabelledKept).toBe(77);
    expect(adjudicated.estimate!.keptRelatedShare).toBeCloseTo(0.6, 6);
    // loss = 10 / (10 + 127 * 0.6)
    expect(adjudicated.estimate!.loss).toBeCloseTo(10 / (10 + 127 * 0.6), 6);
    const [low, high] = adjudicated.estimate!.lossInterval;
    expect(low).toBeLessThan(adjudicated.estimate!.loss);
    expect(high).toBeGreaterThan(adjudicated.estimate!.loss);
    expect(adjudicated.estimate!.barInsideInterval).toBe(low <= 0.05 && 0.05 <= high);
    expect(renderLossMarkdown(report)).toContain("77 kept pairs are unlabelled");
  });

  it("has no estimate once every kept pair is labelled, and reports unlabelled lost pairs", () => {
    const report = lossReport(
      "R_x",
      [pair("k", "k2"), pair("l", "l2")],
      (p) => p.a === "k",
      new Map([[notePairKey("k", "k2"), true]])
    );
    expect(report.adjudicated).toMatchObject({ unlabelledLost: 1, estimate: null, related: 1 });
    expect(renderLossMarkdown(report)).toContain("1 lost pairs have no label");
  });
});

describe("export-based sets", () => {
  const data = (relations: RelationsExport["relations"]): RelationsExport => ({
    format: "memora-relations-export",
    version: 1,
    sources: [
      { id: "book", parentId: null, title: "Book" },
      { id: "chapter", parentId: "book", title: "Chapter" },
      { id: "other", parentId: null, title: "Other" }
    ],
    notes: [
      { id: "n1", sourceItemId: "chapter" },
      { id: "n2", sourceItemId: "book" },
      { id: "n3", sourceItemId: "other" }
    ],
    candidates: [],
    decisions: [],
    relations,
    context: { label: null, database: null, generatedAt: null }
  });
  const relation = (
    a: string,
    b: string,
    extra: Partial<RelationsExport["relations"][number]> = {}
  ) => ({
    sourceNoteId: a,
    targetNoteId: b,
    status: "pending_review",
    relationType: null,
    vectorScore: null,
    textScore: null,
    metadataScore: null,
    graphScore: null,
    rerankScore: null,
    finalScore: null,
    fusionScore: null,
    textRank: null,
    vectorRank: null,
    graphRank: null,
    ...extra
  });

  it("takes the relations as the set and flags pairs inside one root", () => {
    const pairs = exportPairs(
      data([relation("n1", "n2"), relation("n2", "n1"), relation("n1", "n3")])
    );
    expect(pairs).toEqual([
      { a: "n1", b: "n2", sameRoot: true },
      { a: "n1", b: "n3", sameRoot: false }
    ]);
  });

  it("keeps the pairs another export shows, by its verdict or its status", () => {
    const shownByVerdict = keptByExport(
      data([relation("n1", "n3", { shown: true }), relation("n1", "n2", { shown: false })])
    );
    expect(shownByVerdict(pair("n3", "n1"))).toBe(true);
    expect(shownByVerdict(pair("n1", "n2"))).toBe(false);
    const shownByStatus = keptByExport(
      data([relation("n1", "n3"), relation("n1", "n2", { status: "rejected" })])
    );
    expect(shownByStatus(pair("n1", "n3"))).toBe(true);
    expect(shownByStatus(pair("n1", "n2"))).toBe(false);
  });

  it("keeps a pair when the aggregate of its two directions reaches the threshold", () => {
    const scores: PairScores = {
      format: "memora-relations-pair-scores",
      version: 1,
      decider: "",
      scale: "log-odds",
      scores: [
        { query: "a", doc: "b", logOdds: 4 },
        { query: "b", doc: "a", logOdds: -2 },
        { query: "c", doc: "d", logOdds: 1 }
      ]
    };
    expect(
      keptByRankerRule(scores, { aggregation: "max", threshold: 3.3125 })(pair("b", "a"))
    ).toBe(true);
    expect(
      keptByRankerRule(scores, { aggregation: "mean", threshold: 3.3125 })(pair("a", "b"))
    ).toBe(false);
    // Only one direction scored: max keeps it under the threshold rule, mean leaves it out.
    expect(keptByRankerRule(scores, { aggregation: "max", threshold: 0.5 })(pair("c", "d"))).toBe(
      true
    );
    expect(keptByRankerRule(scores, { aggregation: "mean", threshold: -9 })(pair("c", "d"))).toBe(
      false
    );
    expect(keptByRankerRule(scores, { aggregation: "max", threshold: 0 })(pair("x", "y"))).toBe(
      false
    );
  });
});

describe("R_v6 from Spike A's files", () => {
  let directory = "";
  let datasetFile = "";
  let scoresFile = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-reverse-only-"));
    datasetFile = join(directory, "dataset.json");
    scoresFile = join(directory, "scores.json");
    // Four old acceptances in the economy phase: u->v (reverse rejected: reverse-only), v->w (reverse
    // accepted), x->y (no reverse judged) and p->q (reverse rejected, same root).
    const notes = [
      { id: "u", root: "R1" },
      { id: "v", root: "R2" },
      { id: "w", root: "R3" },
      { id: "x", root: "R4" },
      { id: "y", root: "R5" },
      { id: "p", root: "R6" },
      { id: "q", root: "R6" }
    ];
    const row = (query: string, doc: string, accepted: boolean) => ({
      phase: "economy",
      query,
      doc,
      cosine: 0.5,
      oldLlm: accepted ? 0.9 : 0.1,
      finalScore: 0.5,
      accepted
    });
    const rows = [
      row("u", "v", true),
      row("v", "u", false),
      row("v", "w", true),
      row("w", "v", true),
      row("x", "y", true),
      row("p", "q", true),
      row("q", "p", false),
      { ...row("u", "w", true), phase: "validate" },
      { ...row("w", "u", false), phase: "validate" }
    ];
    const all = rows.flatMap((r) => [
      [r.query, r.doc],
      [r.doc, r.query]
    ]);
    const unique = [...new Map(all.map((p) => [p.join("|"), p])).values()];
    await writeFile(datasetFile, JSON.stringify({ notes, rows, sets: { all: unique } }));
    // u->v scores 4.0 and v->u -3 (kept by the max); p->q -1 and q->p 0 (lost).
    const scoreOf = ([a, b]: string[]) =>
      a === "u" && b === "v" ? 4 : a === "p" && b === "q" ? -1 : a === "q" && b === "p" ? 0 : -3;
    await writeFile(
      scoresFile,
      JSON.stringify({ set: "all", logOdds: unique.map((p) => scoreOf(p as string[])) })
    );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("selects the acceptances whose reverse was judged and rejected", async () => {
    const dataset = await readSpikeDataset(datasetFile);
    expect(spikeReverseOnly(dataset)).toEqual([
      { a: "u", b: "v", sameRoot: false },
      { a: "p", b: "q", sameRoot: true }
    ]);
  });

  it("aligns the score file with the dataset's set and refuses a mismatch", async () => {
    const dataset = await readSpikeDataset(datasetFile);
    const scores = await readSpikeScores(scoresFile, dataset);
    expect(scores.scores).toHaveLength(dataset.sets.all.length);
    const short = join(directory, "short.json");
    await writeFile(short, JSON.stringify({ set: "all", logOdds: [1, 2] }));
    await expect(readSpikeScores(short, dataset)).rejects.toThrow("does not match");
  });

  it("reports the loss at the frozen rule from the command line", async () => {
    const out = join(directory, "report.md");
    const json = join(directory, "report.json");
    await runReverseOnly([
      "--spike-dataset",
      datasetFile,
      "--spike-scores",
      scoresFile,
      "--rule",
      "max:3.3125",
      "--out",
      out,
      "--json",
      json
    ]);
    const report = JSON.parse(await readFile(json, "utf8"));
    expect(report.set).toBe("R_v6");
    expect(report.literal).toMatchObject({ total: 2, kept: 1, lost: 1 });
    expect(report.literal.sameRoot).toMatchObject({ total: 1, lost: 1 });
    expect(await readFile(out, "utf8")).toContain("| Literal, all pairs | 2 | 1 | 1 | 50.0% |");
  });

  it("refuses incomplete requests", async () => {
    await expect(runReverseOnly([])).rejects.toThrow("Give --spike-dataset");
    await expect(runReverseOnly(["--spike-dataset", datasetFile])).rejects.toThrow(
      "--spike-scores"
    );
    await expect(runReverseOnly(["--set", join(directory, "none.json")])).rejects.toThrow();
    expect(await runReverseOnly(["--help"])).toContain("Usage:");
  });

  const cache = join(cacheRoot, "spikes/reranker");
  const stored = join(cache, "dataset.json");
  const scores = join(cache, "scores/mlx__mechanism__all__b16.json");
  it.skipIf(!existsSync(stored) || !existsSync(scores))(
    "loses 12 of Spike A's 37 reverse-only acceptances at 3.3125 (stored files)",
    async () => {
      const dataset = await readSpikeDataset(stored);
      const pairs = spikeReverseOnly(dataset);
      const report = lossReport(
        "R_v6",
        pairs,
        keptByRankerRule(await readSpikeScores(scores, dataset), {
          aggregation: "max",
          threshold: 3.3125
        })
      );
      expect(report.literal).toMatchObject({ total: 37, lost: 12 });
      expect(report.literal.sameRoot).toMatchObject({ total: 17, lost: 8 });
      expect(report.literal.crossRoot).toMatchObject({ total: 20, lost: 4 });
    }
  );
});
