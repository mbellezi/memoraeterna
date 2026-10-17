import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { noteText } from "../spikes/reranker/dataset.ts";
import {
  buildBakeoffInputs,
  membershipOf,
  pairKeyOf,
  readSpikeNotes,
  setNames,
  type BakeoffSources,
  type LabelItem
} from "./bakeoff-sets.ts";
import { noteTextsSchema, renderNoteText, storedBody, type StoredNote } from "./note-texts.ts";

const note = (id: string, body = `Body of ${id}.`): StoredNote => ({
  id,
  title: `Title ${id}`,
  idea: `Idea ${id}`,
  body
});

const item = (
  lo: string,
  hi: string,
  sets: string[],
  library: string,
  overrides: Partial<LabelItem> = {}
): LabelItem => ({
  pairId: `note:${library}:${lo}${hi}`,
  kind: "note",
  library,
  lo,
  hi,
  sets,
  pool: "A",
  stratum: 1,
  split: "fit",
  related: true,
  ...overrides
});

function sources(items: LabelItem[], rv9Pairs: Array<[string, string]>): BakeoffSources {
  return {
    labels: {
      format: "memora-f3-relation-labels",
      version: 1,
      labelSetSha256: "0".repeat(64),
      items
    },
    labelsSha256: "1".repeat(64),
    rv9Pairs,
    rv9Sha256: "2".repeat(64),
    notes: {
      fixture: new Map(["f1", "f2", "f3", "f4"].map((id) => [id, note(id)])),
      golden: new Map(["g1", "g2"].map((id) => [id, note(id)])),
      corpus: new Map(),
      "spike-a": new Map(["s1", "s2"].map((id) => [id, note(id)]))
    },
    hashes: { labels: "1".repeat(64) }
  };
}

describe("the bake-off sets", () => {
  it("joins the label pairs and R_v9 into one sorted pair list with the sets of each pair", () => {
    const inputs = buildBakeoffInputs(
      sources(
        [
          item("f2", "f1", ["pool-A", "rv9-sample"], "fixture"),
          item("g1", "g2", ["pool-B"], "golden", { pool: "B" }),
          item("s1", "s2", ["rv6"], "spike-a", { pool: null }),
          // A source pair is no note pair and takes no part in the scoring.
          { ...item("f3", "f4", ["source-base"], "fixture"), kind: "source" }
        ],
        [
          ["f1", "f2"],
          ["f3", "f4"]
        ]
      ),
      "2026-10-17T12:00:00.000Z"
    );
    expect(inputs.pairsFile.pairs).toEqual([
      ["f1", "f2"],
      ["f3", "f4"],
      ["g1", "g2"],
      ["s1", "s2"]
    ]);
    expect(inputs.pairsFile).toMatchObject({
      profile: "f3-bakeoff-labels",
      unorderedPairs: 4,
      directedPairs: 8
    });
    expect(membershipOf(inputs.pairsFile, "f2", "f1")).toEqual(["pool-A", "rv9", "rv9-sample"]);
    expect(membershipOf(inputs.pairsFile, "f4", "f3")).toEqual(["rv9"]);
    expect(membershipOf(inputs.pairsFile, "s2", "s1")).toEqual(["rv6"]);
    expect(membershipOf(inputs.pairsFile, "x", "y")).toEqual([]);
    expect(inputs.counts).toMatchObject({ notes: 8, "pool-A": 1, "pool-B": 1, rv6: 1, rv9: 2 });
    expect(Object.keys(inputs.counts)).toEqual(
      expect.arrayContaining([...setNames, "notes", "unorderedPairs", "directedPairs"])
    );
  });

  it("writes a note-texts file the T46a harness reads, with the notes of the pairs only", () => {
    const inputs = buildBakeoffInputs(
      sources([item("f1", "f2", ["pool-A"], "fixture")], []),
      "2026-10-17T12:00:00.000Z"
    );
    expect(noteTextsSchema.parse(inputs.textsFile).notes.map((n) => n.id)).toEqual(["f1", "f2"]);
  });

  it("refuses a note without text and a note claimed by two libraries", () => {
    expect(() =>
      buildBakeoffInputs(sources([item("f1", "nope", ["pool-A"], "fixture")], []), "t")
    ).toThrow("No text for note nope");
    expect(() =>
      buildBakeoffInputs(
        sources(
          [item("f1", "f2", ["pool-A"], "fixture"), item("f1", "g1", ["pool-B"], "golden")],
          []
        ),
        "t"
      )
    ).toThrow("belongs to the libraries fixture and golden");
    expect(() =>
      buildBakeoffInputs(sources([item("f1", "f2", ["pool-A"], "elsewhere")], []), "t")
    ).toThrow('unknown library "elsewhere"');
  });

  it("keys a pair by its ordered ids", () => {
    expect(pairKeyOf("b", "a")).toBe("a|b");
    expect(pairKeyOf("a", "b")).toBe("a|b");
  });
});

describe("the Spike A notes", () => {
  let directory = "";
  const body = `${"The water finds another way around the barrier. ".repeat(20)}A last sentence.`;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-bakeoff-sets-"));
    const text = noteText({ title: "T", idea: "I", body });
    await writeFile(
      join(directory, "dataset.json"),
      JSON.stringify({ notes: [{ id: "n1", title: "T", idea: "I", text }] })
    );
    for (const phase of ["baseline", "economy", "coverage", "validate"]) {
      await mkdir(join(directory, phase), { recursive: true });
      await writeFile(
        join(directory, phase, "results.json"),
        JSON.stringify({
          notes:
            phase === "economy"
              ? [{ id: "n1", title: "T", idea_statement: "I", body_markdown: body }]
              : []
        })
      );
    }
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("recovers the whole body, which renders the text Spike A scored at 400 and a longer one at 600", async () => {
    const { notes } = await readSpikeNotes(join(directory, "dataset.json"), directory);
    const stored = notes.get("n1")!;
    expect(stored.body).toBe(storedBody(body));
    expect(renderNoteText(stored, 400)).toBe(noteText({ title: "T", idea: "I", body }));
    expect(renderNoteText(stored, 600).length).toBeGreaterThan(renderNoteText(stored, 400).length);
    expect(renderNoteText(stored, 600)).toBe(
      `Title: T\nIdea: I\nText: ${[...body.replace(/\s+/gu, " ").trim()].slice(0, 600).join("")}`
    );
  });

  it("refuses a body that does not render the dataset's text", async () => {
    await writeFile(
      join(directory, "dataset.json"),
      JSON.stringify({
        notes: [{ id: "n1", title: "T", idea: "I", text: "Title: T\nIdea: I\nText: other" }]
      })
    );
    await expect(readSpikeNotes(join(directory, "dataset.json"), directory)).rejects.toThrow(
      "does not render the dataset's text"
    );
  });
});
