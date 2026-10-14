import { z } from "zod";

import type { JsonObject } from "@app/db";

/** Per-note progress of the atomicNoteMatching stage, kept in the stage checkpoint metadata. */
export interface AtomicNoteMatchingCheckpoint {
  completedNoteIds: string[];
  persistedCount: number;
}

const stageCheckpointSchema = z.object({
  metadata: z.object({
    completedNoteIds: z.array(z.string().min(1)).max(100_000),
    persistedCount: z.number().int().nonnegative()
  })
});

export function readAtomicNoteMatchingCheckpoint(stage: unknown): AtomicNoteMatchingCheckpoint {
  const parsed = stageCheckpointSchema.safeParse(stage);
  return parsed.success ? parsed.data.metadata : { completedNoteIds: [], persistedCount: 0 };
}

/** Stage metadata that carries the checkpoint, so waiting or restarting never erases it. */
export function atomicNoteMatchingCheckpointMetadata(stage: unknown): JsonObject {
  const checkpoint = readAtomicNoteMatchingCheckpoint(stage);
  return checkpoint.completedNoteIds.length ? { ...checkpoint } : {};
}

/**
 * Runs note matching from the last checkpoint: notes completed by an earlier attempt are skipped,
 * and every completed note is saved before the next one starts, so a retry resumes after it.
 */
export async function matchAtomicNotesFromCheckpoint<R extends { persistedCount: number }>(input: {
  noteIds: string[];
  checkpoint: AtomicNoteMatchingCheckpoint;
  match: (
    noteIds: string[],
    onProgress: (progress: number) => Promise<void>,
    onNoteCompleted: (noteId: string, persistedCount: number) => Promise<void>
  ) => Promise<R>;
  save: (progress: number, metadata: JsonObject) => Promise<void>;
}): Promise<R & { completed: number; total: number; resumedNotes: number }> {
  const total = input.noteIds.length;
  const current = new Set(input.noteIds);
  const completed = new Set(input.checkpoint.completedNoteIds.filter((id) => current.has(id)));
  const resumedNotes = completed.size;
  const resumedPersisted = resumedNotes > 0 ? input.checkpoint.persistedCount : 0;
  let persistedCount = resumedPersisted;
  const remaining = input.noteIds.filter((id) => !completed.has(id));
  const metadata = (): JsonObject => ({
    completed: completed.size,
    total,
    completedNoteIds: [...completed],
    persistedCount
  });
  const fraction = (done: number) => (total > 0 ? Math.min(1, done / total) : 1);
  await input.save(fraction(resumedNotes), metadata());
  const result = await input.match(
    remaining,
    (progress) => input.save(fraction(resumedNotes + progress * remaining.length), metadata()),
    async (noteId, notePersisted) => {
      completed.add(noteId);
      persistedCount += notePersisted;
      await input.save(fraction(completed.size), metadata());
    }
  );
  return {
    ...result,
    persistedCount: resumedPersisted + result.persistedCount,
    completed: total,
    total,
    resumedNotes
  };
}
