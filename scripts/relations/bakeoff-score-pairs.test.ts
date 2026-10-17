import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aggregatePairScores, readPairScores } from "../golden/relations-export.ts";
import { localModelJob } from "../spikes/topic-tree/local-model-slot.ts";
import {
  bakeoffTask,
  main,
  planConfigs,
  readIndex,
  renderSummary,
  runBakeoffScore,
  scoreFileName,
  summarizeScoreFile,
  type BakeoffDependencies,
  type BakeoffRanker,
  type ScoreCommand
} from "./bakeoff-score-pairs.ts";
import type { LabelItem } from "./bakeoff-sets.ts";
import { noteTextsFormat } from "./note-texts.ts";
import { pairsFileFormat } from "./pair-scoring.ts";

const artifact = {
  name: "qwen3-reranker-0.6b-mlx",
  repository: "mlx-community/Qwen3-Reranker-0.6B",
  revision: "0123456789abcdef0123456789abcdef01234567",
  license: "apache-2.0",
  mainFile: "model.safetensors",
  bytes: 1,
  sha256: "f".repeat(64)
};

describe("the configurations", () => {
  it("cover every instruction at both templates, grouped by instruction", () => {
    const specs = planConfigs("mlx");
    expect(specs).toHaveLength(8);
    expect(specs.map(scoreFileName).slice(0, 4)).toEqual([
      "labels-mlx-mechanism-t400.json",
      "labels-mlx-mechanism-t600.json",
      "labels-mlx-relation-t400.json",
      "labels-mlx-relation-t600.json"
    ]);
    expect(specs.map((spec) => spec.instructionId)).toEqual([
      "mechanism",
      "mechanism",
      "relation",
      "relation",
      "study",
      "study",
      "default",
      "default"
    ]);
  });

  it("score the bge control once per template, with no instruction", () => {
    expect(planConfigs("bge").map(scoreFileName)).toEqual([
      "labels-bge-none-t400.json",
      "labels-bge-none-t600.json"
    ]);
  });

  it("are matched by the local-model slot as scripts that run GGUF in-process", () => {
    expect(
      localModelJob.test(
        "node /repo/node_modules/.bin/tsx scripts/relations/bakeoff-score-pairs.ts score --runtime gguf"
      )
    ).toBe(true);
  });
});

describe("scoring the bake-off sets", () => {
  let directory = "";
  let events: string[] = [];
  let calls: Array<{ instruction: string | null; pairs: number; firstText: string }> = [];
  const noteIds = ["n1", "n2", "n3", "n4"];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-bakeoff-score-"));
    await mkdir(join(directory, "inputs"), { recursive: true });
    const pairs = [
      ["n1", "n2"],
      ["n1", "n3"],
      ["n3", "n4"]
    ];
    await writeFile(
      join(directory, "inputs", "pairs.json"),
      JSON.stringify({
        format: pairsFileFormat,
        version: 1,
        profile: "f3-bakeoff-labels",
        unorderedPairs: 3,
        directedPairs: 6,
        pairs
      })
    );
    await writeFile(
      join(directory, "inputs", "texts.json"),
      JSON.stringify({
        format: noteTextsFormat,
        version: 1,
        profile: "f3-bakeoff-labels",
        libraryDigest: null,
        generatedAt: "2026-10-17T12:00:00.000Z",
        notes: noteIds.map((id, index) => ({
          id,
          title: `Title ${id}`,
          idea: `Idea ${id}`,
          // 800 characters: the 600-character template shows more of it than the 400 one.
          body: `${"w".repeat(100 * (index + 1))} ${"z".repeat(700)}`
        }))
      })
    );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => {
    events = [];
    calls = [];
  });

  function rankerOf(failOnCall?: number): BakeoffRanker {
    let count = 0;
    return {
      path: "product-adapter",
      artifact,
      perCall: 32,
      helperBatchSize: 16,
      runtimeBuild: async () => "memora-mlx-helper@sha256:abc",
      async rank(instruction, pairs, onProgress) {
        count += 1;
        events.push("rank");
        calls.push({ instruction, pairs: pairs.length, firstText: pairs[0]!.query });
        if (count === failOnCall) throw new Error("the helper crashed");
        onProgress?.(pairs.length);
        return {
          logOdds: pairs.map((pair) => pair.query.length * 0.01 - pair.document.length * 0.005),
          tokenCounts: pairs.map(() => 120),
          truncated: 0,
          calls: 1,
          wallMs: 5,
          callMs: [5]
        };
      },
      async dispose() {
        events.push("dispose");
      }
    };
  }

  const dependencies = (ranker: BakeoffRanker): BakeoffDependencies => ({
    openRanker: async () => {
      events.push("open");
      return ranker;
    },
    withLock: async (work) => {
      events.push("lock");
      try {
        return await work();
      } finally {
        events.push("unlock");
      }
    },
    now: () => new Date("2026-10-17T12:00:00.000Z"),
    loadAverage: () => [1, 1, 1],
    log: () => undefined
  });

  const command = (outDir: string, overrides: Partial<ScoreCommand> = {}): ScoreCommand => ({
    runtime: "mlx",
    instructionIds: ["mechanism", "relation"],
    bodies: [400, 600],
    pairsPath: join(directory, "inputs", "pairs.json"),
    textsPath: join(directory, "inputs", "texts.json"),
    outDir,
    ...overrides
  });

  it("scores every configuration inside one lock and one model load, and indexes the files", async () => {
    const outDir = join(directory, "out");
    const written = await runBakeoffScore(command(outDir), dependencies(rankerOf()));
    expect(written.map((path) => path.slice(outDir.length + 1))).toEqual([
      "labels-mlx-mechanism-t400.json",
      "labels-mlx-mechanism-t600.json",
      "labels-mlx-relation-t400.json",
      "labels-mlx-relation-t600.json"
    ]);
    // Lock, open, the warm-up of 4 pairs, four configurations, dispose, unlock.
    expect(events).toEqual([
      "lock",
      "open",
      "rank",
      "rank",
      "rank",
      "rank",
      "rank",
      "dispose",
      "unlock"
    ]);
    expect(calls.map((call) => call.pairs)).toEqual([4, 6, 6, 6, 6]);
    expect(calls.map((call) => call.instruction?.slice(0, 12))).toEqual([
      "Given a note",
      "Given a note",
      "Given a note",
      "Judge whethe",
      "Judge whethe"
    ]);
    // The 600-character template shows more of each note than the 400 one.
    expect(calls[2]!.firstText.length).toBeGreaterThan(calls[1]!.firstText.length);

    const scores = await readPairScores(written[0]!);
    expect(scores.scores).toHaveLength(6);
    expect(scores.scores.slice(0, 2).map(({ query, doc }) => [query, doc])).toEqual([
      ["n1", "n2"],
      ["n2", "n1"]
    ]);
    expect(scores.decider).toContain("instruction=mechanism template=relation-pair-text-v1:400");
    expect(scores.decider).toContain("pairs-per-call=32 helper-batch=16");
    const raw = JSON.parse(await readFile(written[0]!, "utf8")) as {
      run: Record<string, unknown>;
    };
    expect(raw.run).toMatchObject({
      task: bakeoffTask,
      path: "product-adapter",
      runtimeBuild: "memora-mlx-helper@sha256:abc",
      template: { id: "relation-pair-text-v1", bodyCharacters: 400 },
      callPlan: { pairsPerCall: 32, helperBatchSize: 16, calls: 1 },
      inputs: { notes: 4, unorderedPairs: 3, directedPairs: 6 }
    });
    const digests = await Promise.all(
      written.map(
        async (path) =>
          (
            JSON.parse(await readFile(path, "utf8")) as {
              run: { inputs: { noteTextDigest: string } };
            }
          ).run.inputs.noteTextDigest
      )
    );
    // The rendered inputs differ between the templates, and not between the instructions.
    expect(digests[0]).not.toBe(digests[1]);
    expect(digests[0]).toBe(digests[2]);

    const index = await readIndex(outDir);
    expect(index.map((entry) => entry.file)).toEqual(written.map((path) => path.split("/").at(-1)));
    expect(new Set(index.map((entry) => entry.pairsSha256)).size).toBe(1);
    expect(JSON.parse(await readFile(join(outDir, "index.json"), "utf8"))).toMatchObject({
      format: "memora-bakeoff-score-index",
      files: [{ runtime: "mlx", instructionId: "mechanism", bodyCharacters: 400 }, {}, {}, {}]
    });
  });

  it("fails before the lock when a note has no text, and releases everything when scoring fails", async () => {
    await expect(
      runBakeoffScore(
        command(join(directory, "out-missing"), {
          pairsPath: join(directory, "inputs", "pairs-missing.json")
        }),
        dependencies(rankerOf())
      )
    ).rejects.toThrow("Cannot read the pairs file");
    expect(events).toEqual([]);

    await expect(
      runBakeoffScore(command(join(directory, "out-fail")), dependencies(rankerOf(3)))
    ).rejects.toThrow("the helper crashed");
    expect(events.slice(-2)).toEqual(["dispose", "unlock"]);
  });

  it("refuses an unknown instruction before opening anything", async () => {
    await expect(
      runBakeoffScore(
        command(join(directory, "out-unknown"), { instructionIds: ["invented"] }),
        dependencies(rankerOf())
      )
    ).rejects.toThrow('Unknown instruction "invented"');
    expect(events).toEqual([]);
  });

  it("refuses the command line it cannot run", async () => {
    await expect(main(["score", "--runtime", "cuda"])).rejects.toThrow(
      "--runtime is mlx, gguf or bge"
    );
    await expect(main(["score", "--runtime", "mlx", "--bodies", "500"])).rejects.toThrow(
      "--bodies is a list of 400, 600"
    );
  });
});

describe("the descriptive summary", () => {
  const item = (
    lo: string,
    hi: string,
    pool: string | null,
    related: boolean,
    split: "fit" | "eval",
    sets: string[]
  ): LabelItem => ({
    pairId: `note:x:${lo}${hi}`,
    kind: "note",
    library: "fixture",
    lo,
    hi,
    sets,
    pool,
    stratum: 1,
    split,
    related
  });
  const items = [
    item("a", "b", "A", true, "fit", ["pool-A"]),
    item("a", "c", "A", false, "fit", ["pool-A"]),
    item("a", "d", "A", true, "eval", ["pool-A"]),
    item("a", "e", "A", false, "eval", ["pool-A"]),
    item("a", "f", null, true, "eval", ["rv6"])
  ];
  const scores = {
    format: "memora-relations-pair-scores" as const,
    version: 1 as const,
    decider: "x",
    scale: "log-odds" as const,
    scores: [
      { query: "a", doc: "b", logOdds: 5 },
      { query: "b", doc: "a", logOdds: 1 },
      { query: "a", doc: "c", logOdds: 0 },
      { query: "c", doc: "a", logOdds: 2 },
      { query: "a", doc: "d", logOdds: 4 },
      { query: "d", doc: "a", logOdds: 4 },
      { query: "a", doc: "e", logOdds: 3.5 },
      { query: "e", doc: "a", logOdds: -3 },
      { query: "a", doc: "f", logOdds: 2 },
      { query: "f", doc: "a", logOdds: 4 }
    ]
  };

  it("reads AUC per split and the share of R_v6 and R_v9 at the frozen threshold, for max and mean", () => {
    const rows = summarizeScoreFile(
      items,
      new Set(["a|b", "a|c"]),
      "labels-mlx-mechanism-t400.json",
      "mlx",
      scores
    );
    const max = rows.find((row) => row.aggregation === "max")!;
    const meanRow = rows.find((row) => row.aggregation === "mean")!;
    // max: b 5, c 2, d 4, e 3.5; mean: b 3, c 1, d 4, e 0.25
    expect(max.auc.A).toBe(1);
    expect(max.aucFit).toBe(1);
    expect(max.aucEval).toBe(1);
    expect(meanRow.auc.A).toBe(1);
    // The pool-less R_v6 pair a-f has max 4 and mean 3; R_v9's a|b (5) passes, a|c (2) does not.
    expect(max.rv6AtFrozenThreshold).toBe(1);
    expect(meanRow.rv6AtFrozenThreshold).toBe(0);
    expect(max.rv9AtFrozenThreshold).toBe(0.5);
    expect(aggregatePairScores(scores, "mean").get("a:b")).toBe(3);
    const markdown = renderSummary(rows, [
      {
        file: "labels-mlx-mechanism-t400.json",
        msPerDirectedPair: 31.4
      } as never
    ]);
    expect(markdown).toContain("| mlx-mechanism-t400 | max | 1.000 |");
    expect(markdown).toContain("31.4");
  });

  it("reads the AUC over the labelled pairs a scorer covers, as Decisions covers pool A only", () => {
    const withPoolB = [
      ...items,
      item("g", "h", "B", true, "fit", ["pool-B"]),
      item("g", "i", "B", false, "fit", ["pool-B"])
    ];
    const rows = summarizeScoreFile(withPoolB, new Set(), "decisions.json", "decisions", scores);
    expect(rows[0]!.auc.A).toBe(1);
    expect(rows[0]!.auc.B).toBeNull();
    expect(rows[0]!.auc.all).toBe(1);
    expect(rows[0]!.rv6AtFrozenThreshold).toBeNull();
  });

  it("leaves the threshold shares out for a runtime with no frozen rule", () => {
    const rows = summarizeScoreFile(
      items,
      new Set(["a|b"]),
      "labels-bge-none-t400.json",
      "bge",
      scores
    );
    expect(rows[0]!.rv6AtFrozenThreshold).toBeNull();
    expect(rows[0]!.rv9AtFrozenThreshold).toBeNull();
  });
});
