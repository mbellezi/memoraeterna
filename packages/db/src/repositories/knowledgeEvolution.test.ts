import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";

import type { PgClient, PgPool } from "../client.js";
import { applyNoteEvolution } from "./knowledgeEvolution.js";

// Applies an evolution that touches no wiki page, so only the notes are written. The full flow,
// pages included, runs against a real database in `scripts/verify-automatic-wiki-a7.ts`.
const original = "00000000-0000-4000-8000-0000000000a1";
const evidence = (handle: string, chunkId: string) => ({
  handle,
  chunkId,
  sourceItemId: "source-1",
  documentId: "document-1",
  sourceSpanId: null,
  contentHash: `hash-${handle}`
});

function fakeTransaction() {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const db = {
    query: async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      let rows: QueryResultRow[] = [];
      if (text.includes("from atomic_notes where id=any($1::uuid[])"))
        rows = [
          {
            id: original,
            status: "active",
            supersession_status: "current",
            evidence_chunk_id: "chunk-1"
          }
        ];
      else if (text.startsWith("select * from atomic_notes where id=$1"))
        rows = [{ id: values[0], title: "A note" }];
      return { rows, rowCount: text.startsWith("insert into jobs") ? 1 : rows.length };
    }
  };
  return { db: db as unknown as PgClient, queries };
}

const snapshot = {
  limits: { targets: 10 },
  pages: [],
  evidence: [evidence("e1", "chunk-1"), evidence("e2", "chunk-2")],
  contentLanguage: "en",
  profile: { provider: "remote", modelId: "writer", runtime: "remote", profileId: "profile" }
};
const draft = (title: string, handle: string) => ({
  title,
  ideaStatement: `${title} idea`,
  bodyMarkdown: `${title} body [${handle}]`,
  originalHandles: [handle]
});

describe("notes created by a note evolution", () => {
  it("queues the embedding of each new note in the same transaction, and of no other note", async () => {
    const { db, queries } = fakeTransaction();
    const result = await applyNoteEvolution(
      db,
      {} as PgPool,
      "run-1",
      snapshot as never,
      {
        noteEvolution: {
          version: "note-evolution-v1",
          kind: "split",
          noteIds: [original],
          reason: "Two ideas",
          notes: [draft("First", "e1"), draft("Second", "e2")]
        }
      } as never
    );
    expect(result.notes).toHaveLength(2);
    const queued = queries.filter((query) => query.text.includes("insert into jobs"));
    // Each job is for a new note of the evolution, with the source its first evidence names;
    // the superseded original keeps the embedding it already has.
    expect(queued.map((query) => query.values)).toEqual(
      result.notes.map((note) => ["note-embedding", 10, note.id, "source-1"])
    );
    expect(queued.map((query) => query.values[2])).not.toContain(original);
    // Queued after the note exists and under the lock that deduplicates concurrent edits.
    const text = queries.map((query) => query.text);
    for (const note of result.notes) {
      const created = text.findIndex(
        (value, index) =>
          value.startsWith("insert into atomic_notes") && queries[index]!.values[0] === note.id
      );
      const lock = queries.findIndex(
        (query) =>
          query.text.includes("pg_advisory_xact_lock") &&
          query.values[0] === `note-embedding:${note.id}`
      );
      const job = queries.findIndex(
        (query) => query.text.includes("insert into jobs") && query.values[2] === note.id
      );
      expect(created).toBeGreaterThanOrEqual(0);
      expect(lock).toBeGreaterThan(created);
      expect(job).toBeGreaterThan(lock);
    }
  });
});
