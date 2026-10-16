import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createSourceItemRepository,
  createDocumentRepository,
  createChunkRepository,
  type PgPool
} from "../../packages/db/src/index.js";

/**
 * Migration 0052 refuses new legacy content unless `memora.legacy_fixture` is on (D40). This
 * fixture seeds legacy pages on purpose, on scratch databases only. The database default reaches
 * every connection opened later; the connections the pool already holds get it by session. Call it
 * while no other client of the pool is checked out.
 */
export async function allowLegacyFixtureInserts(pool: PgPool): Promise<void> {
  await pool.query(
    "do $$ begin execute format('alter database %I set memora.legacy_fixture = %L', current_database(), 'on'); end $$"
  );
  const clients = await Promise.all(Array.from({ length: pool.totalCount }, () => pool.connect()));
  try {
    for (const client of clients) await client.query("set memora.legacy_fixture = 'on'");
  } finally {
    for (const client of clients) client.release();
  }
}

/**
 * A library as the old builds left it: sources with text, notes and one human wiki page. Versioned
 * synthetic inputs only. The page is written with raw SQL because no legacy repository is left.
 */
export async function seedLegacyLibraryFixture(pool: PgPool, withNotes: boolean) {
  await allowLegacyFixtureInserts(pool);
  const fixture = JSON.parse(
    await readFile(new URL("./automatic-wiki/mixed-library.json", import.meta.url), "utf8")
  );
  const sources = new Map<string, string>(),
    chunks = new Map<string, string>(),
    documents = new Map<string, string>();
  for (const source of fixture.sources) {
    const item = await createSourceItemRepository(pool).create({
      type: source.type,
      title: source.title,
      parentSourceItemId: source.parent ? sources.get(source.parent)! : null
    });
    sources.set(source.key, item.id);
    if (source.text) {
      const document = await createDocumentRepository(pool).create({
        sourceItemId: item.id,
        title: source.title,
        canonicalMarkdown: source.text,
        contentHash: source.text
      });
      const id = randomUUID(),
        span = randomUUID();
      await createChunkRepository(pool).replaceDocumentChunks(document.id, item.id, [
        {
          id,
          sourceSpanId: span,
          chunkIndex: 0,
          content: source.text,
          contentHash: source.text,
          span: { id: span, startOffset: 0, endOffset: source.text.length }
        }
      ]);
      chunks.set(source.key, id);
      documents.set(source.key, document.id);
    }
  }
  const noteIds: string[] = [];
  if (withNotes)
    for (const note of fixture.notes) {
      const id = randomUUID();
      await pool.query(
        "insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values($1::uuid,$2,$3,$3,$4,$5,'synthetic','fixture','test','fixture-v1',$1::text)",
        [id, note.title, note.text, sources.get(note.source), chunks.get(note.source)]
      );
      noteIds.push(id);
    }
  const humanId = randomUUID(),
    revisionId = randomUUID(),
    page = fixture.existingPages[0];
  await pool.query("insert into wiki_pages(id,title,kind) values($1,$2,'topic')", [
    humanId,
    page.title
  ]);
  await pool.query(
    "insert into wiki_page_revisions(id,page_id,number,origin,content,content_hash) values($1,$2,1,'human',$3::jsonb,$4)",
    [
      revisionId,
      humanId,
      JSON.stringify({
        title: page.title,
        kind: "topic",
        sections: [{ id: randomUUID(), title: "Personal interpretation", markdown: page.text }]
      }),
      page.text
    ]
  );
  await pool.query("update wiki_pages set current_revision_id=$2 where id=$1", [
    humanId,
    revisionId
  ]);
  return { noteIds, humanId };
}
