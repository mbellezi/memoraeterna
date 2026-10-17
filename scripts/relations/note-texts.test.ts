import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { noteText } from "../spikes/reranker/dataset.ts";
import {
  noteTextDigest,
  noteTextsFormat,
  readNoteTexts,
  renderNoteText,
  renderedNotes,
  sha256Hex,
  storedBody,
  storedBodyCharacters,
  type NoteTextsFile
} from "./note-texts.ts";

const note = (id: string, body = "Body of the note.") => ({
  id,
  title: `Title ${id}`,
  idea: `Idea ${id}`,
  body
});

const fileOf = (notes: NoteTextsFile["notes"]): NoteTextsFile => ({
  format: noteTextsFormat,
  version: 1,
  profile: "env-test",
  libraryDigest: null,
  generatedAt: "2026-10-17T12:00:00.000Z",
  notes
});

describe("the note text a pair scorer sees", () => {
  it("is Spike A's rendering: title, idea and the first 400 characters of the body", () => {
    const body = `First   line\n\nsecond\tline ${"x".repeat(600)}`;
    expect(renderNoteText(note("a", body))).toBe(
      noteText({ title: "Title a", idea: "Idea a", body })
    );
    expect(renderNoteText(note("a", body))).toMatch(
      /^Title: Title a\nIdea: Idea a\nText: First line second line x+$/u
    );
  });

  it("renders the same text from the body a texts file keeps as from the whole body", () => {
    const body = `${"word ".repeat(500)}\n\n${"é".repeat(900)}`;
    expect([...storedBody(body)].length).toBe(storedBodyCharacters);
    expect(renderNoteText(note("a", storedBody(body)))).toBe(renderNoteText(note("a", body)));
  });

  it("hashes the rendered text and refuses a note listed twice", () => {
    const rendered = renderedNotes(fileOf([note("a"), note("b", "Another body.")]));
    expect(rendered.get("a")).toEqual({
      id: "a",
      text: renderNoteText(note("a")),
      textSha256: sha256Hex(renderNoteText(note("a")))
    });
    expect(rendered.get("a")?.textSha256).not.toBe(rendered.get("b")?.textSha256);
    expect(() => renderedNotes(fileOf([note("a"), note("a")]))).toThrow("twice");
  });

  it("digests the scorer input independent of order and sensitive to any text edit", () => {
    const first = renderedNotes(fileOf([note("a"), note("b")]));
    const reordered = renderedNotes(fileOf([note("b"), note("a")]));
    const edited = renderedNotes(fileOf([note("a"), note("b", "Edited body.")]));
    const digest = noteTextDigest((id) => first.get(id), ["b", "a", "a"]);
    expect(digest).toBe(noteTextDigest((id) => reordered.get(id), ["a", "b"]));
    expect(digest).not.toBe(noteTextDigest((id) => edited.get(id), ["a", "b"]));
    expect(() => noteTextDigest((id) => first.get(id), ["a", "missing"])).toThrow(
      "No text for note missing"
    );
  });
});

describe("reading a texts file", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-note-texts-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns the rendered notes with the hash of the file's bytes", async () => {
    const path = join(directory, "texts.json");
    const content = `${JSON.stringify(fileOf([note("a"), note("b")]))}\n`;
    await writeFile(path, content);
    const read = await readNoteTexts(path);
    expect(read.sha256).toBe(sha256Hex(content));
    expect([...read.rendered.keys()]).toEqual(["a", "b"]);
  });

  it("names the exporter when the file is missing and rejects another format", async () => {
    await expect(readNoteTexts(join(directory, "missing.json"))).rejects.toThrow(
      "export-note-texts.ts"
    );
    const path = join(directory, "other.json");
    await writeFile(path, JSON.stringify({ format: "something-else", version: 1, notes: [] }));
    await expect(readNoteTexts(path)).rejects.toThrow();
  });
});
