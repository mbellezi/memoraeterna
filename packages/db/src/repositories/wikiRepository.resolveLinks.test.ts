import { describe, expect, it } from "vitest";

import type { PgPool } from "../client.js";
import { createWikiRepository } from "./wikiRepository.js";

const pageId = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-0000000000a1";
const sourceId = "00000000-0000-4000-8000-000000000010";
const noteId = "00000000-0000-4000-8000-000000000020";
const memberNoteId = "00000000-0000-4000-8000-000000000021";
const missingPageId = "00000000-0000-4000-8000-000000000030";
const unlinkedSourceId = "00000000-0000-4000-8000-000000000040";

function fakePool(content: unknown) {
  const queries: string[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      if (sql.includes("from wiki_pages p join wiki_page_revisions r"))
        return { rows: content ? [{ revisionId, content }] : [] };
      if (sql.includes("from source_items where id=$1"))
        return {
          rows:
            params[0] === sourceId || params[0] === unlinkedSourceId
              ? [{ id: params[0], title: "Source", source_id: params[0], markdown: "" }]
              : []
        };
      if (sql.includes("from wiki_pages where id=$1")) return { rows: [] };
      if (sql.includes("from atomic_notes where id=$1"))
        return {
          rows: [noteId, memberNoteId].includes(String(params[0]))
            ? [
                {
                  id: params[0],
                  title: "Note",
                  markdown: "Body",
                  source_id: sourceId,
                  evidence_chunk_id: "00000000-0000-4000-8000-0000000000c1",
                  status: "approved",
                  metadata: {},
                  supersession_status: "current"
                }
              ]
            : []
        };
      if (sql.includes("from atomic_note_evolution e join atomic_notes n")) return { rows: [] };
      if (sql.includes("from chunks c join source_items s")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    }
  };
  return { pool: pool as unknown as PgPool, queries };
}

const content = {
  automatic: {
    links: [
      { kind: "source", id: sourceId },
      { kind: "atomic_note", id: noteId },
      { kind: "page", id: missingPageId }
    ],
    memberships: [{ target: { kind: "atomic_note", id: memberNoteId } }]
  },
  // A legacy reference to the same note and one that is not a valid identifier.
  sections: [
    { markdown: `See memora:atomic_note/${noteId} and memora:atomic_note/${"x".repeat(36)}.` }
  ]
};

describe("wiki batched link resolution", () => {
  it("resolves every link of a revision in one pass, de-duplicated, listing unresolved ones", async () => {
    const { pool, queries } = fakePool(content);

    const result = await createWikiRepository(pool).resolveLinks({ pageId });

    expect(result?.revisionId).toBe(revisionId);
    expect(result?.targets.map((t) => `${t.kind}:${t.id}`).toSorted()).toEqual(
      [`atomic_note:${memberNoteId}`, `atomic_note:${noteId}`, `source:${sourceId}`].toSorted()
    );
    expect(result?.unresolved).toEqual([{ kind: "page", id: missingPageId }]);
    // The page revision is read once for the whole page, not once per link.
    expect(queries.filter((sql) => sql.includes("from wiki_pages p join"))).toHaveLength(1);
  });

  it("returns null when the revision does not exist", async () => {
    const { pool } = fakePool(null);
    expect(await createWikiRepository(pool).resolveLinks({ pageId, revisionId })).toBeNull();
  });

  it("still refuses a single target that the page does not link to", async () => {
    const { pool } = fakePool(content);
    await expect(
      createWikiRepository(pool).linkedTarget({ pageId, kind: "source", id: unlinkedSourceId })
    ).rejects.toThrow("wiki.errors.invalid");
    await expect(
      createWikiRepository(pool).linkedTarget({ pageId, kind: "source", id: sourceId })
    ).resolves.toMatchObject({ kind: "source", id: sourceId });
  });
});
