import { describe, expect, it } from "vitest";
import { wikiAreaIds } from "@app/domain";

import type { PgPool } from "../client.js";
import { createWikiRepository, wikiAreaForRole, wikiResolveLinksLimit } from "./wikiRepository.js";

const pageId = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-0000000000a1";
const sourceId = "00000000-0000-4000-8000-000000000010";
const noteId = "00000000-0000-4000-8000-000000000020";
const memberNoteId = "00000000-0000-4000-8000-000000000021";
const missingPageId = "00000000-0000-4000-8000-000000000030";
const unlinkedSourceId = "00000000-0000-4000-8000-000000000040";
const uuid = (prefix: number, n: number) =>
  `00000000-0000-4000-8000-${String(prefix * 100_000 + n).padStart(12, "0")}`;

interface FakeOptions {
  /** Ids of sources and notes that exist. */
  sources?: string[];
  notes?: string[];
  failSources?: boolean;
  failEvidenceOf?: string;
}

function fakePool(content: unknown, options: FakeOptions = {}) {
  const sources = new Set(options.sources ?? [sourceId, unlinkedSourceId]);
  const notes = new Set(options.notes ?? [noteId, memberNoteId]);
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql.includes("from wiki_pages p join wiki_page_revisions r"))
        return { rows: content ? [{ revisionId, content }] : [] };
      if (sql.includes("from source_items where id=any")) {
        if (options.failSources) throw new Error("source table unavailable");
        return {
          rows: (params[0] as string[])
            .filter((id) => sources.has(id))
            .map((id) => ({ id, title: "Source", source_id: id }))
        };
      }
      if (sql.includes("from wiki_pages where id=any")) return { rows: [] };
      if (sql.includes("from entities where id=any")) return { rows: [] };
      if (sql.includes("from atomic_notes where id=any"))
        return {
          rows: (params[0] as string[])
            .filter((id) => notes.has(id))
            .map((id) => ({
              id,
              title: "Note",
              markdown: "Body",
              source_id: sourceId,
              evidence_chunk_id: "00000000-0000-4000-8000-0000000000c1",
              status: "approved",
              metadata: {},
              supersession_status: "current"
            }))
        };
      if (sql.includes("from atomic_note_evolution e join atomic_notes n")) return { rows: [] };
      if (sql.includes("from chunks c join source_items s")) {
        if (params[0] === options.failEvidenceOf) throw new Error("evidence unavailable");
        return { rows: [] };
      }
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

const idsQueried = (queries: Array<{ sql: string; params: unknown[] }>, fragment: string) =>
  queries
    .filter((query) => query.sql.includes(fragment))
    .flatMap((query) => query.params[0] as string[]);

describe("wiki batched link resolution", () => {
  it("resolves every link of a revision in one pass, de-duplicated, listing unresolved ones", async () => {
    const { pool, queries } = fakePool(content);

    const result = await createWikiRepository(pool).resolveLinks({ pageId });

    expect(result?.revisionId).toBe(revisionId);
    expect(result?.targets.map((t) => `${t.kind}:${t.id}`).toSorted()).toEqual(
      [`atomic_note:${memberNoteId}`, `atomic_note:${noteId}`, `source:${sourceId}`].toSorted()
    );
    expect(result?.unresolved).toEqual([{ kind: "page", id: missingPageId }]);
    expect(result?.failed).toEqual([]);
    // The page revision is read once for the whole page, not once per link.
    expect(queries.filter((query) => query.sql.includes("from wiki_pages p join"))).toHaveLength(1);
  });

  it("reads each kind with one query for all its links, not one per link", async () => {
    const links = Array.from({ length: 40 }, (_, n) => ({ kind: "source", id: uuid(1, n) }));
    const notes = Array.from({ length: 40 }, (_, n) => ({ kind: "atomic_note", id: uuid(2, n) }));
    const { pool, queries } = fakePool(
      { automatic: { links: [...links, ...notes], memberships: [] }, sections: [] },
      { sources: links.map((link) => link.id), notes: notes.map((link) => link.id) }
    );

    const result = await createWikiRepository(pool).resolveLinks({ pageId });

    expect(result?.targets).toHaveLength(80);
    expect(queries.filter((query) => query.sql.includes("from source_items"))).toHaveLength(1);
    expect(queries.filter((query) => query.sql.includes("from atomic_notes"))).toHaveLength(1);
    expect(
      queries.filter((query) => query.sql.includes("from atomic_note_evolution"))
    ).toHaveLength(1);
    // Only the evidence of a note is read note by note.
    expect(queries.filter((query) => query.sql.includes("from chunks c join"))).toHaveLength(40);
  });

  it("never queries a reference that is not a well-formed identifier", async () => {
    // Matches the legacy reference pattern (hex and dashes, 36 characters) but not the UUID layout.
    const malformed = "a".repeat(36);
    const lettered = "0000000a-0000-4000-8000-00000000000b";
    const { pool, queries } = fakePool(
      {
        automatic: {
          links: [{ kind: "atomic_note", id: lettered.toUpperCase() }],
          memberships: []
        },
        sections: [
          { markdown: `memora:atomic_note/${malformed} memora:atomic_note/${"-".repeat(36)}` }
        ]
      },
      { notes: [lettered] }
    );

    const result = await createWikiRepository(pool).resolveLinks({ pageId });

    // The malformed references are dropped; an upper-case identifier is read in canonical form.
    expect(idsQueried(queries, "from atomic_notes where id=any")).toEqual([lettered]);
    expect(result?.targets.map((target) => target.id)).toEqual([lettered]);
    expect(result?.unresolved).toEqual([]);
  });

  it("caps the links resolved in one batch and leaves the rest to individual reads", async () => {
    const links = Array.from({ length: wikiResolveLinksLimit + 150 }, (_, n) => ({
      kind: "source",
      id: uuid(3, n)
    }));
    const { pool, queries } = fakePool(
      { automatic: { links, memberships: [] }, sections: [] },
      { sources: links.map((link) => link.id) }
    );

    const result = await createWikiRepository(pool).resolveLinks({ pageId });

    expect(idsQueried(queries, "from source_items")).toHaveLength(wikiResolveLinksLimit);
    expect(result?.targets).toHaveLength(wikiResolveLinksLimit);
    // The links past the cap are neither resolved nor reported missing or failed.
    expect(result?.unresolved).toEqual([]);
    expect(result?.failed).toEqual([]);
  });

  it("reports a note whose read failed instead of failing the whole page", async () => {
    const { pool } = fakePool(content, { failEvidenceOf: noteId });

    const result = await createWikiRepository(pool).resolveLinks({ pageId });

    expect(result?.failed.map((ref) => ref.id)).toContain(noteId);
    // The source and the page verdict are intact; nothing rejected.
    expect(result?.targets.map((target) => target.kind)).toContain("source");
    expect(result?.unresolved).toEqual([{ kind: "page", id: missingPageId }]);
  });

  it("stops reading once a read fails and reports what it did not read as failed", async () => {
    const notes = Array.from({ length: 30 }, (_, n) => uuid(4, n));
    const { pool, queries } = fakePool(
      {
        automatic: {
          links: notes.map((id) => ({ kind: "atomic_note", id })),
          memberships: []
        },
        sections: []
      },
      { notes, failEvidenceOf: notes[0] }
    );

    const result = await createWikiRepository(pool).resolveLinks({ pageId });

    const evidenceReads = queries.filter((query) => query.sql.includes("from chunks c join"));
    // Bounded concurrency means at most one wave started before the failure was seen.
    expect(evidenceReads.length).toBeLessThan(notes.length);
    expect(evidenceReads.length).toBeLessThanOrEqual(6);
    expect(result!.targets.length + result!.failed.length).toBe(notes.length);
    expect(result!.failed.map((ref) => ref.id)).toContain(notes[0]);
    expect(result!.failed.length).toBeGreaterThan(notes.length - 6);
  });

  it("marks a kind whose query failed as failed and reads no further kind", async () => {
    const { pool, queries } = fakePool(content, { failSources: true });

    const result = await createWikiRepository(pool).resolveLinks({ pageId });

    expect(result?.failed.map((ref) => `${ref.kind}:${ref.id}`).toSorted()).toEqual(
      [
        `source:${sourceId}`,
        `atomic_note:${noteId}`,
        `atomic_note:${memberNoteId}`,
        `page:${missingPageId}`
      ].toSorted()
    );
    expect(result?.targets).toEqual([]);
    expect(queries.some((query) => query.sql.includes("from atomic_notes"))).toBe(false);
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

  it("reads one linked note with the same shape as the batch and rethrows a failed read", async () => {
    const { pool } = fakePool(content);
    const batch = await createWikiRepository(pool).resolveLinks({ pageId });
    const single = await createWikiRepository(pool).linkedTarget({
      pageId,
      kind: "atomic_note",
      id: noteId
    });
    expect(single).toEqual(batch?.targets.find((target) => target.id === noteId));

    const failing = fakePool(content, { failEvidenceOf: noteId });
    await expect(
      createWikiRepository(failing.pool).linkedTarget({ pageId, kind: "atomic_note", id: noteId })
    ).rejects.toThrow("evidence unavailable");
  });
});

describe("the area of a role", () => {
  it("maps every automatic role to one area", () => {
    expect(wikiAreaForRole({ kind: "topic", role: "topic" })).toBe(wikiAreaIds.themes);
    expect(wikiAreaForRole({ kind: "entity", role: "entity" })).toBe(wikiAreaIds.entities);
    expect(wikiAreaForRole({ kind: "synthesis", role: "synthesis" })).toBe(wikiAreaIds.syntheses);
    expect(wikiAreaForRole({ kind: "synthesis", role: "investigation" })).toBe(
      wikiAreaIds.investigations
    );
    expect(wikiAreaForRole({ kind: "synthesis" })).toBe(wikiAreaIds.syntheses);
    expect(wikiAreaForRole({ kind: "collection", role: "map" })).toBe(wikiAreaIds.maps);
    expect(wikiAreaForRole({ kind: "collection", role: "source_toc" })).toBe(wikiAreaIds.maps);
  });
});
