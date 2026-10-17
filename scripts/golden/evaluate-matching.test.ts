import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runEvaluate, type EvaluateDependencies } from "./evaluate-matching.ts";
import type { HeldOutAccess } from "./freeze-guard.ts";
import { summarizeSample, type GateSample } from "./gate-f3.ts";
import { evaluateMatching } from "./matching-evaluation.ts";
import type { RelationsExport } from "./relations-export.ts";
import {
  evaluationOf,
  expectedHeldOut,
  forbiddenHeldOut,
  inputOf,
  mapping,
  notesOfPair,
  openAccess,
  sealedAccess,
  worldExport,
  type SampleSpec
} from "./test-world.ts";

const good: SampleSpec = {
  shown: 28,
  sourceLinked: 28,
  tuningSourceLinked: 26,
  sourceCalls: 20,
  sourceSeconds: 4
};

describe("evaluate-matching", () => {
  let directory = "";
  let mappingFile = "";
  const logs: string[] = [];
  const dependencies = (access: HeldOutAccess, overrides: Partial<EvaluateDependencies> = {}) =>
    ({
      readLibrary: async () => inputOf(good),
      readLibraryExport: async () => worldExport(),
      readHeldOutAccess: async () => access,
      log: (message: string) => logs.push(message),
      ...overrides
    }) satisfies EvaluateDependencies;
  const write = async (name: string, value: unknown) => {
    const file = join(directory, name);
    await writeFile(file, JSON.stringify(value));
    return file;
  };
  const sampleFile = (name: string, label: string, spec: SampleSpec = good) =>
    write(name, summarizeSample(label, evaluationOf(spec), openAccess, { database: "test" }));

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-evaluate-"));
    mappingFile = await write("mapping.json", mapping);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("prints the usage", async () => {
    const outcome = await runEvaluate(["--help"], dependencies(sealedAccess));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("--pre-freeze-feasibility");
    expect(outcome.text).toContain("--gate <f1a|f3>");
  });

  describe("--pre-freeze-feasibility", () => {
    it("prints the two held-out aggregates and nothing else, before any freeze", async () => {
      logs.length = 0;
      const data = worldExport();
      const [reachable, , ...rest] = expectedHeldOut();
      const reach = (pair: string, rank: number) => {
        const [source, target] = notesOfPair(pair);
        return {
          sourceNoteId: source,
          targetNoteId: target,
          finalRank: rank,
          textRank: null,
          vectorRank: rank,
          graphRank: null,
          textScore: null,
          vectorScore: null,
          metadataScore: null,
          graphScore: null,
          fusionScore: null,
          rerankScore: null,
          finalScore: null,
          passedThreshold: null
        };
      };
      data.candidates = [
        reach(reachable!, 1),
        ...rest.map((pair, index) => reach(pair, (index % 20) + 1))
      ];
      const relations = await write("relations.json", data);
      const scores = await write("scores.json", {
        format: "memora-relations-pair-scores",
        version: 1,
        scale: "log-odds",
        scores: [
          ...[reachable!, ...rest].flatMap((pair) => {
            const [a, b] = notesOfPair(pair);
            return [
              { query: a, doc: b, logOdds: 5 },
              { query: b, doc: a, logOdds: 1 }
            ];
          }),
          ...(() => {
            const [a, b] = notesOfPair(forbiddenHeldOut()[0]!);
            return [
              { query: a, doc: b, logOdds: 9 },
              { query: b, doc: a, logOdds: 9 }
            ];
          })()
        ]
      });
      const outcome = await runEvaluate(
        [
          "--pre-freeze-feasibility",
          "--relations",
          relations,
          "--scores",
          scores,
          "--mapping",
          mappingFile,
          "--label",
          "MLX"
        ],
        dependencies(sealedAccess)
      );
      expect(outcome.exitCode).toBe(0);
      // The forbidden pair was never offered by retrieval, so the ranker cannot link it.
      expect(outcome.text).toBe(
        [
          "held-out expected root pairs reachable at k=20: 27 of 28",
          "MLX at max of both directions >= 3.3125 log-odds: held-out expected 27 of 28, forbidden 0 of 35"
        ].join("\n")
      );
      expect(logs).toEqual([]);
    });

    it("refuses to be combined with anything that could print more", async () => {
      await expect(
        runEvaluate(
          ["--pre-freeze-feasibility", "--relations", "r", "--scores", "s", "--json", "x.json"],
          dependencies(sealedAccess)
        )
      ).rejects.toThrow("prints two aggregates and nothing else");
    });
  });

  describe("--gate f3", () => {
    it("aggregates stored samples; sealed before the freeze, with no held-out number anywhere", async () => {
      logs.length = 0;
      const files = [
        await sampleFile("s0.json", "S0"),
        await sampleFile("s1.json", "S1"),
        await sampleFile("s2.json", "S2"),
        await sampleFile("b1.json", "B1")
      ];
      const json = join(directory, "gate-sealed.json");
      const outcome = await runEvaluate(
        [
          "--gate", "f3",
          ...files.flatMap((file, index) => ["--sample", `${["S0", "S1", "S2", "B1"][index]}=${file}`]),
          "--live-judge", "S0,S1",
          "--check",
          "--json", json
        ], // prettier-ignore
        dependencies(sealedAccess)
      );
      expect(outcome.exitCode).toBe(2);
      expect(outcome.text).toContain("S0 sealed, S1 sealed, S2 sealed, B1 sealed");
      expect(outcome.text).toContain("held-out sealed until the freeze (decision D3)");
      expect(logs.join(" ")).toContain("held-out sealed until the freeze");
      const stored = JSON.parse(await readFile(json, "utf8"));
      expect(stored.samples.every((sample: GateSample) => sample.partitions.holdout === null)).toBe(
        true
      );
      expect(stored.series.heldOutShownExpected.mean).toBeNull();
      expect(stored.pass).toBeNull();
    });

    it("reads the held-out result and gates it once the freeze record is open", async () => {
      const files = [
        await sampleFile("o0.json", "S0"),
        await sampleFile("o1.json", "S1"),
        await sampleFile("o2.json", "S2", { ...good, sourceReplayed: 20 }),
        await sampleFile("o3.json", "B1", { ...good, shown: 27 })
      ];
      const outcome = await runEvaluate(
        [
          "--gate", "f3",
          ...files.flatMap((file, index) => ["--sample", `${["S0", "S1", "S2", "B1"][index]}=${file}`]),
          "--live-judge", "S0,S1",
          "--check"
        ], // prettier-ignore
        dependencies(openAccess)
      );
      expect(outcome.text).toContain("S0 28, S1 28, S2 28, B1 27");
      expect(outcome.text).toContain("mean 27.8, min 27");
      expect(outcome.text).toContain("| All | | | | pass |");
      expect(outcome.exitCode).toBe(0);
    });

    it("scores a library when a sample names a connection, and seals it without the freeze record", async () => {
      logs.length = 0;
      const outcome = await runEvaluate(
        [
          "--gate",
          "f3",
          "--sample",
          "S0=postgres://u:p@127.0.0.1:1/db",
          "--min-samples",
          "1",
          "--mapping",
          mappingFile
        ],
        dependencies(sealedAccess)
      );
      expect(logs).toContain("[evaluate-matching] reading 127.0.0.1:1/db");
      expect(outcome.text).toContain("S0 sealed");
      expect(outcome.text).not.toContain("S0 28");
      // The connection string never reaches the report.
      expect(outcome.text).not.toContain("u:p@");
    });

    it("takes a stored evaluation as a sample and labels it", async () => {
      const stored = await write("evaluation.json", {
        ...evaluationOf(good),
        context: {
          label: "from file",
          database: "127.0.0.1:2/db",
          generatedAt: "2026-10-30T12:00:00Z"
        }
      });
      const outcome = await runEvaluate(
        ["--gate", "f3", "--sample", `X0=${stored}`, "--min-samples", "1"],
        dependencies(openAccess)
      );
      expect(outcome.text).toContain("X0 28");
      const sealed = await runEvaluate(
        ["--gate", "f3", "--sample", stored, "--min-samples", "1"],
        dependencies(sealedAccess)
      );
      expect(sealed.text).toContain("from file sealed");
    });

    it("refuses a stored evaluation from before the gate, which has no applied-only layer", async () => {
      const evaluation = evaluationOf(good);
      const old = structuredClone(evaluation) as unknown as {
        partitions: Record<string, { layers: Record<string, unknown> }>;
      };
      delete old.partitions.tuning!.layers.notesApplied;
      const file = await write("pre-gate-evaluation.json", old);
      await expect(
        runEvaluate(["--gate", "f3", "--sample", file], dependencies(openAccess))
      ).rejects.toThrow("from before the F3 gate");
    });

    it("reads a stored gate report as its samples and refuses duplicates and unknown names", async () => {
      const first = await sampleFile("d0.json", "S0");
      const second = await sampleFile("d1.json", "S1");
      const report = join(directory, "report.json");
      await runEvaluate(
        [
          "--gate",
          "f3",
          "--sample",
          `S0=${first}`,
          "--sample",
          `S1=${second}`,
          "--json",
          report,
          "--min-samples",
          "2"
        ],
        dependencies(openAccess)
      );
      const both = await runEvaluate(
        ["--gate", "f3", "--sample", report, "--min-samples", "2"],
        dependencies(openAccess)
      );
      expect(both.text).toContain("S0 28, S1 28");
      await expect(
        runEvaluate(
          ["--gate", "f3", "--sample", `A=${first}`, "--sample", `A=${second}`],
          dependencies(openAccess)
        )
      ).rejects.toThrow('Two samples are labelled "A"');
      await expect(
        runEvaluate(
          ["--gate", "f3", "--sample", `S0=${first}`, "--live-judge", "S9"],
          dependencies(openAccess)
        )
      ).rejects.toThrow("not loaded: S9");
      await expect(
        runEvaluate(
          ["--gate", "f3", "--sample", join(directory, "missing.json")],
          dependencies(openAccess)
        )
      ).rejects.toThrow("Cannot read the sample");
      const other = await write("other.json", { hello: "world" });
      await expect(
        runEvaluate(["--gate", "f3", "--sample", other], dependencies(openAccess))
      ).rejects.toThrow("neither a connection nor a stored sample");
    });
  });

  describe("the F1a report (no --gate)", () => {
    it("seals the held-out partition without the freeze record, in the report and the JSON", async () => {
      logs.length = 0;
      const json = join(directory, "legacy.json");
      const out = join(directory, "legacy.md");
      const outcome = await runEvaluate(
        [
          "--db",
          "postgres://u:p@127.0.0.1:1/db",
          "--mapping",
          mappingFile,
          "--json",
          json,
          "--out",
          out,
          "--check"
        ],
        dependencies(sealedAccess)
      );
      expect(outcome).toEqual({ text: null, exitCode: 2 });
      const markdown = await readFile(out, "utf8");
      expect(markdown).toContain("Result sealed until the freeze (decision D3).");
      const stored = await readFile(json, "utf8");
      expect(JSON.parse(stored).partitions.holdout.sealed).toBe(true);
      for (const pair of expectedHeldOut()) expect(stored).not.toContain(`"${pair}"`);
      expect(stored).not.toContain("u:p@");
    });

    it("prints the held-out result when the freeze record is open", async () => {
      const outcome = await runEvaluate(
        ["--db", "postgres://u:p@127.0.0.1:1/db", "--mapping", mappingFile],
        dependencies(openAccess, { readLibrary: async () => inputOf({ shown: 27 }) })
      );
      expect(outcome.text).toContain("| Expected root pairs linked | 27/28 |");
      expect(outcome.text).toContain("Note relations: expected not linked: ");
    });

    it("reports errors without echoing a connection string", async () => {
      await expect(
        runEvaluate(
          ["--db", "postgres://u:p@db.example.com/x", "--mapping", mappingFile],
          dependencies(openAccess)
        )
      ).rejects.toThrow("Only a loopback PostgreSQL");
    });
  });

  describe("--export-relations", () => {
    it("writes the offline export of a library and says what it holds", async () => {
      logs.length = 0;
      const out = join(directory, "export.json");
      const data: RelationsExport = {
        ...worldExport(),
        context: { label: "x", database: "d", generatedAt: null }
      };
      const outcome = await runEvaluate(
        ["--db", "postgres://u:p@127.0.0.1:1/db", "--export-relations", out],
        dependencies(sealedAccess, { readLibraryExport: async () => data })
      );
      expect(outcome).toEqual({ text: null, exitCode: 0 });
      expect(JSON.parse(await readFile(out, "utf8")).format).toBe("memora-relations-export");
      expect(logs.at(-1)).toContain("0 candidates, 0 decisions, 0 relations");
    });
  });

  it("scores the same library the same way as the pure evaluator", () => {
    expect(evaluateMatching(inputOf(good)).partitions.holdout.layers.notes.expected.hit).toBe(28);
  });
});
