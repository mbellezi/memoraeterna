import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { WikiPageContentSchema, ConsultationInputSchema, type WikiPageContent } from "@app/domain";
import {
  createWikiRepository,
  createKnowledgeConsultationRepository,
  createSourceItemRepository,
  createDocumentRepository,
  createChunkRepository,
  type PgPool
} from "../../packages/db/src/index.js";
import {
  createWikiContextRepository,
  noteFingerprint,
  rowFingerprint
} from "../../packages/db/src/repositories/wikiContextRepository.js";
import type { ConsultationService } from "../../apps/desktop/src/main/services/consultation-service.js";

/** Runs inside the existing A5 isolated cluster, after its original zero-note checks. */
export async function verifyHierarchyReading(db: PgPool, consultation: ConsultationService) {
  const wiki = createWikiRepository(db),
    retrieval = createKnowledgeConsultationRepository(db),
    context = createWikiContextRepository(db);
  async function source(title: string) {
    const text = title + " reports an exact synthetic observation.",
      s = await createSourceItemRepository(db).create({ type: "GenericDocument", title });
    const d = await createDocumentRepository(db).create({
        sourceItemId: s.id,
        title,
        canonicalMarkdown: text,
        contentHash: text
      }),
      chunk = randomUUID(),
      span = randomUUID();
    await createChunkRepository(db).replaceDocumentChunks(d.id, s.id, [
      {
        id: chunk,
        sourceSpanId: span,
        chunkIndex: 0,
        content: text,
        contentHash: text,
        span: { id: span, startOffset: 0, endOffset: text.length }
      }
    ]);
    return { source: s.id, document: d.id, chunk, text };
  }
  const a = await source("Hierarchy primary"),
    b = await source("Hierarchy secondary"),
    outside = await source("Related isolation");
  async function save(content: WikiPageContent, id = randomUUID()) {
    const tx = await db.connect();
    try {
      await tx.query("begin");
      await wiki.save(
        {
          id,
          expectedRevisionId: null,
          content,
          evidenceChunkIds: [
            ...content.sections.flatMap((s) => s.evidenceIds),
            ...(content.automatic?.groups.flatMap((g) => g.explanationEvidenceIds) ?? [])
          ]
        },
        {
          transaction: tx,
          origin: "organization",
          allocatedTarget: true,
          humanApproved: false,
          explicitParent: true
        }
      );
      await tx.query("commit");
    } finally {
      tx.release();
    }
    return (await wiki.get(id))!;
  }
  async function topic(title: string, parentId: string | null, chunk?: string) {
    const section = randomUUID(),
      revision = randomUUID();
    return save(
      WikiPageContentSchema.parse({
        title,
        kind: "topic",
        parentId,
        sections: chunk
          ? [
              {
                id: section,
                sectionRevisionId: revision,
                title: "Observation",
                markdown: "A supported hierarchy observation.",
                provenance: "generated",
                evidenceReview: "needs_review",
                evidenceIds: [chunk],
                assessment: {
                  version: "automatic-wiki-v1",
                  sectionId: section,
                  sectionRevisionId: revision,
                  humanReview: "unreviewed",
                  support: "validated",
                  reason: "generated_pending_verification",
                  supportMethod: "model_checked",
                  supportAuditId: randomUUID(),
                  inputFingerprint: "fixture",
                  freshness: "current"
                }
              }
            ]
          : []
      })
    );
  }
  const root = await topic("Navigation only root", null),
    category = await topic("Navigation category", root.id),
    leaf = await topic("Substantive descendant", category.id, a.chunk),
    related = await topic("Related page", null, outside.chunk);
  const note = randomUUID();
  await db.query(
    "insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values($1::uuid,'Shared pending note','Shared observation','A retained two-source observation.',$2,$3,'pending_review','synthetic','fixture','test','h5a',$1::text)",
    [note, a.source, a.chunk]
  );
  // Retain the secondary original, then remove its live link. Scope must still see it.
  await db.query(
    "insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id) values($1,$2,$3)",
    [note, b.source, b.chunk]
  );
  await db.query(
    "insert into atomic_note_evidence(note_id,chunk_id,source_id,snapshot) select $1,c.id,c.source_item_id,jsonb_build_object('chunkId',c.id,'sourceItemId',c.source_item_id,'documentId',c.document_id,'sourceSpanId',c.source_span_id,'contentHash',c.content_hash,'excerpt',c.content,'sourceTitle',s.title,'documentCreatedAt',d.created_at,'locator',null) from chunks c join source_items s on s.id=c.source_item_id join documents d on d.id=c.document_id where c.id=$2",
    [note, b.chunk]
  );
  await db.query("delete from atomic_note_source_links where atomic_note_id=$1", [note]);
  async function toc(title: string, owner: string | null, children: string[] = []) {
    const id = randomUUID(),
      group = randomUUID(),
      revision = randomUUID();
    const targets = [
      { kind: "atomic_note", id: note, purpose: "reading" },
      ...children.map((id) => ({ kind: "page", id, purpose: "subtopic" })),
      { kind: "page", id: related.id, purpose: "related" }
    ];
    const members = targets.map((target, order) => ({
      version: "automatic-wiki-v1",
      id: randomUUID(),
      pageId: id,
      groupId: group,
      target: { kind: target.kind, id: target.id },
      purpose: target.purpose,
      order,
      origin: "generated",
      placementProtected: false,
      expectedPageRevisionId: revision,
      targetFingerprint: "fixture"
    }));
    const content = WikiPageContentSchema.parse({
      title,
      kind: "collection",
      review: "reviewed",
      automatic: {
        version: "automatic-wiki-v1",
        management: "ai_managed",
        role: {
          kind: "collection",
          role: owner ? "topic_toc" : "map",
          owner: owner ? { kind: "page", id: owner } : null
        },
        purpose: "Read exact observations",
        placementProtected: false,
        links: [],
        groups: [
          {
            version: "automatic-wiki-v1",
            id: group,
            collectionId: id,
            title: "Reading group",
            explanation: "A supported reading explanation.",
            explanationEvidenceIds: [a.chunk],
            membershipIds: members.map((m) => m.id),
            orderProtected: false,
            origin: "generated"
          }
        ],
        memberships: members
      }
    });
    const page = await save(content, id);
    const fingerprint = (
      await db.query(`select ${noteFingerprint("n")} fingerprint from atomic_notes n where id=$1`, [
        note
      ])
    ).rows[0].fingerprint;
    await db.query(
      "insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot) values($1,$2,'atomic_note',$3,$4,'{}')",
      [page.revisionId, group, note, fingerprint]
    );
    return { page, group };
  }
  const inner = await toc("Nested reading", null),
    outer = await toc("Owned reading", leaf.id, [inner.page.id]);
  const request = { sourceIds: [], includeDescendants: false, pageId: root.id };
  assert.deepEqual(
    await retrieval.scope(request),
    [a.source, b.source].sort(),
    "Ancestor scope includes descendants and retained secondary source, but no related-only source"
  );
  assert.deepEqual(
    await retrieval.scope({ ...request, pageId: outer.page.id }),
    [a.source, b.source].sort(),
    "Explicit TOC owner and nested reading scope agree"
  );
  const notes = await wiki.context({ pageId: root.id, view: "notes", after: null, limit: 1 });
  assert.equal(notes.items.length, 1);
  assert.equal(notes.items[0]!.id, note);
  assert.equal(notes.next, null);
  assert.deepEqual(
    notes.items[0]!.associations.map((a: any) => a.viaPageId).sort(),
    [inner.page.id, outer.page.id].sort(),
    "One pending note retains two distinct TOC associations"
  );
  const sourcePage1 = await wiki.context({
    pageId: root.id,
    view: "sources",
    after: null,
    limit: 1
  });
  assert.ok(sourcePage1.next);
  const sourcePage2 = await wiki.context({
    pageId: root.id,
    view: "sources",
    after: sourcePage1.next,
    limit: 1
  });
  assert.deepEqual(
    [...sourcePage1.items, ...sourcePage2.items].map((i) => i.id).sort(),
    [a.source, b.source].sort()
  );
  assert.equal(sourcePage2.next, null);
  assert.ok(
    (
      await wiki.context({ pageId: outer.page.id, view: "connections", after: null, limit: 100 })
    ).items.some((i) => i.id === related.id && i.reason === "related"),
    "Related links remain visible connections"
  );
  const compiled = await retrieval.compiled(
    [a.source, b.source, outside.source],
    "What do we know?",
    root.id,
    false
  );
  assert.ok(compiled.some((c) => c.context.pageId === leaf.id));
  assert.ok(
    compiled.some((c) => c.context.id === inner.group) &&
      compiled.some((c) => c.context.id === outer.group),
    "Nested groups enter generic ancestor consultation"
  );
  assert.ok(
    !compiled.some((c) => [root.id, category.id, related.id].includes(c.context.pageId!)),
    "Sectionless ancestors and related-only pages create no compiled units"
  );
  for (const unit of compiled) {
    assert.equal(new Set(unit.originals.map((e) => e.chunkId)).size, unit.originals.length);
    for (const original of unit.originals)
      assert.equal(original.excerpt, original.chunkId === a.chunk ? a.text : b.text);
  }
  assert.ok(
    (await retrieval.compiled([a.source, b.source], "What do we know?", outer.page.id, false)).some(
      (c) => c.context.pageId === leaf.id
    ),
    "Explicit owner consultation preserved"
  );
  assert.ok(
    !(await retrieval.compiled([a.source], "What do we know?", root.id, false)).some((c) =>
      [inner.group, outer.group].includes(c.context.id)
    ),
    "Excluded retained secondary source cannot enter group prose"
  );
  assert.ok(
    !(await context.contexts([a.source], [a.chunk, b.chunk], false)).some((c) => c.id === note)
  );
  assert.ok(
    !(await context.contexts([a.source, b.source], [a.chunk], false)).some((c) => c.id === note),
    "Every complete retained original must be packed before note prose"
  );
  const eligible = (await context.contexts([a.source, b.source], [a.chunk, b.chunk], false)).find(
    (c) => c.id === note
  )!;
  assert.deepEqual(eligible.chunkIds, [a.chunk, b.chunk].sort());
  assert.equal(eligible.review, "pending_review");
  assert.ok(
    !(await context.contexts([a.source, b.source], [a.chunk, b.chunk], true)).some(
      (c) => c.id === note
    )
  );
  const answer = await consultation.ask(
    ConsultationInputSchema.parse({
      version: "knowledge-consultation-v2",
      requestId: randomUUID(),
      question: "What do we know?",
      pageId: root.id
    })
  );
  assert.ok(
    answer.contexts.some((c) => c.pageId === leaf.id) &&
      answer.contexts.some((c) => c.id === inner.group)
  );
  assert.deepEqual(
    answer.evidence.map((e) => e.chunkId).sort(),
    [a.chunk, b.chunk].sort(),
    "Actual compiled packing deduplicates complete originals"
  );
  assert.ok(
    answer.contexts.filter((c) => c.kind === "wiki_section").length <= 6 &&
      answer.evidence.length <= 12
  );
  // Dependency-only note relations retain both participants' full source lineage.
  const peer = randomUUID();
  await db.query(
    "insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values($1::uuid,'Peer','Peer observation','Peer observation.',$2,$3,'pending_review','synthetic','fixture','test','h5a',$1::text)",
    [peer, a.source, a.chunk]
  );
  const relation = randomUUID();
  await db.query(
    "insert into atomic_note_relations(id,source_atomic_note_id,target_atomic_note_id,final_score,explanation) values($1,$2,$3,1,'A related observation.')",
    [relation, note, peer]
  );
  const consumer = await topic("Dependency-only consumer", null, a.chunk),
    fingerprint = (
      await db.query(
        `select ${rowFingerprint("r")} fingerprint from atomic_note_relations r where id=$1`,
        [relation]
      )
    ).rows[0].fingerprint;
  await db.query(
    "insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot) values($1,$2,'note_relation',$3,$4,'{}')",
    [consumer.revisionId, consumer.sections[0]!.id, relation, fingerprint]
  );
  assert.deepEqual(
    await retrieval.scope({ ...request, pageId: consumer.id }),
    [a.source, b.source].sort()
  );
  assert.ok(
    !(await retrieval.compiled([a.source], "What do we know?", consumer.id, false)).some(
      (c) => c.context.pageId === consumer.id
    )
  );
  const relationUnit = (
    await retrieval.compiled([a.source, b.source], "What do we know?", consumer.id, false)
  ).find((c) => c.context.pageId === consumer.id)!;
  assert.deepEqual(relationUnit.originals.map((e) => e.chunkId).sort(), [a.chunk, b.chunk].sort());
  // A malformed retained source attribution cannot certify a current original.
  await db.query("update atomic_note_evidence set source_id=$2 where note_id=$1", [
    note,
    outside.source
  ]);
  const historical = await wiki.linkedTarget({
    pageId: inner.page.id,
    kind: "atomic_note",
    id: note
  });
  assert.equal(historical!.noteState!.current, false);
  assert.ok(
    historical!.evidence.some((e) => e.chunkId === b.chunk && e.excerpt === b.text && !e.current),
    "The inspector preserves mismatched historical excerpts without current support"
  );
  assert.ok(
    !(await context.contexts([a.source, b.source, outside.source], [a.chunk, b.chunk], false)).some(
      (c) => c.id === note
    )
  );
  assert.ok(
    !(
      await retrieval.compiled(
        [a.source, b.source, outside.source],
        "What do we know?",
        root.id,
        false
      )
    ).some((c) => [inner.group, outer.group].includes(c.context.id))
  );
  await db.query("update atomic_note_evidence set source_id=$2 where note_id=$1", [note, b.source]);
  // Missing retained originals never become current or newly authorized evidence.
  await db.query(
    "update documents set metadata=jsonb_build_object('supersededByDocumentId',$2::text) where id=$1",
    [b.document, randomUUID()]
  );
  assert.ok(
    !(await retrieval.compiled([a.source, b.source], "What do we know?", root.id, false)).some(
      (c) => [inner.group, outer.group].includes(c.context.id)
    )
  );
  assert.ok(
    !(await context.contexts([a.source, b.source], [a.chunk, b.chunk], false)).some(
      (c) => c.id === note
    )
  );
  await db.query("delete from source_items where id=$1", [b.source]);
  assert.ok(
    !(await context.contexts([a.source, b.source], [a.chunk, b.chunk], false)).some(
      (c) => c.id === note
    ),
    "Deleted retained secondary original remains ineligible"
  );
  assert.ok(
    !(await retrieval.compiled([a.source, b.source], "What do we know?", root.id, false)).some(
      (c) => [inner.group, outer.group].includes(c.context.id)
    )
  );
  await verifyTree(db);
  console.log(
    "H5a PostgreSQL: ancestor/principal/nested TOC consultation, distinct shared-note associations, retained secondary scope/currentness, exact deduplicated originals, related-only isolation and deep/broad keyset/path reads passed."
  );
}

async function verifyTree(db: PgPool) {
  const wiki = createWikiRepository(db),
    root = randomUUID(),
    nodes: Array<{
      id: string;
      parentId: string | null;
      title: string;
      position: number;
      revisionId: string;
      content: WikiPageContent;
      hash: string;
    }> = [];
  function add(id: string, parentId: string | null, title: string, position = 0) {
    const content = WikiPageContentSchema.parse({
      title,
      kind: "topic",
      parentId,
      position,
      sections: [],
      pinned: id === root
    });
    nodes.push({
      id,
      parentId,
      title,
      position,
      revisionId: randomUUID(),
      content,
      hash: createHash("sha256").update(JSON.stringify(content)).digest("hex")
    });
  }
  add(root, null, "Deep broad root");
  const wide = Array.from({ length: 240 }, () => randomUUID());
  wide.forEach((id, i) => add(id, root, "Sibling " + String(i).padStart(3, "0"), i));
  let parent = root;
  for (let depth = 0; depth < 220; depth++) {
    const id = randomUUID();
    add(id, parent, "Deep " + depth, 500);
    parent = id;
  }
  await db.query(
    "insert into wiki_pages(id,parent_id,title,kind,position) select (x->>'id')::uuid,(x->>'parentId')::uuid,x->>'title','topic',(x->>'position')::int from jsonb_array_elements($1) x",
    [JSON.stringify(nodes)]
  );
  await db.query(
    "insert into wiki_page_revisions(id,page_id,number,origin,content,content_hash) select (x->>'revisionId')::uuid,(x->>'id')::uuid,1,'human',x->'content',x->>'hash' from jsonb_array_elements($1) x",
    [JSON.stringify(nodes)]
  );
  await db.query(
    "update wiki_pages p set current_revision_id=(x->>'revisionId')::uuid from jsonb_array_elements($1) x where p.id=(x->>'id')::uuid",
    [JSON.stringify(nodes)]
  );
  const first = await wiki.tree({ parentId: root, after: null, limit: 17, pathTo: parent });
  assert.equal(first.path.length, 221);
  assert.ok(first.items.every((p) => !p.hasChildren));
  const loaded = [...first.items];
  let cursor = first.next;
  while (cursor) {
    const next = await wiki.tree({ parentId: root, after: cursor, limit: 17 });
    loaded.push(...next.items);
    cursor = next.next;
  }
  assert.deepEqual(
    loaded.slice(0, 240).map((p) => p.id),
    wide
  );
  assert.equal(loaded.length, 241);
  assert.ok(loaded.at(-1)!.hasChildren);
  assert.ok(
    (await wiki.tree({ view: "pinned", parentId: null, after: null, limit: 100 })).items.some(
      (p) => p.id === root
    )
  );
  assert.ok(
    (await wiki.tree({ view: "recent", parentId: null, after: null, limit: 100 })).items.length > 0
  );
  await db.query("update wiki_pages set archived=true where id=$1", [root]);
  const orphanPath = await wiki.tree({ parentId: null, after: null, limit: 1000, pathTo: parent });
  assert.equal(orphanPath.path.length, 220);
  assert.ok(orphanPath.items.some((p) => p.id === wide[0] && p.parentId === null));
  // Direct corruption is synthetic defense coverage, never a canonical mutation path.
  const missingRevisionParent = randomUUID();
  await db.query(
    "insert into wiki_pages(id,title,kind) values($1,'Missing current revision','topic')",
    [missingRevisionParent]
  );
  await db.query("update wiki_pages set parent_id=$2 where id=$1", [
    wide[0],
    missingRevisionParent
  ]);
  assert.ok(
    (await wiki.tree({ parentId: null, after: null, limit: 1000 })).items.some(
      (p) => p.id === wide[0] && p.parentId === null
    )
  );
  await db.query("update wiki_pages set parent_id=$2 where id=$1", [nodes[241]!.id, parent]);
  assert.equal(
    (await wiki.tree({ parentId: null, after: null, limit: 1, pathTo: parent })).path.length,
    220,
    "Defensive cyclic path terminates without a depth cutoff"
  );
}
