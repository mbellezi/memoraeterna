import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WikiPageSchema, WikiPageContentSchema, WikiQuerySchema, WikiResultsSchema, WikiPageListSchema } from "@app/domain";
import {
  createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations,
  createSourceItemRepository, createDocumentRepository, createChunkRepository, createWikiRepository,
  createSourceRelationRepository, listSourceRelations, type SourceRelationChunk
} from "../packages/db/src/index.js";

const root = resolve(import.meta.dirname, "..");
const workDir = await mkdtemp(join(tmpdir(), "memora-wiki-"));
const migrations = join(root, "packages/db/drizzle"), seedFolder = join(root, "packages/db/seed");
const sidecar = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({
binDir: sidecar.binDir, dataDir: join(workDir, "data"), database: "wiki_test",
  user: "wiki_test", password: randomUUID(), startupTimeoutMs: 30000, shutdownTimeoutMs: 10000
});
let pool, emptyPool;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
  const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
  const prior = journal.entries.filter((entry: { idx: number }) => entry.idx < 23), oldFolder = join(workDir, "old");
  await mkdir(join(oldFolder, "meta"), { recursive: true });
  await writeFile(join(oldFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: prior }));
  for (const entry of prior) await copyFile(join(migrations, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
  await runMigrations(pool, oldFolder);
  const sources = createSourceItemRepository(pool);
  const book = await sources.create({ type: "Book", title: "Metadata-only encyclopedia" });
  const a = await sources.create({ type: "BookChapter", title: "Memória e aprendizagem" });
  const b = await sources.create({ type: "AcademicPaper", title: "Conflicting account" });
  await pool.query("update source_items set parent_source_item_id=$1 where id=$2", [book.id, a.id]);
  assert.equal((await runMigrations(pool, migrations, { seedFolder })).seed.applied, false);
  assert.equal((await pool.query("select count(*)::int as n from source_items")).rows[0].n, 3);
  for (const table of ["wiki_pages", "wiki_page_revisions", "wiki_evidence"]) assert.equal((await pool.query("select count(*)::int as n from information_schema.tables where table_name=$1", [table])).rows[0].n, 1);
  assert.equal((await pool.query("select count(*)::int as n from pg_indexes where tablename in('wiki_pages','wiki_page_revisions','wiki_evidence')")).rows[0].n, 7);
  const columns=(await pool.query("select table_name,column_name,data_type from information_schema.columns where table_name like 'wiki_%'")).rows;
  for(const [table,column,type] of [["wiki_pages","id","uuid"],["wiki_pages","current_revision_id","uuid"],["wiki_pages","parent_id","uuid"],["wiki_pages","position","integer"],["wiki_pages","archived","boolean"],["wiki_page_revisions","content","jsonb"],["wiki_page_revisions","number","integer"],["wiki_page_revisions","content_hash","text"],["wiki_evidence","snapshot","jsonb"],["wiki_evidence","source_item_id","uuid"],["wiki_evidence","document_id","uuid"],["wiki_evidence","chunk_id","uuid"],["wiki_evidence","source_span_id","uuid"]]) {
    assert.equal(columns.find((item)=>item.table_name===table&&item.column_name===column)?.data_type,type);
  }
  assert.equal((await pool.query("select count(*)::int as n from pg_constraint where conrelid in('wiki_pages'::regclass,'wiki_page_revisions'::regclass,'wiki_evidence'::regclass) and contype='f'")).rows[0].n,3);
  assert.equal((await pool.query("select count(*)::int as n from pg_constraint where conname='wiki_pages_not_self_parent'")).rows[0].n,1);
  const chunk = async (source: typeof a, content: string): Promise<SourceRelationChunk> => {
    const doc = await createDocumentRepository(pool!).create({ sourceItemId: source.id, title: source.title, canonicalMarkdown: content, contentHash: content });
    const id = randomUUID(), span = randomUUID();
    await createChunkRepository(pool!).replaceDocumentChunks(doc.id, source.id, [{ id, sourceSpanId: span, chunkIndex: 0, content, contentHash: content, span: { id: span, startOffset: 0, endOffset: content.length } }]);
    return { id, sourceItemId: source.id, documentId: doc.id, sourceSpanId: span, content, contentHash: content, title: source.title, summary: null, rootId: source.id === a.id ? book.id : b.id };
  };
  const ac = await chunk(a, "Retrieval improves durable memory."), bc = await chunk(b, "Retrieval alone is insufficient without feedback.");
  const catalog = await chunk(book, JSON.stringify({ title: book.title, summary: "Synthetic catalog metadata" }));
  await pool.query("update chunks set metadata=jsonb_build_object('processingMode','catalog_metadata'),chunking_version='catalog-metadata-v1' where id=$1", [catalog.id]);
  const wiki = createWikiRepository(pool);
  const search = async (input: Parameters<typeof WikiQuerySchema.parse>[0]) => WikiResultsSchema.parse(await wiki.search(WikiQuerySchema.parse(input)));
  assert.equal((await search({ kind: "source" })).items.length, 3, "Catalog includes metadata-only container with no model/notes/graph");
  assert.equal((await search({ text: "memoria", kind: "source" })).items[0]?.id, a.id, "Accent-normalized title lookup");
  assert.equal((await search({ kind: "source", sourceIds: [book.id], includeDescendants: false })).items.length, 1);
  assert.equal((await search({ kind: "source", sourceIds: [book.id], includeDescendants: true })).items.length, 2);
  assert.ok(!(await search({ kind: "chunk" })).items.some((item) => item.id === catalog.id), "Catalog metadata is not original evidence");
  await assert.rejects(wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: "Invalid catalog claim", kind: "topic", sections: [{ id: randomUUID(), title: "Claim", markdown: "Not evidence", evidenceIds: [catalog.id] }] }), evidenceChunkIds: [catalog.id] }), /wiki.errors.evidence/);
  const content = WikiPageContentSchema.parse({ title: "Memory", kind: "topic", sections: [{ id: randomUUID(), title: "Evidence", markdown: "Retrieval helps memory.", evidenceIds: [ac.id] }] });
  const id = await wiki.save({ expectedRevisionId: null, content, evidenceChunkIds: [ac.id] });
  let page = WikiPageSchema.parse(await wiki.get(id));
  assert.equal(page.sections[0]?.protected, true); assert.equal(page.evidence[0]?.documentId, ac.documentId); assert.equal(page.evidence[0]?.sourceSpanId, ac.sourceSpanId);
  const first = page.revisionId, evidenceId = page.evidence[0]!.id;
  page = WikiPageSchema.parse(await wiki.get(await wiki.save({ id, expectedRevisionId: first, content: { ...content, title: "Learning", sections: [{ ...content.sections[0]!, markdown: "My edited interpretation.", evidenceIds: [evidenceId] }] }, evidenceChunkIds: [] })));
  assert.equal(page.revisionNumber, 2); assert.equal(page.sections[0]?.evidenceReview, "needs_review");
  assert.ok(page.aliases.includes("Memory")); assert.equal((await search({ text: "Memory", kind: "page", currentOnly: false })).items[0]?.exact, true);
  assert.equal((await search({ kind: "page", currentOnly: true })).items.length, 0, "Changed assertion is not verified evidence");
  assert.equal(WikiPageSchema.parse(await wiki.get(id, first)).sections[0]?.markdown, content.sections[0]?.markdown, "History immutable");
  await assert.rejects(wiki.save({ id, expectedRevisionId: first, content, evidenceChunkIds: [] }), /wiki.errors.conflict/);
  const collection = await wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: "Study", kind: "collection" }), evidenceChunkIds: [] });
  const currentRevision = page.revisionId;
  await wiki.save({ id, expectedRevisionId: currentRevision, content: { ...WikiPageContentSchema.strip().parse(page), parentId: collection, collectionIds: [collection] }, evidenceChunkIds: [] });
  const parent = WikiPageSchema.parse(await wiki.get(collection));
  await assert.rejects(wiki.save({ id: collection, expectedRevisionId: parent.revisionId, content: { ...WikiPageContentSchema.strip().parse(parent), parentId: id }, evidenceChunkIds: [] }), /wiki.errors.cycle/);
  const before = (await wiki.history(id)).length;
  await assert.rejects(wiki.save({ id, expectedRevisionId: WikiPageSchema.parse(await wiki.get(id)).revisionId, content: { ...content, sections: [{ ...content.sections[0]!, evidenceIds: [randomUUID()] }] }, evidenceChunkIds: [] }), /wiki.errors.evidence/);
  assert.equal((await wiki.history(id)).length, before, "Failed multi-row mutation rolls back");
  const mixed = await wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: "Mixed", kind: "synthesis", sections: [{ id: randomUUID(), title: "Both", markdown: "Compare both accounts", evidenceIds: [ac.id, bc.id] }] }), evidenceChunkIds: [ac.id, bc.id] });
  assert.equal((await search({ pageId: mixed, sourceIds: [a.id], kind: "source" })).items.length, 1, "Page scope intersects explicit allowed sources");
  assert.ok(!(await search({ sourceIds: [a.id], kind: "page", currentOnly: false })).items.some((item) => item.id === mixed), "Mixed-scope page does not leak prose");
  const relations = createSourceRelationRepository(pool);
  await relations.commitDecision("wiki-fixture", book.id, b.id, [{ existingId: null, sourceItemId: a.id, targetSourceItemId: b.id, relationType: "contrasts", sourceIdea: ac.content, targetIdea: bc.content, explanation: "Different conditions for memory benefits", importance: 0.9, confidence: 0.9, evidence: [{ source: ac, target: bc, note: null }] }], {});
  assert.equal((await search({ kind: "source_relation", sourceIds: [a.id] })).items.length, 0, "Neither endpoint may escape scope");
  const relation = (await search({ kind: "source_relation", sourceIds: [a.id, b.id] })).items[0]!;
  assert.equal((await search({ kind: "source_relation", reviewedOnly: true })).items.length, 0);
  const detail = await listSourceRelations(pool, a.id, b.id, 0, 30, relation.id);
  assert.equal(detail.relations.length, 1); assert.equal(detail.relations[0]!.evidence.length, 1);
  assert.equal(await relations.review(relation.id, "accepted", detail.relations[0]!.updatedAt), true);
  assert.equal((await search({ kind: "source_relation", reviewedOnly: true })).items.length, 1, "Source relationship review is independent of page review");
  const noteId=randomUUID();
  await pool.query(`insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key)
    values($1,'Memory claim','Memory claim','An approved current note',$2,$3,'approved','test','test','local','test',$1::uuid::text)`,[noteId,a.id,ac.id]);
  assert.equal((await search({kind:"atomic_note",reviewedOnly:true})).items[0]?.id,noteId);
  const linkedNoteId=randomUUID();
  await pool.query(`insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key)
    values($1,'Linked claim','Linked claim','Primary current, secondary stale',$2,$3,'approved','test','test','local','test',$1::uuid::text)`,[linkedNoteId,b.id,bc.id]);
  await pool.query("insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id) values($1,$2,$3)",[linkedNoteId,a.id,ac.id]);
  assert.equal((await search({kind:"atomic_note",sourceIds:[b.id]})).items.length,0,"Linked note cannot expose excluded supporting source");
  await pool.query("update documents set metadata=jsonb_build_object('supersededByDocumentId',$2::text) where id=$1", [ac.documentId, randomUUID()]);
  assert.equal((await search({kind:"atomic_note",reviewedOnly:true})).items.length,0,"Approved/current notes with superseded source evidence are excluded");
  assert.ok((await search({kind:"atomic_note",reviewedOnly:true,currentOnly:false})).items.every((item)=>!item.current),"Historical notes disclose stale evidence");
  page = WikiPageSchema.parse(await wiki.get(id));
  assert.equal(page.evidence[0]?.current, false); assert.equal(page.evidence[0]?.excerpt, ac.content);
  assert.ok(!(await search({ kind: "page" })).items.some((item) => item.id === mixed), "Stale exact consumed evidence excludes current-only page");
  assert.equal((await search({ kind: "source_relation" })).items.length, 0);
  assert.equal((await search({ kind: "source_relation", currentOnly: false })).items.length, 1, "Historical relation remains inspectable");
  assert.equal((await search({ kind: "source", limit: 1 })).hasMore, true);
  WikiPageListSchema.parse(await wiki.list());
  assert.equal((await pool.query("select count(*)::int as n from jobs")).rows[0].n, 0, "Manual wiki never schedules processing");
  await pool.query("delete from source_items where id=$1", [a.id]);
  page = WikiPageSchema.parse(await wiki.get(id)); assert.equal(page.evidence[0]?.excerpt, ac.content, "Evidence snapshot survives source deletion");
  assert.ok((await search({kind:"page",currentOnly:false})).items.some((item)=>item.id===id),"Historical page remains discoverable after cited source deletion");
  await pool.query("create database wiki_empty"); const url = new URL(connection.connectionString); url.pathname = "/wiki_empty";
  emptyPool = createPgPool({ connectionString: url.toString(), max: 2 });
  assert.equal((await runMigrations(emptyPool, migrations, { seedFolder })).seed.applied, true);
  assert.equal((await emptyPool.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0].n, journal.entries.length);
  assert.equal((await createWikiRepository(emptyPool).search(WikiQuerySchema.parse({}))).items.length, 0);
  console.log("Wiki verified: populated upgrade and empty baseline/history, columns/indexes, metadata-only catalog, accent lookup, explicit descendant scope, protected revisions, optimistic conflicts, cycle rollback, evidence identity and revalidation, mixed-scope exclusion, directed conceptual relations and independent review, stale/deleted evidence snapshots, pagination and zero AI jobs.");
} finally {
  if (emptyPool) await closePgPool(emptyPool); if (pool) await closePgPool(pool);
  await manager.stop(); await rm(workDir, { recursive: true, force: true });
}
