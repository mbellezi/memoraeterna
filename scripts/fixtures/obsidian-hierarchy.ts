import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WikiPageContentSchema, type WikiPageContent } from "@app/domain";
import {
  createSourceItemRepository,
  createDocumentRepository,
  createChunkRepository,
  createAtomicNoteRepository,
  createWikiRepository,
  createObsidianWikiRepository,
  createObsidianSyncRepository,
  createJobRepository,
  type PgPool
} from "../../packages/db/src/index.js";
import { ObsidianSyncService } from "../../apps/desktop/src/main/services/obsidian-sync-service.js";
import { runObsidianSync } from "../../apps/desktop/src/main/workers/obsidian-sync.worker.js";
import { buildObsidianMirror } from "../../apps/desktop/src/main/services/obsidian-mirror.js";
import { pathIdentity } from "../../apps/desktop/src/main/services/obsidian-layout-paths.js";

/** Isolated empty PostgreSQL + real vault. No application launch or model calls. */
export async function verifyObsidianHierarchy(pool: PgPool, vault: string) {
  await mkdir(vault, { recursive: true });
  const wiki = createWikiRepository(pool),
    repo = createObsidianWikiRepository(pool),
    registry = createObsidianSyncRepository(pool);
  const config = { version: 2 as const, language: "en" as const, attachments: "omit" as const },
    all = { sourceIds: [], pageIds: [], includeDescendants: false };
  let settings = {
    obsidianVaultPath: vault,
    managedRoot: "Memora",
    obsidianSyncEnabled: true,
    obsidianSyncPaused: false,
    deletionPolicy: "tombstone" as const,
    uploadCopiesEnabled: false,
    uploadCopiesFolderPath: null,
    updatedAt: new Date().toISOString()
  };
  const service = new ObsidianSyncService({
    getPool: () => pool,
    getStorageSettings: async () => settings,
    getLocale: async () => "en",
    writeProjection: async (input) => ({
      mtimeMs: Number((await runObsidianSync({ action: "write", ...input })).mtimeMs)
    })
  });
  async function run() {
    const id = (await service.wiki.enqueue(true))!,
      jobs = createJobRepository(pool),
      job = (await jobs.findById(id))!;
    await jobs.update(id, { status: "running" });
    const result = await service.wiki.execute(job);
    await jobs.update(id, { status: "succeeded", result });
    return result;
  }
  async function source(title: string) {
    const s = await createSourceItemRepository(pool).create({ type: "GenericDocument", title }),
      text = title + " exact original.",
      d = await createDocumentRepository(pool).create({
        sourceItemId: s.id,
        title,
        canonicalMarkdown: text,
        contentHash: text
      }),
      chunk = randomUUID(),
      span = randomUUID();
    await createChunkRepository(pool).replaceDocumentChunks(d.id, s.id, [
      {
        id: chunk,
        chunkIndex: 0,
        content: text,
        contentHash: text,
        sourceSpanId: span,
        span: { id: span, startOffset: 0, endOffset: text.length }
      }
    ]);
    return { id: s.id, chunk, document: d.id, text };
  }
  async function save(content: WikiPageContent, id = randomUUID()) {
    const previous = await wiki.get(id),
      tx = await pool.connect();
    try {
      await tx.query("begin");
      await wiki.save(
        {
          version: 2,
          id,
          expectedRevisionId: previous?.revisionId ?? null,
          content,
          evidenceChunkIds: [
            ...content.sections.flatMap((s) => s.evidenceIds),
            ...(content.automatic?.groups.flatMap((g) => g.explanationEvidenceIds) ?? [])
          ].map((id) => previous?.evidence.find((e) => e.id === id)?.chunkId ?? id)
        },
        {
          transaction: tx,
          origin: "organization",
          allocatedTarget: !previous,
          humanApproved: true,
          explicitParent: true
        }
      );
      await tx.query("commit");
    } catch (error) {
      await tx.query("rollback");
      throw error;
    } finally {
      tx.release();
    }
    return (await wiki.get(id))!;
  }
  async function topic(title: string, parentId: string | null = null, chunk?: string) {
    return save(
      WikiPageContentSchema.parse({
        title,
        kind: "topic",
        parentId,
        sections: chunk
          ? [
              {
                id: randomUUID(),
                title: "Evidence",
                markdown: "Exact supported synthetic claim.",
                provenance: "personal",
                protected: true,
                evidenceIds: [chunk]
              }
            ]
          : []
      })
    );
  }
  try {
    const a = await source("Allowed original"),
      b = await source("Excluded retained original");
    const note = await createAtomicNoteRepository(pool).upsertGenerated({
      title: "One shared note",
      bodyMarkdown: "One identity across nested reading indexes.",
      ideaStatement: "Shared observation.",
      sourceItemId: a.id,
      evidenceChunkId: a.chunk,
      evidenceLinks: [{ chunkId: a.chunk }],
      generationProvider: "synthetic",
      generationModel: "fixture",
      generationRuntime: "synthetic",
      generationPromptVersion: "h5c",
      generationKey: randomUUID()
    });
    await pool.query(
      "insert into atomic_note_evidence(note_id,chunk_id,source_id,snapshot) select $1,c.id,c.source_item_id,jsonb_build_object('chunkId',c.id,'sourceItemId',c.source_item_id,'documentId',c.document_id,'sourceSpanId',c.source_span_id,'contentHash',c.content_hash,'excerpt',c.content,'sourceTitle',s.title,'documentCreatedAt',d.created_at,'locator',null) from chunks c join source_items s on s.id=c.source_item_id join documents d on d.id=c.document_id where c.id=$2",
      [note.id, b.chunk]
    );
    await pool.query(
      "insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id) values($1,$2,$3)",
      [note.id, b.id, b.chunk]
    );
    await pool.query(
      "delete from atomic_note_source_links where atomic_note_id=$1 and source_item_id=$2",
      [note.id, b.id]
    );
    let parent: string | null = null;
    const chain: string[] = [];
    for (let i = 0; i < 40; i++) {
      const page = await topic(`${i} ${"日本語 mémoire ".repeat(12)}`, parent);
      chain.push(page.id);
      parent = page.id;
    }
    const leaf = await topic("Leaf with original", parent, a.chunk),
      safe = await topic("Scoped independent leaf", chain[0]!, a.chunk);
    async function toc(title: string, owner: string | null, children: string[] = []) {
      const id = randomUUID(),
        group = randomUUID(),
        targets = [
          { kind: "atomic_note", id: note.id, purpose: "reading" },
          ...children.map((id) => ({ kind: "page", id, purpose: "subtopic" })),
          { kind: "page", id: safe.id, purpose: "related" }
        ],
        members = targets.map((target, order) => ({
          version: "automatic-wiki-v1",
          id: randomUUID(),
          pageId: id,
          groupId: group,
          target: { kind: target.kind, id: target.id },
          purpose: target.purpose,
          order,
          origin: "human",
          placementProtected: true,
          expectedPageRevisionId: randomUUID(),
          targetFingerprint: "fixture"
        }));
      return save(
        WikiPageContentSchema.parse({
          title,
          kind: "collection",
          automatic: {
            version: "automatic-wiki-v1",
            management: "human_managed",
            role: {
              kind: "collection",
              role: owner ? "topic_toc" : "map",
              owner: owner ? { kind: "page", id: owner } : null
            },
            purpose: "Nested exact originals",
            placementProtected: true,
            links: [],
            groups: [
              {
                version: "automatic-wiki-v1",
                id: group,
                collectionId: id,
                title: "Private retained-derived heading",
                explanation: "Private retained-derived explanation",
                explanationEvidenceIds: [a.chunk],
                membershipIds: members.map((m) => m.id),
                orderProtected: true,
                origin: "human"
              }
            ],
            memberships: members
          }
        }),
        id
      );
    }
    const inner = await toc("Inner retained reading", null),
      outer = await toc("Owned retained reading", leaf.id, [inner.id]);
    const history = await save(
      WikiPageContentSchema.parse({
        title: "Retained interpretation page",
        kind: "topic",
        sections: [
          {
            id: randomUUID(),
            title: "Current allowed claim",
            markdown: "Current allowed claim.",
            provenance: "generated",
            evidenceIds: [a.chunk],
            interpretations: [
              {
                version: "knowledge-interpretation-v1",
                assertionId: randomUUID(),
                revisionId: randomUUID(),
                statement: "Private historical interpretation",
                perspective: "ai_interpretation",
                context: "historical",
                eventTime: null,
                validFrom: null,
                validUntil: null,
                publicationTime: null,
                relationships: [],
                procedure: null,
                recordedAt: [{ documentId: b.document, at: "2026-01-01" }],
                revisedAt: "2026-01-02",
                evidence: [
                  {
                    sourceItemId: b.id,
                    documentId: b.document,
                    chunkId: b.chunk,
                    sourceSpanId: null,
                    contentHash: b.text,
                    excerpt: b.text,
                    sourceTitle: "Excluded retained original",
                    documentCreatedAt: "2026-01-01",
                    locator: null
                  }
                ]
              }
            ]
          }
        ]
      })
    );
    const dependency = await topic("Dependency-only note consumer", null, a.chunk);
    await pool.query(
      "insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot) values($1,$2,'atomic_note',$3,'fixture','{}')",
      [dependency.revisionId, dependency.sections[0]!.id, note.id]
    );
    const entities: string[] = [],
      entityPages: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      entities.push(id);
      await pool.query(
        "insert into entities(id,type,canonical_name,normalized_name,confidence) values($1,'person','Alex Smith','alex smith',1)",
        [id]
      );
      const p = await save(
        WikiPageContentSchema.parse({
          title: "Alex Smith",
          kind: "entity",
          entityId: id,
          parentId: chain[1],
          sections: [
            {
              id: randomUUID(),
              title: "Attribution",
              markdown: "A distinct canonical entity.",
              provenance: "personal",
              evidenceIds: [a.chunk]
            }
          ]
        })
      );
      entityPages.push(p.id);
    }
    let targets = await buildObsidianMirror(pool, "Memora", all, config);
    assert.equal(
      new Set(targets.map((t) => pathIdentity(t.path))).size,
      targets.length,
      "Portable paths are collision-safe"
    );
    assert.ok(targets.every((t) => Buffer.byteLength(t.path) <= 900));
    assert.ok(
      targets.filter((t) => chain.includes(t.id)).some((t) => t.path.split("/").length < 8),
      "Deep logical ancestry uses bounded physical folders"
    );
    assert.equal(targets.filter((t) => t.id === note.id).length, 1);
    const rendered = targets.find((t) => t.id === outer.id)!;
    assert.ok(
      rendered.generated.includes("Nested reading index") &&
        rendered.generated.includes("Related link")
    );
    assert.ok(
      rendered.generated.includes(targets.find((t) => t.id === inner.id)!.path.replace(/\.md$/, ""))
    );
    for (let i = 0; i < 2; i++)
      assert.ok(targets.find((t) => t.id === entityPages[i])!.generated.includes(entities[i]!));
    const leafGenerated = targets.find((t) => t.id === leaf.id)!.generated;
    for (const id of chain)
      assert.ok(
        leafGenerated.includes(targets.find((t) => t.id === id)!.path.replace(/\.md$/, "")),
        "Breadcrumb retains every logical ancestor"
      );
    const first = await run();
    assert.equal(first.conflicts, 0);
    const registered = await registry.list(),
      savedPaths = new Map(registered.map((f) => [f.memoraId, f.relativePath]));
    const legacyExisting = await service.wiki["plan"](
      settings,
      all,
      await repo.sources([], false),
      await repo.notes([a.id, b.id], true)
    );
    for (const id of [...chain, leaf.id, inner.id, outer.id, ...entityPages])
      assert.equal(
        legacyExisting.find((t) => t.id === id)!.path,
        savedPaths.get(id),
        "Legacy plan preserves registered paths before computing parents"
      );
    for (const id of chain)
      assert.ok(
        legacyExisting
          .find((t) => t.id === leaf.id)!
          .generated.includes(savedPaths.get(id)!.replace(/\.md$/, ""))
      );
    assert.ok(
      legacyExisting.find((t) => t.id === outer.id)!.generated.includes("Nested reading index") &&
        legacyExisting.find((t) => t.id === outer.id)!.generated.includes("Related link")
    );
    const leafFile = (await registry.findByMemoraId(leaf.id))!,
      dirty =
        (await readFile(join(vault, leafFile.relativePath), "utf8")) + "\nIndependent local edit";
    await writeFile(join(vault, leafFile.relativePath), dirty);
    // Rename + reparent + archive/restore never relocate already registered identities.
    for (const id of chain.slice(0, 8)) {
      const p = (await wiki.get(id))!;
      await save(WikiPageContentSchema.strip().parse({ ...p, title: "Renamed " + p.title }), id);
    }
    await save(
      WikiPageContentSchema.strip().parse({ ...leaf, title: "Renamed leaf", parentId: chain[2] }),
      leaf.id
    );
    let changed = await run();
    assert.ok(changed.conflicts > 0);
    assert.equal(await readFile(join(vault, leafFile.relativePath), "utf8"), dirty);
    const current = (await wiki.get(safe.id))!;
    await save(WikiPageContentSchema.strip().parse({ ...current, archived: true }), safe.id);
    await run();
    assert.ok((await readFile(join(vault, savedPaths.get(safe.id)!), "utf8")).includes("Archived"));
    await save(WikiPageContentSchema.strip().parse({ ...current, archived: false }), safe.id);
    await run();
    for (const f of await registry.list())
      if (savedPaths.has(f.memoraId)) assert.equal(f.relativePath, savedPaths.get(f.memoraId));
    assert.equal((await registry.list()).filter((f) => f.memoraId === note.id).length, 1);
    // Scope closure retains secondary originals after live-link removal, follows
    // nested indexes, and excludes derived ancestor headings and breadcrumbs.
    const narrow = { ...all, sourceIds: [a.id] };
    targets = await buildObsidianMirror(pool, "Memora", narrow, config);
    for (const id of [note.id, inner.id, outer.id, leaf.id, history.id, dependency.id, ...chain])
      assert.ok(!targets.some((t) => t.id === id), "Excluded lineage: " + id);
    assert.ok(targets.some((t) => t.id === safe.id));
    assert.ok(!targets.find((t) => t.id === safe.id)!.generated.includes("Renamed 0"));
    assert.ok(
      !targets.some(
        (t) =>
          (t.generated + t.editorial).includes("Private retained-derived") ||
          t.generated.includes("Private historical interpretation")
      )
    );
    const beforeDeletion = await repo.noteEvidence(note.id, a.chunk);
    assert.equal(beforeDeletion.find((e) => e.id === b.chunk)!.current, true);
    await pool.query(
      "update atomic_note_evidence set source_id=$2 where note_id=$1 and chunk_id=$3",
      [note.id, a.id, b.chunk]
    );
    assert.equal(
      (await repo.noteEvidence(note.id, a.chunk)).find((e) => e.id === b.chunk)!.current,
      false,
      "Mismatched retained attribution is historical"
    );
    assert.equal(
      (await repo.notes([a.id, b.id], true)).find((n) => n.id === note.id)!.current,
      false
    );
    await pool.query(
      "update atomic_note_evidence set source_id=$2 where note_id=$1 and chunk_id=$3",
      [note.id, b.id, b.chunk]
    );
    await pool.query("delete from source_items where id=$1", [b.id]);
    assert.equal(
      (await repo.noteEvidence(note.id, a.chunk)).find((e) => e.id === b.chunk)!.current,
      false
    );
    targets = await buildObsidianMirror(pool, "Memora", narrow, config);
    assert.ok(!targets.some((t) => [note.id, inner.id, outer.id, ...chain].includes(t.id)));
    const full = await buildObsidianMirror(pool, "Memora", all, config),
      historical = full.find((t) => t.id === note.id)!;
    assert.ok(
      historical.generated.includes(b.text) && historical.generated.includes("Unavailable")
    );
    assert.ok(
      full.find((t) => t.id === history.id)!.generated.includes("Private historical interpretation")
    );
    // Both outward formats share scope authorization; legacy plan performs no writes.
    const legacy = await service.wiki["plan"](
      settings,
      narrow,
      await repo.sources([a.id], false),
      await repo.notes([a.id])
    );
    assert.ok(legacy.some((t) => t.id === safe.id));
    assert.ok(
      !legacy.some((t) =>
        [note.id, inner.id, outer.id, leaf.id, history.id, dependency.id, ...chain].includes(t.id)
      )
    );
    settings = { ...settings, obsidianSyncEnabled: false };
    assert.equal(await service.wiki.enqueue(true), null);
    assert.equal(await readFile(join(vault, leafFile.relativePath), "utf8"), dirty);
    // New targets in an explicitly configured legacy vault also stay portable.
    const legacyIds: string[] = [];
    let legacyParent: string | null = null;
    for (let i = 0; i < 20; i++) {
      const p = await topic(`${i} ${"Legacy deep path ".repeat(10)}`, legacyParent);
      legacyIds.push(p.id);
      legacyParent = p.id;
    }
    const legacyDeep = await service.wiki["plan"](
      settings,
      all,
      await repo.sources([], false),
      await repo.notes([a.id], true)
    );
    for (const id of legacyIds)
      assert.ok(Buffer.byteLength(legacyDeep.find((t) => t.id === id)!.path) <= 900);
    assert.ok(
      legacyDeep.find((t) => t.id === legacyIds.at(-1))!.path.split("/").length < legacyIds.length
    );
    // Sentinel overflow is checked before exclusion; a late eligible page must
    // never disappear because the first thousand happened to be out of scope.
    const missing = 1001 - (await repo.pages()).length;
    for (let i = 0; i < missing; i++)
      await pool.query(
        "insert into wiki_pages(id,title,kind) values($1,'Excluded sentinel','topic')",
        [randomUUID()]
      );
    await assert.rejects(buildObsidianMirror(pool, "Memora", narrow, config), /limit/);
    await assert.rejects(
      service.wiki["plan"](
        settings,
        narrow,
        await repo.sources([a.id], false),
        await repo.notes([a.id])
      ),
      /limit/
    );
    return {
      depth: 40,
      legacyDepth: 20,
      sharedNotes: 1,
      entities: 2,
      registeredPathsPreserved: true,
      dirtyPreserved: true,
      retainedScope: true,
      rawOverflow: true,
      disabledSync: true
    };
  } finally {
    await service.shutdown();
  }
}
