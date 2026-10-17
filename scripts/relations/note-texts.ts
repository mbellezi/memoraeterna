/**
 * The note text a pair scorer sees (F3 T46a). Exports of the matching candidate lists hold ids only,
 * so the text of the notes to score travels in its own file (`memora-relations-note-texts`), read from
 * a scratch clone of a measurement profile by `export-note-texts.ts` and hashed here. The rendering is
 * Spike A's (`scripts/spikes/reranker/dataset.ts`): title, idea statement and the first 400 characters
 * of the body, one labelled line each, so the frozen rule of Spike A (max of both directions at 3.3125
 * log-odds for MLX, 3.16 for GGUF) applies to the scores unchanged.
 *
 * Fixture and golden-small text is synthetic or public, and ENV-C text is public (decision D4); the
 * files still stay under `.cache` and are never committed.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { bodyCharacters as spikeBodyCharacters } from "../spikes/reranker/dataset.ts";

export const noteTextsFormat = "memora-relations-note-texts";

/** Identity of the rendering, recorded in every score file. */
export const textTemplateId = "spike-a-note-text-v1";

/** Body characters kept in a texts file: enough for the 400- and 600-character templates of D13. */
export const storedBodyCharacters = 1_200;

const storedNoteSchema = z
  .object({ id: z.string().min(1), title: z.string(), idea: z.string(), body: z.string() })
  .strict();

export const noteTextsSchema = z
  .object({
    format: z.literal(noteTextsFormat),
    version: z.literal(1),
    profile: z.string().min(1),
    /** The golden runner's notes digest of the whole library the texts were read from. */
    libraryDigest: z.string().nullable(),
    generatedAt: z.string(),
    notes: z.array(storedNoteSchema)
  })
  .strict();
export type NoteTextsFile = z.infer<typeof noteTextsSchema>;
export type StoredNote = z.infer<typeof storedNoteSchema>;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The body as the rendering sees it: whitespace collapsed, cut to the characters the file keeps. */
export function storedBody(body: string): string {
  return [...body.replace(/\s+/gu, " ").trim()].slice(0, storedBodyCharacters).join("");
}

/** Body characters of the bake-off's two templates (D13): the product picks one. */
export const templateBodyCharacters = [400, 600] as const;
export type TemplateBodyCharacters = (typeof templateBodyCharacters)[number];

/**
 * Title, idea and the first `bodyCharacters` characters of the body, one labelled line each. With
 * Spike A's 400 this is exactly `noteText` of the spike dataset (the product's `relation-pair-text-v1`);
 * 600 is the other template of the bake-off.
 */
export function renderNoteText(
  note: Pick<StoredNote, "title" | "idea" | "body">,
  bodyCharacters: number = spikeBodyCharacters
): string {
  const body = [...note.body.replace(/\s+/gu, " ").trim()].slice(0, bodyCharacters).join("");
  return `Title: ${note.title}\nIdea: ${note.idea}\nText: ${body}`;
}

export interface RenderedNote {
  id: string;
  /** The exact text the decider sees for this note. */
  text: string;
  /** SHA-256 of `text` (decision D13's rendered-input hash). */
  textSha256: string;
}

export type TextLookup = (noteId: string) => RenderedNote | undefined;

/** Renders every note of a texts file once; refuses a duplicated id. */
export function renderedNotes(
  file: NoteTextsFile,
  bodyCharacters: number = spikeBodyCharacters
): Map<string, RenderedNote> {
  const rendered = new Map<string, RenderedNote>();
  for (const note of file.notes) {
    if (rendered.has(note.id)) throw new Error(`The note texts hold note ${note.id} twice.`);
    const text = renderNoteText(note, bodyCharacters);
    rendered.set(note.id, { id: note.id, text, textSha256: sha256Hex(text) });
  }
  return rendered;
}

/** One hash over the rendered text of the given notes: equal digests mean equal scorer input. */
export function noteTextDigest(lookup: TextLookup, noteIds: Iterable<string>): string {
  const lines = [...new Set(noteIds)].sort().map((id) => {
    const note = lookup(id);
    if (!note) throw new Error(`No text for note ${id}.`);
    return `${id}\t${note.textSha256}`;
  });
  return sha256Hex(lines.join("\n"));
}

export interface ReadNoteTexts {
  file: NoteTextsFile;
  /** SHA-256 of the file's bytes. */
  sha256: string;
  rendered: Map<string, RenderedNote>;
}

export async function readNoteTexts(
  path: string,
  bodyCharacters: number = spikeBodyCharacters
): Promise<ReadNoteTexts> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`Cannot read the note texts "${path}". Export them with export-note-texts.ts.`);
  }
  const file = noteTextsSchema.parse(JSON.parse(bytes.toString("utf8")));
  return { file, sha256: sha256Hex(bytes), rendered: renderedNotes(file, bodyCharacters) };
}
