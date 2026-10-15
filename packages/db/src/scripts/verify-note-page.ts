import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentRepository,
  createNotePageRepository,
  createObjectLocateRepository,
  createPgPool,
  createRelationExplanationRepository,
  createSourceItemRepository,
  relationExplanationPlan,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "../index.js";
import { NotePageSchema, NotePageRelationsSchema, notePageLimits } from "@app/domain";

/**
 * Real-database check of the Note page read model (`notes.page` and `notes.relations`): the note in
 * each authorship, its evidence with anchors and currency, its relations with direction, decider,
 * explanation and paging, successors and placement, on a throwaway PostgreSQL sidecar migrated
 * from scratch. Latency at scale is measured by `scripts/objects/note-page-benchmark.ts`.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-note-page-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_note_page",
  user: "memora_note_page",
  password: `note-page-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

let pool: PgPool | null = null;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 3 });
  const db = pool;
  await runMigrations(db, resolve(packageRoot, "drizzle"));

  const sources = createSourceItemRepository(db);
  const documents = createDocumentRepository(db);
  const chunks = createChunkRepository(db);
  const notes = createAtomicNoteRepository(db);
  const relations = createAtomicNoteRelationRepository(db);
  const repository = createNotePageRepository(db);
  const read = async (
    noteId: string,
    relationLimit: number = notePageLimits.relationPage,
    contentLanguage = "en"
  ) => {
    const page = await repository.readPage(noteId, { relationLimit, contentLanguage });
    return page ? NotePageSchema.parse(page) : null;
  };

  const book = await sources.create({ type: "Book", title: "The Work" });
  const chapter = await sources.create({
    type: "BookChapter",
    title: "Chapter One",
    parentSourceItemId: book.id
  });
  const paper = await sources.create({ type: "StandaloneArticle", title: "A Paper" });

  async function addChunks(
    sourceItemId: string,
    texts: string[],
    options: { superseded?: boolean; page?: (index: number) => number | null } = {}
  ) {
    const content = texts.join("\n\n");
    const document = await documents.create({
      sourceItemId,
      title: "Document",
      canonicalMarkdown: content,
      contentHash: randomUUID(),
      ...(options.superseded ? { metadata: { supersededByDocumentId: randomUUID() } } : {})
    });
    let offset = 0;
    const ids: string[] = [];
    const ranges: Array<{ start: number; end: number }> = [];
    await chunks.replaceDocumentChunks(
      document.id,
      sourceItemId,
      texts.map((text, index) => {
        const id = randomUUID();
        ids.push(id);
        const span = {
          id: randomUUID(),
          startOffset: offset,
          endOffset: offset + text.length,
          page: options.page?.(index) ?? null
        };
        ranges.push({ start: span.startOffset, end: span.endOffset });
        offset += text.length + 2;
        return {
          id,
          sourceSpanId: span.id,
          chunkIndex: index,
          content: text,
          contentHash: id,
          span
        };
      })
    );
    return { documentId: document.id, chunkIds: ids, ranges };
  }

  async function addNote(input: {
    title: string;
    createdFrom: string;
    chunk: string;
    status?: string;
    supersession?: string;
    ownership?: "source" | "knowledge";
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, language, status, supersession_status,
         ownership, created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key, metadata)
       values ($1::uuid, $2, $3, $4, 'en', $5::atomic_note_status, $6, $7, $8, $9, 'verify', 'writer-model',
         'local', 'verify', $1::uuid::text, $10)`,
      [
        id,
        input.title,
        `${input.title} body.`,
        `${input.title} idea.`,
        input.status ?? "active",
        input.supersession ?? "current",
        input.ownership ?? "source",
        input.createdFrom,
        input.chunk,
        input.metadata ?? {}
      ]
    );
    return id;
  }
  const link = (noteId: string, sourceItemId: string, chunkId: string) =>
    db.query(
      "insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id) values ($1, $2, $3)",
      [noteId, sourceItemId, chunkId]
    );

  // 1. A missing note.
  assert.equal(await read(randomUUID()), null, "a missing note returns null");

  // 2. Core fields for each authorship.
  const bookChunks = await addChunks(book.id, ["Retrieval strengthens memory.", "Second passage."]);
  const chapterChunks = await addChunks(
    chapter.id,
    ["Chapter passage zero.", "Chapter passage one.", "Chapter passage two."],
    { page: (index) => (index === 1 ? 7 : null) }
  );
  const oldPaper = await addChunks(paper.id, ["An earlier version of the paper."], {
    superseded: true
  });
  const note = await addNote({
    title: "Retrieval",
    createdFrom: book.id,
    chunk: bookChunks.chunkIds[0]!
  });
  let page = (await read(note))!;
  assert.equal(page.note.authorship, "ai");
  assert.equal(page.note.humanProtected, false);
  assert.equal(page.note.generationModel, "writer-model");
  assert.equal(page.note.homeSourceId, book.id);
  assert.equal(page.note.language, "en");
  assert.equal(page.note.reviewedAt, null);
  assert.equal(page.note.lastEditedAt, null);

  const approved = await addNote({
    title: "Approved",
    createdFrom: book.id,
    chunk: bookChunks.chunkIds[1]!
  });
  await notes.review({ id: approved, action: "approve" });
  const approvedPage = (await read(approved))!;
  assert.equal(approvedPage.note.status, "approved");
  assert.ok(approvedPage.note.reviewedAt, "an approved note has its review time");
  assert.equal(approvedPage.note.authorship, "ai");

  const edited = await addNote({
    title: "Edited",
    createdFrom: book.id,
    chunk: bookChunks.chunkIds[1]!
  });
  const editedBefore = (await read(edited))!;
  await assert.rejects(
    notes.review({
      id: edited,
      action: "edit",
      title: "Stale",
      expectedUpdatedAt: new Date(Date.parse(editedBefore.note.updatedAt) - 1000).toISOString()
    }),
    /sourceWorkspace\.conflict/,
    "a stale token is refused"
  );
  await notes.review({
    id: edited,
    action: "edit",
    title: "Edited by a person",
    expectedUpdatedAt: editedBefore.note.updatedAt
  });
  const editedPage = (await read(edited))!;
  assert.equal(editedPage.note.authorship, "edited");
  assert.equal(editedPage.note.humanProtected, true);
  assert.ok(editedPage.note.lastEditedAt, "an edited note has its edit time");
  assert.equal(editedPage.note.title, "Edited by a person");
  // The token the page returns is the one the next edit needs.
  await notes.review({
    id: edited,
    action: "edit",
    title: "Edited twice",
    expectedUpdatedAt: editedPage.note.updatedAt
  });

  // The legacy run that recorded the evolution; its id is history only (no FK since 0052).
  const run = randomUUID();
  const evolved = await addNote({
    title: "Evolved",
    createdFrom: book.id,
    chunk: bookChunks.chunkIds[0]!,
    ownership: "knowledge",
    metadata: { humanProtected: true, evolutionRunId: run }
  });
  const evolvedPage = (await read(evolved))!;
  assert.equal(evolvedPage.note.authorship, "evolution");
  assert.equal(evolvedPage.note.ownership, "knowledge");
  assert.equal(evolvedPage.note.humanProtected, true);

  // 3. Evidence.
  await link(note, chapter.id, chapterChunks.chunkIds[1]!);
  await link(note, paper.id, oldPaper.chunkIds[0]!);
  await db.query(
    "insert into atomic_note_evidence (note_id, chunk_id, source_id, snapshot) values ($1, $2, $3, $4)",
    [
      note,
      randomUUID(),
      randomUUID(),
      { excerpt: "A preserved passage.", sourceTitle: "A deleted source", contentHash: "gone" }
    ]
  );
  page = (await read(note))!;
  const [primary, ...others] = page.evidence.items;
  assert.equal(page.evidence.total, 4);
  assert.equal(primary?.primary, true, "the primary passage comes first");
  assert.equal(primary?.chunkId, bookChunks.chunkIds[0]);
  assert.equal(primary?.workTitle, null, "a root passage has no separate work title");
  assert.deepEqual(primary?.range, bookChunks.ranges[0]);
  const inChapter = others.find((item) => item.chunkId === chapterChunks.chunkIds[1]);
  assert.equal(inChapter?.sourceTitle, "Chapter One");
  assert.equal(inChapter?.workTitle, "The Work", "a section passage names its work");
  assert.equal(inChapter?.chunkIndex, 1);
  assert.equal(inChapter?.page, 7);
  assert.deepEqual(inChapter?.range, chapterChunks.ranges[1]);
  assert.equal(inChapter?.current, true);
  const earlier = others.find((item) => item.chunkId === oldPaper.chunkIds[0]);
  assert.equal(earlier?.current, false, "a superseded document is not current");
  assert.equal(earlier?.sourceAvailable, true);
  const preserved = others.find((item) => item.sourceTitle === "A deleted source");
  assert.equal(preserved?.sourceAvailable, false, "only the snapshot survives");
  assert.equal(preserved?.current, false);
  assert.equal(preserved?.chunkIndex, null);
  assert.equal(preserved?.range, null);
  assert.equal(preserved?.excerpt, "A preserved passage.");

  const crowded = await addChunks(
    paper.id,
    Array.from({ length: notePageLimits.evidence + 5 }, (_, index) => `Crowded passage ${index}.`)
  );
  const crowdedNote = await addNote({
    title: "Crowded",
    createdFrom: paper.id,
    chunk: crowded.chunkIds[0]!
  });
  for (const chunkId of crowded.chunkIds) await link(crowdedNote, paper.id, chunkId);
  const crowdedPage = (await read(crowdedNote))!;
  assert.equal(crowdedPage.evidence.items.length, notePageLimits.evidence);
  assert.equal(crowdedPage.evidence.total, notePageLimits.evidence + 5, "the total stays exact");

  // 4. Relations.
  const longText = `${"Spacing ".repeat(120)}end.`;
  const otherChunks = await addChunks(paper.id, [longText, "Other two.", "Other three."]);
  const other = async (title: string, options: Partial<Parameters<typeof addNote>[0]> = {}) =>
    addNote({ title, createdFrom: paper.id, chunk: otherChunks.chunkIds[0]!, ...options });
  const outgoing = await other("Outgoing");
  const incoming = await other("Incoming");
  const unknown = await other("Unknown");
  const rejectedRelation = await other("Rejected relation");
  const rejectedNote = await other("Rejected note", { status: "rejected" });
  const archivedNote = await other("Archived note", { status: "archived" });
  const superseded = await other("Superseded", { supersession: "superseded" });
  // Only a knowledge-owned note outlives its primary chunk (a source note is deleted with it).
  const dangling = await other("Dangling", { ownership: "knowledge" });
  await db.query("update atomic_notes set evidence_chunk_id = $2 where id = $1", [
    dangling,
    otherChunks.chunkIds[1]
  ]);
  await db.query("delete from chunks where id = $1", [otherChunks.chunkIds[1]]);
  const relate = (
    otherId: string,
    finalScore: number,
    input: Partial<Parameters<typeof relations.upsert>[0]> = {}
  ) =>
    relations.upsert({
      sourceAtomicNoteId: note,
      targetAtomicNoteId: otherId,
      relationType: "supports",
      finalScore,
      explanation: "knowledge.relations.explanations.reranked",
      ...input
    });
  await relate(outgoing, 0.9, {
    explanation: `Both describe recall in <note-ref id="${note}" />.`,
    matchingModel: "decider-a",
    metadata: {
      decisionSource: "model",
      semanticSourceAtomicNoteId: note,
      semanticTargetAtomicNoteId: outgoing
    }
  });
  await relate(incoming, 0.8, {
    relationType: "extends",
    explanation: "A cached explanation.",
    matchingModel: "decider-a",
    metadata: {
      decisionSource: "cache",
      semanticSourceAtomicNoteId: incoming,
      semanticTargetAtomicNoteId: note
    }
  });
  await relate(unknown, 0.7, { explanation: "knowledge.relations.explanations.hybrid" });
  await relate(rejectedRelation, 0.99, { status: "rejected" });
  await relate(rejectedNote, 0.98);
  await relate(archivedNote, 0.97);
  await relate(superseded, 0.6, { matchingModel: "" });
  await relate(dangling, 0.5);
  page = (await read(note))!;
  const byOther = new Map(page.relations.items.map((item) => [item.other.id, item]));
  assert.equal(page.relations.total, 5, "rejected relations and notes are hidden");
  assert.deepEqual(
    page.relations.items.map((item) => item.other.id),
    [outgoing, incoming, unknown, superseded, dangling],
    "the order follows the stored score"
  );
  assert.equal(byOther.get(outgoing)?.direction, "outgoing");
  assert.equal(byOther.get(incoming)?.direction, "incoming");
  assert.equal(byOther.get(unknown)?.direction, "unknown");
  assert.deepEqual(byOther.get(outgoing)?.explanation, {
    text: `Both describe recall in <note-ref id="${note}" />.`,
    writtenBy: "decider-a"
  });
  assert.equal(byOther.get(outgoing)?.decidedBy, "decider-a");
  assert.deepEqual(byOther.get(incoming)?.explanation, {
    text: "A cached explanation.",
    writtenBy: null
  });
  assert.equal(byOther.get(unknown)?.explanation, null, "a message key is no explanation");
  assert.equal(byOther.get(unknown)?.decidedBy, null);
  assert.equal(byOther.get(superseded)?.decidedBy, null, "a blank model is unknown");
  assert.equal(byOther.get(superseded)?.other.superseded, true);
  assert.equal(byOther.get(dangling)?.other.passage, null, "a gone primary chunk has no passage");
  assert.equal(
    byOther.get(outgoing)?.other.passage?.excerpt.length,
    notePageLimits.excerptCharacters
  );
  assert.equal(byOther.get(outgoing)?.other.sourceTitle, "A Paper");
  const pages = [];
  for (const offset of [0, 2, 4])
    pages.push(
      NotePageRelationsSchema.parse(
        await repository.listRelations(note, { offset, limit: 2, contentLanguage: "en" })
      )
    );
  assert.ok(
    pages.every((relationPage) => relationPage.total === 5),
    "the total is stable"
  );
  assert.deepEqual(
    pages.flatMap((relationPage) => relationPage.items.map((item) => item.other.id)),
    [outgoing, incoming, unknown, superseded, dangling],
    "pages are disjoint and complete"
  );
  const past = await repository.listRelations(note, {
    offset: 10,
    limit: 2,
    contentLanguage: "en"
  });
  assert.deepEqual(past, { items: [], total: 5 }, "an offset past the end is empty");
  assert.equal((await read(note, 2))!.relations.items.length, 2, "the first page is bounded");
  const fromOther = (await read(incoming))!.relations.items.find((item) => item.other.id === note);
  assert.equal(fromOther?.direction, "outgoing", "the direction is relative to the page's note");

  // 4b. Explanations written on demand: stored beside the relation, current while the inputs hold.
  const explanations = createRelationExplanationRepository(db);
  const explained = byOther.get(unknown)!.id;
  const relationRow = async () =>
    (
      await db.query(
        "select updated_at::text as at, explanation from atomic_note_relations where id = $1",
        [explained]
      )
    ).rows[0];
  const impacts = async () =>
    Number((await db.query("select count(*)::int as n from knowledge_impact_events")).rows[0].n);
  const [relationBefore, impactsBefore] = [await relationRow(), await impacts()];
  const explainContext = (await explanations.readContext(explained))!;
  assert.equal(explainContext.stored, null);
  const plan = relationExplanationPlan({ ...explainContext, language: "en" });
  const saved = await explanations.save({
    relationId: explained,
    text: `Written on open about <note-ref id="${note}" />.`,
    inputHash: plan.inputHash,
    promptVersion: "relation-explanation-v1",
    provider: "verify",
    model: "writer-x",
    runtime: "remote",
    aiTaskRunId: null,
    language: "en"
  });
  assert.ok(saved?.writtenAt instanceof Date);
  assert.deepEqual(await relationRow(), relationBefore, "the relation row is not written");
  assert.equal(await impacts(), impactsBefore, "writing an explanation records no legacy impact");
  let explainedRelation = (await read(note))!.relations.items.find((item) => item.id === explained);
  assert.deepEqual(explainedRelation?.explanation, {
    text: `Written on open about <note-ref id="${note}" />.`,
    writtenBy: "writer-x"
  });
  assert.equal(
    (await explanations.readContext(explained))!.stored?.inputHash,
    plan.inputHash,
    "the cache keeps the inputs it was written for"
  );
  assert.equal(
    (await read(note, notePageLimits.relationPage, "pt-BR"))!.relations.items.find(
      (item) => item.id === explained
    )?.explanation,
    null,
    "an explanation written in another content language is stale"
  );
  assert.notEqual(
    relationExplanationPlan({ ...explainContext, language: "pt-BR" }).inputHash,
    plan.inputHash,
    "the content language is part of what the explanation is cached for"
  );
  await notes.review({ id: unknown, action: "edit", ideaStatement: "Unknown idea, edited." });
  explainedRelation = (await read(note))!.relations.items.find((item) => item.id === explained);
  assert.equal(explainedRelation?.explanation, null, "an edited idea makes the explanation stale");
  assert.notEqual(
    relationExplanationPlan({ ...(await explanations.readContext(explained))!, language: "en" })
      .inputHash,
    plan.inputHash
  );
  assert.equal(
    await explanations.save({
      relationId: randomUUID(),
      text: "Nothing to explain.",
      inputHash: "x",
      promptVersion: "relation-explanation-v1",
      provider: "verify",
      model: "writer-x",
      runtime: "remote",
      aiTaskRunId: null,
      language: "en"
    }),
    null,
    "a removed relation stores nothing"
  );
  await db.query("delete from atomic_note_relations where id = $1", [explained]);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from atomic_note_relation_explanations where relation_id = $1",
        [explained]
      )
    ).rows[0].n,
    0,
    "the explanation goes with its relation"
  );

  // 4c. Characters, not UTF-16 units, bound an excerpt; a relation outlives the home source of a
  // knowledge-owned note, and its audit never links a source that is gone.
  const hub = await addNote({ title: "Hub", createdFrom: book.id, chunk: bookChunks.chunkIds[0]! });
  const emojiChunks = await addChunks(paper.id, [`${"Spacing \u{1F600} ".repeat(120)}end.`]);
  const emojiNote = await addNote({
    title: "Emoji",
    createdFrom: paper.id,
    chunk: emojiChunks.chunkIds[0]!
  });
  const homeless = await sources.create({ type: "StandaloneArticle", title: "A Source To Delete" });
  const homelessChunks = await addChunks(homeless.id, ["A passage that goes with its source."]);
  const orphan = await addNote({
    title: "Orphan",
    createdFrom: homeless.id,
    chunk: homelessChunks.chunkIds[0]!,
    ownership: "knowledge"
  });
  await db.query("delete from source_items where id = $1", [homeless.id]);
  assert.equal(
    (await db.query("select count(*)::int as n from atomic_notes where id = $1", [orphan])).rows[0]
      .n,
    1,
    "a knowledge-owned note outlives its home source"
  );
  for (const [target, finalScore] of [
    [emojiNote, 0.9],
    [orphan, 0.8]
  ] as const)
    await relations.upsert({
      sourceAtomicNoteId: hub,
      targetAtomicNoteId: target,
      relationType: "supports",
      finalScore,
      explanation: "knowledge.relations.explanations.reranked"
    });
  await db.query(
    "insert into atomic_note_evidence (note_id, chunk_id, source_id, snapshot) values ($1, $2, $3, $4)",
    [
      hub,
      randomUUID(),
      randomUUID(),
      {
        excerpt: "\u{1F600}".repeat(notePageLimits.evidenceExcerptCharacters + 5),
        sourceTitle: "A long preserved passage"
      }
    ]
  );
  const hubPage = (await read(hub))!; // the contract parses it: no excerpt fails on its UTF-16 length
  const emojiExcerpt = hubPage.relations.items.find((item) => item.other.id === emojiNote)?.other
    .passage?.excerpt;
  assert.equal(Array.from(emojiExcerpt ?? "").length, notePageLimits.excerptCharacters);
  assert.ok(
    (emojiExcerpt?.length ?? 0) > notePageLimits.excerptCharacters,
    "the excerpt has more UTF-16 units than characters, and still loads"
  );
  const preservedExcerpt = hubPage.evidence.items.find(
    (item) => item.sourceTitle === "A long preserved passage"
  )?.excerpt;
  assert.equal(Array.from(preservedExcerpt ?? "").length, notePageLimits.evidenceExcerptCharacters);
  assert.equal(hubPage.relations.total, 2);
  assert.equal(hubPage.relations.items.length, 2, "every counted relation is listed");
  const orphanRelation = hubPage.relations.items.find((item) => item.other.id === orphan)!;
  assert.equal(orphanRelation.other.sourceItemId, null, "the note has no source any more");
  assert.equal(orphanRelation.other.sourceTitle, "");
  const orphanPages = [];
  for (const offset of [0, 1])
    orphanPages.push(
      NotePageRelationsSchema.parse(
        await repository.listRelations(hub, { offset, limit: 1, contentLanguage: "en" })
      )
    );
  assert.deepEqual(
    orphanPages.flatMap((relationPage) => relationPage.items.map((item) => item.other.id)),
    [emojiNote, orphan],
    "paging by what was listed reaches the relation to the orphaned note"
  );
  const orphanContext = (await explanations.readContext(orphanRelation.id))!;
  assert.equal(
    [orphanContext.a, orphanContext.b].find((n) => n.id === orphan)?.homeSourceId,
    null,
    "an explanation links no source that is gone"
  );
  assert.equal(
    [orphanContext.a, orphanContext.b].find((n) => n.id === hub)?.homeSourceId,
    book.id,
    "a source that exists is still linked"
  );

  // 5. Successors.
  await db.query(
    "insert into atomic_note_evolution (previous_id, next_id, run_id, kind, reason) values ($1, $2, $3, 'merge', 'verify')",
    [superseded, evolved, run]
  );
  assert.deepEqual((await read(superseded))!.successors, [{ id: evolved, title: "Evolved" }]);

  // 6. Placement is exactly what objects.locate answers.
  assert.deepEqual(page.placement, await createObjectLocateRepository(db).locateNote(note));

  // 7. Every statement runs inside a read-only transaction.
  const client = await db.connect();
  try {
    await client.query("begin read only");
    await client.query(repository.statements.note, [note, notePageLimits.successors]);
    await client.query(repository.statements.evidence, [note, notePageLimits.evidence, 31]);
    await client.query(repository.statements.relations, [
      note,
      20,
      0,
      notePageLimits.excerptCharacters
    ]);
    await client.query("commit");
  } finally {
    client.release();
  }

  console.info(
    JSON.stringify({
      verified: [
        "missing note is null; AI, approved, edited (token round-trip) and evolution notes",
        "evidence: primary first, section and work titles, chunk index, range and page, superseded and preserved passages, exact total past the limit",
        "relations: outgoing, incoming and unknown direction, hidden rejected relations and notes, superseded other",
        "relations: explanation writer, message keys, blank decider, dangling passage, clipped excerpt",
        "excerpts: cut and validated in characters (emoji at the bound), relations to a knowledge note whose home source was deleted listed and counted, no deleted source in an explanation's audit",
        "relations: score order, disjoint paging, stable totals",
        "explanations written on demand: shown with their writer, stale after an edit or in another content language, no relation write or legacy impact, removed with the relation",
        "successors, placement equal to objects.locate, every statement read-only"
      ]
    })
  );
} finally {
  if (pool) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
