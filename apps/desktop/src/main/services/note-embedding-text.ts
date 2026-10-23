import { createHash } from "node:crypto";

import { renderPrompt } from "./prompt-runtime.js";

/** What a note's embedding text is made of. */
export interface NoteEmbeddingFields {
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
}

/**
 * The text a note is embedded from; its hash tells whether a stored vector is still current. The
 * `note-embedding` job, matching and AUDIT's stale-embedding lint all read it from here, so they
 * agree on which vectors are current.
 */
export function atomicNoteEmbeddingText(note: NoteEmbeddingFields): string {
  return renderPrompt("embedding.content.note", {
    note_title: note.title,
    note_idea: note.ideaStatement,
    note_body: note.bodyMarkdown
  });
}

/** The content hash stored with a note's vector (`embeddings.content_hash`). */
export function atomicNoteEmbeddingHash(note: NoteEmbeddingFields): string {
  return createHash("sha256").update(atomicNoteEmbeddingText(note)).digest("hex");
}
