import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { costUsd, type RawRecord } from "../spikes/decisions/budget.ts";
import { maxCandidatesPerRequest } from "../spikes/decisions/design.ts";
import type { LabelFixture, LabelItem } from "./bakeoff-sets.ts";
import {
  buildDecisionSets,
  buildJobs,
  runIdOf,
  scanForSecrets,
  scoresFromRecords,
  shuffleSalts,
  usageOf,
  type DecisionSets
} from "./bakeoff-decisions.ts";
import type { StoredNote } from "./note-texts.ts";

const note = (id: string): StoredNote => ({
  id,
  title: `Title ${id}`,
  idea: `Idea ${id}`,
  body: `Body of note ${id}.`
});

const item = (lo: string, hi: string, sets: string[], library: string): LabelItem => ({
  pairId: `note:${library}:${lo}${hi}`,
  kind: "note",
  library,
  lo,
  hi,
  sets,
  pool: sets.includes("pool-A") ? "A" : null,
  stratum: 1,
  split: "fit",
  related: true
});

const labelsOf = (items: LabelItem[]): LabelFixture => ({
  format: "memora-f3-relation-labels",
  version: 1,
  labelSetSha256: "0".repeat(64),
  items
});

const fixtureIds = Array.from({ length: 30 }, (_, index) => `f${String(index).padStart(2, "0")}`);
const fixtureNotes = new Map(fixtureIds.map((id) => [id, note(id)]));
const spikeNotes = new Map(["s1", "s2"].map((id) => [id, note(id)]));

function sets(): DecisionSets {
  // f00 is a candidate of every other fixture note: 29 neighbours, two requests of at most 20.
  return buildDecisionSets({
    labels: labelsOf([
      item("f00", "f01", ["pool-A"], "fixture"),
      item("s1", "s2", ["rv6"], "spike-a"),
      // A pool-B pair and a source pair are none of the Decisions sets.
      item("f02", "f03", ["pool-B"], "golden"),
      { ...item("f04", "f05", ["source-base"], "fixture"), kind: "source" }
    ]),
    fixtureLists: fixtureIds.slice(1).map((id) => ["f00", id] as const),
    fixtureNotes,
    spikeNotes
  });
}

describe("the Decisions sets", () => {
  it("hold the fixture candidate lists, pool A and R_v6, both directions, each pair once", () => {
    const built = sets();
    expect(built.pairs).toHaveLength(30);
    expect(built.pairs.find((p) => p.lo === "f00" && p.hi === "f01")?.sets).toEqual([
      "fixture-lists",
      "pool-A"
    ]);
    expect(built.pairs.find((p) => p.lo === "s1")?.sets).toEqual(["rv6"]);
    expect(built.byQuery.get("f00")).toHaveLength(29);
    expect(built.byQuery.get("f07")).toEqual(["f00"]);
    expect(built.byQuery.get("s2")).toEqual(["s1"]);
    expect([...built.byQuery.keys()]).toEqual([...built.byQuery.keys()].sort());
    expect(built.texts.get("f00")).toBe(
      "Title: Title f00\nIdea: Idea f00\nText: Body of note f00."
    );
  });

  it("refuse a golden or corpus pair in the sets, and a note with no text", () => {
    expect(() =>
      buildDecisionSets({
        labels: labelsOf([item("g1", "g2", ["pool-A"], "golden")]),
        fixtureLists: [],
        fixtureNotes,
        spikeNotes
      })
    ).toThrow("only reads synthetic text");
    expect(() =>
      buildDecisionSets({
        labels: labelsOf([]),
        fixtureLists: [["f00", "unknown"]],
        fixtureNotes,
        spikeNotes
      })
    ).toThrow("neither a fixture nor a Spike A note");
  });
});

describe("the Decisions requests", () => {
  const instruction = "Decide whether the notes are related.";

  it("send one request per query note and chunk of at most 20 candidates", () => {
    const jobs = buildJobs(sets(), instruction, shuffleSalts[0]);
    const f00 = jobs.filter((job) => (job.meta as { queryId: string }).queryId === "f00");
    expect(f00).toHaveLength(2);
    expect(f00.every((job) => job.request.questions.length <= maxCandidatesPerRequest)).toBe(true);
    expect(
      f00.flatMap((job) => (job.meta as { candidateIds: string[] }).candidateIds).sort()
    ).toEqual(fixtureIds.slice(1));
    // 30 fixture notes and 2 Spike A notes as queries: 2 requests for f00, 1 for each other.
    expect(jobs).toHaveLength(2 + 29 + 2);
    expect(new Set(jobs.map((job) => job.key)).size).toBe(jobs.length);
  });

  it("are a function of the content and the shuffle, and never carry a note id", () => {
    const first = buildJobs(sets(), instruction, shuffleSalts[0]);
    expect(buildJobs(sets(), instruction, shuffleSalts[0])).toEqual(first);
    const second = buildJobs(sets(), instruction, shuffleSalts[1]);
    const order = (jobs: typeof first) =>
      jobs.find((job) => (job.meta as { queryId: string }).queryId === "f00")!.meta;
    expect((order(first) as { candidateIds: string[] }).candidateIds).not.toEqual(
      (order(second) as { candidateIds: string[] }).candidateIds
    );
    // The query and candidate ids are not in what the provider sees (the note ids are `f00`...; titles say `Title f00`).
    for (const job of first) {
      const body = JSON.stringify(job.request).replace(/Title f\d\d|Idea f\d\d|note f\d\d/gu, "");
      expect(body).not.toMatch(/\bf\d\d\b/u);
    }
    expect(runIdOf(shuffleSalts[1])).toBe("bakeoff-decisions__predicate__bakeoff-2");
  });
});

const record = (
  key: string,
  queryId: string,
  candidateIds: string[],
  probabilities: Array<number | null>,
  overrides: Partial<RawRecord> = {}
): RawRecord => ({
  runId: "run",
  key,
  kind: "bakeoff/predicate",
  meta: { queryId, candidateIds },
  at: "2026-10-17T12:00:00.000Z",
  questions: candidateIds.length,
  bodyChars: 1000,
  ok: true,
  usage: { inputTokens: 1_000, cachedTokens: 100, outputTokens: 20, reasoningTokens: 5 },
  answers: probabilities.map((probability, index) =>
    probability === null
      ? { type: "refusal", name: `rel_c${index + 1}` }
      : { type: "predicate", name: `rel_c${index + 1}`, probability }
  ),
  ...overrides
});

describe("the Decisions scores", () => {
  const small = buildDecisionSets({
    labels: labelsOf([]),
    fixtureLists: [
      ["f00", "f01"],
      ["f00", "f02"]
    ],
    fixtureNotes,
    spikeNotes
  });

  it("average the shuffles' probabilities per directed pair and give them as log-odds", () => {
    const result = scoresFromRecords(small, [
      [
        record("k1", "f00", ["f02", "f01"], [0.9, 0.5]),
        record("k2", "f01", ["f00"], [0.2]),
        record("k3", "f02", ["f00"], [0.7])
      ],
      [record("k1", "f00", ["f01", "f02"], [0.7, 0.3]), record("k2", "f01", ["f00"], [0.4])]
    ]);
    const byPair = new Map(result.scores.map((score) => [`${score.query}|${score.doc}`, score]));
    expect(byPair.get("f00|f01")!.shuffles).toEqual([0.5, 0.7]);
    expect(byPair.get("f00|f01")!.probability).toBeCloseTo(0.6, 12);
    expect(byPair.get("f00|f01")!.logOdds).toBeCloseTo(Math.log(0.6 / 0.4), 9);
    expect(byPair.get("f00|f02")!.shuffles).toEqual([0.9, 0.3]);
    // A pair scored by one shuffle keeps that probability.
    expect(byPair.get("f02|f00")!.shuffles).toEqual([0.7]);
    expect(result.missing).toEqual([]);
  });

  it("leaves a refused or failed pair out and counts it", () => {
    const result = scoresFromRecords(small, [
      [
        record("k1", "f00", ["f01", "f02"], [null, 0.8]),
        record("k2", "f01", ["f00"], [0.4], { ok: false }),
        record("k3", "f02", ["f00"], [0.7])
      ]
    ]);
    expect(result.refusals).toBe(1);
    expect(result.missing).toEqual([
      { query: "f00", doc: "f01" },
      { query: "f01", doc: "f00" }
    ]);
    expect(result.scores).toHaveLength(2);
  });

  it("sum the tokens and price them at the input rate", () => {
    const unbilled = record("k2", "f01", ["f00"], [0.5]);
    delete unbilled.usage;
    const usage = usageOf([record("k1", "f00", ["f01"], [0.5]), { ...unbilled, ok: false }]);
    expect(usage).toMatchObject({
      requests: 2,
      failedRequests: 1,
      inputTokens: 1_000,
      cachedTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5
    });
    expect(usage.usd).toBe(costUsd(1_000));
  });
});

describe("the scan for the key", () => {
  let directory = "";
  // Built at run time so no key-shaped literal sits in the source.
  const secret = ["sk", "test", "0123456789abcdefghij"].join("-");
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-bakeoff-scan-"));
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "clean.log"), "sent 515 requests, run spend US$ 0.2500\n");
    await writeFile(join(directory, "nested", "leak.log"), `Authorization: ${secret}\n`);
    await writeFile(
      join(directory, "bearer.log"),
      `Authorization: ${["Bearer", "abcdefghijklmnop"].join(" ")}\n`
    );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("names the files that hold the key or a key-shaped string, and only counts the rest", async () => {
    const report = await scanForSecrets([directory], [secret]);
    expect(report.files).toBe(3);
    expect(report.keyHits).toEqual([join(directory, "nested", "leak.log")]);
    expect(report.keyShapedHits.sort()).toEqual([
      join(directory, "bearer.log"),
      join(directory, "nested", "leak.log")
    ]);
    expect((await scanForSecrets([join(directory, "clean.log")], [secret])).keyHits).toEqual([]);
  });
});
