import { z } from "zod";

import type { JsonObject } from "@app/db";

import { StoredDecidedNoteSchema, type StoredDecidedNote } from "./relations/relation-link.js";

/**
 * Per-note progress of the atomicNoteMatching stage, kept in the stage checkpoint metadata: the
 * notes decided so far and the accepted pairs each one handed on, which the link job persists
 * (F3 D21, D24). A restart resumes after the last decided note with its pairs intact.
 */
export interface AtomicNoteMatchingCheckpoint {
  completedNoteIds: string[];
  persistedCount: number;
  /** The decided notes that accepted at least one pair, in decide order. */
  decided: StoredDecidedNote[];
}

const stageCheckpointSchema = z.object({
  metadata: z.object({
    completedNoteIds: z.array(z.string().min(1)).max(100_000),
    persistedCount: z.number().int().nonnegative(),
    decided: z.array(StoredDecidedNoteSchema).max(100_000).default([])
  })
});

/** The checkpoint of a stage; one that does not parse starts over (decisions are cached). */
export function readAtomicNoteMatchingCheckpoint(stage: unknown): AtomicNoteMatchingCheckpoint {
  const parsed = stageCheckpointSchema.safeParse(stage);
  return parsed.success
    ? parsed.data.metadata
    : { completedNoteIds: [], persistedCount: 0, decided: [] };
}

/**
 * Runs note matching from the last checkpoint: notes completed by an earlier attempt are skipped,
 * and every completed note is saved, with the pairs it handed on, before the next one starts, so a
 * retry resumes after it. Only `save` (at the start and once per completed note) writes the
 * checkpoint; the progress ticks inside a note go to `reportProgress` and never rewrite it.
 */
export async function matchAtomicNotesFromCheckpoint<R extends { persistedCount: number }>(input: {
  noteIds: string[];
  checkpoint: AtomicNoteMatchingCheckpoint;
  match: (
    noteIds: string[],
    onProgress: (progress: number) => Promise<void>,
    onNoteCompleted: (noteId: string, persistedCount: number) => Promise<void>,
    onNoteDecided: (note: StoredDecidedNote) => void
  ) => Promise<R>;
  save: (progress: number, metadata: JsonObject) => Promise<void>;
  reportProgress: (progress: number) => Promise<void>;
}): Promise<
  R & { completed: number; total: number; resumedNotes: number; decided: StoredDecidedNote[] }
> {
  const total = input.noteIds.length;
  const current = new Set(input.noteIds);
  const completed = new Set(input.checkpoint.completedNoteIds.filter((id) => current.has(id)));
  const resumedNotes = completed.size;
  const resumedPersisted = resumedNotes > 0 ? input.checkpoint.persistedCount : 0;
  // The pairs of the notes an earlier attempt decided; a note decided again replaces its entry.
  const decided = new Map(
    input.checkpoint.decided
      .filter((note) => completed.has(note.noteId))
      .map((note) => [note.noteId, note] as const)
  );
  let persistedCount = resumedPersisted;
  const remaining = input.noteIds.filter((id) => !completed.has(id));
  const metadata = (): JsonObject => ({
    completed: completed.size,
    total,
    completedNoteIds: [...completed],
    persistedCount,
    decided: [...decided.values()]
  });
  const fraction = (done: number) => (total > 0 ? Math.min(1, done / total) : 1);
  await input.save(fraction(resumedNotes), metadata());
  const result = await input.match(
    remaining,
    (progress) => input.reportProgress(fraction(resumedNotes + progress * remaining.length)),
    async (noteId, notePersisted) => {
      completed.add(noteId);
      persistedCount += notePersisted;
      await input.save(fraction(completed.size), metadata());
    },
    (note) => {
      decided.delete(note.noteId);
      decided.set(note.noteId, note);
    }
  );
  return {
    ...result,
    persistedCount: resumedPersisted + result.persistedCount,
    completed: total,
    total,
    resumedNotes,
    decided: [...decided.values()]
  };
}
