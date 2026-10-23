import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  budgetedQueries,
  closePgPool,
  createPgPool,
  StatementBudgetError,
  type PgPool
} from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  contentTsvectorCalls,
  planExpressions,
  planNodes,
  scanPlacements,
  storedVectorReads,
  tsvectorCalls,
  type PlanNode
} from "./consultationPlan.js";
import {
  consultationCandidatesSql,
  createConsultationRepository
} from "./consultationRepository.js";

// Ask's candidate retrieval against a real PostgreSQL database: which summary concepts and source
// relations count as signals of which passages, and the statement budget an Ask runs under.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** Four sources; D stays out of the scope asked about. C's summary is stale. E and F hold the accents. */
const source = { a: u(1), b: u(2), c: u(3), d: u(4), e: u(5), f: u(6) };
const chunk = {
  a0: u(21),
  a1: u(22),
  b0: u(31),
  b1: u(32),
  c0: u(41),
  d0: u(51),
  e0: u(61),
  e1: u(62),
  e2: u(63),
  f0: u(71)
};
const question = "How does photosynthesis work?";

describe.skipIf(!sidecarInstalled)("Ask retrieval on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;
  /** The rank the retrieval gives a text for the question (its `terms` expression). */
  const rank = async (text: string) =>
    (
      await pool.query(
        `select ts_rank_cd(to_tsvector('simple',unaccent($1)),(select to_tsquery('simple',coalesce(nullif(string_agg(quote_literal(word),' | '),''),'''__empty__''')) from (select distinct unnest(tsvector_to_array(to_tsvector('simple',unaccent($2)))) as word) words)) as rank`,
        [text, question]
      )
    ).rows[0].rank as number;
  const signals = async (reviewedOnly: boolean) => {
    const rows = await createConsultationRepository(pool).candidates(
      [source.a, source.b, source.c],
      question,
      reviewedOnly
    );
    return Object.fromEntries(
      rows.map((row) => [
        Object.entries(chunk).find(([, id]) => id === row.chunkId)![0],
        { concept: row.concept as number, relation: row.relation as number, total: row.total }
      ])
    );
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-ask-retrieval-"));
    // Parallel test files pick free ports the same way; a lost race needs only a fresh attempt.
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_ask_retrieval_test",
        user: "memora_ask_retrieval_test",
        password: `ask-retrieval-${randomUUID()}`,
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

    const passages: Record<string, string[]> = {
      [source.a]: [chunk.a0, chunk.a1],
      [source.b]: [chunk.b0, chunk.b1],
      [source.c]: [chunk.c0],
      [source.d]: [chunk.d0]
    };
    for (const [n, [id, ids]] of Object.entries(passages).entries()) {
      await pool.query(
        "insert into source_items (id, type, title, metadata) values ($1, 'WebArticle', $2, $3)",
        [id, `Source ${n}`, id === source.c ? { summaryStale: "true" } : {}]
      );
      const document = randomUUID();
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'text', $3)`,
        [document, id, `document-${n}`]
      );
      for (const [index, chunkId] of ids.entries())
        await pool.query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           values ($1, $2, $3, $4, 'A plain passage.', $5)`,
          [chunkId, document, id, index, `hash-${chunkId}`]
        );
    }

    const summary = (sourceItemId: string, concepts: unknown[], isCurrent = true) =>
      pool.query(
        `insert into source_summaries (source_item_id, is_current, summary, provider, model,
           runtime, prompt_version, input_hash, output_hash, metadata)
         values ($1, $2, 'Summary.', 'seed', 'seed', 'local', 'seed', 'in', 'out', $3)`,
        [sourceItemId, isCurrent, { concepts }]
      );
    await summary(source.a, [
      { idea: "Photosynthesis turns light into sugar", evidenceChunkIds: [chunk.a0] },
      { idea: "An unrelated idea", evidenceChunkIds: [chunk.a1] },
      // Would outrank the first if it counted: one of its passages is outside the scope.
      { idea: "How does photosynthesis work", evidenceChunkIds: [chunk.a0, chunk.d0] }
    ]);
    // An earlier summary of A no longer counts.
    await summary(
      source.a,
      [{ idea: "How does photosynthesis work", evidenceChunkIds: [chunk.a1] }],
      false
    );
    // None of B's concepts is grounded, and none of the malformed ones fails the query.
    await summary(source.b, [
      { idea: "photosynthesis", evidenceChunkIds: [chunk.b0, chunk.d0] },
      { idea: "photosynthesis", evidenceChunkIds: [chunk.b0.toUpperCase()] },
      { idea: "photosynthesis", evidenceChunkIds: [chunk.b0, null] },
      { idea: "photosynthesis", evidenceChunkIds: ["not-a-chunk"] },
      { idea: "photosynthesis", evidenceChunkIds: chunk.b0 },
      { idea: "photosynthesis", evidenceChunkIds: { first: chunk.b0 } },
      { idea: "photosynthesis", evidenceChunkIds: [] },
      { idea: "photosynthesis" },
      "photosynthesis, a legacy concept string"
    ]);
    // C's summary is stale: its grounded concept does not count.
    await summary(source.c, [{ idea: "photosynthesis", evidenceChunkIds: [chunk.c0] }]);

    const relation = async (
      key: string,
      from: string,
      to: string,
      status: string,
      explanation: string,
      evidence: { from: string; to: string; stale?: boolean }
    ) => {
      const id = randomUUID();
      await pool.query(
        `insert into source_relations (id, source_item_id, target_source_item_id, identity_key,
           relation_type, source_idea, target_idea, explanation, importance, confidence, status)
         values ($1, $2, $3, $4, 'supports', 'An idea', 'Another idea', $5, 0.9, 0.9, $6)`,
        [id, from, to, key, explanation, status]
      );
      await pool.query(
        `insert into source_relation_evidence (relation_id, evidence_key, origin, source_chunk_id,
           target_chunk_id, snapshot)
         values ($1, 'evidence', 'source_analysis', $2, $3, $4)`,
        [
          id,
          evidence.from,
          evidence.to,
          {
            sourceHash: evidence.stale ? "an earlier text" : `hash-${evidence.from}`,
            targetHash: `hash-${evidence.to}`
          }
        ]
      );
    };
    await relation("r1", source.a, source.b, "pending_review", "photosynthesis", {
      from: chunk.a1,
      to: chunk.b1
    });
    // Rejected, stale and out-of-scope relations would outrank r1 if they counted.
    const strong = "how does photosynthesis work";
    await relation("r2", source.a, source.b, "rejected", strong, { from: chunk.a0, to: chunk.b0 });
    await relation("r3", source.a, source.b, "accepted", strong, {
      from: chunk.a0,
      to: chunk.b1,
      stale: true
    });
    await relation("r4", source.a, source.d, "accepted", strong, { from: chunk.a0, to: chunk.d0 });
    await relation("r5", source.b, source.c, "accepted", "photosynthesis work", {
      from: chunk.b0,
      to: chunk.c0
    });

    // Sources and passages whose text only the stored vectors have to rank the way unaccent() did:
    // accents, capitals, repeated words, a title that is the question, notes of every standing,
    // and entities named and aliased with accents.
    const text = {
      [chunk.e0]:
        "La fotosíntesis convierte la luz en azúcar. Photosynthesis, PHOTOSYNTHESIS: ação, coração.",
      [chunk.e1]: "Plain passage without the subject, only água and memória.",
      [chunk.e2]:
        "How does it work? Água, ÁGUA e agua; fotossíntese — photosynthesis (work work work).",
      [chunk.f0]: "Nada que ver con el asunto."
    };
    const titles = {
      [source.e]: "Fotosíntesis y Photosynthesis",
      [source.f]: "how does PHOTOSYNTHESIS work?"
    };
    const layout: [string, string[]][] = [
      [source.e, [chunk.e0, chunk.e1, chunk.e2]],
      [source.f, [chunk.f0]]
    ];
    for (const [id, ids] of layout) {
      await pool.query("insert into source_items (id, type, title) values ($1, 'WebArticle', $2)", [
        id,
        titles[id]
      ]);
      const document = randomUUID();
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'text', $3)`,
        [document, id, `document-${id}`]
      );
      for (const [index, chunkId] of ids.entries())
        await pool.query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           values ($1, $2, $3, $4, $5, $6)`,
          [chunkId, document, id, index, text[chunkId], `hash-${chunkId}`]
        );
    }
    const note = (
      evidence: string,
      idea: string,
      body: string,
      status: string,
      supersession = "current"
    ) =>
      pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
           evidence_chunk_id, generation_provider, generation_model, generation_runtime,
           generation_prompt_version, generation_key, status, supersession_status)
         values ($1::uuid, 'Note', $2, $3, $4, $5, 't', 't', 'local', 't', $1::text, $6, $7)`,
        [randomUUID(), body, idea, source.e, evidence, status, supersession]
      );
    // Two current notes on e0 (the best counts), one approved note on e2, and notes that never count.
    await note(chunk.e0, "La fotosíntesis es el camino", "Cuerpo: luz, azúcar y ação.", "active");
    await note(chunk.e0, "Photosynthesis", "Photosynthesis photosynthesis work.", "active");
    await note(chunk.e2, "Água y memória", "Fotossíntese e work.", "approved");
    await note(chunk.e1, "Photosynthesis work", "Rejected.", "rejected");
    await note(chunk.e1, "Photosynthesis work", "Superseded.", "active", "superseded");
    const entity = async (name: string, aliases: string[], chunks: string[]) => {
      const id = randomUUID();
      await pool.query(
        `insert into entities (id, type, canonical_name, normalized_name, aliases, confidence)
         values ($1, 'concept', $2, lower($2), $3, 0.9)`,
        [id, name, JSON.stringify(aliases)]
      );
      for (const chunkId of chunks)
        await pool.query(
          `insert into entity_mentions (entity_id, source_item_id, chunk_id, surface_text, confidence)
           values ($1, $2, $3, $4, 0.9)`,
          [id, source.e, chunkId, name]
        );
    };
    await entity("Fotosíntesis", ["photosynthesis", "Fotosintesis"], [chunk.e0, chunk.e2]);
    await entity("Ação", ["acao"], [chunk.e0]);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("gives every passage of a source its best grounded concept of the current, fresh summary", async () => {
    const concept = await rank("Photosynthesis turns light into sugar");
    expect(concept).toBeGreaterThan(0);
    const all = await signals(false);
    expect(Object.keys(all).toSorted()).toEqual(["a0", "a1", "b0", "b1", "c0"]);
    expect(all.a0!.total).toBe(5);
    expect(all.a0!.concept).toBeCloseTo(concept, 6);
    expect(all.a1!.concept).toBeCloseTo(concept, 6);
    for (const name of ["b0", "b1", "c0"]) expect(all[name]!.concept, name).toBe(0);
  });

  it("ranks a passage by the current relations its evidence rests on, on either side", async () => {
    const [r1, r5] = [
      await rank("An idea Another idea photosynthesis"),
      await rank("An idea Another idea photosynthesis work")
    ];
    const all = await signals(false);
    expect(all.a0!.relation).toBe(0);
    expect(all.a1!.relation).toBeCloseTo(r1, 6);
    expect(all.b1!.relation).toBeCloseTo(r1, 6);
    expect(all.b0!.relation).toBeCloseTo(r5, 6);
    expect(all.c0!.relation).toBeCloseTo(r5, 6);
  });

  it("keeps only accepted relations and no concept when only reviewed material may answer", async () => {
    const r5 = await rank("An idea Another idea photosynthesis work");
    const reviewed = await signals(true);
    for (const name of ["a0", "a1", "b0", "b1", "c0"])
      expect(reviewed[name]!.concept, name).toBe(0);
    expect(reviewed.a1!.relation).toBe(0);
    expect(reviewed.b1!.relation).toBe(0);
    expect(reviewed.b0!.relation).toBeCloseTo(r5, 6);
    expect(reviewed.c0!.relation).toBeCloseTo(r5, 6);
  });

  it("ranks the stored text vectors as unaccent() ranked the text before, to 1e-9", async () => {
    // Every signal the migration stored, recomputed per row with the expressions the statement
    // used before 0064: unaccent() at query time over the text of the passage, the note, the
    // title and the entity.
    const before = async (sources: string[], asked: string) =>
      new Map(
        (
          await pool.query(
            `with terms as(select to_tsquery('simple',coalesce(nullif(string_agg(quote_literal(word),' | '),''),'''__empty__''')) as q from (select distinct unnest(tsvector_to_array(to_tsvector('simple',unaccent($2)))) as word) words)
             select c.id as "chunkId",
               ts_rank_cd(to_tsvector('simple',unaccent(c.content)),terms.q) as text,
               case when unaccent(lower(s.title))=unaccent(lower($2)) then 1 else ts_rank_cd(to_tsvector('simple',unaccent(s.title)),terms.q) end as title,
               coalesce((select max(ts_rank_cd(to_tsvector('simple',unaccent(n.idea_statement||' '||n.body_markdown)),terms.q)) from atomic_notes n where n.evidence_chunk_id=c.id and n.status not in('rejected','archived') and n.supersession_status='current'),0) as note,
               coalesce((select max(ts_rank_cd(to_tsvector('simple',unaccent(e.canonical_name||' '||e.aliases::text)),terms.q)) from entity_mentions m join entities e on e.id=m.entity_id where m.chunk_id=c.id and m.source_item_id=c.source_item_id),0) as entity
             from chunks c join source_items s on s.id=c.source_item_id cross join terms
             where c.source_item_id=any($1::uuid[])`,
            [sources, asked]
          )
        ).rows.map((row) => [row.chunkId as string, row] as const)
      );
    const sources = [source.e, source.f, source.a];
    const questions = [
      question,
      "Fotosíntesis, ação e memória",
      "fotosintesis AGUA work",
      "how does photosynthesis work?",
      "PHOTOSYNTHESIS",
      "???",
      "unrelated words only"
    ];
    let compared = 0;
    let positive = 0;
    for (const asked of questions) {
      const expected = await before(sources, asked);
      const rows = await createConsultationRepository(pool).candidates(sources, asked, false);
      expect(rows.length).toBe(expected.size);
      for (const row of rows) {
        const was = expected.get(row.chunkId)!;
        for (const signal of ["text", "title", "note", "entity"] as const) {
          expect(
            Math.abs(Number(row[signal]) - Number(was[signal])),
            `${signal} of ${row.chunkId} for "${asked}"`
          ).toBeLessThanOrEqual(1e-9);
          compared += 1;
          if (Number(was[signal]) > 0) positive += 1;
        }
      }
    }
    // The comparison is not vacuous: accents, a title equal to the question and notes all rank.
    expect(compared).toBeGreaterThan(80);
    expect(positive).toBeGreaterThan(25);
    const exact = (
      await createConsultationRepository(pool).candidates([source.f], question, false)
    )[0]!;
    expect(exact.title).toBe(1);
  });

  it("counts only the approved notes of a reviewed answer and no entity", async () => {
    const asked = "Photosynthesis ação água";
    const reviewed = await createConsultationRepository(pool).candidates([source.e], asked, true);
    const byChunk = Object.fromEntries(reviewed.map((row) => [row.chunkId as string, row]));
    // Only e2's note is approved; e0's notes are active, e1's are rejected or superseded.
    expect(Number(byChunk[chunk.e2]!.note)).toBeGreaterThan(0);
    expect(Number(byChunk[chunk.e0]!.note)).toBe(0);
    expect(Number(byChunk[chunk.e1]!.note)).toBe(0);
    for (const row of reviewed) expect(Number(row.entity), "no entity when reviewed").toBe(0);
    const open = Object.fromEntries(
      (await createConsultationRepository(pool).candidates([source.e], asked, false)).map((row) => [
        row.chunkId as string,
        row
      ])
    );
    expect(Number(open[chunk.e0]!.note)).toBeGreaterThan(0);
    expect(Number(open[chunk.e1]!.note)).toBe(0);
    expect(Number(open[chunk.e0]!.entity)).toBeGreaterThan(0);
  });

  /** The plan of the statement `candidates` sends, captured as it goes to the pool and not run. */
  const candidatesPlan = async (setting = ""): Promise<PlanNode> => {
    const sent: { text: string; values: unknown[] }[] = [];
    const spy = {
      query: ((text: string, values?: unknown[]) => {
        sent.push({ text, values: values ?? [] });
        return Promise.resolve({ rows: [] });
      }) as unknown as PgPool["query"]
    };
    await createConsultationRepository(spy).candidates(
      [source.a, source.b, source.c],
      question,
      false
    );
    expect(sent).toHaveLength(1);
    const { text, values } = sent[0]!;
    expect(text).toBe(consultationCandidatesSql);
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (setting) await client.query(setting);
      const { rows } = await client.query(`explain (verbose, format json) ${text}`, values);
      await client.query("rollback");
      return (rows[0]["QUERY PLAN"] as { Plan: PlanNode }[])[0]!.Plan;
    } finally {
      client.release();
    }
  };

  it("evaluates every signal that is not the chunk's once per statement, never per candidate row", async () => {
    // Only the plan is read, so the guard holds whatever the data and whatever plan statistics would choose.
    const plan = await candidatesPlan();
    // The scans that once ran for every candidate chunk: the summaries and their concepts, the
    // evidence of source relations, the check of a concept's evidence IDs against the chunks in
    // scope (`chunks cc`), and the entities mentioned in a chunk with the text of each.
    const scans = {
      source_summaries: scanPlacements(plan, "source_summaries"),
      source_relation_evidence: scanPlacements(plan, "source_relation_evidence"),
      "chunks cc": scanPlacements(plan, "chunks", "cc"),
      entity_mentions: scanPlacements(plan, "entity_mentions"),
      entities: scanPlacements(plan, "entities")
    };
    for (const [name, found] of Object.entries(scans)) {
      expect(found.length, `${name} is read by the statement`).toBeGreaterThan(0);
      for (const { cte, inSubPlan } of found) {
        // The `candidates` CTE holds the per-chunk rows: what it reads in a SubPlan runs per row.
        expect(cte, `${name} is read inside a CTE of its own`).toBeDefined();
        expect(cte, `${name} is read outside the per-chunk CTE`).not.toBe("CTE candidates");
        expect(inSubPlan, `${name} is not read in a SubPlan`).toBe(false);
      }
    }
  });

  it("reads the stored text vectors and parses no text of a passage or a note", async () => {
    const plan = await candidatesPlan();
    expect(storedVectorReads(plan)).toEqual({ passages: true, notes: true });
    expect(contentTsvectorCalls(plan)).toEqual([]);
    // Nothing is parsed per candidate row at all: the titles, entities and concepts it still parses
    // sit in CTEs of their own.
    const candidates = planNodes(plan).find(
      ({ node }) => node["Subplan Name"] === "CTE candidates"
    )!.node;
    expect(planExpressions(candidates).flatMap(tsvectorCalls)).toEqual([]);
  });

  it("recognizes the expressions the statement ran before the stored vectors", () => {
    const before: PlanNode = {
      "Node Type": "Seq Scan",
      Output: [
        "ts_rank_cd(to_tsvector('simple'::regconfig, unaccent(c.content)), terms.q)",
        "(SubPlan 2)"
      ],
      Plans: [
        {
          "Node Type": "Index Scan",
          "Parent Relationship": "SubPlan",
          Output: [
            "max(ts_rank_cd(to_tsvector('simple'::regconfig, unaccent(((n.idea_statement || ' '::text) || n.body_markdown))), terms.q))"
          ]
        }
      ]
    };
    expect(contentTsvectorCalls(before)).toHaveLength(2);
    expect(storedVectorReads(before)).toEqual({ passages: false, notes: false });
    // Only the scan of the table that owns the column counts: the notes' weighted vector of 0058 is
    // not Ask's, and the stored vectors are read where their tables are scanned.
    const after: PlanNode = {
      "Node Type": "Nested Loop",
      Plans: [
        { "Node Type": "Seq Scan", "Relation Name": "chunks", Output: ["c.id", "c.search_tsv"] },
        {
          "Node Type": "Index Scan",
          "Relation Name": "atomic_notes",
          Output: ["n.search_tsv", "n.ask_tsv"]
        }
      ]
    };
    expect(storedVectorReads(after)).toEqual({ passages: true, notes: true });
    expect(
      storedVectorReads({
        "Node Type": "Index Scan",
        "Relation Name": "atomic_notes",
        Output: ["n.search_tsv"]
      })
    ).toEqual({ passages: false, notes: false });
    // A title or an entity name is not the text of a passage or a note.
    expect(
      contentTsvectorCalls({
        "Node Type": "Result",
        Output: ["to_tsvector('simple'::regconfig, unaccent(s.title))"]
      })
    ).toEqual([]);
  });

  it("finds the notes resting on a passage through their evidence index", async () => {
    await pool.query("analyze atomic_notes");
    const plan = await candidatesPlan("set local enable_seqscan = off");
    // The per-passage lookup sits in `candidates`; the topic scope reads the notes in a CTE of its own.
    const notes = scanPlacements(plan, "atomic_notes").filter(
      ({ cte }) => cte === "CTE candidates"
    );
    expect(notes.map(({ index }) => index)).toEqual(["atomic_notes_evidence_chunk_id_idx"]);
  });

  it("stops a statement at its caller's remaining budget and leaves no setting behind", async () => {
    const started = Date.now();
    await expect(
      budgetedQueries(pool, () => 300).query("select pg_sleep(10)")
    ).rejects.toBeInstanceOf(StatementBudgetError);
    expect(Date.now() - started).toBeLessThan(5_000);
    const { rows } = await budgetedQueries(pool, () => 45_000).query<{ timeout: string }>(
      "select current_setting('statement_timeout') as timeout"
    );
    expect(rows[0]!.timeout).toBe("45s");
    const sessions = await Promise.all(
      [1, 2, 3, 4].map(() => pool.query<{ statement_timeout: string }>("show statement_timeout"))
    );
    expect(sessions.map((result) => result.rows[0]!.statement_timeout)).toEqual([
      "0",
      "0",
      "0",
      "0"
    ]);
  });
});
