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
import { createConsultationRepository } from "./consultationRepository.js";

// Ask's candidate retrieval against a real PostgreSQL database: which summary concepts and source
// relations count as signals of which passages, and the statement budget an Ask runs under.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** Four sources; D stays out of the scope asked about. C's summary is stale. */
const source = { a: u(1), b: u(2), c: u(3), d: u(4) };
const chunk = { a0: u(21), a1: u(22), b0: u(31), b1: u(32), c0: u(41), d0: u(51) };
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
