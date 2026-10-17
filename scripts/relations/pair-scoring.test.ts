import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aggregatePairScores,
  pairScoresSchema,
  parseRankerRule
} from "../golden/relations-export.ts";
import type { PairText, ScoreCall } from "../spikes/reranker/runtimes.ts";
import { noteTextsFormat, renderedNotes, sha256Hex } from "./note-texts.ts";
import {
  buildScoreFile,
  checkScoreFile,
  directedPairsOf,
  noteIdsOf,
  pairScoresFormat,
  pairsFileFormat,
  pairTexts,
  readPairsFile,
  scoreDirectedPairs,
  type PairScorer,
  type PairsFile
} from "./pair-scoring.ts";

const pairsFile = (pairs: Array<[string, string]>): PairsFile => ({
  format: pairsFileFormat,
  version: 1,
  profile: "env-test",
  unorderedPairs: pairs.length,
  directedPairs: 2 * pairs.length,
  pairs
});

const texts = renderedNotes({
  format: noteTextsFormat,
  version: 1,
  profile: "env-test",
  libraryDigest: null,
  generatedAt: "2026-10-17T12:00:00.000Z",
  notes: ["a", "b", "c"].map((id, index) => ({
    id,
    title: `Title ${id}`,
    idea: `Idea ${id}`,
    body: "x".repeat(10 * (index + 1))
  }))
});

const artifact = {
  name: "qwen3-reranker-0.6b-mlx",
  repository: "mlx-community/Qwen3-Reranker-0.6B",
  revision: "0123456789abcdef0123456789abcdef01234567",
  license: "apache-2.0",
  mainFile: "model.safetensors",
  bytes: 1,
  sha256: "f".repeat(64)
};

/** A scorer whose score depends on the direction: longer query, higher; longer document, lower. */
function fakeScorer(requests: PairText[][] = []): PairScorer {
  return {
    name: "mlx",
    artifact,
    async scorePairs(pairs): Promise<ScoreCall> {
      requests.push(pairs);
      return {
        logOdds: pairs.map((pair) => pair.query.length * 0.01 - pair.document.length * 0.02),
        wallMs: 10,
        tokenCounts: pairs.map(() => 300)
      };
    }
  };
}

describe("the pairs file", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-pairs-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const write = async (name: string, value: unknown): Promise<string> => {
    const path = join(directory, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };

  it("reads T44's format with the hash of its bytes", async () => {
    const file = { ...pairsFile([["a", "b"]]), addedBy: { "export.json": 1 } };
    const path = await write("ok.json", file);
    const read = await readPairsFile(path);
    expect(read.file.pairs).toEqual([["a", "b"]]);
    expect(read.sha256).toBe(sha256Hex(JSON.stringify(file)));
  });

  it("refuses wrong counts, a note paired with itself and a pair listed in both orders", async () => {
    await expect(
      readPairsFile(await write("counts.json", { ...pairsFile([["a", "b"]]), directedPairs: 3 }))
    ).rejects.toThrow("counts do not match");
    await expect(readPairsFile(await write("self.json", pairsFile([["a", "a"]])))).rejects.toThrow(
      "with itself"
    );
    await expect(
      readPairsFile(
        await write(
          "twice.json",
          pairsFile([
            ["a", "b"],
            ["b", "a"]
          ])
        )
      )
    ).rejects.toThrow("twice");
    await expect(readPairsFile(join(directory, "missing.json"))).rejects.toThrow("Cannot read");
  });
});

describe("directed pairs", () => {
  it("lists both directions of every pair, the file's direction first", () => {
    expect(
      directedPairsOf([
        ["a", "b"],
        ["a", "c"]
      ])
    ).toEqual([
      { query: "a", doc: "b" },
      { query: "b", doc: "a" },
      { query: "a", doc: "c" },
      { query: "c", doc: "a" }
    ]);
    expect(
      noteIdsOf([
        ["b", "a"],
        ["c", "a"]
      ])
    ).toEqual(["a", "b", "c"]);
  });

  it("puts the query note's text first and names notes without text", () => {
    const [forward] = pairTexts([{ query: "a", doc: "b" }], (id) => texts.get(id));
    expect(forward?.query).toBe(texts.get("a")?.text);
    expect(forward?.document).toBe(texts.get("b")?.text);
    expect(() => pairTexts([{ query: "a", doc: "zz" }], (id) => texts.get(id))).toThrow(
      "1 note(s) have no text (first: zz)"
    );
  });
});

describe("scoring directed pairs", () => {
  const prompts = (count: number): PairText[] =>
    Array.from({ length: count }, (_, index) => ({
      query: `query ${index}`,
      document: `document ${"x".repeat(index)}`
    }));

  it("sends requests of at most the request size and keeps the order", async () => {
    const requests: PairText[][] = [];
    const progress: Array<[number, number]> = [];
    const input = prompts(7);
    const scored = await scoreDirectedPairs(fakeScorer(requests), input, {
      batchSize: 16,
      requestSize: 3,
      onProgress: (done, total) => progress.push([done, total])
    });
    expect(requests.map((request) => request.length)).toEqual([3, 3, 1]);
    expect(scored.requests).toBe(3);
    expect(scored.wallMs).toBe(30);
    expect(scored.tokenCounts).toHaveLength(7);
    expect(progress).toEqual([
      [3, 7],
      [6, 7],
      [7, 7]
    ]);
    expect(scored.logOdds).toEqual(
      input.map((pair) => pair.query.length * 0.01 - pair.document.length * 0.02)
    );
  });

  it("refuses a scorer that returns too few or non-finite scores", async () => {
    const short: PairScorer = {
      name: "mlx",
      artifact,
      scorePairs: async (pairs) => ({ logOdds: pairs.slice(1).map(() => 0), wallMs: 1 })
    };
    const broken: PairScorer = {
      name: "mlx",
      artifact,
      scorePairs: async (pairs) => ({ logOdds: pairs.map(() => Number.NaN), wallMs: 1 })
    };
    const options = { batchSize: 16, requestSize: 8 };
    await expect(scoreDirectedPairs(short, prompts(2), options)).rejects.toThrow("missing");
    await expect(scoreDirectedPairs(broken, prompts(2), options)).rejects.toThrow("non-finite");
    await expect(
      scoreDirectedPairs(fakeScorer(), prompts(2), { batchSize: 16, requestSize: 0 })
    ).rejects.toThrow("request size");
  });
});

describe("the score file", () => {
  const pairs = {
    file: pairsFile([
      ["a", "b"],
      ["a", "c"]
    ]),
    sha256: "p".repeat(64)
  };
  const directed = directedPairsOf(pairs.file.pairs);

  async function build() {
    const scored = await scoreDirectedPairs(
      fakeScorer(),
      pairTexts(directed, (id) => texts.get(id)),
      { batchSize: 16, requestSize: 8 }
    );
    return buildScoreFile({
      profile: "env-test",
      runtime: "mlx",
      instructionId: "mechanism",
      instruction: "Given a note, decide.",
      pairs,
      textsPath: "texts.json",
      textsSha256: "t".repeat(64),
      lookup: (id) => texts.get(id),
      artifact,
      build: { kind: "mlx-helper", sha256: "h".repeat(64) },
      options: { batchSize: 16, requestSize: 8 },
      directed,
      scored,
      startedAt: "2026-10-17T12:00:00.000Z",
      finishedAt: "2026-10-17T12:00:01.000Z",
      hostLoadAverage: { before: [1, 1, 1], after: [2, 2, 2] }
    });
  }

  it("is the format the evaluator, rescore and reverse-only scripts read", async () => {
    const file = await build();
    expect(file.format).toBe(pairScoresFormat);
    const parsed = pairScoresSchema.parse(JSON.parse(JSON.stringify(file)));
    expect(parsed.scores).toHaveLength(4);
    expect(parsed.scores[0]).toEqual({
      query: "a",
      doc: "b",
      logOdds: file.scores[0]?.logOdds
    });
    const { aggregation, threshold } = parseRankerRule("max:3.3125");
    const maxOfBoth = aggregatePairScores(parsed, aggregation).get("a:b");
    expect(maxOfBoth).toBe(Math.max(file.scores[0]!.logOdds, file.scores[1]!.logOdds));
    expect(threshold).toBe(3.3125);
  });

  it("records the hashes of its inputs, the model, the build and the timing", async () => {
    const { run } = await build();
    expect(run.inputs).toMatchObject({
      pairsSha256: pairs.sha256,
      textsSha256: "t".repeat(64),
      notes: 3,
      unorderedPairs: 2,
      directedPairs: 4
    });
    expect(run.inputs.noteTextDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(run.instructionSha256).toBe(sha256Hex("Given a note, decide."));
    expect(run.model.sha256).toBe(artifact.sha256);
    expect(run.build).toEqual({ kind: "mlx-helper", sha256: "h".repeat(64) });
    expect(run.parameters).toEqual({ helperBatchSize: 16, requestSize: 8 });
    expect(run.timing).toMatchObject({ requests: 1, msPerDirectedPair: 2.5 });
    expect(run.tokens).toEqual({ mean: 300, max: 300 });
  });

  it("checks the scores against the pair list", async () => {
    const file = await build();
    expect(() => checkScoreFile(file, pairs.file)).not.toThrow();
    expect(() => checkScoreFile({ ...file, scores: file.scores.slice(1) }, pairs.file)).toThrow(
      "Expected 4"
    );
    const repeated = [file.scores[0]!, file.scores[0]!, file.scores[2]!, file.scores[3]!];
    expect(() => checkScoreFile({ ...file, scores: repeated }, pairs.file)).toThrow(
      "unexpected or repeated"
    );
  });
});
