import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPgPool,
  closePgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  createSourceItemRepository,
  createDocumentRepository,
  createChunkRepository,
  createSourceRelationRepository,
  createEntityIdentityRepository,
  createRelationTypeRepository,
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
  createKnowledgeGraphDashboardRepository,
  createEmbeddingRepository,
  createSourceRelationExplanationRepository,
  listSourceRelations,
  noteRelationFingerprintSql,
  sourceRelationExplainable,
  sourceRelationExplanationPlan,
  sourceRelationIdentityKey,
  type SourceRelationChunk,
  type SourceRelationWrite
} from "../index.js";
import { createIngestionRunRepository } from "../repositories/ingestionRunRepository.js";
import { createSourceSummaryRepository } from "../repositories/sourceSummaryRepository.js";

const root = resolve(import.meta.dirname, "../../../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-source-relations-"));
const migrations = join(root, "packages/db/drizzle"),
  seedFolder = join(root, "packages/db/seed");
const sidecar = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "relations_test",
  user: "relations_test",
  password: randomUUID(),
  startupTimeoutMs: 30000,
  shutdownTimeoutMs: 10000
});
let pool, emptyPool;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
  const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
  const prior = journal.entries.filter((entry: { idx: number }) => entry.idx < 22),
    oldFolder = join(workDir, "old");
  await mkdir(join(oldFolder, "meta"), { recursive: true });
  await writeFile(
    join(oldFolder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: prior })
  );
  for (const entry of prior)
    await copyFile(join(migrations, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
  await runMigrations(pool, oldFolder);
  const sources = createSourceItemRepository(pool);
  const book = await sources.create({ type: "Book", title: "Learning mechanisms" });
  const a = await sources.create({ type: "BookChapter", title: "Retrieval and lasting learning" });
  const b = await sources.create({
    type: "AcademicPaper",
    title: "Retrieval mechanisms and learning"
  });
  const sibling = await sources.create({ type: "BookChapter", title: "Other learning mechanisms" });
  await pool.query(
    "update source_items set parent_source_item_id = $1 where id = any($2::uuid[])",
    [book.id, [a.id, sibling.id]]
  );
  assert.equal((await runMigrations(pool, migrations, { seedFolder })).seed.applied, false);
  assert.equal(
    (await pool.query("select title from source_items where id = $1", [a.id])).rows[0].title,
    a.title
  );
  for (const table of [
    "source_relations",
    "source_relation_evidence",
    "source_matching_decisions",
    "source_matching_runs"
  ]) {
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from information_schema.tables where table_name = $1",
          [table]
        )
      ).rows[0].n,
      1
    );
  }
  const chunk = async (source: typeof a, content: string): Promise<SourceRelationChunk> => {
    const doc = await createDocumentRepository(pool!).create({
      sourceItemId: source.id,
      title: source.title,
      canonicalMarkdown: content,
      contentHash: content
    });
    const id = randomUUID(),
      span = randomUUID();
    await createChunkRepository(pool!).replaceDocumentChunks(doc.id, source.id, [
      {
        id,
        sourceSpanId: span,
        chunkIndex: 0,
        content,
        contentHash: content,
        span: { id: span, startOffset: 0, endOffset: content.length }
      }
    ]);
    return {
      id,
      sourceItemId: source.id,
      documentId: doc.id,
      sourceSpanId: span,
      content,
      contentHash: content,
      title: source.title,
      summary: content,
      rootId: source.id === b.id ? b.id : book.id,
      rootTitle: source.id === b.id ? b.title : book.title,
      chunkIndex: 0
    };
  };
  const ac = await chunk(
    a,
    "Retrieval practice improves long-term retention through effortful recall."
  );
  const bc = await chunk(
    b,
    "Effortful retrieval strengthens retention; feedback supports correction of errors."
  );
  const sc = await chunk(sibling, "Feedback mechanisms explain learning errors.");
  await sources.update(a.id, { summary: ac.content });
  await sources.update(b.id, { summary: bc.content });
  const repository = createSourceRelationRepository(pool);
  assert.equal(
    await createEmbeddingRepository(pool).hasSourceMatchingCoverage(a.id, ac.documentId),
    false
  );
  for (const c of [ac, bc])
    await createSourceSummaryRepository(pool).create({
      sourceItemId: c.sourceItemId,
      summary: c.content,
      provider: "test",
      model: "test",
      runtime: "local",
      promptVersion: "summary-v3",
      inputHash: c.contentHash,
      outputHash: c.contentHash,
      metadata: {
        concepts: [
          { idea: "Effortful recall strengthens long-term retention.", evidenceChunkIds: [c.id] }
        ]
      }
    });
  assert.deepEqual(
    await repository.roots([book.id, a.id, sibling.id, b.id]),
    [book.id, b.id],
    "Roots are visited in title order, never in ID order"
  );
  const fingerprint = await repository.fingerprint(book.id);
  await pool.query("update chunks set chunking_version = 'test-v2' where id = $1", [ac.id]);
  assert.notEqual(
    await repository.fingerprint(book.id),
    fingerprint,
    "Rechunking invalidates cached pair decisions even when the document text is unchanged"
  );
  const found = await repository.candidates(book.id, 40);
  assert.ok(found.some((item) => item.id === b.id && item.textScore > 0));
  assert.ok(
    found.every((item) => item.id === b.id),
    "Text retrieval excludes the querying root and all its subitems before reranking"
  );
  const evidence = await repository.pairChunks(book.id, b.id, [], 4);
  assert.ok(evidence.some((item) => item.id === ac.id && item.rootId === book.id));
  assert.ok(
    evidence.every((item) => item.rootTitle.length > 0 && Number.isInteger(item.chunkIndex)),
    "Evidence carries the work title and chunk position that order the prompt"
  );
  assert.deepEqual(
    (await repository.pairChunks(b.id, book.id, [], 4)).map((item) => item.id).sort(),
    evidence.map((item) => item.id).sort(),
    "The evidence does not depend on which of the two roots starts the match"
  );
  assert.ok(
    found.every((item) => item.title.length > 0),
    "Candidates carry their work title"
  );
  for (const dimensions of [256, 768, 1024]) {
    const vector = Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
    for (const source of [a, b, sibling])
      await createEmbeddingRepository(pool).upsert({
        targetType: "source_item",
        targetId: source.id,
        provider: "test",
        model: `test-${dimensions}`,
        runtime: "local",
        strategy: `source-composite-centroid-v2:space-${dimensions}`,
        contentHash: "test",
        embedding: vector
      });
  }
  assert.ok(
    (await repository.candidates(book.id, 40)).some(
      (item) => item.id === b.id && item.vectorScore > 0.99
    )
  );
  assert.ok(
    (await repository.candidates(book.id, 40)).every((item) => item.id === b.id),
    "Even identical sibling vectors cannot retrieve the querying root"
  );
  for (const dimensions of [256, 768, 1024])
    await pool.query(
      `update embeddings_${dimensions} set strategy = 'source-composite-centroid-v2:different' where target_id = $1`,
      [b.id]
    );
  assert.equal(
    (await repository.candidates(book.id, 40)).find((item) => item.id === b.id)?.vectorScore,
    0
  );
  const beforeVectors = await repository.fingerprint(book.id);
  for (const dimensions of [256, 768, 1024])
    for (const c of [ac, bc])
      await createEmbeddingRepository(pool).upsert({
        targetType: "chunk",
        targetId: c.id,
        chunkId: c.id,
        provider: "test",
        model: `test-${dimensions}`,
        runtime: "local",
        strategy: `native-v2:space-${dimensions}`,
        contentHash: c.contentHash,
        embedding: Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0))
      });
  assert.notEqual(
    await repository.fingerprint(book.id),
    beforeVectors,
    "New compatible vectors invalidate retrieval decisions"
  );
  assert.equal(
    await createEmbeddingRepository(pool).hasSourceMatchingCoverage(a.id, ac.documentId),
    true
  );
  assert.ok(
    (await repository.candidates(book.id, 40)).some(
      (item) => item.id === b.id && item.vectorScore > 0.99
    ),
    "Chunk vectors independently discover source candidates"
  );
  assert.ok((await repository.pairChunks(book.id, b.id, [], 1)).some((item) => item.id === ac.id));
  const noteIds = [randomUUID(), randomUUID()].sort().reverse();
  for (const [index, c] of [ac, bc].entries())
    await pool.query(
      `insert into atomic_notes
    (id,title,body_markdown,idea_statement,created_from_source_item_id,evidence_chunk_id,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key)
    values ($1::uuid,$2,$2,$2,$3,$4,'test','test','local','test',$1::uuid::text)`,
      [noteIds[index], c.content, c.sourceItemId, c.id]
    );
  // Decided from the higher UUID to the lower one: stored as the sorted pair, read `hi_to_lo`.
  const { relation: noteRelation } = await createAtomicNoteRelationRepository(pool).upsertDecided({
    subjectAtomicNoteId: noteIds[0]!,
    objectAtomicNoteId: noteIds[1]!,
    relationType: "supports",
    band: null,
    finalScore: 0.95,
    explanation: "test"
  });
  assert.equal(noteRelation.direction, "hi_to_lo");
  assert.deepEqual(
    await createAtomicNoteRelationRepository(pool).pairStatuses(noteIds[0]!, [noteIds[1]!]),
    new Map([[noteIds[1]!, "pending_review"]])
  );
  assert.deepEqual(
    await createAtomicNoteRelationRepository(pool).pairStatuses(noteIds[1]!, [noteIds[0]!]),
    new Map([[noteIds[0]!, "pending_review"]])
  );
  const boundedEvidence = await repository.pairChunks(book.id, b.id, [ac.id, sc.id, bc.id], 1);
  assert.equal(boundedEvidence.filter((chunk) => chunk.rootId === book.id).length, 1);
  assert.equal(boundedEvidence.filter((chunk) => chunk.rootId === b.id).length, 1);
  const notes = await repository.pairNotes(book.id, b.id);
  assert.equal(notes[0]?.sourceItemId, a.id, "The semantic direction survives sorted UUID storage");
  await pool.query("update atomic_note_relations set relation_type = 'contrasts' where id = $1", [
    noteRelation.id
  ]);
  const symmetric = (await repository.pairNotes(book.id, b.id))[0]!;
  assert.equal(
    symmetric.sourceItemId,
    a.id,
    "Symmetric relationships keep their stored direction; the prompt's content order orients them, never an ID order"
  );
  await pool.query("update atomic_note_relations set relation_type = 'supports' where id = $1", [
    noteRelation.id
  ]);
  const pairKeyNotes = await repository.pairNoteFingerprints(book.id, b.id);
  assert.deepEqual(
    pairKeyNotes,
    notes.map((note) => note.fingerprint),
    "The pair key reads the same note relations the prompt lists while none is cited"
  );
  assert.deepEqual(
    await repository.pairNoteFingerprints(b.id, book.id),
    pairKeyNotes,
    "Both sides of a pair key on the same note relations"
  );
  const relation: SourceRelationWrite = {
    existingId: null,
    sourceItemId: a.id,
    targetSourceItemId: b.id,
    relationType: "supports",
    sourceIdea: ac.content,
    targetIdea: bc.content,
    explanation: "Both describe retention through retrieval.",
    importance: 0.9,
    confidence: 0.95,
    evidence: [{ source: ac, target: bc, note: notes[0]! }]
  };
  assert.equal(
    await repository.commitDecision("first", book.id, b.id, [relation], { proposals: 1 }),
    1
  );
  assert.deepEqual(
    await repository.pairNotes(book.id, b.id),
    [],
    "Already represented note relationships are excluded before reranking"
  );
  for (const [left, right] of [
    [book.id, b.id],
    [b.id, book.id]
  ])
    assert.deepEqual(
      await repository.pairNoteFingerprints(left!, right!),
      pairKeyNotes,
      "A cited note relation stays in the pair key, so the other side does not judge the pair again"
    );
  assert.equal(
    (await repository.candidates(book.id, 40)).find((item) => item.id === b.id)?.noteScore,
    0,
    "Existing note links no longer promote a reranking candidate"
  );
  assert.equal(
    await repository.commitDecision("first", book.id, b.id, [relation], { proposals: 1 }),
    0
  );
  let page = await listSourceRelations(pool, book.id, b.id);
  assert.equal(page.relations.length, 1);
  assert.equal(page.relations[0]!.current, true);
  const id = String(page.relations[0]!.id);
  // Approving a note invalidates nothing; editing or discarding it does.
  const isCurrent = async () =>
    (await listSourceRelations(pool!, book.id, b.id)).relations[0]!.current;
  const noteRepository = createAtomicNoteRepository(pool);
  for (const noteId of noteIds) await noteRepository.review({ id: noteId, action: "approve" });
  assert.equal(await isCurrent(), true, "Approving either note keeps the derived evidence current");
  const original = (
    await pool.query("select body_markdown as body from atomic_notes where id = $1", [noteIds[0]])
  ).rows[0].body as string;
  await noteRepository.review({
    id: noteIds[0]!,
    action: "edit",
    bodyMarkdown: `${original} Edited.`
  });
  assert.equal(await isCurrent(), false, "An edit invalidates the derived evidence");
  await noteRepository.review({ id: noteIds[0]!, action: "edit", bodyMarkdown: original });
  assert.equal(await isCurrent(), true, "Restoring the text restores the evidence");
  await noteRepository.review({ id: noteIds[1]!, action: "discard" });
  assert.equal(await isCurrent(), false, "A discarded note invalidates the derived evidence");
  await pool.query("update atomic_notes set status = 'approved' where id = $1", [noteIds[1]]);
  assert.equal(await isCurrent(), true);
  // Evidence written under the former formula (status in the facts) heals through migration 0048.
  const formerFacts = (alias: string, status: string) =>
    `concat_ws('|',${alias}.id::text,${alias}.idea_statement,${alias}.body_markdown,'${status}',${alias}.supersession_status)`;
  await pool.query(
    `update source_relation_evidence e set snapshot = jsonb_set(e.snapshot, '{noteFingerprint}', to_jsonb(md5(concat_ws('|',
       n.id::text, n.relation_type, n.status::text, n.metadata::text,
       least(${formerFacts("a", "active")}, ${formerFacts("b", "active")}),
       greatest(${formerFacts("a", "active")}, ${formerFacts("b", "active")})))))
     from atomic_note_relations n, atomic_notes a, atomic_notes b
     where n.id = e.note_relation_id and a.id = e.source_note_id and b.id = e.target_note_id`
  );
  assert.equal(await isCurrent(), false, "A former fingerprint of a now approved note is stale");
  const rekey = await readFile(
    join(migrations, "0048_note_fingerprint_without_review_status.sql"),
    "utf8"
  );
  assert.equal(
    (await pool.query(rekey)).rowCount,
    1,
    "0048 re-keys evidence stale only by approval"
  );
  assert.equal((await pool.query(rekey)).rowCount, 0, "The migration is idempotent");
  // 0048's formula still hashed the relation's status and metadata; 0056 re-keyed every current
  // evidence row to the facts-only formula (checked by `npm run db:relations:verify`).
  assert.equal(await isCurrent(), false, "A pre-0056 fingerprint is not the facts-only one");
  await pool.query(
    `update source_relation_evidence e set snapshot = jsonb_set(e.snapshot, '{noteFingerprint}',
       to_jsonb(${noteRelationFingerprintSql("n", "a", "b")}))
     from atomic_note_relations n, atomic_notes a, atomic_notes b
     where n.id = e.note_relation_id and a.id = e.source_note_id and b.id = e.target_note_id`
  );
  assert.equal(await isCurrent(), true, "Re-keyed to the facts-only formula, as 0056 does");
  await repository.commitDecision(
    "direct",
    book.id,
    b.id,
    [{ ...relation, existingId: id, evidence: [{ source: ac, target: bc, note: null }] }],
    { proposals: 1 }
  );
  page = await listSourceRelations(pool, book.id, b.id);
  assert.equal(page.relations.length, 1);
  assert.equal(
    page.relations[0]!.evidence.length,
    2,
    "Two origins enrich one conceptual relationship"
  );
  let graph = await createKnowledgeGraphDashboardRepository(pool).get("sources", "relations");
  assert.equal(graph.edges.length, 1, "Repeated evidence never increases prevalence");
  assert.equal(graph.edges[0]!.source, a.id);
  assert.equal(graph.edges[0]!.label, "supports");
  assert.equal(await repository.review(id, "accepted", page.relations[0]!.updatedAt), true);
  await repository.commitDecision(
    "second-idea",
    book.id,
    b.id,
    [
      {
        ...relation,
        sourceIdea: "A distinct idea",
        evidence: [{ source: sc, target: bc, note: null }],
        sourceItemId: sibling.id
      }
    ],
    { proposals: 1 }
  );
  assert.equal(
    (await listSourceRelations(pool, a.id, b.id)).relations.length,
    1,
    "A chapter preview must exclude sibling evidence"
  );
  assert.equal((await listSourceRelations(pool, book.id, b.id, 0, 1)).hasMore, true);
  await pool.query("update atomic_note_relations set status = 'rejected' where id = $1", [
    noteRelation.id
  ]);
  page = await listSourceRelations(pool, a.id, b.id);
  assert.equal(page.relations[0]!.current, true, "The independent direct evidence remains current");
  assert.equal(
    page.relations[0]!.evidence.filter((item: { current: boolean }) => item.current).length,
    1
  );
  assert.equal(page.relations[0]!.status, "accepted");
  await pool.query(
    "update documents set metadata = jsonb_build_object('supersededByDocumentId',$2::text) where id = $1",
    [ac.documentId, randomUUID()]
  );
  page = await listSourceRelations(pool, a.id, b.id);
  assert.equal(page.relations[0]!.current, false);
  assert.equal(page.relations[0]!.status, "accepted");
  graph = await createKnowledgeGraphDashboardRepository(pool).get("sources", "relations");
  assert.equal(
    graph.edges.some((edge) => edge.id === id),
    false,
    "Superseded evidence is not a live graph edge"
  );
  await assert.rejects(repository.commitDecision("stale", book.id, b.id, [relation], {}));
  assert.equal(
    await repository.decision("stale"),
    null,
    "An invalid batch rolls back its checkpoint"
  );
  await repository.commitDecision("negative", book.id, b.id, [], { proposals: 0 });
  assert.ok(await repository.decision("negative"));
  await repository.saveRun("run", book.id, { inputTokens: 123, proposals: 2 });
  assert.equal((await repository.runState("run"))?.inputTokens, 123);
  const runs = createIngestionRunRepository(pool);
  const run = await runs.create({
    sourceItemId: book.id,
    effectiveStages: ["sourceMatching"],
    requestedStages: ["sourceMatching"]
  });
  await runs.initializeStages(run.id, ["sourceMatching"], ["sourceMatching"]);
  await runs.complete(run.id);
  await runs.updateStageProgress(run.id, "sourceMatching", 0.5, {});
  await runs.failStage(run.id, "sourceMatching", "synthetic failure");
  const failed = await runs.findById(run.id);
  assert.equal(
    failed?.status,
    "succeeded",
    "A collective stage must not reactivate a finished participant's job"
  );
  assert.equal((failed?.stagesCheckpoint.sourceMatching as { status: string }).status, "failed");
  const entityCatalog = createEntityIdentityRepository(pool),
    typeCatalog = createRelationTypeRepository(pool);
  for (const dimensions of [256, 768, 1024]) {
    const vector = {
      embedding: Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0)),
      spaceKey: "matching-calibration",
      contentHash: "fixture",
      provider: "test",
      model: "test",
      runtime: "local",
      metadata: {}
    };
    for (let i = 0; i < 5; i++) {
      const entityId = randomUUID(),
        typeId = randomUUID();
      await pool.query(
        "insert into entities (id,type,canonical_name,normalized_name,confidence) values ($1,'Concept',$2,$2,1)",
        [entityId, `candidate-${dimensions}-${i}`]
      );
      await entityCatalog.saveVector(entityId, vector);
      await pool.query(
        "insert into relation_types (id,predicate,definition) values ($1,$2,'A synthetic calibration definition')",
        [typeId, `candidate_${dimensions}_${i}`]
      );
      await typeCatalog.saveVector(typeId, vector);
    }
    assert.equal(
      (
        await entityCatalog.candidates({
          type: "Concept",
          names: [],
          vector,
          threshold: 0.5,
          limit: 1
        })
      ).length,
      1
    );
    assert.equal(
      (
        await entityCatalog.candidates({
          type: "Concept",
          names: [],
          vector,
          threshold: 0.5,
          limit: 5
        })
      ).length,
      5
    );
    assert.equal((await typeCatalog.candidates(vector, 0.5, 1)).length, 1);
    assert.equal((await typeCatalog.candidates(vector, 0.5, 5)).length, 5);
  }
  // Verdicts without prose (source-relations-v5): identity (source, target, type), evidence merges
  // on upsert, an owner-rejected relation is never brought back, raw verdicts stay in the decision.
  const decidedA = await sources.create({ type: "Book", title: "Decided work A" });
  const decidedB = await sources.create({ type: "Book", title: "Decided work B" });
  const decidedChunk = async (
    source: typeof decidedA,
    content: string,
    chunkIndex = 0
  ): Promise<SourceRelationChunk> => {
    const doc = await createDocumentRepository(pool!).create({
      sourceItemId: source.id,
      title: `${source.title} ${chunkIndex}`,
      canonicalMarkdown: content,
      contentHash: `${source.id}-${chunkIndex}`
    });
    const id = randomUUID(),
      span = randomUUID();
    await createChunkRepository(pool!).replaceDocumentChunks(doc.id, source.id, [
      {
        id,
        sourceSpanId: span,
        chunkIndex,
        content,
        contentHash: content,
        span: { id: span, startOffset: 0, endOffset: content.length }
      }
    ]);
    return {
      id,
      sourceItemId: source.id,
      documentId: doc.id,
      sourceSpanId: span,
      content,
      contentHash: content,
      title: source.title,
      summary: null,
      rootId: source.id,
      rootTitle: source.title,
      chunkIndex
    };
  };
  const xa = await decidedChunk(decidedA, "Spaced retrieval improves retention over weeks.");
  const xb = await decidedChunk(decidedB, "Distributed practice strengthens long-term memory.");
  const decided = (
    relationType: string,
    evidence: Array<[SourceRelationChunk, SourceRelationChunk]>,
    from = decidedA.id,
    to = decidedB.id
  ): SourceRelationWrite => ({
    existingId: null,
    sourceItemId: from,
    targetSourceItemId: to,
    relationType,
    sourceIdea: null,
    targetIdea: null,
    explanation: null,
    importance: 0.9,
    confidence: 0.85,
    evidence: evidence.map(([source, target]) => ({ source, target, note: null }))
  });
  const rawItems = [{ from: decidedA.id, to: decidedB.id, type: "supports", importance: 90 }];
  assert.equal(
    await repository.commitDecision(
      "v5-first",
      decidedA.id,
      decidedB.id,
      [decided("supports", [[xa, xb]])],
      {
        promptVersion: "source-relations-v5",
        items: rawItems,
        proposals: 1
      }
    ),
    1
  );
  const decidedRows = async (relationType: string) =>
    (
      await pool!.query(
        `select r.id, r.identity_key, r.source_item_id, r.source_idea, r.target_idea, r.explanation, r.status::text as status,
          r.metadata, (select count(*)::int from source_relation_evidence e where e.relation_id = r.id) as evidence
        from source_relations r where r.relation_type = $1 and $2::uuid in (r.source_item_id, r.target_source_item_id)
        order by r.created_at, r.id`,
        [relationType, decidedA.id]
      )
    ).rows;
  let supports = await decidedRows("supports");
  assert.equal(supports.length, 1);
  assert.equal(
    supports[0].identity_key,
    sourceRelationIdentityKey(decidedA.id, decidedB.id, "supports"),
    "A verdict without prose is identified by its endpoints and type"
  );
  assert.deepEqual(
    [supports[0].source_idea, supports[0].target_idea, supports[0].explanation],
    [null, null, null],
    "No prose is stored"
  );
  assert.equal(supports[0].metadata.items, undefined, "Raw verdicts stay in the decision row");
  assert.deepEqual(
    (await repository.decision("v5-first"))?.items,
    rawItems,
    "The decision keeps every raw verdict"
  );
  const xa2 = await decidedChunk(
    decidedA,
    "Retrieval spaced across days outlasts massed study.",
    1
  );
  assert.equal(
    await repository.commitDecision(
      "v5-second",
      decidedA.id,
      decidedB.id,
      [decided("supports", [[xa2, xb]])],
      {
        proposals: 0
      }
    ),
    1
  );
  supports = await decidedRows("supports");
  assert.equal(supports.length, 1, "The same endpoints and type are one relation");
  assert.equal(supports[0].evidence, 2, "Evidence merges on upsert");
  // A symmetric verdict answered the other way round is the same relation, its evidence turned.
  await repository.commitDecision(
    "v5-sym",
    decidedA.id,
    decidedB.id,
    [decided("similar_to", [[xa, xb]])],
    {}
  );
  await repository.commitDecision(
    "v5-sym-reversed",
    decidedA.id,
    decidedB.id,
    [decided("similar_to", [[xb, xa]], decidedB.id, decidedA.id)],
    {}
  );
  const similar = await decidedRows("similar_to");
  assert.equal(similar.length, 1);
  assert.equal(similar[0].evidence, 1, "The reversed evidence is the same evidence");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from source_relation_evidence where relation_id = $1 and source_chunk_id = $2",
        [similar[0].id, xa.id]
      )
    ).rows[0].n,
    1,
    "Evidence is stored in the relation's orientation"
  );
  // The owner rejects: no verdict brings the relation back, nor adds evidence to it.
  const supportsView = (await listSourceRelations(pool, decidedA.id, decidedB.id)).relations.find(
    (item: { relationType: string }) => item.relationType === "supports"
  )!;
  assert.equal(supportsView.sourceIdea, null, "Relations without prose list with null prose");
  assert.equal(
    await repository.review(String(supportsView.id), "rejected", supportsView.updatedAt),
    true
  );
  const xb2 = await decidedChunk(decidedB, "Spacing effects hold across ages and materials.", 1);
  assert.equal(
    await repository.commitDecision(
      "v5-after-rejection",
      decidedA.id,
      decidedB.id,
      [decided("supports", [[xa, xb2]])],
      {}
    ),
    0,
    "An owner-rejected relation is never brought back"
  );
  supports = await decidedRows("supports");
  assert.deepEqual(
    supports.map((row: { status: string; evidence: number }) => [row.status, row.evidence]),
    [["rejected", 2]]
  );
  assert.ok(await repository.decision("v5-after-rejection"), "The verdict is still recorded");
  // An older relation with prose and the owner's acceptance receives the evidence and keeps both.
  const older: SourceRelationWrite = {
    ...decided("extends", [[xa, xb]]),
    sourceIdea: "Spacing retrieval extends retention.",
    targetIdea: "Distributed practice and memory.",
    explanation: "Older prose."
  };
  await repository.commitDecision("v4-older", decidedA.id, decidedB.id, [older], {});
  const olderView = (await listSourceRelations(pool, decidedA.id, decidedB.id)).relations.find(
    (item: { relationType: string }) => item.relationType === "extends"
  )!;
  assert.equal(
    await repository.review(String(olderView.id), "accepted", olderView.updatedAt),
    true
  );
  assert.equal(
    await repository.commitDecision(
      "v5-older",
      decidedA.id,
      decidedB.id,
      [decided("extends", [[xa2, xb2]])],
      {}
    ),
    1
  );
  const extendsRows = await decidedRows("extends");
  assert.equal(extendsRows.length, 1, "A verdict merges into the older relation of that type");
  assert.deepEqual(
    [extendsRows[0].status, extendsRows[0].explanation, extendsRows[0].evidence],
    ["accepted", "Older prose.", 2],
    "The older relation keeps its prose and the owner's acceptance"
  );
  // Explanations written on open: cached per inputs and language, gone with their relation.
  const explanations = createSourceRelationExplanationRepository(pool);
  const similarContext = (await explanations.readContext(String(similar[0].id)))!;
  assert.ok(sourceRelationExplainable(similarContext));
  assert.deepEqual(
    [similarContext.source.passages.length, similarContext.target.passages.length],
    [1, 1]
  );
  assert.equal(
    sourceRelationExplainable((await explanations.readContext(String(supports[0].id)))!),
    false
  );
  assert.equal(
    sourceRelationExplainable((await explanations.readContext(String(olderView.id)))!),
    false
  );
  const plan = sourceRelationExplanationPlan(similarContext, "pt-BR");
  assert.equal(plan.direction, "symmetric");
  assert.ok(
    await explanations.save({
      relationId: String(similar[0].id),
      text: `<source-ref id="${decidedA.id}" /> e <source-ref id="${decidedB.id}" /> concordam.`,
      inputHash: plan.inputHash,
      promptVersion: "source-relation-explanation-v1",
      provider: "test",
      model: "writer",
      runtime: "local",
      aiTaskRunId: null,
      language: "pt-BR"
    })
  );
  assert.equal(
    (await explanations.currentExplanations([String(similar[0].id)], "pt-BR")).get(
      String(similar[0].id)
    )?.writtenBy,
    "writer"
  );
  assert.equal((await explanations.currentExplanations([String(similar[0].id)], "en")).size, 0);
  await assert.rejects(
    pool.query("update source_relation_explanations set text = '' where relation_id = $1", [
      similar[0].id
    ]),
    "An empty explanation is refused"
  );
  assert.equal(
    await explanations.save({
      relationId: randomUUID(),
      text: "Nothing to explain.",
      inputHash: "x",
      promptVersion: "source-relation-explanation-v1",
      provider: "test",
      model: "writer",
      runtime: "local",
      aiTaskRunId: null,
      language: "en"
    }),
    null,
    "No explanation is stored for a relation that does not exist"
  );
  await pool.query("delete from source_relations where id = $1", [similar[0].id]);
  assert.equal(
    (await pool.query("select count(*)::int as n from source_relation_explanations")).rows[0].n,
    0,
    "An explanation is deleted with its relation"
  );
  // Equal scores order by content: the same eight works get random IDs, yet always rank by title.
  const tieText = "Spacing practice distributes study sessions across time.";
  const tieQuery = await sources.create({ type: "Book", title: "Tie query" });
  await chunk(tieQuery, tieText);
  const tieTitles = Array.from({ length: 8 }, (_, i) => `Tie work ${String.fromCharCode(65 + i)}`);
  for (const title of [...tieTitles].reverse())
    await chunk(await sources.create({ type: "Book", title }), tieText);
  assert.deepEqual(
    (await repository.candidates(tieQuery.id, 40))
      .filter((item) => item.title.startsWith("Tie work"))
      .map((item) => item.title),
    tieTitles,
    "Equal scores rank by work title, never by ID"
  );
  await pool.query("create database relations_empty");
  const url = new URL(connection.connectionString);
  url.pathname = "/relations_empty";
  emptyPool = createPgPool({ connectionString: url.toString(), max: 2 });
  assert.equal((await runMigrations(emptyPool, migrations, { seedFolder })).seed.applied, true);
  assert.equal(
    (await emptyPool.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]
      .n,
    journal.entries.length
  );
  await pool.query("delete from source_items where id = any($1::uuid[])", [
    [book.id, a.id, sibling.id, decidedA.id]
  ]);
  assert.equal((await pool.query("select count(*)::int as n from source_relations")).rows[0].n, 0);
  console.log(
    "Verified populated upgrade and empty baseline; all vector spaces; chapter ownership and direction; approval keeps note evidence current and migration 0048 heals former fingerprints; both origins, deduplication, pagination, review preservation, invalidation, rollback, negative cache, durable budget and deletion; configurable canonical candidate limits, saved note-pair lookup, pair keys that keep cited note relations from both sides and per-root evidence caps; verdicts without prose identified by endpoints and type, evidence merged on upsert (symmetric turned), owner rejection never undone, older prose and acceptance kept, raw verdicts in the decision row, and explanations cached per inputs and language, refused when empty and deleted with their relation."
  );
} finally {
  if (emptyPool) await closePgPool(emptyPool);
  if (pool) await closePgPool(pool);
  await manager.stop();
  await rm(workDir, { recursive: true, force: true });
}
