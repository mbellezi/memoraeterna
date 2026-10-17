import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aliasesOfPrompt, measureSalvageShare } from "./graph-salvage-share.ts";

const extraction = (aliases = '["c1","c2"]') =>
  `Extract knowledge graph elements only from the source excerpts below.\n` +
  `The only allowed evidence aliases in this batch are: ${aliases}. Never output any other alias.\n` +
  `Source title: Synthetic`;
const repair = (previous: string) =>
  `The previous knowledge-graph response was invalid or incomplete.\n` +
  `The only allowed evidence aliases in this batch are: ["c1","c2"]. Never output any other alias.\n` +
  `Previous invalid output:\n${previous}`;
const entity = (key: string) => ({
  key,
  type: "Concept",
  identityDescription: "A concept.",
  canonicalName: key,
  aliases: [],
  confidence: 0.9,
  evidenceChunkIds: ["c1"]
});
const relation = (subject: string, object: string) => ({
  subjectEntityKey: subject,
  predicate: "relates_to",
  displayLabel: "Relates to",
  definition: "The subject relates to the object.",
  objectEntityKey: object,
  confidence: 0.8,
  evidenceChunkIds: ["c2"]
});

let directory: string;
let counter = 0;
const addEntry = async (taskType: string, input: string, ...outputs: string[]) => {
  counter += 1;
  const key = counter.toString(16).padStart(64, "0");
  const folder = join(directory, "entries", key.slice(0, 2));
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, `${key}.json`),
    JSON.stringify({
      format: "memora-ai-cassette-entry",
      version: 1,
      key,
      taskType,
      request: { input },
      responses: outputs.map((output) => ({ output }))
    })
  );
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memora-salvage-share-"));
  counter = 0;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("aliasesOfPrompt", () => {
  it("reads the alias list the prompt allows", () => {
    expect([...aliasesOfPrompt(extraction()).keys()]).toEqual(["c1", "c2"]);
    expect(aliasesOfPrompt("no aliases here").size).toBe(0);
  });
});

describe("measureSalvageShare", () => {
  it("counts the answers the strict parse rejects and the share salvage keeps with no call", async () => {
    const clean = JSON.stringify({ entities: [entity("e1")], relations: [] });
    const badRelation = JSON.stringify({
      entities: [entity("e1"), entity("e2")],
      relations: [relation("e1", "e2"), relation("e1", "ghost"), relation("e2", "e2")]
    });
    const nothingValid = JSON.stringify({ entities: [{ key: "e1" }], relations: [] });
    await addEntry("knowledge-graph-generation", extraction(), clean);
    await addEntry("knowledge-graph-generation", `${extraction()} one`, badRelation);
    await addEntry("knowledge-graph-generation", `${extraction()} two`, '{"entities":[');
    await addEntry("knowledge-graph-generation", `${extraction()} three`, nothingValid);
    // A repair entry: its response is one more extraction answer, and it counts as a recorded repair.
    await addEntry("knowledge-graph-generation", repair(badRelation), clean);
    // Other prompts and other tasks are not extraction.
    await addEntry("knowledge-graph-generation", "Match entities only when {}", '{"matches":[]}');
    await addEntry("summarization", extraction(), "text");

    const report = await measureSalvageShare(directory);
    expect(report).toMatchObject({
      answers: 5,
      repairAnswers: 1,
      recordedRepairs: 1,
      strictFailures: 3,
      invalidJson: 1,
      salvageKept: 1,
      salvageEmpty: 1,
      keptShareOfValidJson: 0.5,
      dropped: { unknown_entity_key: 1, self_relation: 1 },
      items: { entitiesReceived: 2, entitiesKept: 2, relationsReceived: 3, relationsKept: 1 }
    });
    expect(report.keptShareOfFailures).toBeCloseTo(1 / 3);
  });

  it("reports no share when nothing was rejected", async () => {
    await addEntry(
      "knowledge-graph-generation",
      extraction(),
      JSON.stringify({ entities: [entity("e1")], relations: [] })
    );
    const report = await measureSalvageShare(directory);
    expect(report).toMatchObject({
      answers: 1,
      strictFailures: 0,
      keptShareOfValidJson: null,
      keptShareOfFailures: null
    });
  });
});

/**
 * Opt-in check on the recorded failures (git-ignored library data): salvage keeps the great majority
 * of the answers the recording-era parse rejected. Point `MEMORA_SALVAGE_CASSETTES` at cassette
 * folders (comma separated), for example the four local-writer E6 cassettes (46 failing answers by
 * the lower-bound count, 41 expected to pass with no call) and `golden-small-f2` (Codex).
 */
const recorded = (process.env.MEMORA_SALVAGE_CASSETTES ?? "")
  .split(",")
  .map((folder) => folder.trim())
  .filter((folder) => folder && existsSync(join(folder, "cassette.json")));

describe.skipIf(recorded.length === 0)("recorded extraction failures", () => {
  it("are kept by salvage with no call for at least 85% of the valid-JSON ones", async () => {
    for (const folder of recorded) {
      const report = await measureSalvageShare(folder);
      console.info(
        `salvage share ${folder}: ${JSON.stringify({ ...report, cassette: undefined })}`
      );
      expect(report.strictFailures).toBeGreaterThan(0);
      expect(report.keptShareOfValidJson).toBeGreaterThanOrEqual(0.85);
    }
  });
});
