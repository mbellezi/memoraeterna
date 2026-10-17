import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readPairScores } from "../golden/relations-export.ts";
import { repositoryRoot } from "../spikes/reranker/dataset.ts";
import type { ScoreCall } from "../spikes/reranker/runtimes.ts";
import { localModelJob } from "../spikes/topic-tree/local-model-slot.ts";
import { noteTextsFormat } from "./note-texts.ts";
import { pairsFileFormat, type PairScorer } from "./pair-scoring.ts";
import {
  compareScores,
  frozenThreshold,
  main,
  recordedPath,
  runB1,
  runParity,
  runScore,
  runtimeKindOf,
  type Dependencies,
  type PairRuntime,
  type ParityReference
} from "./score-pairs.ts";

const artifact = {
  name: "qwen3-reranker-0.6b-mlx",
  repository: "mlx-community/Qwen3-Reranker-0.6B",
  revision: "0123456789abcdef0123456789abcdef01234567",
  license: "apache-2.0",
  mainFile: "model.safetensors",
  bytes: 1,
  sha256: "f".repeat(64)
};

describe("the local-model slot", () => {
  it("sees a relations scorer running GGUF in-process, which shows no node-llama-cpp", () => {
    expect(
      localModelJob.test(
        "node /repo/node_modules/.bin/tsx scripts/relations/score-pairs.ts score --runtime gguf"
      )
    ).toBe(true);
    expect(localModelJob.test("tsx scripts/relations/rematch-fixture.ts")).toBe(true);
  });

  it("still sees the helper, the spike scorers and node-llama-cpp, and not unrelated scripts", () => {
    expect(localModelJob.test("/x/native/mlx-helper/.build/release/memora-mlx-helper")).toBe(true);
    expect(localModelJob.test("tsx scripts/spikes/reranker/score.ts --runtime mlx")).toBe(true);
    expect(localModelJob.test("tsx scripts/spikes/topic-tree/embed-real.ts")).toBe(true);
    expect(localModelJob.test("node /x/node_modules/node-llama-cpp/dist/cli.js")).toBe(true);
    expect(localModelJob.test("tsx scripts/relations/labels/tally.ts --pass r-v9")).toBe(false);
    expect(localModelJob.test("tsx scripts/golden/rescore.ts --export x.json")).toBe(false);
  });
});

describe("the harness commands", () => {
  let directory = "";
  let events: string[] = [];
  let requests: number[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-score-pairs-"));
    for (const profile of ["env-x", "env-y"]) {
      const ids = [`${profile}-a`, `${profile}-b`, `${profile}-c`];
      const pairs = [
        [ids[0]!, ids[1]!],
        [ids[0]!, ids[2]!]
      ];
      await mkdir(join(directory, "pairs"), { recursive: true });
      await mkdir(join(directory, "texts"), { recursive: true });
      await writeFile(
        join(directory, "pairs", `${profile}-pairs.json`),
        JSON.stringify({
          format: pairsFileFormat,
          version: 1,
          profile,
          unorderedPairs: 2,
          directedPairs: 4,
          pairs
        })
      );
      await writeFile(
        join(directory, "texts", `${profile}-note-texts.json`),
        JSON.stringify({
          format: noteTextsFormat,
          version: 1,
          profile,
          libraryDigest: null,
          generatedAt: "2026-10-17T12:00:00.000Z",
          notes: ids.map((id, index) => ({
            id,
            title: `Title ${id}`,
            idea: `Idea ${id}`,
            body: "y".repeat(5 * (index + 1))
          }))
        })
      );
    }
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function runtimeOf(failAt?: number): PairRuntime {
    let calls = 0;
    const scorer: PairScorer = {
      name: "mlx",
      artifact,
      async scorePairs(pairs): Promise<ScoreCall> {
        events.push("score");
        requests.push(pairs.length);
        calls += 1;
        if (calls === failAt) throw new Error("the helper crashed");
        return {
          logOdds: pairs.map((pair) => pair.query.length * 0.01 - pair.document.length * 0.02),
          wallMs: 4,
          tokenCounts: pairs.map(() => 120)
        };
      }
    };
    return {
      ...scorer,
      scorePairs: scorer.scorePairs.bind(scorer),
      async dispose() {
        events.push("dispose");
      }
    };
  }

  function dependencies(runtime: PairRuntime): Dependencies {
    return {
      openRuntime: async () => {
        events.push("open");
        return runtime;
      },
      runtimeBuild: async () => ({ kind: "mlx-helper", sha256: "h".repeat(64) }),
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
    };
  }

  const scoreCommand = (profiles: string[], outDir: string) => ({
    runtime: runtimeKindOf("mlx"),
    profiles,
    instructionId: "mechanism",
    instruction: "Given a note (Query), decide.",
    batchSize: 16,
    requestSize: 2_048,
    pairsDir: join(directory, "pairs"),
    textsDir: join(directory, "texts"),
    outDir
  });

  beforeEach(() => {
    events = [];
    requests = [];
  });

  it("scores every profile inside one lock and one model load, and writes readable scores", async () => {
    const outDir = join(directory, "out-score");
    const written = await runScore(
      scoreCommand(["env-x", "env-y"], outDir),
      dependencies(runtimeOf())
    );
    expect(written).toEqual([
      join(outDir, "env-x-mlx-mechanism.json"),
      join(outDir, "env-y-mlx-mechanism.json")
    ]);
    // Lock, one open, one warm-up of 4 pairs, one request per profile, dispose, unlock.
    expect(events).toEqual(["lock", "open", "score", "score", "score", "dispose", "unlock"]);
    expect(requests).toEqual([4, 4, 4]);
    const scores = await readPairScores(written[0]!);
    expect(scores.scores).toHaveLength(4);
    expect(scores.decider).toContain("instruction=mechanism");
    const raw = JSON.parse(await readFile(written[0]!, "utf8")) as { run: { inputs: object } };
    expect(raw.run.inputs).toMatchObject({ directedPairs: 4, notes: 3 });
  });

  it("fails before the lock when a note has no text, and releases everything when scoring fails", async () => {
    const broken = join(directory, "texts-broken");
    await mkdir(broken, { recursive: true });
    await writeFile(
      join(broken, "env-x-note-texts.json"),
      JSON.stringify({
        format: noteTextsFormat,
        version: 1,
        profile: "env-x",
        libraryDigest: null,
        generatedAt: "2026-10-17T12:00:00.000Z",
        notes: []
      })
    );
    await expect(
      runScore(
        { ...scoreCommand(["env-x"], join(directory, "out-broken")), textsDir: broken },
        dependencies(runtimeOf())
      )
    ).rejects.toThrow("have no text");
    expect(events).toEqual([]);

    await expect(
      runScore(scoreCommand(["env-x"], join(directory, "out-fail")), dependencies(runtimeOf(2)))
    ).rejects.toThrow("the helper crashed");
    expect(events).toEqual(["lock", "open", "score", "score", "dispose", "unlock"]);
  });

  it("measures B1 on a profile's pairs and writes the result beside its table", async () => {
    const out = join(directory, "out-b1", "b1-mlx.json");
    const { result, markdown } = await runB1(
      {
        runtime: "mlx",
        profile: "env-x",
        instructionId: "mechanism",
        instruction: "Given a note (Query), decide.",
        callSizes: [2],
        helperBatches: [1, 2],
        repeats: 1,
        callsPerRepeat: 1,
        seed: 3,
        pairsDir: join(directory, "pairs"),
        textsDir: join(directory, "texts"),
        out
      },
      dependencies(runtimeOf())
    );
    expect(result.combinations.map((row) => [row.callSize, row.helperBatch])).toEqual([
      [2, 1],
      [2, 2]
    ]);
    expect(markdown).toContain("B1 mlx");
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({
      format: "memora-relations-b1",
      task: "T46a",
      inputs: { profile: "env-x" }
    });
    expect(await readFile(out.replace(/\.json$/u, ".md"), "utf8")).toBe(markdown);
    expect(events.at(-1)).toBe("unlock");
  });

  it("rescores a sample of Spike A's pairs and compares them with its stored scores", async () => {
    const reference: ParityReference = {
      pairs: [
        ["n1", "n2"],
        ["n2", "n1"],
        ["n1", "n3"]
      ],
      textOf: new Map([
        ["n1", "one"],
        ["n2", "twenty"],
        ["n3", "thirty three"]
      ]),
      // What the fake runtime scores, so the rescore agrees except for one pair nudged across the rule.
      logOdds: [3 * 0.01 - 6 * 0.02, 6 * 0.01 - 3 * 0.02, 3.4],
      batchSize: 16
    };
    const report = await runParity(
      {
        runtime: "mlx",
        instructionId: "mechanism",
        instruction: "Given a note (Query), decide.",
        sample: 10,
        seed: 5,
        batchSize: 16,
        out: join(directory, "out-parity", "parity-mlx.json")
      },
      reference,
      dependencies(runtimeOf())
    );
    expect(report).toMatchObject({
      sample: 3,
      referencePairs: 3,
      referenceBatchSize: 16,
      threshold: frozenThreshold.mlx,
      thresholdFlips: 1
    });
    expect(report.maxAbsDelta).toBeCloseTo(3.4 - (3 * 0.01 - 12 * 0.02), 9);
  });

  it("refuses the command line it cannot run", async () => {
    await expect(main(["score", "--runtime", "cuda"])).rejects.toThrow("--runtime is mlx or gguf");
    await expect(main(["score", "--runtime", "mlx", "--bogus"])).rejects.toThrow();
  });
});

describe("the paths a score file records", () => {
  it("are relative to the checkout when inside it, and untouched outside", () => {
    expect(recordedPath(join(repositoryRoot, ".cache", "f3", "scratch", "t46a", "a.json"))).toBe(
      join(".cache", "f3", "scratch", "t46a", "a.json")
    );
    expect(recordedPath(join(tmpdir(), "elsewhere", "a.json"))).toBe(
      join(tmpdir(), "elsewhere", "a.json")
    );
  });
});

describe("comparing two score lists", () => {
  it("reports the differences and the pairs that change side of the threshold", () => {
    const report = compareScores([1, 3.3, 3.4, -2], [1.1, 3.4, 3.2, -2], 3.3125);
    expect(report.maxAbsDelta).toBeCloseTo(0.2, 9);
    expect(report.meanAbsDelta).toBeCloseTo(0.1, 9);
    expect(report.thresholdFlips).toBe(2);
    expect(() => compareScores([1], [1, 2], 3)).toThrow("differ in length");
  });
});
