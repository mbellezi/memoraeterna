import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { addressTargets, formatObjectAddress } from "@app/domain";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createAuditLintRepository } from "./auditLintRepository.js";
import type { AuditEmbeddingSpace } from "./auditLintRepository.js";

/**
 * The reads of AUDIT's lints (F4 T85, D19) on a real PostgreSQL with the indexes of migration 0058:
 * nearest neighbours of the notes embedded since a cursor, notes that share a title, vectors that
 * are missing or older than their note, and the persisted addresses with what they still name.
 */
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const space: AuditEmbeddingSpace = {
  dimensions: 256,
  spaceKey: "audit-space",
  model: "audit-model"
};
const embedding = (theta: number): string =>
  `[${Array.from({ length: 256 }, (_, axis) =>
    axis === 0 ? Math.cos(theta) : axis === 1 ? Math.sin(theta) : 0
  ).join(",")}]`;

describe.skipIf(!sidecarInstalled)("AUDIT lint reads on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let planPool: pg.Pool | undefined;
  let counter = 100;
  let sourceId = "";
  let chunkId = "";
  const lints = () => createAuditLintRepository(pool!);

  /** A note with a vector of the audited space written at `embeddedAt` (a minute of the day). */
  async function addNote(note: {
    title: string;
    theta?: number;
    embeddedAt?: number;
    status?: string;
    supersession?: string;
    hash?: string;
    strategy?: string;
    updatedAfter?: boolean;
  }): Promise<string> {
    counter += 1;
    const id = u(counter);
    await pool!.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
          created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
          generation_runtime, generation_prompt_version, generation_key)
       values ($1::uuid, $2, 'Body', 'Idea', $3, $4, $5, $6, 'test', 'test', 'local', 'test', $1::text)`,
      [id, note.title, note.status ?? "active", note.supersession ?? "current", sourceId, chunkId]
    );
    if (note.theta !== undefined) {
      const minute = String(note.embeddedAt ?? counter % 60).padStart(2, "0");
      await pool!.query(
        `insert into embeddings_256 (target_type, target_id, provider, model, runtime, strategy,
            content_hash, embedding, created_at)
         values ('atomic_note', $1, 'test', $2, 'none', $3, $4, $5::vector,
                 ('2026-10-20T10:' || $6 || ':00Z')::timestamptz)`,
        [
          id,
          space.model,
          note.strategy ?? `native-v2:${space.spaceKey}`,
          note.hash ?? `hash-${id}`,
          embedding(note.theta),
          minute
        ]
      );
      // The note was last written before its vector, or (an edit) after it.
      await pool!.query("update atomic_notes set updated_at = $2::timestamptz where id = $1", [
        id,
        note.updatedAfter ? "2026-10-20T11:00:00Z" : "2026-10-20T09:00:00Z"
      ]);
    }
    return id;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-audit-lints-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_audit_lints",
      user: "memora_audit_lints",
      password: `audit-lints-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    // The planner reads a table this small with a scan; this makes it choose the HNSW index the
    // lint is written for, as it does on a library of thousands of notes.
    planPool = new pg.Pool({
      connectionString: connection.connectionString,
      max: 2,
      options: "-c enable_seqscan=off -c enable_sort=off"
    });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    sourceId = u(1);
    const documentId = randomUUID();
    chunkId = randomUUID();
    await pool.query("insert into source_items (id, type, title) values ($1, 'Book', 'Source')", [
      sourceId
    ]);
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'text', 'doc-hash')`,
      [documentId, sourceId]
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'text', 'chunk-hash')`,
      [chunkId, documentId, sourceId]
    );
  }, 120_000);

  afterAll(async () => {
    if (planPool) await planPool.end().catch(() => undefined);
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  beforeEach(async () => {
    await pool!.query("delete from jobs");
    await pool!.query("delete from view_history");
    await pool!.query("delete from atomic_notes");
  });

  describe("duplicate neighbours", () => {
    it("reads the nearest current notes of each note embedded after the cursor", async () => {
      const first = await addNote({ title: "First", theta: 0, embeddedAt: 1 });
      const near = await addNote({ title: "Near", theta: 0.05, embeddedAt: 2 });
      const far = await addNote({ title: "Far", theta: 1.2, embeddedAt: 3 });
      const hidden = await addNote({
        title: "Superseded twin",
        theta: 0.001,
        embeddedAt: 4,
        supersession: "superseded"
      });
      const otherSpace = await addNote({
        title: "Other space",
        theta: 0.002,
        embeddedAt: 5,
        strategy: "native-v2:another"
      });
      const batch = await lints().duplicateBatch(space, null, 10, 2);
      // The superseded note and the vector of another space take no part, on either side.
      expect(batch.notes.map((note) => note.id)).toEqual([first, near, far]);
      const neighbours = (id: string) =>
        batch.neighbours
          .filter((entry) => entry.noteId === id)
          .map((entry) => [entry.otherId, Math.round(entry.cosine * 1e4) / 1e4]);
      expect(neighbours(first)).toEqual([
        [near, Math.round(Math.cos(0.05) * 1e4) / 1e4],
        [far, Math.round(Math.cos(1.2) * 1e4) / 1e4]
      ]);
      expect(neighbours(near)[0]?.[0]).toBe(first);
      expect(batch.neighbours.some((entry) => [hidden, otherSpace].includes(entry.otherId))).toBe(
        false
      );
      // A page resumes exactly after its cursor, and the last page is short.
      const page = await lints().duplicateBatch(space, null, 2, 2);
      expect(page.notes.map((note) => note.id)).toEqual([first, near]);
      const last = page.notes.at(-1)!;
      const rest = await lints().duplicateBatch(space, { at: last.at, id: last.id }, 2, 2);
      expect(rest.notes.map((note) => note.id)).toEqual([far]);
      expect(rest.neighbours.filter((entry) => entry.noteId === far)).toHaveLength(2);
      expect(
        (await lints().duplicateBatch(space, { at: rest.notes[0]!.at, id: far }, 2, 2)).notes
      ).toEqual([]);
    });

    it("uses the partial HNSW index of the note vectors for the neighbour search", async () => {
      for (let n = 0; n < 6; n += 1)
        await addNote({ title: `Note ${n}`, theta: n * 0.3, embeddedAt: n });
      const client = await planPool!.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('hnsw.iterative_scan', 'relaxed_order', true)");
        const plan = await client.query<{ "QUERY PLAN": string }>(
          `explain select nn.other_id
             from (select embedding, target_id from embeddings_256 where target_type = 'atomic_note'
                    limit 1) b
             cross join lateral (
               select e.target_id as other_id from embeddings_256 e
                where e.target_type = 'atomic_note' and e.target_id <> b.target_id
                order by e.embedding <=> b.embedding limit 3) nn`
        );
        expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
          "embeddings_256_note_hnsw_idx"
        );
        await client.query("rollback");
      } finally {
        client.release();
      }
    });
  });

  describe("title groups", () => {
    it("groups current notes whose titles are the same once case, accents and spaces are folded", async () => {
      const one = await addNote({ title: "Memória  de trabalho" });
      const two = await addNote({ title: "memoria de TRABALHO" });
      const three = await addNote({ title: " Memória de trabalho " });
      await addNote({ title: "Memória de longo prazo" });
      await addNote({ title: "Memória de trabalho", supersession: "superseded" });
      await addNote({ title: "Memória de trabalho", status: "archived" });
      await addNote({ title: "Alone" });
      const groups = await lints().titleGroups([one, three]);
      expect(groups).toEqual([[one, two, three].sort()]);
      expect(await lints().titleGroups([])).toEqual([]);
      const alone = await addNote({ title: "Only me" });
      expect(await lints().titleGroups([alone])).toEqual([]);
    });
  });

  describe("pair evidence", () => {
    it("tells whether a pair still holds: both current, the cosine and the title", async () => {
      const a = await addNote({ title: "Same title", theta: 0, embeddedAt: 1 });
      const b = await addNote({ title: "SAME   title", theta: 0.1, embeddedAt: 2 });
      const c = await addNote({
        title: "Other",
        theta: 0.2,
        embeddedAt: 3,
        supersession: "superseded"
      });
      const d = await addNote({ title: "No vector" });
      const evidence = await lints().pairEvidence(space, [
        [a, b],
        [a, c],
        [a, d]
      ]);
      expect(evidence[0]).toMatchObject({ a, b, bothCurrent: true, sameTitle: true });
      expect(evidence[0]?.cosine).toBeCloseTo(Math.cos(0.1), 5);
      expect(evidence[1]).toMatchObject({ bothCurrent: false, sameTitle: false });
      expect(evidence[2]).toMatchObject({ bothCurrent: true, cosine: null, sameTitle: false });
      expect(await lints().pairEvidence(space, [])).toEqual([]);
    });
  });

  describe("stale embeddings", () => {
    it("finds the current notes with no vector in the space and leaves a queued one alone", async () => {
      const bare = await addNote({ title: "Bare" });
      const queued = await addNote({ title: "Queued" });
      const failed = await addNote({ title: "Failed lately" });
      const old = await addNote({ title: "Failed long ago" });
      await addNote({ title: "Embedded", theta: 0 });
      await addNote({ title: "Elsewhere", theta: 0, strategy: "native-v2:another" });
      await addNote({ title: "Archived", status: "archived" });
      const job = (note: string, status: string, finished: string | null) =>
        pool!.query(
          `insert into jobs (type, status, payload, finished_at)
           values ('note-embedding', $2, jsonb_build_object('atomicNoteId', $1::text), $3::timestamptz)`,
          [note, status, finished]
        );
      await job(queued, "queued", null);
      await job(failed, "failed", new Date(Date.now() - 3_600_000).toISOString());
      await job(old, "failed", new Date(Date.now() - 48 * 3_600_000).toISOString());
      const missing = await lints().notesWithoutVector(space, 10, 24);
      const ids = missing.map((note) => note.id).sort();
      expect(ids).toContain(bare);
      expect(ids).toContain(old);
      expect(ids).not.toContain(queued);
      expect(ids).not.toContain(failed);
      // "Elsewhere" has a vector, but not in this space: it is the space change's work only when
      // the route moved, so the lint lists it like any note without a vector here.
      expect(missing.every((note) => note.sourceItemId === sourceId)).toBe(true);
      expect(await lints().notesWithoutVector(space, 1, 24)).toHaveLength(1);
    });

    it("lists the notes edited after their vector, in the order of the edit, from a cursor", async () => {
      const current = await addNote({ title: "Current", theta: 0, embeddedAt: 1 });
      const edited = await addNote({
        title: "Edited",
        theta: 0.1,
        embeddedAt: 2,
        updatedAfter: true
      });
      const editedLater = await addNote({
        title: "Edited later",
        theta: 0.2,
        embeddedAt: 3,
        updatedAfter: true
      });
      await pool!.query(
        "update atomic_notes set updated_at = '2026-10-20T12:00:00Z' where id = $1",
        [editedLater]
      );
      const found = await lints().notesEditedAfterVector(space, null, 10, 24);
      expect(found.map((note) => note.id)).toEqual([edited, editedLater]);
      expect(found[0]).toMatchObject({
        title: "Edited",
        ideaStatement: "Idea",
        bodyMarkdown: "Body",
        storedHash: `hash-${edited}`
      });
      expect(found.map((note) => note.id)).not.toContain(current);
      const next = await lints().notesEditedAfterVector(
        space,
        { at: found[0]!.at, id: found[0]!.id },
        10,
        24
      );
      expect(next.map((note) => note.id)).toEqual([editedLater]);
      await pool!.query(
        `insert into jobs (type, status, payload)
         values ('note-embedding', 'running', jsonb_build_object('atomicNoteId', $1::text))`,
        [edited]
      );
      expect((await lints().notesEditedAfterVector(space, null, 10, 24)).map((n) => n.id)).toEqual([
        editedLater
      ]);
    });
  });

  describe("persisted addresses", () => {
    it("lists the recents with their hosts and says which objects are gone", async () => {
      const note = await addNote({ title: "A note" });
      const gone = u(9_001);
      const entry = (kind: string, id: string, parent: string | null = null) =>
        pool!.query(
          `insert into view_history (kind, object_id, address, title, parent_address)
           values ($1, $2::uuid, $3, 'Title', $4)`,
          [kind, id, `memora://${kind}/${id}`, parent]
        );
      await entry("note", note, `memora://source/${sourceId}`);
      await entry("note", gone);
      await entry("source", sourceId);
      await entry("question", u(9_002));
      await entry("topic", u(9_003));
      const addresses = await lints().persistedAddresses(100);
      expect(addresses.map((item) => item.role).sort()).toEqual([
        "entry",
        "entry",
        "entry",
        "entry",
        "entry",
        "parent"
      ]);
      const resolutions = await lints().addressResolutions(addressTargets(addresses), 64);
      const at = (kind: "note" | "source" | "topic" | "question", id: string) =>
        resolutions.get(formatObjectAddress({ kind, id }));
      expect(at("note", note)).toBe("ok");
      expect(at("note", gone)).toBe("missing");
      expect(at("source", sourceId)).toBe("ok");
      expect(at("question", u(9_002))).toBe("ok");
      // A topic that is not in the database at all is missing (the redirects are checked with the
      // tree in topicRedirectCompression.test.ts).
      expect(at("topic", u(9_003))).toBe("missing");
      expect(await lints().persistedAddresses(2)).toHaveLength(2);
    });
  });
});
