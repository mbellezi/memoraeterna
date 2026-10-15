import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import type { ConsultationInput, ConsultationResult } from "@app/domain";

import { ConsultationService } from "./consultation-service.js";

/**
 * Real-database proof that Ask answers from sources, chunks, notes, summary concepts, entity
 * mentions and source relations alone: on a small library it checks scope, descendants, the
 * reviewed-only filter, optional context and relations, staleness, and that the answer and the
 * prompt are identical after every legacy wiki, organization, maintenance and impact table is
 * dropped. It starts its own temporary PostgreSQL sidecar and touches no other database.
 *
 *   npx tsx apps/desktop/src/main/services/verify-consultation.ts
 */
const workspace = resolve(import.meta.dirname, "../../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const workDir = await mkdtemp(join(tmpdir(), "memora-consultation-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_consultation",
  user: "memora_consultation",
  password: `consultation-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const report: Record<string, unknown> = {};
const round = (value: number) => Math.round(value * 100) / 100;
const id = () => randomUUID();

const profile = {
  profileId: id(),
  providerConfigId: null,
  localModelId: id(),
  provider: "fixture",
  modelId: "fixture-model",
  runtime: "test",
  revision: null,
  privacy: "offline_only" as const,
  parameters: {},
  identityHash: "fixture",
  contextWindow: 65536
};
const book = id(),
  chapter = id(),
  paper = id(),
  astronomy = id();
const chunk = { c1: id(), c2: id(), c3: id(), p1: id(), p2: id(), a1: id() };
const note = { approved: id(), active: id() };
const entity = id(),
  relation = id();

async function seed(db: PgPool) {
  await db.query(
    `insert into source_items (id, type, title, parent_source_item_id) values
       ($1, 'Book', 'Learning Science', null),
       ($2, 'BookChapter', 'Learning Science chapter 1', $1),
       ($3, 'AcademicPaper', 'Feedback Study', null),
       ($4, 'AcademicPaper', 'Astronomy Notes', null)`,
    [book, chapter, paper, astronomy]
  );
  const documents = { chapter: id(), paper: id(), astronomy: id() };
  await db.query(
    `insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values
       ($1, $4, 'Chapter', 'seed', 'doc-chapter'), ($2, $5, 'Paper', 'seed', 'doc-paper'),
       ($3, $6, 'Astronomy', 'seed', 'doc-astronomy')`,
    [documents.chapter, documents.paper, documents.astronomy, chapter, paper, astronomy]
  );
  const rows: Array<[string, string, string, number, string]> = [
    [
      chunk.c1,
      documents.chapter,
      chapter,
      0,
      "Retrieval practice improved delayed recall in a classroom study."
    ],
    [
      chunk.c2,
      documents.chapter,
      chapter,
      1,
      "Spacing the practice sessions further improved delayed recall."
    ],
    [
      chunk.c3,
      documents.chapter,
      chapter,
      2,
      "Beginners gained less from practice without feedback."
    ],
    [
      chunk.p1,
      documents.paper,
      paper,
      0,
      "Feedback after retrieval corrected mistakes and improved delayed recall."
    ],
    [
      chunk.p2,
      documents.paper,
      paper,
      1,
      "Without feedback, retrieval practice did not help beginners."
    ],
    [chunk.a1, documents.astronomy, astronomy, 0, "Stars form inside dense molecular clouds."]
  ];
  for (const [chunkId, documentId, sourceId, index, content] of rows)
    await db.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, $4, $5, md5($5))`,
      [chunkId, documentId, sourceId, index, content]
    );
  for (const [noteId, status, chunkId, sourceId, title] of [
    [note.approved, "approved", chunk.c1, chapter, "Retrieval practice"],
    [note.active, "active", chunk.p1, paper, "Feedback and retrieval"]
  ] as const) {
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
          ownership, created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
          generation_runtime, generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, $5::atomic_note_status, 'current', 'source', $6, $7, 'seed', 'seed', 'local', 'seed', $8)`,
      [
        noteId,
        title,
        `${title} body.`,
        `${title} supports delayed recall`,
        status,
        sourceId,
        chunkId,
        `key-${noteId}`
      ]
    );
    await db.query(
      `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id) values ($1, $2, $3)`,
      [noteId, sourceId, chunkId]
    );
  }
  await db.query(
    `insert into source_summaries (source_item_id, summary, provider, model, runtime, prompt_version, input_hash, output_hash, metadata)
     values ($1, 'A summary.', 'seed', 'seed', 'local', 'seed', 'in', 'out', $2::jsonb)`,
    [
      chapter,
      JSON.stringify({
        concepts: [
          { idea: "retrieval practice improves delayed recall", evidenceChunkIds: [chunk.c1] }
        ]
      })
    ]
  );
  await db.query(
    `insert into entities (id, type, canonical_name, normalized_name, confidence) values ($1, 'concept', 'Retrieval practice', 'retrieval practice', 0.9)`,
    [entity]
  );
  await db.query(
    `insert into entity_mentions (entity_id, source_item_id, chunk_id, surface_text, confidence) values ($1, $2, $3, 'retrieval practice', 0.9)`,
    [entity, chapter, chunk.c1]
  );
  await db.query(
    `insert into source_relations (id, source_item_id, target_source_item_id, identity_key, relation_type, source_idea, target_idea, explanation, importance, confidence, status)
     values ($1, $2, $3, 'verify-consultation', 'supports', 'Practice', 'Feedback', 'The paper shows feedback strengthens the practice effect.', 0.8, 0.8, 'accepted')`,
    [relation, chapter, paper]
  );
  await db.query(
    `insert into source_relation_evidence (relation_id, evidence_key, origin, source_chunk_id, target_chunk_id, snapshot)
     select $1, 'k1', 'source_analysis', $2, $3, jsonb_build_object('sourceHash', (select content_hash from chunks where id = $2), 'targetHash', (select content_hash from chunks where id = $3))`,
    [relation, chunk.c1, chunk.p1]
  );
}

/** The fake model answers by citing the first passage it was given; what it saw is recorded. */
function asker(db: PgPool, onModelCall?: () => Promise<void>) {
  const prompts: string[] = [];
  const service = new ConsultationService({
    getPool: () => db,
    contentLanguage: async () => "en",
    ai: {
      pinOrganizationProfile: async () => profile,
      runConsultationEmbedding: async () => null,
      runOrganizationTask: async (_profile: unknown, prompt: string) => {
        prompts.push(prompt);
        await onModelCall?.();
        const handle = /"handle":"(e\d+)"/.exec(prompt)?.[1] ?? "e1";
        return {
          output: JSON.stringify({
            paragraphs: [
              {
                markdown: `Retrieval practice helps [${handle}].`,
                citations: [handle],
                contextIds: []
              }
            ],
            gaps: []
          }),
          aiTaskRunId: randomUUID(),
          inputTokens: 100,
          outputTokens: 20,
          costEstimate: 0
        };
      }
    } as never
  });
  const ask = async (overrides: Partial<ConsultationInput> = {}) => {
    const started = performance.now();
    const result = await service.ask({
      requestId: randomUUID(),
      question: "Does retrieval practice improve delayed recall?",
      ...overrides
    } as ConsultationInput);
    return { result, ms: round(performance.now() - started) };
  };
  return { ask, prompts };
}
const titles = (result: ConsultationResult) =>
  [...new Set(result.evidence.map((e) => e.sourceTitle))].toSorted();
/** What must not change when the legacy tables disappear: everything but the request id. */
const comparable = (result: ConsultationResult) => ({ ...result, id: null });

try {
  const connection = await manager.start();
  const db = createPgPool({ connectionString: connection.connectionString, max: 8 });
  await runMigrations(db, migrationsFolder);
  await seed(db);

  // 1. The whole library: passages, notes, concepts, entities and relations reach the model.
  const first = asker(db);
  const whole = await first.ask();
  assert.deepEqual(titles(whole.result), ["Feedback Study", "Learning Science chapter 1"]);
  assert.ok(!whole.result.evidence.some((e) => e.chunkId === chunk.a1), "an unrelated passage");
  assert.deepEqual(
    whole.result.contexts.map((c) => c.kind).toSorted(),
    ["atomic_note", "atomic_note", "entity_mention", "summary"],
    "optional context from notes, a grounded concept and an entity"
  );
  for (const signal of ["text", "note", "concept", "entity", "relation"])
    assert.ok(whole.result.coverage.signals.includes(signal), `signal ${signal}`);
  assert.ok(first.prompts[0]!.includes("The paper shows feedback strengthens"), "the relation");
  assert.ok(first.prompts[0]!.includes("Retrieval practice supports delayed recall"), "the note");
  assert.equal(whole.result.coverage.stale, false);
  assert.equal(whole.result.coverage.sourceCount, 4);
  assert.equal(whole.result.answer.paragraphs[0]!.citations.length, 1);
  report.library = {
    ms: whole.ms,
    evidence: whole.result.evidence.length,
    contexts: whole.result.contexts.length,
    signals: whole.result.coverage.signals
  };

  // 2. Scope: chosen sources, and descendants only when asked for.
  const scoped = await asker(db).ask({ sourceIds: [paper] });
  assert.deepEqual(titles(scoped.result), ["Feedback Study"]);
  await assert.rejects(
    asker(db).ask({ sourceIds: [book] }),
    /consultation\.errors\.noRelevantEvidence/,
    "a book has no passages of its own"
  );
  const descendants = await asker(db).ask({ sourceIds: [book], includeDescendants: true });
  assert.deepEqual(titles(descendants.result), ["Learning Science chapter 1"]);
  report.scope = { chosen: scoped.ms, descendants: descendants.ms };

  // 3. Reviewed only: approved notes, and no concepts or entities.
  const reviewed = await asker(db).ask({ reviewedOnly: true });
  assert.deepEqual(
    reviewed.result.contexts.map((c) => [c.kind, c.review]),
    [["atomic_note", "approved"]]
  );

  // 4. Staleness: material that changes while the model answers is flagged.
  const edited = await asker(db, async () => {
    await db.query("update chunks set content_hash = 'changed' where id = $1", [chunk.c1]);
  }).ask();
  assert.equal(edited.result.coverage.stale, true, "a passage changed during the answer");
  await db.query("update chunks set content_hash = md5(content) where id = $1", [chunk.c1]);
  const rewritten = await asker(db, async () => {
    await db.query("update atomic_notes set body_markdown = 'Rewritten.' where id = $1", [
      note.approved
    ]);
  }).ask();
  assert.equal(rewritten.result.coverage.stale, true, "a note changed during the answer");
  await db.query(
    "update atomic_notes set body_markdown = 'Retrieval practice body.' where id = $1",
    [note.approved]
  );
  const settled = await asker(db).ask();
  assert.equal(settled.result.coverage.stale, false);

  // 5. Ask needs no legacy table: drop every wiki, organization, maintenance and impact table.
  const legacy = (
    await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'
         and tablename ~ '^(wiki_|organization_|maintenance_|automatic_routine_|knowledge_impact_)'`
    )
  ).rows.map((row) => row.tablename);
  assert.ok(legacy.length >= 30, `found ${legacy.length} legacy tables`);
  const before = asker(db),
    reference = await before.ask({ requestId: id() });
  for (const table of legacy) await db.query(`drop table if exists "${table}" cascade`);
  const remaining = await db.query(
    `select count(*)::int as count from pg_tables where schemaname = 'public'
       and tablename ~ '^(wiki_|organization_|maintenance_|automatic_routine_|knowledge_impact_)'`
  );
  assert.equal(remaining.rows[0]!.count, 0, "no legacy table is left");
  const after = asker(db),
    withoutLegacy = await after.ask({ requestId: id() });
  assert.deepEqual(
    comparable(withoutLegacy.result),
    comparable(reference.result),
    "the same answer without the legacy tables"
  );
  assert.equal(after.prompts[0], before.prompts[0], "the same prompt without the legacy tables");
  const scopedAfter = await asker(db).ask({
    sourceIds: [book],
    includeDescendants: true,
    reviewedOnly: true
  });
  assert.deepEqual(titles(scopedAfter.result), ["Learning Science chapter 1"]);
  report.withoutLegacyTables = {
    dropped: legacy.length,
    sameAnswer: true,
    samePrompt: true,
    beforeMs: reference.ms,
    afterMs: withoutLegacy.ms
  };

  console.info(JSON.stringify({ ok: true, ...report }, null, 2));
  await closePgPool(db);
} finally {
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
