import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { capBoundSources, readCassetteEntries, type CassetteEntry } from "./cap-bound-sources.ts";

/** A recorded graph prompt as the catalog renders it (both generations of the caps sentence). */
function prompt(
  title: string,
  options: {
    caps?: [number, number];
    heading?: string;
    repair?: boolean;
    claims?: boolean;
    language?: string;
  } = {}
): string {
  const [entities, relations] = options.caps ?? [12, 12];
  const caps = options.claims
    ? `at most ${entities} entities, 8 claims, and ${relations} relations`
    : `at most ${entities} entities and ${relations} relations`;
  return [
    "Produce all natural-language response text in English.",
    options.repair
      ? "The previous knowledge-graph response was invalid or incomplete."
      : "Extract knowledge graph elements only from the source excerpts below.",
    `This batch may return ${caps}. These are hard limits; never exceed them.`,
    `Source title: ${title}`,
    `Source language: ${options.language ?? "English"}`,
    `${options.heading ?? "Source excerpts"}:`,
    "[s1; evidence=c1]",
    "Title: Excerpt",
    ...(options.repair ? ["", "Previous invalid output:", "{"] : [])
  ].join("\n");
}

function answer(entities: number, relations: number): string {
  return JSON.stringify({
    entities: Array.from({ length: entities }, (_, index) => ({ key: `e${index + 1}` })),
    relations: Array.from({ length: relations }, () => ({ subjectEntityKey: "e1" }))
  });
}

function entry(
  input: string,
  output: unknown,
  taskType = "knowledge-graph-generation"
): CassetteEntry {
  return { taskType, request: { input }, responses: [{ output }] };
}

describe("cap-bound sources from recorded traces (F5 D23)", () => {
  it("counts a source whose answers reached the entity or relation budget", () => {
    const entries = [
      // 260 entities over three batches: the budget of 250 cut the last batch.
      entry(prompt("Long book"), answer(100, 10)),
      entry(prompt("Long book"), answer(100, 10)),
      entry(prompt("Long book"), answer(60, 10)),
      // 500 relations reach the relation budget.
      entry(prompt("Dense paper"), answer(10, 300)),
      entry(prompt("Dense paper"), answer(10, 200)),
      entry(prompt("Short story"), answer(12, 12)),
      entry(prompt("Short story"), answer(12, 12))
    ];
    const report = capBoundSources(entries);
    expect(report).toMatchObject({
      graphCalls: 7,
      sources: 3,
      capBound: 2,
      loweredPrompts: 0,
      maxEntities: 260,
      maxRelations: 500
    });
    expect(report.capBoundSources.map((source) => source.entities)).toEqual([260, 20]);
    expect(JSON.stringify(report), "titles are never printed").not.toContain("Long book");
  });

  it("counts a source one of whose prompts states lowered caps", () => {
    const report = capBoundSources([
      entry(prompt("Cut source", { claims: true }), answer(3, 3)),
      entry(prompt("Cut source", { caps: [5, 12], claims: true }), answer(5, 5)),
      entry(prompt("Whole source", { caps: [24, 24] }), answer(3, 3))
    ]);
    expect(report).toMatchObject({ sources: 2, capBound: 1, loweredPrompts: 1 });
    expect(report.capBoundSources[0]).toMatchObject({ calls: 2, loweredPrompts: 1 });
  });

  it("reads only the source graph's first attempts", () => {
    const report = capBoundSources([
      entry(prompt("Book", { repair: true, caps: [8, 8] }), answer(300, 0)),
      entry(prompt("Book", { heading: "Atomic notes" }), answer(300, 0)),
      entry(prompt("Book", { heading: "Source catalog metadata" }), answer(4, 4)),
      entry("Resolve these entity identities.", answer(300, 0)),
      entry(prompt("Book"), [0.1, 0.2], "embedding"),
      entry(prompt("Book"), "not json")
    ]);
    expect(report).toMatchObject({ graphCalls: 2, sources: 1, capBound: 0, maxEntities: 4 });
  });

  it("keeps two sources with one title apart by language", () => {
    const report = capBoundSources([
      entry(prompt("Memória", { language: "Portuguese" }), answer(200, 0)),
      entry(prompt("Memória", { language: "English" }), answer(200, 0))
    ]);
    expect(report).toMatchObject({ sources: 2, capBound: 0 });
  });

  describe("a cassette folder", () => {
    let folder = "";
    afterEach(async () => {
      if (folder) await rm(folder, { recursive: true, force: true });
    });

    it("reads every entry under entries/ and skips unreadable files", async () => {
      folder = await mkdtemp(join(tmpdir(), "cap-bound-"));
      await mkdir(join(folder, "entries", "ab"), { recursive: true });
      await mkdir(join(folder, "entries", "cd"), { recursive: true });
      const write = (name: string, value: unknown) =>
        writeFile(join(folder, "entries", name), JSON.stringify(value));
      await write("ab/one.json", {
        format: "memora-ai-cassette-entry",
        version: 1,
        key: "one",
        taskType: "knowledge-graph-generation",
        request: { input: prompt("Book") },
        responses: [{ output: answer(251, 0) }, { output: answer(1, 0) }]
      });
      await write("cd/two.json", { taskType: "embedding" });
      await writeFile(join(folder, "entries", "cd", "broken.json"), "{");
      const entries = await readCassetteEntries(folder);
      expect(entries).toHaveLength(1);
      expect(capBoundSources(entries)).toMatchObject({ capBound: 1, maxEntities: 251 });
    });
  });
});
