import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createAtomicNoteRepository } from "./atomicNoteRepository.js";
import {
  vectorScanSettingsSql,
  noteRetrievalDefaults,
  noteTextCandidatesStatement,
  noteVectorCandidatesStatement,
  withVectorScanSettings
} from "./noteRetrievalSql.js";
import type { Queryable } from "./types.js";

// The candidate queries of note matching (F3 T49, D28): the SQL they send, and their answers on a
// real PostgreSQL database with the indexes of migration 0058.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const embedding = (theta: number): number[] =>
  Array.from({ length: 256 }, (_, axis) =>
    axis === 0 ? Math.cos(theta) : axis === 1 ? Math.sin(theta) : 0
  );

describe("note retrieval statements", () => {
  const text = noteTextCandidatesStatement({ noteId: "note", limit: 16 });
  const vector = noteVectorCandidatesStatement({
    noteId: "note",
    embedding: embedding(0),
    embeddingModel: "model",
    embeddingSpaceKey: "space",
    embeddingProvider: "provider",
    embeddingRuntime: "runtime",
    limit: 24
  });

  it("looks the note's selective terms up in search_tsv and its title in the trigram index", () => {
    const sql = text.text.replace(/\s+/g, " ");
    expect(sql).toContain("search_tsv @@ (select query from lexical)");
    expect(sql).toContain("f_unaccent(candidate.title) % (select title_unaccented from subject)");
    expect(sql).toContain("ts_rank_cd(candidate.search_tsv, (select query from lexical), 32)");
    // The terms exclude the stop words of every language the product writes in.
    expect(sql).toContain("portuguese_stem");
    // Nothing is computed per row of the library but the rank of the rows the indexes return.
    expect(sql).not.toContain("similarity(unaccent(");
    expect(sql).not.toContain("plainto_tsquery");
    expect(text.values).toEqual([
      "note",
      16,
      noteRetrievalDefaults.termLimit,
      noteRetrievalDefaults.termPostingLimit
    ]);
  });

  it("excludes superseded, archived and rejected notes and the note itself in both queries", () => {
    for (const statement of [text, vector]) {
      const sql = statement.text.replace(/\s+/g, " ");
      expect(sql).toContain("candidate.id <> $1");
      expect(sql).toContain("candidate.status not in ('rejected', 'archived')");
      expect(sql).toContain("candidate.supersession_status = 'current'");
    }
  });

  it("orders the vector query by the raw distance and re-sorts outside, ending on content", () => {
    const sql = vector.text.replace(/\s+/g, " ");
    // A computed alias would hide the order from the HNSW index.
    expect(sql).toContain("order by e.embedding <=> $2::vector limit $4::int");
    expect(sql).toContain("from embeddings_256 e");
    expect(sql).toContain(
      'order by "vectorScore" desc, candidate.title, candidate.idea_statement, candidate.id'
    );
    expect(text.text.replace(/\s+/g, " ")).toContain(
      'order by "textScore" desc, candidate.title, candidate.idea_statement, candidate.id'
    );
    expect(vector.values).toEqual([
      "note",
      `[${embedding(0).join(",")}]`,
      "model",
      24,
      "space",
      "provider",
      "runtime"
    ]);
  });

  it("walks the sources below the roots of a fence, and only when there is one", () => {
    expect(text.text).not.toContain("fence_tree");
    expect(vector.text).not.toContain("fence_tree");
    const roots = ["00000000-0000-4000-8000-000000000001"];
    const fencedText = noteTextCandidatesStatement({
      noteId: "note",
      fence: { rootSourceItemIds: roots }
    });
    const fencedVector = noteVectorCandidatesStatement({
      noteId: "note",
      embedding: embedding(0),
      fence: { rootSourceItemIds: roots }
    });
    for (const statement of [fencedText, fencedVector]) {
      expect(statement.text).toContain("with recursive fence_tree(id)");
      expect(statement.text).toContain(
        "candidate.created_from_source_item_id in (select id from fence_tree)"
      );
    }
    expect(fencedText.values.at(-1)).toEqual(roots);
    expect(fencedText.text).toContain("any($5::uuid[])");
    expect(fencedVector.values.at(-1)).toEqual(roots);
    expect(fencedVector.text).toContain("any($8::uuid[])");
  });

  it("refuses a vector of a dimension that has no table", () => {
    expect(() => noteVectorCandidatesStatement({ noteId: "note", embedding: [1, 2, 3] })).toThrow(
      "Unsupported embedding dimension: 3"
    );
  });
});

describe("vector scan settings of a retrieval", () => {
  const result = { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] } as QueryResult;

  class Recorder implements Queryable {
    readonly sql: string[] = [];
    released = false;
    totalCount?: number;
    constructor(private readonly failOn?: string) {}
    async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
      this.sql.push(text);
      if (this.failOn && text === this.failOn) throw new Error("boom");
      return result as QueryResult<T>;
    }
    async connect() {
      return Object.assign(this, { release: () => (this.released = true) });
    }
  }

  it("applies them to one transaction of a pool and releases the connection", async () => {
    const pool = new Recorder();
    pool.totalCount = 0;
    await withVectorScanSettings(pool, (connection) => connection.query("select 1"));
    expect(pool.sql).toEqual(["begin", vectorScanSettingsSql, "select 1", "commit"]);
    expect(pool.released).toBe(true);
    expect(vectorScanSettingsSql).toContain("'hnsw.iterative_scan', 'relaxed_order', true");
    expect(vectorScanSettingsSql).toContain(
      `'hnsw.ef_search', '${noteRetrievalDefaults.hnswEfSearch}', true`
    );
    expect(vectorScanSettingsSql).toContain(
      `'random_page_cost', '${noteRetrievalDefaults.randomPageCost}', true`
    );
  });

  it("rolls back and releases when the query fails", async () => {
    const pool = new Recorder("select 1");
    pool.totalCount = 0;
    await expect(
      withVectorScanSettings(pool, (connection) => connection.query("select 1"))
    ).rejects.toThrow("boom");
    expect(pool.sql).toEqual(["begin", vectorScanSettingsSql, "select 1", "rollback"]);
    expect(pool.released).toBe(true);
  });

  it("leaves the transaction of a caller alone", async () => {
    const client = new Recorder();
    await withVectorScanSettings(client, (connection) => connection.query("select 1"));
    expect(client.sql).toEqual([vectorScanSettingsSql, "select 1"]);
  });
});

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = { rootA: u(1), chapterA: u(2), rootB: u(3), rootC: u(4) };

describe.skipIf(!sidecarInstalled)("note retrieval on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  // The planner reads a table this small with a scan; these settings make it choose the indexes the
  // queries are written for, as it does on a library of thousands of notes.
  let indexPool: pg.Pool;
  // The same for the GIN indexes, which only bitmap scans can use.
  let bitmapPool: pg.Pool;
  let notes: ReturnType<typeof createAtomicNoteRepository>;
  let indexNotes: ReturnType<typeof createAtomicNoteRepository>;
  let counter = 100;
  const chunkOf = new Map<string, string>();

  const space = {
    embeddingModel: "test-embedding",
    embeddingSpaceKey: "test-space",
    embeddingProvider: "test",
    embeddingRuntime: "none"
  };

  async function addNote(note: {
    id?: string;
    title: string;
    idea: string;
    body?: string;
    status?: string;
    supersession?: string;
    source?: string;
    theta?: number;
  }): Promise<string> {
    counter += 1;
    const id = note.id ?? u(counter);
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
          created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
          generation_runtime, generation_prompt_version, generation_key)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'test', 'test', 'local', 'test', $1::text)`,
      [
        id,
        note.title,
        note.body ?? note.idea,
        note.idea,
        note.status ?? "active",
        note.supersession ?? "current",
        note.source ?? ids.rootC,
        chunkOf.get(note.source ?? ids.rootC)
      ]
    );
    if (note.theta !== undefined)
      await pool.query(
        `insert into embeddings_256 (target_type, target_id, provider, model, runtime, strategy, content_hash, embedding)
         values ('atomic_note', $1, $2, $3, $4, 'native-v2:' || $5, 'hash', $6::vector)`,
        [
          id,
          space.embeddingProvider,
          space.embeddingModel,
          space.embeddingRuntime,
          space.embeddingSpaceKey,
          `[${embedding(note.theta).join(",")}]`
        ]
      );
    return id;
  }

  const vectorQuery = (
    repository: typeof notes,
    theta: number,
    extra: { limit?: number; fence?: { rootSourceItemIds: string[] } } = {}
  ) =>
    repository.findVectorMatchingCandidates({
      noteId: u(999_999),
      embedding: embedding(theta),
      ...space,
      ...extra
    });
  const idsOf = (candidates: Array<{ note: { id: string } }>) =>
    candidates.map((candidate) => candidate.note.id);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-note-retrieval-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_note_retrieval_test",
        user: "memora_note_retrieval_test",
        password: `note-retrieval-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    indexPool = new pg.Pool({
      connectionString: connection.connectionString,
      max: 2,
      options: "-c enable_seqscan=off -c enable_bitmapscan=off -c enable_sort=off"
    });
    bitmapPool = new pg.Pool({
      connectionString: connection.connectionString,
      max: 2,
      options: "-c enable_seqscan=off"
    });
    notes = createAtomicNoteRepository(pool);
    indexNotes = createAtomicNoteRepository(indexPool);
    const source = (id: string, type: string, title: string, parent: string | null) =>
      pool.query(
        "insert into source_items (id, type, title, parent_source_item_id) values ($1, $2, $3, $4)",
        [id, type, title, parent]
      );
    await source(ids.rootA, "Book", "Root A", null);
    await source(ids.chapterA, "BookChapter", "Chapter of A", ids.rootA);
    await source(ids.rootB, "Book", "Root B", null);
    await source(ids.rootC, "Book", "Root C", null);
    // A note's evidence chunk must belong to its source (a trigger enforces it).
    for (const sourceId of [ids.rootA, ids.chapterA, ids.rootB, ids.rootC]) {
      const documentId = randomUUID();
      const chunkId = randomUUID();
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'text', $3)`,
        [documentId, sourceId, `hash-${sourceId}`]
      );
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, 0, 'text', $4)`,
        [chunkId, documentId, sourceId, `chunk-${sourceId}`]
      );
      chunkOf.set(sourceId, chunkId);
    }
  }, 120_000);

  afterAll(async () => {
    if (indexPool) await indexPool.end().catch(() => undefined);
    if (bitmapPool) await bitmapPool.end().catch(() => undefined);
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("keeps the retrieval indexes in the schema", async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where indexname in ('atomic_notes_search_tsv_idx', 'atomic_notes_title_trgm_idx',
                            'embeddings_256_note_hnsw_idx', 'embeddings_768_note_hnsw_idx',
                            'embeddings_1024_note_hnsw_idx')`
    );
    const definition = (name: string) => rows.find((row) => row.indexname === name)?.indexdef ?? "";
    expect(rows).toHaveLength(5);
    expect(definition("atomic_notes_search_tsv_idx")).toContain("USING gin (search_tsv)");
    expect(definition("atomic_notes_title_trgm_idx")).toContain(
      "USING gin (f_unaccent(title) gin_trgm_ops)"
    );
    for (const dimensions of [256, 768, 1024])
      expect(definition(`embeddings_${dimensions}_note_hnsw_idx`)).toMatch(
        /USING hnsw \(embedding vector_cosine_ops\) WHERE \(target_type = 'atomic_note'/
      );
  });

  it("generates search_tsv from the title and idea (A) and the first 4,000 body characters (B)", async () => {
    const id = await addNote({
      title: "Coração e memória",
      idea: "Hippocampus consolidates sleep",
      body: `${"x ".repeat(1_995)}early late ${"y ".repeat(50)}beyond`
    });
    const row = (
      await pool.query<{ tsv: string }>(
        "select search_tsv::text as tsv from atomic_notes where id = $1",
        [id]
      )
    ).rows[0]!;
    // Accents and case are folded; the title and idea weigh A, the body B.
    expect(row.tsv).toContain("'coracao':1A");
    expect(row.tsv).toMatch(/'hippocampus':\d+A/);
    expect(row.tsv).toMatch(/'early':\d+B/);
    // Past 4,000 characters the body is not indexed.
    expect(row.tsv).not.toContain("'beyond'");
    // An edit regenerates it.
    await pool.query("update atomic_notes set title = 'Memória' where id = $1", [id]);
    const edited = await pool.query<{ tsv: string }>(
      "select search_tsv::text as tsv from atomic_notes where id = $1",
      [id]
    );
    expect(edited.rows[0]!.tsv).toContain("'memoria':1A");
    expect(edited.rows[0]!.tsv).not.toContain("'coracao'");
  });

  describe("text candidates", () => {
    it("finds notes by shared selective terms and by a similar title, folding accents", async () => {
      const subject = await addNote({
        title: "Neuroplasticidade durante o sono",
        idea: "O hipocampo consolida a memória durante o sono profundo"
      });
      const sharedTerm = await addNote({
        title: "A different heading entirely",
        idea: "Hipocampo lesions impair formation of new episodic traces"
      });
      const accentFolded = await addNote({
        title: "Another heading",
        idea: "Memoria depends on sono profundo rhythms"
      });
      // A title that is similar but shares no word with the subject: only the trigram index finds it.
      const similarTitle = await addNote({
        title: "Neuroplastcidade duranti o sonno",
        idea: "Wholly unrelated vocabulary here"
      });
      const stopWordsOnly = await addNote({
        title: "Zzzz",
        idea: "O que os para com uma the of and"
      });
      const found = idsOf(await notes.findTextMatchingCandidates({ noteId: subject, limit: 30 }));
      expect(found).toEqual(expect.arrayContaining([sharedTerm, accentFolded, similarTitle]));
      // A note that shares only function words with the subject is not a candidate.
      expect(found).not.toContain(stopWordsOnly);
      expect(found).not.toContain(subject);
    });

    it("leaves out superseded, archived and rejected notes", async () => {
      const subject = await addNote({
        title: "Quokka burrow ecology",
        idea: "Quokkas shelter in burrows during heat"
      });
      const copy = (status: string, supersession = "current") =>
        addNote({
          title: `Quokka burrow ecology ${status}${supersession}`,
          idea: "Quokkas shelter in burrows during heat",
          status,
          supersession
        });
      const eligible = [await copy("active"), await copy("pending_review"), await copy("approved")];
      const excluded = [
        await copy("rejected"),
        await copy("archived"),
        await copy("archived", "superseded"),
        await copy("active", "superseded")
      ];
      const found = idsOf(await notes.findTextMatchingCandidates({ noteId: subject, limit: 30 }));
      expect(found).toEqual(expect.arrayContaining(eligible));
      for (const id of excluded) expect(found).not.toContain(id);
    });

    it("drops a term found in more notes than the posting limit", async () => {
      const subject = await addNote({
        title: "Unique subject heading",
        idea: "Marsupial tardigrade ecology"
      });
      const rare = await addNote({ title: "Rare partner", idea: "Tardigrade desiccation" });
      for (let copy = 0; copy < 4; copy += 1)
        await addNote({ title: `Marsupial filler ${copy}`, idea: "Marsupial grazing habits" });
      const commonOnly = await addNote({
        title: "Common partner",
        idea: "Marsupial ecology notes"
      });
      const strict = idsOf(
        await notes.findTextMatchingCandidates({ noteId: subject, limit: 30, termPostingLimit: 3 })
      );
      expect(strict).toContain(rare);
      expect(strict).not.toContain(commonOnly);
      const lenient = idsOf(
        await notes.findTextMatchingCandidates({
          noteId: subject,
          limit: 30,
          termPostingLimit: 300
        })
      );
      expect(lenient).toContain(commonOnly);
    });

    it("ranks by score and breaks ties by title, idea and then ID, whatever the IDs are", async () => {
      const subject = await addNote({
        title: "Axolotl regeneration study",
        idea: "Axolotl limbs regenerate cartilage"
      });
      // Three identical-score copies inserted with IDs in the reverse order of their titles.
      const copies = [
        await addNote({
          id: u(5_003),
          title: "Copy c",
          idea: "Axolotl limbs regenerate cartilage tissue"
        }),
        await addNote({
          id: u(5_002),
          title: "Copy b",
          idea: "Axolotl limbs regenerate cartilage tissue"
        }),
        await addNote({
          id: u(5_001),
          title: "Copy a",
          idea: "Axolotl limbs regenerate cartilage tissue"
        })
      ];
      const first = idsOf(await notes.findTextMatchingCandidates({ noteId: subject, limit: 30 }));
      const order = copies.map((id) => first.indexOf(id));
      expect(order.every((position) => position >= 0)).toBe(true);
      // Titles a, b, c: the reverse of the insertion order.
      expect(order).toEqual([...order].sort((a, b) => b - a));
      expect(idsOf(await notes.findTextMatchingCandidates({ noteId: subject, limit: 30 }))).toEqual(
        first
      );
    });

    it("quotes the lexemes of urls, paths, e-mail addresses and punctuation into a valid query", async () => {
      const subject = await addNote({
        title: "Links & paths",
        idea: `See http://example.org/a?b=c&d=e, mail o'brien@example.org, C:\\Users\\x\\file.txt, "quoted" (c++) |!:*`
      });
      const partner = await addNote({
        title: "Partner for links",
        idea: "The page http://example.org/a?b=c&d=e explains it"
      });
      const found = idsOf(await notes.findTextMatchingCandidates({ noteId: subject, limit: 30 }));
      expect(found).toContain(partner);
    });

    it("returns nothing for a note without text or a note that does not exist", async () => {
      const empty = await addNote({ title: "", idea: "", body: "" });
      expect(await notes.findTextMatchingCandidates({ noteId: empty, limit: 30 })).toEqual([]);
      expect(await notes.findTextMatchingCandidates({ noteId: u(999_998), limit: 30 })).toEqual([]);
      expect(
        await notes.findTextMatchingCandidates({ noteId: empty, limit: 30, termLimit: 0 })
      ).toEqual([]);
    });

    it("uses both GIN indexes and no sequential scan of atomic_notes", async () => {
      const subject = await addNote({ title: "Plan check", idea: "Echolocation sonar bats" });
      const statement = noteTextCandidatesStatement({ noteId: subject, limit: 16 });
      const plan = await bitmapPool.query<{ "QUERY PLAN": string }>(
        `explain ${statement.text}`,
        statement.values
      );
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toContain("Bitmap Index Scan on atomic_notes_search_tsv_idx");
      expect(text).toContain("Bitmap Index Scan on atomic_notes_title_trgm_idx");
      expect(text).not.toMatch(/Seq Scan on atomic_notes/);
    });
  });

  describe("vector candidates", () => {
    const hnswPlan = async (repositoryPool: pg.Pool): Promise<string> => {
      const statement = noteVectorCandidatesStatement({
        noteId: u(999_999),
        embedding: embedding(0),
        ...space
      });
      const connection = await repositoryPool.connect();
      try {
        await connection.query("begin");
        await connection.query(vectorScanSettingsSql);
        const plan = await connection.query<{ "QUERY PLAN": string }>(
          `explain ${statement.text}`,
          statement.values
        );
        return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        await connection.query("rollback");
        connection.release();
      }
    };

    it("orders by the partial HNSW index of the dimension table", async () => {
      expect(await hnswPlan(indexPool)).toMatch(/Index Scan using embeddings_256_note_hnsw_idx/);
    });

    it("leaves out superseded, archived and rejected notes and orders by similarity", async () => {
      const nearest = await addNote({ title: "V near", idea: "v1", theta: 0.01 });
      const middle = await addNote({ title: "V middle", idea: "v2", theta: 0.3 });
      const excluded = [
        await addNote({ title: "V rejected", idea: "v3", theta: 0.0, status: "rejected" }),
        await addNote({ title: "V archived", idea: "v4", theta: 0.0, status: "archived" }),
        await addNote({
          title: "V superseded",
          idea: "v5",
          theta: 0.0,
          status: "archived",
          supersession: "superseded"
        })
      ];
      for (const repository of [notes, indexNotes]) {
        const found = await vectorQuery(repository, 0, { limit: 5 });
        const order = idsOf(found);
        for (const id of excluded) expect(order).not.toContain(id);
        expect(order.indexOf(nearest)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(nearest)).toBeLessThan(order.indexOf(middle));
        const scores = found.map((candidate) => candidate.vectorScore);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
        expect(found.every((candidate) => candidate.textScore === 0)).toBe(true);
      }
    });

    it("breaks ties by title and idea, whatever the IDs and the insertion order", async () => {
      const tied = [
        await addNote({ id: u(6_003), title: "Tie c", idea: "t", theta: 1.2 }),
        await addNote({ id: u(6_002), title: "Tie b", idea: "t", theta: 1.2 }),
        await addNote({ id: u(6_001), title: "Tie a", idea: "t", theta: 1.2 })
      ];
      for (const repository of [notes, indexNotes]) {
        const found = idsOf(await vectorQuery(repository, 1.2, { limit: 5 }));
        expect(found.slice(0, 3)).toEqual([tied[2], tied[1], tied[0]]);
      }
    });

    it("still returns the limit when the nearest vectors belong to excluded notes", async () => {
      // 160 archived notes are nearer than 60 eligible ones: more than the 100 candidates one HNSW
      // scan examines (hnsw.ef_search). Iterative scans keep reading the index until the filters
      // have let `limit` rows through.
      const base = 2.0;
      for (let step = 0; step < 160; step += 1)
        await addNote({
          title: `Starved archived ${step}`,
          idea: "s",
          theta: base + step * 1e-4,
          status: "archived"
        });
      const eligible: string[] = [];
      for (let step = 0; step < 60; step += 1)
        eligible.push(
          await addNote({
            title: `Starved eligible ${step}`,
            idea: "s",
            theta: base + 0.1 + step * 1e-3
          })
        );
      expect(await hnswPlan(indexPool)).toMatch(/embeddings_256_note_hnsw_idx/);
      const found = await vectorQuery(indexNotes, base, { limit: 10 });
      expect(found).toHaveLength(10);
      expect(idsOf(found).every((id) => eligible.includes(id))).toBe(true);

      // Without iterative scans the same statement starves.
      const statement = noteVectorCandidatesStatement({
        noteId: u(999_999),
        embedding: embedding(base),
        ...space,
        limit: 10
      });
      const connection = await indexPool.connect();
      try {
        await connection.query("begin");
        await connection.query("select set_config('hnsw.ef_search', '100', true)");
        const starved = await connection.query(statement.text, statement.values);
        expect(starved.rows.length).toBeLessThan(10);
      } finally {
        await connection.query("rollback");
        connection.release();
      }
    });

    it("keeps its HNSW settings to its own transaction", async () => {
      await vectorQuery(notes, 0, { limit: 3 });
      const setting = await pool.query<{ value: string }>(
        "select current_setting('hnsw.iterative_scan', true) as value"
      );
      expect(setting.rows[0]!.value ?? "off").not.toBe("relaxed_order");
    });
  });

  describe("the visibility fence", () => {
    it("shows only the notes of the roots it lets through, and their chapters", async () => {
      const inRoot = await addNote({
        title: "Fence quasar photometry",
        idea: "Quasar photometry calibrates luminosity",
        source: ids.rootA,
        theta: 2.5
      });
      const inChapter = await addNote({
        title: "Fence quasar photometry chapter",
        idea: "Quasar photometry calibrates luminosity",
        source: ids.chapterA,
        theta: 2.5
      });
      const elsewhere = await addNote({
        title: "Fence quasar photometry other",
        idea: "Quasar photometry calibrates luminosity",
        source: ids.rootB,
        theta: 2.5
      });
      const subject = await addNote({
        title: "Fence quasar photometry subject",
        idea: "Quasar photometry calibrates luminosity",
        source: ids.rootC,
        theta: 2.5
      });
      const textOf = (fence?: { rootSourceItemIds: string[] }) =>
        notes
          .findTextMatchingCandidates({ noteId: subject, limit: 30, ...(fence ? { fence } : {}) })
          .then(idsOf);
      const vectorOf = (fence?: { rootSourceItemIds: string[] }) =>
        vectorQuery(notes, 2.5, { limit: 30, ...(fence ? { fence } : {}) }).then(idsOf);

      for (const query of [textOf, vectorOf]) {
        const all = await query();
        expect(all).toEqual(expect.arrayContaining([inRoot, inChapter, elsewhere]));
        const fenced = await query({ rootSourceItemIds: [ids.rootA] });
        expect(fenced).toEqual(expect.arrayContaining([inRoot, inChapter]));
        expect(fenced).not.toContain(elsewhere);
        const other = await query({ rootSourceItemIds: [ids.rootB] });
        expect(other).toContain(elsewhere);
        expect(other).not.toContain(inRoot);
        expect(other).not.toContain(inChapter);
        // An empty fence hides everything.
        expect(await query({ rootSourceItemIds: [] })).toEqual([]);
      }
    });

    it("keeps returning the limit behind a fence over the iterative scan", async () => {
      const fenced = await vectorQuery(indexNotes, 2.5, {
        limit: 2,
        fence: { rootSourceItemIds: [ids.rootA] }
      });
      expect(fenced).toHaveLength(2);
    });
  });
});
