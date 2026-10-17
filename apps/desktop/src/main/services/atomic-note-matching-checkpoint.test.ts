import { describe, expect, it, vi } from "vitest";

import {
  matchAtomicNotesFromCheckpoint,
  readAtomicNoteMatchingCheckpoint,
  type AtomicNoteMatchingCheckpoint
} from "./atomic-note-matching-checkpoint.js";
import type { StoredDecidedNote } from "./relations/relation-link.js";

const noteIds = ["n1", "n2", "n3", "n4"];

/** A decided note with one accepted pair, as the matcher hands it on. */
const decidedNote = (noteId: string): StoredDecidedNote => ({
  noteId,
  sourceItemId: "source",
  decider: {
    kind: "ranker",
    mode: "ranker",
    deciderKey: "decider",
    calibration: "provisional",
    profileId: "profile",
    modelId: "ranker"
  },
  pairs: [
    {
      noteId,
      candidateId: `other-${noteId}`,
      candidateSourceItemId: "other-source",
      band: "apply",
      probability: null,
      score: 4.5,
      calibration: "provisional",
      relationType: null,
      subjectId: null,
      decisionSource: "model",
      vectorScore: 0.8,
      graphScore: null
    }
  ]
});

/** A matcher that decides notes in order and fails on the note named in `failOn`. */
function matcher(failOn?: string) {
  const matched: string[] = [];
  const match = vi.fn(
    async (
      ids: string[],
      onProgress: (progress: number) => Promise<void>,
      onNoteCompleted: (noteId: string, persisted: number) => Promise<void>,
      onNoteDecided: (note: StoredDecidedNote) => void
    ) => {
      for (const [index, id] of ids.entries()) {
        if (id === failOn) throw new Error("matching_failed");
        matched.push(id);
        onNoteDecided(decidedNote(id));
        await onProgress((index + 1) / ids.length);
        await onNoteCompleted(id, 0);
      }
      return { persistedCount: 0, decider: "ranker" };
    }
  );
  return { match, matched };
}

describe("atomic note matching checkpoint", () => {
  it("resumes after the last decided note, with the pairs it handed on, when an attempt fails", async () => {
    const saved: Array<{ progress: number; metadata: Record<string, unknown> }> = [];
    const save = async (progress: number, metadata: Record<string, unknown>) =>
      void saved.push({ progress, metadata });
    const ticks: number[] = [];
    const reportProgress = async (progress: number) => void ticks.push(progress);
    const first = matcher("n3");
    await expect(
      matchAtomicNotesFromCheckpoint({
        noteIds,
        checkpoint: readAtomicNoteMatchingCheckpoint(undefined),
        match: first.match,
        save,
        reportProgress
      })
    ).rejects.toThrow("matching_failed");
    expect(first.matched).toEqual(["n1", "n2"]);
    // The checkpoint is written at the start and once per completed note; a progress tick inside a
    // note never rewrites it.
    expect(saved.map((entry) => (entry.metadata.completedNoteIds as string[]).length)).toEqual([
      0, 1, 2
    ]);
    expect(ticks).toEqual([0.25, 0.5]);
    const checkpoint = readAtomicNoteMatchingCheckpoint({
      status: "failed",
      metadata: saved.at(-1)!.metadata
    });
    // No relation is persisted while deciding (F3 D21): the pairs wait in the checkpoint.
    expect(checkpoint).toEqual({
      completedNoteIds: ["n1", "n2"],
      persistedCount: 0,
      decided: [decidedNote("n1"), decidedNote("n2")]
    });

    const retry = matcher();
    ticks.length = 0;
    const result = await matchAtomicNotesFromCheckpoint({
      noteIds,
      checkpoint,
      match: retry.match,
      save,
      reportProgress
    });
    // Ticks continue from the resumed notes and never go backwards.
    expect(ticks).toEqual([0.75, 1]);
    expect(retry.matched).toEqual(["n3", "n4"]);
    expect(result).toEqual({
      persistedCount: 0,
      decider: "ranker",
      completed: 4,
      total: 4,
      resumedNotes: 2,
      decided: noteIds.map(decidedNote)
    });
    const final = saved.at(-1)!;
    expect(final.progress).toBe(1);
    expect(final.metadata).toMatchObject({
      completed: 4,
      total: 4,
      completedNoteIds: ["n1", "n2", "n3", "n4"],
      decided: noteIds.map(decidedNote)
    });
    // Progress never goes backwards across the resumed attempt.
    const resumedProgress = saved.slice(saved.findIndex((s) => s.progress === 0.5));
    for (const [index, entry] of resumedProgress.entries())
      if (index > 0)
        expect(entry.progress).toBeGreaterThanOrEqual(resumedProgress[index - 1]!.progress);
  });

  it("ignores completed notes that no longer belong to the source and malformed checkpoints", async () => {
    const stale: AtomicNoteMatchingCheckpoint = {
      completedNoteIds: ["gone"],
      persistedCount: 7,
      decided: [decidedNote("gone")]
    };
    const run = matcher();
    const result = await matchAtomicNotesFromCheckpoint({
      noteIds: ["n1"],
      checkpoint: stale,
      match: run.match,
      save: async () => {},
      reportProgress: async () => {}
    });
    expect(run.matched).toEqual(["n1"]);
    // The note that left the source takes its pairs with it.
    expect(result).toMatchObject({
      persistedCount: 0,
      resumedNotes: 0,
      decided: [decidedNote("n1")]
    });
    for (const malformed of [
      null,
      {},
      { metadata: { completed: 2, total: 4 } },
      { metadata: { completedNoteIds: "n1", persistedCount: 1 } },
      { metadata: { completedNoteIds: ["n1"], persistedCount: -1 } },
      { metadata: { completedNoteIds: ["n1"], persistedCount: 0, decided: [{ noteId: "n1" }] } }
    ])
      expect(readAtomicNoteMatchingCheckpoint(malformed)).toEqual({
        completedNoteIds: [],
        persistedCount: 0,
        decided: []
      });
    // A checkpoint written before the link job had no pairs: it still resumes.
    expect(
      readAtomicNoteMatchingCheckpoint({
        metadata: { completedNoteIds: ["n1"], persistedCount: 3 }
      })
    ).toEqual({ completedNoteIds: ["n1"], persistedCount: 3, decided: [] });
  });

  it("skips the matcher's work for a fully completed checkpoint", async () => {
    const run = matcher();
    const result = await matchAtomicNotesFromCheckpoint({
      noteIds: ["n1", "n2"],
      checkpoint: { completedNoteIds: ["n1", "n2"], persistedCount: 5, decided: [] },
      match: run.match,
      save: async () => {},
      reportProgress: async () => {}
    });
    expect(run.match).toHaveBeenCalledWith(
      [],
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    );
    expect(result).toMatchObject({ persistedCount: 5, completed: 2, total: 2, resumedNotes: 2 });
  });
});
