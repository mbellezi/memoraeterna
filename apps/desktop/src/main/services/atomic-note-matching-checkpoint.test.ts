import { describe, expect, it, vi } from "vitest";

import {
  atomicNoteMatchingCheckpointMetadata,
  matchAtomicNotesFromCheckpoint,
  readAtomicNoteMatchingCheckpoint,
  type AtomicNoteMatchingCheckpoint
} from "./atomic-note-matching-checkpoint.js";

const noteIds = ["n1", "n2", "n3", "n4"];

/** A matcher that completes notes in order and fails on the note named in `failOn`. */
function matcher(failOn?: string) {
  const matched: string[] = [];
  const match = vi.fn(
    async (
      ids: string[],
      onProgress: (progress: number) => Promise<void>,
      onNoteCompleted: (noteId: string, persisted: number) => Promise<void>
    ) => {
      let persistedCount = 0;
      for (const [index, id] of ids.entries()) {
        if (id === failOn) throw new Error("matching_failed");
        matched.push(id);
        persistedCount += 1;
        await onProgress((index + 1) / ids.length);
        await onNoteCompleted(id, 1);
      }
      return { persistedCount, threshold: 0.6 };
    }
  );
  return { match, matched };
}

describe("atomic note matching checkpoint", () => {
  it("resumes after the last completed note when an attempt fails", async () => {
    const saved: Array<{ progress: number; metadata: Record<string, unknown> }> = [];
    const save = async (progress: number, metadata: Record<string, unknown>) =>
      void saved.push({ progress, metadata });
    const first = matcher("n3");
    await expect(
      matchAtomicNotesFromCheckpoint({
        noteIds,
        checkpoint: readAtomicNoteMatchingCheckpoint(undefined),
        match: first.match,
        save
      })
    ).rejects.toThrow("matching_failed");
    expect(first.matched).toEqual(["n1", "n2"]);
    const checkpoint = readAtomicNoteMatchingCheckpoint({
      status: "failed",
      metadata: saved.at(-1)!.metadata
    });
    expect(checkpoint).toEqual({ completedNoteIds: ["n1", "n2"], persistedCount: 2 });

    const retry = matcher();
    const result = await matchAtomicNotesFromCheckpoint({
      noteIds,
      checkpoint,
      match: retry.match,
      save
    });
    expect(retry.matched).toEqual(["n3", "n4"]);
    expect(result).toEqual({
      persistedCount: 4,
      threshold: 0.6,
      completed: 4,
      total: 4,
      resumedNotes: 2
    });
    const final = saved.at(-1)!;
    expect(final.progress).toBe(1);
    expect(final.metadata).toMatchObject({
      completed: 4,
      total: 4,
      completedNoteIds: ["n1", "n2", "n3", "n4"],
      persistedCount: 4
    });
    // Progress never goes backwards across the resumed attempt.
    const resumedProgress = saved.slice(saved.findIndex((s) => s.progress === 0.5));
    for (const [index, entry] of resumedProgress.entries())
      if (index > 0)
        expect(entry.progress).toBeGreaterThanOrEqual(resumedProgress[index - 1]!.progress);
  });

  it("ignores completed notes that no longer belong to the source and malformed checkpoints", async () => {
    const stale: AtomicNoteMatchingCheckpoint = { completedNoteIds: ["gone"], persistedCount: 7 };
    const run = matcher();
    const result = await matchAtomicNotesFromCheckpoint({
      noteIds: ["n1"],
      checkpoint: stale,
      match: run.match,
      save: async () => {}
    });
    expect(run.matched).toEqual(["n1"]);
    expect(result).toMatchObject({ persistedCount: 1, resumedNotes: 0 });
    for (const malformed of [
      null,
      {},
      { metadata: { completed: 2, total: 4 } },
      { metadata: { completedNoteIds: "n1", persistedCount: 1 } },
      { metadata: { completedNoteIds: ["n1"], persistedCount: -1 } }
    ])
      expect(readAtomicNoteMatchingCheckpoint(malformed)).toEqual({
        completedNoteIds: [],
        persistedCount: 0
      });
  });

  it("carries the checkpoint through waiting and restarting, and nothing when there is none", () => {
    const stage = {
      status: "failed",
      metadata: { completed: 1, total: 2, completedNoteIds: ["n1"], persistedCount: 3 }
    };
    expect(atomicNoteMatchingCheckpointMetadata(stage)).toEqual({
      completedNoteIds: ["n1"],
      persistedCount: 3
    });
    expect(atomicNoteMatchingCheckpointMetadata({ status: "running", metadata: {} })).toEqual({});
    expect(atomicNoteMatchingCheckpointMetadata(undefined)).toEqual({});
  });

  it("skips the matcher's work for a fully completed checkpoint", async () => {
    const run = matcher();
    const result = await matchAtomicNotesFromCheckpoint({
      noteIds: ["n1", "n2"],
      checkpoint: { completedNoteIds: ["n1", "n2"], persistedCount: 5 },
      match: run.match,
      save: async () => {}
    });
    expect(run.match).toHaveBeenCalledWith([], expect.any(Function), expect.any(Function));
    expect(result).toMatchObject({ persistedCount: 5, completed: 2, total: 2, resumedNotes: 2 });
  });
});
